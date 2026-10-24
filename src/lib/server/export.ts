import type pg from 'pg';
import type { CsvExportArgs } from '../types.js';
import { csvExportSchema } from '../schema-validation.js';
import { ident, loadMetadata, qualify, rowSelection } from './db.js';

// Bound retained rows, not bytes: an individual PostgreSQL value can itself be large.
const BATCH_ROWS = 256;
const textRows = {
	rowMode: 'array' as const,
	types: { getTypeParser: () => (value: string) => value }
};
const record = (values: (string | null)[]) =>
	values.map((value) => value === null ? '' : `"${value.replaceAll('"', '""')}"`).join(',') + '\r\n';

/** All matching SELECT-visible rows, with exact text output and one cursor snapshot. */
export async function exportCsv(
	pool: pg.Pool, target: CsvExportArgs, signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
	const validated = csvExportSchema['~standard'].validate(target);
	if ('issues' in validated) throw new Error(validated.issues[0].message);
	target = validated.value;
	signal?.throwIfAborted();
	const client = await pool.connect();
	let released = false;
	let stopped = false;
	let failure: unknown;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const release = (destroy = false) => {
		if (released) return;
		released = true;
		signal?.removeEventListener('abort', abort);
		client.removeListener('error', broken);
		client.release(destroy);
	};
	const stop = (error?: unknown) => {
		if (!stopped) {
			stopped = true;
			failure = error;
			if (error !== undefined) controller?.error(error);
		}
		// Closing only this lease rolls back and interrupts a potentially in-flight FETCH.
		release(true);
	};
	const abort = () => stop(new DOMException('CSV export aborted', 'AbortError'));
	const broken = (error: Error) => stop(error);
	const rollback = async () => {
		if (released) return;
		try {
			await client.query('rollback');
			release();
		} catch {
			release(true);
		}
	};
	client.on('error', broken);
	signal?.addEventListener('abort', abort, { once: true });

	try {
		if (signal?.aborted) {
			abort();
			throw failure;
		}
		// READ COMMITTED keeps the catalog fences fresh; DECLARE fixes the data snapshot.
		await client.query('begin isolation level read committed read only');
		const searchPath = (await client.query<{ search_path: string }>('show search_path')).rows[0].search_path;
		await client.query("set local search_path = pg_catalog; set local lock_timeout = '3s'");
		const catalog = async () => (await client.query<{
			oid: string; namespace: string; version: string; ordinary: boolean;
		}>(`
			select c.oid::text as oid, n.oid::text as namespace, n.xmin::text as version,
				c.relkind = 'r' and not c.relispartition and not exists (
					select from pg_inherits where inhrelid = c.oid or inhparent = c.oid
				) as ordinary
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = $1 and c.relname = $2`, [target.schema, target.table])).rows[0];
		const before = await catalog();
		if (!before) throw new Error('Table does not exist');
		if (!before.ordinary) throw new Error('CSV export supports only standalone ordinary tables');
		const check = async () => {
			const after = await catalog();
			if (!after || !after.ordinary || after.oid !== before.oid
				|| after.namespace !== before.namespace || after.version !== before.version) {
				throw new Error('Table or namespace changed; retry the export');
			}
		};
		const table = qualify(target.schema, target.table);
		await client.query(`lock table ${table} in access share mode`);
		await check();
		let selection = '';
		let projected = 't.*';
		let values: (string | number)[] = [];
		if (target.query || target.columns) {
			// Read fresh metadata on this locked lease, never the grid's cached catalog.
			const metadata = (await loadMetadata(client, target))[0];
			if (!metadata) throw new Error('Table changed; retry the export');
			if (target.columns) {
				const names = new Set(target.columns);
				for (const name of names) {
					if (!metadata.columns.some((column) => column.name === name)) throw new Error(`Unknown column: ${name}`);
				}
				projected = metadata.columns.filter((column) => names.has(column.name))
					.map((column) => `t.${ident(column.name)}`).join(', ');
			}
			if (target.query) {
				const query = rowSelection(metadata, target.query);
				selection = `${query.filter} order by ${query.order}`;
				values = query.values;
			}
		}
		// Match grid operator resolution (e.g. citext) and function/RLS execution context.
		await client.query("select pg_catalog.set_config('search_path', $1, true)", [searchPath]);
		await client.query(`declare superbase_csv no scroll cursor for select ${projected} from ${table} t ${selection}`, values);
		const metadata = await client.query<(string | null)[]>({
			text: 'fetch forward 0 from superbase_csv', ...textRows
		});
		if (!metadata.fields.length) throw new Error('Zero-column tables cannot be represented as CSV');
		// Namespace renames do not respect relation locks. Verify the actual SELECT binding,
		// then fence namespace rename/replacement (including rename-and-restore via xmin).
		if (metadata.fields.some((field) => String(field.tableID) !== before.oid)) {
			throw new Error('Table changed; retry the export');
		}
		await client.query('set local search_path = pg_catalog');
		await check();
		await client.query("select pg_catalog.set_config('search_path', $1, true)", [searchPath]);
		if (stopped) throw failure;
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				controller.enqueue(encoder.encode(record(metadata.fields.map((field) => field.name))));
			},
			async pull(value) {
				if (stopped) return;
				try {
					const batch = await client.query<(string | null)[]>({
						text: `fetch forward ${BATCH_ROWS} from superbase_csv`, ...textRows
					});
					if (stopped) return;
					if (batch.rows.length) {
						value.enqueue(encoder.encode(batch.rows.map(record).join('')));
					} else {
						await client.query('rollback');
						if (stopped) return;
						stopped = true;
						release();
						value.close();
					}
				} catch (error) {
					if (stopped) return;
					stopped = true;
					value.error(error);
					await rollback();
				}
			},
			cancel() { stop(); }
		});
	} catch (error) {
		await rollback();
		throw error;
	}
}
