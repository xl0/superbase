import type pg from 'pg';
import type { TableTarget } from '../types.js';
import { schemaTargetSchema } from '../schema-validation.js';
import { qualify } from './db.js';

// Bound retained rows, not bytes: an individual PostgreSQL value can itself be large.
const BATCH_ROWS = 256;
const textRows = {
	rowMode: 'array' as const,
	types: { getTypeParser: () => (value: string) => value }
};
const record = (values: (string | null)[]) =>
	values.map((value) => value === null ? '' : `"${value.replaceAll('"', '""')}"`).join(',') + '\r\n';

/** All SELECT-visible rows, with PostgreSQL's exact text output and one cursor snapshot. */
export async function exportCsv(
	pool: pg.Pool, target: TableTarget, signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
	const validated = schemaTargetSchema['~standard'].validate(target);
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
		await client.query(`declare superbase_csv no scroll cursor for select * from ${table}`);
		const metadata = await client.query<(string | null)[]>({
			text: 'fetch forward 0 from superbase_csv', ...textRows
		});
		if (!metadata.fields.length) throw new Error('Zero-column tables cannot be represented as CSV');
		// Namespace renames do not respect relation locks. Verify the actual SELECT binding,
		// then fence namespace rename/replacement (including rename-and-restore via xmin).
		if (metadata.fields.some((field) => String(field.tableID) !== before.oid)) {
			throw new Error('Table changed; retry the export');
		}
		await check();
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
