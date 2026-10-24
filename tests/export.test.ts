import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import ts from 'typescript';
import { exportCsv } from '../src/lib/server/export.js';
import { ident, listRows, qualify } from '../src/lib/server/db.js';
import { csvExportSchema } from '../src/lib/schema-validation.js';
import type { CsvExportArgs, RowQuery } from '../src/lib/types.js';

const namespace = `sb_csv_${process.pid}_${crypto.randomUUID().slice(0, 12).replaceAll('-', '')}`;
const target = (table: string, schema = namespace) => ({ connection: 'test', schema, table });
const tableSql = (table: string) => qualify(namespace, table);
const csv = (values: (string | null)[]) =>
	values.map((value) => value === null ? '' : `"${value.replaceAll('"', '""')}"`).join(',') + '\r\n';
const read = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

test('direct export validates the exact target before acquiring a client', async () => {
	const pool = { connect() { throw new Error('must not connect'); } } as unknown as pg.Pool;
	await expect(exportCsv(pool, { ...target('x'), sql: 'select 1' } as any)).rejects.toThrow('Unexpected field');
	for (const query of [
		{ sort: [], search: '', page: 0 },
		{ sort: [{ column: 'id', direction: 'desc; select 1' }], search: '' },
		{ sort: [], search: '', filters: [{ column: 'id', operator: 'sql', value: '1' }] },
		{ sort: [], search: '', filters: Array(21).fill({ column: 'id', operator: 'eq', value: '1' }) },
		{ sort: [], search: '', filters: [{ column: 'id', operator: 'eq', value: 'x'.repeat(10_001) }] }
	]) await expect(exportCsv(pool, { ...target('x'), query } as any)).rejects.not.toThrow('must not connect');
	for (const columns of [[], ['id', 'id'], [''], [null], ['x'.repeat(64)], Array(1601).fill('id')]) {
		await expect(exportCsv(pool, { ...target('x'), columns } as any)).rejects.not.toThrow('must not connect');
	}
	const controller = new AbortController();
	controller.abort();
	await expect(exportCsv(pool, target('x'), controller.signal)).rejects.toThrow();
});

