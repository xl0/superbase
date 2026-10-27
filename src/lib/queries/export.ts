import type pg from 'pg';
import type { CsvExportArgs } from '../types.js';
import { ident, qualify } from '../ddl.js';
import { actAs, loadMetadata, rowSelection, textTypes } from './db.js';

const BATCH_ROWS = 256;
const textRows = { rowMode: 'array' as const, types: textTypes };
// Non-null values are always quoted; SQL NULL is an empty, unquoted field.
const record = (values: (string | null)[]) =>
	values.map((value) => value === null ? '' : `"${value.replaceAll('"', '""')}"`).join(',') + '\r\n';

/** Stream all matching rows as exact PostgreSQL text from one read-only cursor snapshot. */
export async function exportCsv(pool: pg.Pool, target: CsvExportArgs, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	const client = await pool.connect();
	let header: pg.QueryArrayResult;
	try {
		await client.query('begin read only');
		let projection = 't.*', selection = '', values: (string | number)[] = [];
		if (target.query || target.columns) {
			const [table] = await loadMetadata(client, target);
			if (!table) throw new Error(`Table ${target.schema}.${target.table} not found`);
			// Selected columns keep table order; filtering and sorting still see every column.
			if (target.columns) {
				projection = table.columns.filter((column) => target.columns!.includes(column.name))
					.map((column) => `t.${ident(column.name)}`).join(', ');
			}
			if (target.query) {
				const query = rowSelection(table, target.query);
				selection = `${query.where} ${query.order ? `order by ${query.order}` : ''}`;
				values = query.values;
			}
		}
		if (!projection) throw new Error('Select at least one column');
		await actAs(client, target.as);
		await client.query(`declare superbase_csv no scroll cursor for select ${projection} from ${qualify(target.schema, target.table)} t ${selection}`, values);
		header = await client.query({ text: 'fetch 0 from superbase_csv', ...textRows });
	} catch (error) {
		await client.query('rollback').catch(() => {});
		client.release();
		throw error;
	}
	let finished = false;
	const finish = (destroy: boolean) => {
		if (finished) return;
		finished = true;
		signal?.removeEventListener('abort', abort);
		// Destroying the connection also interrupts an in-flight FETCH.
		if (destroy) client.release(true);
		else client.query('rollback').then(() => client.release(), () => client.release(true));
	};
	const abort = () => finish(true);
	signal?.addEventListener('abort', abort);
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(record(header.fields.map((field) => field.name))));
		},
		async pull(controller) {
			try {
				const batch = await client.query({ text: `fetch ${BATCH_ROWS} from superbase_csv`, ...textRows });
				if (batch.rows.length) controller.enqueue(encoder.encode(batch.rows.map(record).join('')));
				else { controller.close(); finish(false); }
			} catch (error) {
				controller.error(error);
				finish(true);
			}
		},
		cancel() { finish(true); }
	});
}
