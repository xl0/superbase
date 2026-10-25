import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { exportCsv } from '../src/lib/server/export.js';
import { ident, qualify } from '../src/lib/ddl.js';

const url = process.env.TEST_DATABASE_URL;
const namespace = `sb_csv_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
const target = (table: string) => ({ connection: 'test', schema: namespace, table });
const csv = (values: (string | null)[]) => values.map((value) => value === null ? '' : `"${value.replaceAll('"', '""')}"`).join(',') + '\r\n';
const read = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
let pool: pg.Pool;

(url ? describe : describe.skip)('PostgreSQL cursor CSV', () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: url, max: 2 });
		await pool.query(`create schema ${ident(namespace)}`);
	});
	afterAll(async () => {
		await pool.query(`drop schema ${ident(namespace)} cascade`);
		await pool.end();
	});

	test('exact text across batches, column selection, and grid filters/order', async () => {
		const table = qualify(namespace, 'odd "name"');
		await pool.query(`create table ${table} (id int primary key, n numeric, doc json, "null" text, empty text, "a,b" text)`);
		await pool.query(`insert into ${table} select i, 9007199254740993.5, '{ "n": 1, "n": 2 }', null, '', '=1\r\n"x"' from generate_series(1, 600) i`);
		const row = (id: number) => [String(id), '9007199254740993.5', '{ "n": 1, "n": 2 }', null, '', '=1\r\n"x"'];
		const header = csv(['id', 'n', 'doc', 'null', 'empty', 'a,b']);
		expect(await read(await exportCsv(pool, target('odd "name"')))).toBe(header + Array.from({ length: 600 }, (_, i) => csv(row(i + 1))).join(''));
		// Selected columns keep table order; filters and sort still use every column.
		const filtered = await exportCsv(pool, { ...target('odd "name"'), columns: ['a,b', 'id'], query: {
			search: '', sort: [{ column: 'id', direction: 'desc' }], filters: [{ column: 'id', operator: 'lte', value: '3' }]
		} });
		expect(await read(filtered)).toBe(csv(['id', 'a,b']) + [3, 2, 1].map((id) => csv([String(id), '=1\r\n"x"'])).join(''));
		await expect(exportCsv(pool, { ...target('odd "name"'), query: { search: '', sort: [], filters: [{ column: 'id', operator: 'eq', value: 'x' }] } }))
			.rejects.toThrow('invalid input syntax');
		expect(pool.idleCount + pool.waitingCount).toBe(pool.totalCount);
	});

	test('cancelling a stream releases its client', async () => {
		const stream = await exportCsv(pool, target('odd "name"'));
		const reader = stream.getReader();
		await reader.read();
		await reader.cancel();
		await Bun.sleep(50);
		expect((await pool.query('select 1 as ok')).rows[0].ok).toBe(1);
		expect(pool.totalCount).toBeLessThanOrEqual(2);
	});
});