test('download route validates origin/query/generation and uses safe attachment headers and readable errors', async () => {
	const key = `__csvRoute_${crypto.randomUUID()}`;
	let calls = 0;
	let expectedSignal: AbortSignal | undefined;
	const postQuery: RowQuery = {
		sort: [{ column: '__proto__', direction: 'desc' }], search: '',
		filters: [{ column: 'value', operator: 'eq', value: '雪\r\n\"'.repeat(2000) }],
		filter: JSON.parse('{"__proto__":"9007199254740993"}')
	};
	const state = {
		csvExportSchema,
		activePool(connection: string) {
			calls++;
			if (connection !== 'test') throw new Error('stale generation');
			return 'captured';
		},
		safeErrorMessage(error: Error) { return error.message.replaceAll('secret', '[redacted]'); },
		async exportCsv(pool: unknown, value: CsvExportArgs, signal: AbortSignal) {
			expect(pool).toBe('captured');
			expect(signal).toBe(expectedSignal);
			if (value.query) expect(value.query).toEqual(postQuery);
			if (value.table === 'fail') throw new Error('database secret failure');
			return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('"x"\r\n')); c.close(); } });
		}
	};
	(globalThis as any)[key] = state;
	try {
		const source = (await readFile(new URL('../src/routes/export/+server.ts', import.meta.url), 'utf8'))
			.replace(/^import .* from '#lib\/.*';$/gm, '');
		const compiled = ts.transpileModule(
			`const { activePool, safeErrorMessage, exportCsv, csvExportSchema } = globalThis[${JSON.stringify(key)}];\n${source}`,
			{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
		).outputText;
		const { GET, POST } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
		async function request(query: string, headers?: Record<string, string>) {
			const url = new URL(`http://localhost:5173/export?${query}`);
			const request = new Request(url, { headers });
			expectedSignal = request.signal;
			return GET({ request, url }) as Promise<Response>;
		}
		const params = (table: string) => new URLSearchParams(target(table)).toString();
		for (const query of [params('x') + '&table=y', params('x') + '&filter=x', 'connection=test&schema=x']) {
			const response = await request(query);
			expect(response.status).toBe(400);
			expect(response.headers.has('content-disposition')).toBe(false);
		}
		for (const headers of [
			{ origin: 'https://evil.example' }, { origin: 'null' },
			{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }
		]) expect((await request(params('x'), headers)).status).toBe(403);
		expect(calls).toBe(0);
		const response = await request(params('../é"\r\nx'), { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' });
		expect(calls).toBe(1);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
		const disposition = response.headers.get('content-disposition')!;
		expect(disposition).toStartWith('attachment; filename="export.csv"; filename*=UTF-8\'\'');
		expect(decodeURIComponent(disposition.split("UTF-8''")[1])).toBe('.._é___x.csv');
		expect(await response.text()).toBe('"x"\r\n');
		const failed = await request(params('fail'));
		expect(failed.status).toBe(400);
		expect(failed.headers.has('content-disposition')).toBe(false);
		expect(failed.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await failed.text()).toBe('CSV export failed: database [redacted] failure');
		expect((await request(params('x').replace('connection=test', 'connection=stale'))).status).toBe(400);

		async function post(body: URLSearchParams | string, headers: Record<string, string> = {}, query = '') {
			const url = new URL(`http://localhost:5173/export${query}`);
			const request = new Request(url, { method: 'POST', body, headers: {
				origin: url.origin, 'content-type': 'application/x-www-form-urlencoded', ...headers
			} });
			expectedSignal = request.signal;
			return POST({ request, url }) as Promise<Response>;
		}
		const form = new URLSearchParams({ export: JSON.stringify({ ...target('x'), query: postQuery }) });
		const filtered = await post(form);
		expect(filtered.status).toBe(200);
		expect(filtered.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(await filtered.text()).toBe('"x"\r\n');
		const before = calls;
		for (const headers of [
			{ origin: '' }, { origin: 'null' }, { origin: 'https://evil.example' },
			{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }
		]) expect((await post(form, headers)).status).toBe(403);
		expect((await post(form, { 'content-type': 'application/json' })).status).toBe(415);
		for (const body of ['export={', `${form}&export={}`, `${form}&extra=1`, 'other=1',
			new URLSearchParams({ export: JSON.stringify({ ...target('x'), query: { ...postQuery, limit: 1 } }) })]) {
			const response = await post(body);
			expect(response.status).toBe(400);
			expect(response.headers.has('content-disposition')).toBe(false);
		}
		expect((await post(form, {}, '?table=other')).status).toBe(400);
		expect(calls).toBe(before);
		const stale = await post(new URLSearchParams({ export: JSON.stringify({ ...target('x'), connection: 'stale', query: postQuery }) }));
		expect(stale.status).toBe(400);
		expect(await stale.text()).toContain('stale generation');
	} finally {
		delete (globalThis as any)[key];
	}
});

const url = process.env.TEST_DATABASE_URL;
let pool: pg.Pool;
let exports: pg.Pool;
let created = false;

// Deterministic real-PostgreSQL interleavings, without globally mocking pg or shared modules.
function interleaved(run: (sql: string, client: pg.PoolClient) => Promise<void>, base = exports): pg.Pool {
	return { connect: async () => {
		const client = await base.connect();
		return new Proxy(client, {
			get(object, key) {
				if (key === 'query') return async (...args: any[]) => {
					const result = await (client.query as any)(...args);
					await run(typeof args[0] === 'string' ? args[0] : args[0].text, client);
					return result;
				};
				const value = Reflect.get(object, key);
				return typeof value === 'function' ? value.bind(object) : value;
			}
		});
	} } as pg.Pool;
}

(url ? describe : describe.skip)('PostgreSQL cursor CSV', () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: url, max: 3, statement_timeout: 5000 });
		exports = new pg.Pool({
			connectionString: url, max: 1, statement_timeout: 5000,
			query_timeout: 6000, connectionTimeoutMillis: 2000
		});
		await pool.query(`create schema ${ident(namespace)}`);
		created = true;
		await pool.query(`create table ${tableSql('rows')} (id int, value text);
			insert into ${tableSql('rows')} select i, 'value' from generate_series(1, 1301) i`);
	});

	afterAll(async () => {
		try {
			if (created) await pool.query(`drop schema ${ident(namespace)} cascade`);
		} finally {
			await exports?.end();
			await pool?.end();
		}
	});

	test('exact text, hostile identifiers, NULL/empty, formulas and all rows across bounded chunks', async () => {
		const name = '../é"\r\nx';
		const columns = ['__proto__', 'n', 'stamp', 'json', 'bytes', 'array', 'null', 'empty', 'quoted,"\r\n'];
		await pool.query(`create table ${tableSql(name)} (
			"__proto__" bigint, n numeric, stamp timestamp(6), json json, bytes bytea,
			"array" text[], "null" text, empty text, ${ident(columns.at(-1)!)} text)`);
		const exact = [
			'9007199254740993', '12345678901234567890.12345678901234567890',
			'2024-02-29 12:34:56.123456', '{ "n": 9007199254740993, "n": 2 }',
			'\\x00ff', '{"a,b","quote\\"",""}', null, '', '=SUM(A1)\r\n"雪",\rtrail'
		];
		await pool.query(`insert into ${tableSql(name)} select $1,$2,$3,$4,$5,$6,$7,$8,$9
			from generate_series(1, 1301)`, exact);
		let fetches = 0;
		const wrapped = interleaved(async (sql, client) => {
			if (sql.startsWith('fetch forward 256')) fetches++;
			if (sql.startsWith('declare')) {
				expect((await client.query('show transaction_read_only')).rows[0].transaction_read_only).toBe('on');
			}
		});
		const stream = await exportCsv(wrapped, target(name));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetches).toBe(0, 'header backpressure prevents speculative data fetches');
		const reader = stream.getReader();
		let output = '';
		let chunks = 0;
		const decoder = new TextDecoder();
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			output += decoder.decode(next.value, { stream: true });
			chunks++;
		}
		output += decoder.decode();
		expect(output).toBe(csv(columns) + csv(exact).repeat(1301));
		expect(chunks).toBe(7);
		expect(fetches).toBe(7);
		expect(await read(await exportCsv(exports, { ...target(name), columns: [columns.at(-1)!, '__proto__', 'null', 'empty'] }))).toBe(
			csv(['__proto__', 'null', 'empty', columns.at(-1)!]) + csv([exact[0], null, '', exact.at(-1)!]).repeat(1301)
		);
		expect(exports.idleCount).toBe(1);
	});

	test('cursor snapshot excludes later inserts; empty tables have a header, zero columns fail before streaming', async () => {
		await pool.query(`create table ${tableSql('snapshot')} (v text);
			insert into ${tableSql('snapshot')} values ('before');
			create table ${tableSql('empty')} ("__proto__" text); create table ${tableSql('zero')} ()`);
		const stream = await exportCsv(exports, { ...target('snapshot'), query: {
			sort: [{ column: 'v', direction: 'asc' }], search: '',
			filters: [{ column: 'v', operator: 'neq', value: 'excluded' }]
		} });
		await pool.query(`insert into ${tableSql('snapshot')} values ('after')`);
		expect(await read(stream)).toBe('"v"\r\n"before"\r\n');
		expect(await read(await exportCsv(exports, target('empty')))).toBe('"__proto__"\r\n');
		await expect(exportCsv(exports, target('zero'))).rejects.toThrow('Zero-column');
		await expect(exportCsv(exports, target('missing'))).rejects.toThrow('does not exist');
		expect(exports.idleCount).toBe(1);
	});

	test('filtered CSV matches grid ordering across all pages, including exact FK tuples and native comparisons', async () => {
		await pool.query(`create table ${tableSql('filtered')} (
			"__proto__" int primary key, bucket int, n numeric, note text, uid uuid);
			insert into ${tableSql('filtered')} select i, i % 2,
				case when i % 7 <> 0 then 9007199254740993.123456789 + (i % 5) end,
				case when i % 11 = 0 then '' else 'quote''雪' end, null
			from generate_series(1, 3101) i`);
		const query: RowQuery = {
			sort: [{ column: 'n', direction: 'desc' }, { column: 'note', direction: 'asc' }], search: '',
			filter: { bucket: '1' }, filters: [
				{ column: '__proto__', operator: 'gte', value: '201' },
				{ column: '__proto__', operator: 'lte', value: '2800' },
				{ column: 'note', operator: 'ilike', value: "%quote'雪%" }
			]
		};
		const expected = await pool.query<(string | null)[]>({
			text: `select * from ${tableSql('filtered')} where bucket = 1 and "__proto__" between 201 and 2800
				and note ilike '%quote''雪%' order by n desc nulls last, note asc nulls last, "__proto__" asc`,
			rowMode: 'array', types: { getTypeParser: () => (v: string) => v }
		});
		expect(expected.rows.length).toBeGreaterThan(1000);
		const header = csv(expected.fields.map((field) => field.name));
		expect(await read(await exportCsv(exports, { ...target('filtered'), query }))).toBe(
			header + expected.rows.map(csv).join('')
		);
		// Selection order is table order, and omitted sort/filter columns still affect rows.
		expect(await read(await exportCsv(exports, { ...target('filtered'), query, columns: ['note', '__proto__'] }))).toBe(
			csv(['__proto__', 'note']) + expected.rows.map((row) => csv([row[0], row[3]])).join('')
		);
		await expect(exportCsv(exports, { ...target('filtered'), columns: ['missing'] })).rejects.toThrow('Unknown column');
		const grid: (string | null)[][] = [];
		for (let page = 0; ; page++) {
			const result = await listRows(pool, { ...target('filtered'), ...query, page, pageSize: 100 });
			grid.push(...result.rows.map((row) => expected.fields.map((field) => row.values[field.name])));
			if (!result.hasMore) break;
		}
		expect(grid).toEqual(expected.rows);
		const exact: RowQuery = { search: '', sort: [], filter: JSON.parse('{"__proto__":"201","bucket":"1"}') };
		expect(await read(await exportCsv(exports, { ...target('filtered'), query: exact }))).toBe(
			header + csv(expected.rows.find((row) => row[0] === '201')!)
		);
		const none: RowQuery = { search: '', sort: [], filters: [{ column: 'note', operator: 'eq', value: "x' OR true --" }] };
		expect(await read(await exportCsv(exports, { ...target('filtered'), query: none }))).toBe(header);
		expect(await read(await exportCsv(exports, { ...target('filtered'), query: none, columns: ['uid'] }))).toBe('"uid"\r\n');
		for (const [column, value, error] of [
			['uid', 'not-a-uuid', 'invalid input syntax for type uuid'],
			['missing', '1', 'Unknown column']
		]) {
			await expect(exportCsv(exports, { ...target('filtered'), query: {
				search: '', sort: [], filters: [{ column, operator: 'eq', value }]
			} })).rejects.toThrow(error);
		}
		await expect(exportCsv(exports, { ...target('filtered'), query: {
			search: '', sort: [{ column: 'missing', direction: 'asc' }]
		} })).rejects.toThrow('Invalid sort column');
		expect(exports.idleCount).toBe(1);
	});

	test('export retains the grid connection search path for custom operators and exact FK comparisons', async () => {
		await pool.query(`create function ${tableSql('case_equal')}(text, text) returns boolean
			language sql immutable as 'select pg_catalog.lower($1) operator(pg_catalog.=) pg_catalog.lower($2)';
			create operator ${ident(namespace)}.= (
				function = ${tableSql('case_equal')}, leftarg = text, rightarg = text);
			create table ${tableSql('operators')} (value text);
			insert into ${tableSql('operators')} values ('Alice'), ('alice'), ('Bob')`);
		const custom = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace},pg_catalog`, max: 1 });
		try {
			for (const query of [
				{ search: '', sort: [], filters: [{ column: 'value', operator: 'eq', value: 'alice' }] },
				{ search: '', sort: [], filter: { value: 'alice' } }
			] satisfies RowQuery[]) {
				const grid = await listRows(custom, { ...target('operators'), ...query, page: 0, pageSize: 100 });
				expect(grid.rows.map((row) => row.values.value)).toEqual(['Alice', 'alice']);
				expect(await read(await exportCsv(custom, { ...target('operators'), query }))).toBe(
					'"value"\r\n"Alice"\r\n"alice"\r\n'
				);
			}
			expect((await custom.query('show search_path')).rows[0].search_path).toBe(`${namespace},pg_catalog`);
		} finally { await custom.end(); }
	});

	test('nonowner SELECT-only role respects RLS and permission failures are pre-stream', async () => {
		const role = `${namespace}_reader`;
		let roleCreated = false;
		let reader: pg.Pool | undefined;
		try {
			await pool.query(`create role ${ident(role)}`);
			roleCreated = true;
			await pool.query(`grant usage on schema ${ident(namespace)} to ${ident(role)};
				create table ${tableSql('rls')} (id int);
				insert into ${tableSql('rls')} select i from generate_series(1, 1301) i;
				alter table ${tableSql('rls')} enable row level security;
				alter table ${tableSql('rls')} force row level security;
				create policy visible on ${tableSql('rls')} to ${ident(role)} using (id % 2 = 0);
				grant select on ${tableSql('rls')} to ${ident(role)}`);
			reader = new pg.Pool({ connectionString: url, options: `-c role=${role}`, max: 1 });
			expect(await read(await exportCsv(reader, target('rls')))).toBe(
				'"id"\r\n' + Array.from({ length: 650 }, (_, i) => csv([String((i + 1) * 2)])).join('')
			);
			expect(await read(await exportCsv(reader, { ...target('rls'), query: {
				search: '', sort: [{ column: 'id', direction: 'desc' }],
				filters: [{ column: 'id', operator: 'lt', value: '10' }]
			} }))).toBe('"id"\r\n"8"\r\n"6"\r\n"4"\r\n"2"\r\n');
			await expect(exportCsv(reader, target('rows'))).rejects.toThrow('permission denied');
			expect(reader.idleCount).toBe(1);
		} finally {
			await reader?.end();
			if (roleCreated) {
				await pool.query(`drop policy if exists visible on ${tableSql('rls')};
					drop owned by ${ident(role)}; drop role ${ident(role)}`);
			}
		}
	});

	test('cancellation and request abort release only the leased client, including blocked initial lock', async () => {
		const cancelled = await exportCsv(exports, target('rows'));
		await cancelled.cancel();
		expect(exports.totalCount).toBe(0);
		const controller = new AbortController();
		const stream = await exportCsv(exports, target('rows'), controller.signal);
		controller.abort();
		await expect(read(stream)).rejects.toThrow('aborted');
		expect(exports.totalCount).toBe(0);
		const blocker = await pool.connect();
		try {
			await blocker.query(`begin; lock table ${tableSql('rows')} in access exclusive mode`);
			const abort = new AbortController();
			const pending = exportCsv(exports, target('rows'), abort.signal);
			setTimeout(() => abort.abort(), 50);
			await expect(pending).rejects.toThrow();
			expect(exports.totalCount).toBe(0);
		} finally {
			await blocker.query('rollback');
			blocker.release();
		}
		expect(await read(await exportCsv(exports, target('empty')))).toBe('"__proto__"\r\n');
	});

	test('midstream query errors break the stream and return a rolled-back lease', async () => {
		let fetches = 0;
		const wrapped = interleaved(async (sql, client) => {
			if (sql.startsWith('fetch forward 256') && ++fetches === 2) {
				await client.query('select 1 / 0');
			}
		});
		const stream = await exportCsv(wrapped, target('rows'));
		await expect(read(stream)).rejects.toThrow('division by zero');
		// Acquiring the sole slot also waits for error cleanup; no active transaction leaks.
		expect((await exports.query('show transaction_read_only')).rows[0].transaction_read_only).toBe('off');
	});

	test('abort interrupts an in-flight fetch and a broken idle lease errors rather than finishing CSV', async () => {
		const controller = new AbortController();
		let began!: () => void;
		const fetching = new Promise<void>((resolve) => { began = resolve; });
		const wrapped = interleaved(async (sql, client) => {
			if (!sql.startsWith('fetch forward 256')) return;
			began();
			await client.query('select pg_sleep(10)');
		});
		const stream = await exportCsv(wrapped, target('rows'), controller.signal);
		const reader = stream.getReader();
		await reader.read(); // Header; the next pull enters the blocked query.
		const pending = reader.read().then(() => null, (error) => error);
		await fetching;
		controller.abort();
		expect((await pending).name).toBe('AbortError');
		expect(exports.totalCount).toBe(0);

		let pid = 0;
		const tracked = interleaved(async (sql, client) => {
			if (sql.startsWith('declare')) pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
		});
		const broken = await exportCsv(tracked, target('rows'));
		const removed = new Promise<void>((resolve) => exports.once('remove', () => resolve()));
		await pool.query('select pg_terminate_backend($1)', [pid]);
		await expect(read(broken)).rejects.toThrow();
		await removed;
		expect(exports.totalCount).toBe(0);
	});

	test('table replacement and namespace replacement/rename-back cannot silently retarget the cursor', async () => {
		for (const boundary of ['before-lock', 'before-declare', 'after-declare', 'restore']) {
			const original = `${namespace}_race`;
			const moved = `${namespace}_moved`;
			const replacement = `${namespace}_other`;
			try {
				await pool.query(`create schema ${ident(original)};
					create table ${qualify(original, 't')} (v text);
					insert into ${qualify(original, 't')} values ('original')`);
				let catalogs = 0;
				let changed = false;
				const wrapped = interleaved(async (sql) => {
					if (sql.includes('from pg_class c join pg_namespace')) catalogs++;
					const atBoundary = boundary === 'before-lock' ? catalogs === 1
						: boundary === 'before-declare' ? catalogs === 2
						: sql.startsWith('declare');
					if (changed || !atBoundary) return;
					changed = true;
					await pool.query(`alter schema ${ident(original)} rename to ${ident(moved)};
						create schema ${ident(original)}; create table ${qualify(original, 't')} (v text);
						insert into ${qualify(original, 't')} values ('replacement')`);
					if (boundary === 'restore') {
						await pool.query(`alter schema ${ident(original)} rename to ${ident(replacement)};
							alter schema ${ident(moved)} rename to ${ident(original)}`);
					}
				});
				await expect(exportCsv(wrapped, { ...target('t', original), query: {
					search: '', sort: [{ column: 'v', direction: 'asc' }]
				} })).rejects.toThrow('changed');
				expect(changed).toBe(true);
			} finally {
				for (const schema of [original, moved, replacement]) {
					await pool.query(`drop schema if exists ${ident(schema)} cascade`);
				}
			}
		}
		await pool.query(`create table ${tableSql('replaced')} (v text)`);
		let changed = false;
		const wrapped = interleaved(async (sql) => {
			if (changed || !sql.includes('from pg_class c join pg_namespace')) return;
			changed = true;
			await pool.query(`drop table ${tableSql('replaced')}; create table ${tableSql('replaced')} (v text)`);
		});
		await expect(exportCsv(wrapped, target('replaced'))).rejects.toThrow('changed');
	});
});
