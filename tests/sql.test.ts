import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { SqlSessions } from '../src/lib/server/sql.ts';
import { SQL_MAX_BYTES, SQL_MAX_LENGTH, SQL_MAX_RESULTS, SQL_MAX_ROWS } from '../src/lib/sql.ts';

const url = process.env.TEST_DATABASE_URL;
const redact = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll('secret-marker', '[redacted]');
const managers: SqlSessions[] = [];
function manager(config: pg.ClientConfig = { connectionString: url }) {
	const sessions = new SqlSessions(config, redact);
	managers.push(sessions);
	return sessions;
}
function run(sessions: SqlSessions, session: string, sql: string, id = crypto.randomUUID()) {
	return sessions.run({ session, sql, run: id });
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
	let release!: () => void;
	return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}
// Instrument just this manager's next client, leaving pg's actual wire protocol intact.
function nextClient(sessions: SqlSessions, change: (client: pg.Client) => void) {
	const internal = sessions as unknown as { client(): pg.Client };
	const create = internal.client.bind(sessions);
	internal.client = () => {
		internal.client = create;
		const client = create();
		change(client);
		return client;
	};
}

afterEach(() => {
	for (const sessions of managers.splice(0)) sessions.dispose();
});

test('defensive validation, unknown IDs, idempotent close and permanent disposal', async () => {
	const sessions = manager({ host: 'not-used' });
	for (const sql of ['', ' ', '\0', 'x'.repeat(SQL_MAX_LENGTH + 1)]) {
		await expect(run(sessions, 'missing', sql)).rejects.toThrow('SQL must');
	}
	await expect(run(sessions, 'missing', 'select 1', '')).rejects.toThrow('run ID');
	await expect(run(sessions, 'missing', 'select 1')).rejects.toThrow('Unknown or closed');
	await expect(sessions.cancel({ session: 'missing', run: 'x' })).rejects.toThrow('Unknown or closed');
	sessions.close('missing');
	sessions.dispose();
	sessions.dispose();
	await expect(sessions.open()).rejects.toThrow('disposed');
});

(url ? describe : describe.skip)('SQL console on isolated PostgreSQL fixtures', () => {
	const schema = `sb_sql_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
	const table = `"${schema}".writes`;
	let pool: pg.Pool;
	let created = false;
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: url, max: 3, statement_timeout: 5000 });
		await pool.query(`create schema "${schema}"; create table ${table} (id text primary key)`);
		created = true;
	});
	afterAll(async () => {
		try { if (created) await pool.query(`drop schema "${schema}" cascade`); }
		finally { await pool?.end(); }
	});

	test('exact positional text, duplicate names, empty SELECT, commands, dollar quotes and multiple results', async () => {
		const sessions = manager();
		const { session, transaction } = await sessions.open();
		expect(transaction).toBe('idle');
		const result = await run(sessions, session, `-- semicolons are not a parser boundary here
			select 9007199254740993::bigint as x, 123456789.123456789::numeric as x,
			'{ "n": 9007199254740993, "n": 2 }'::json as "__proto__", null::text,
			array['a,b', ''] as a, '2024-02-29 12:34:56.123456'::timestamp,
			$$semi;colon ' quote$$ as text;
			select 1 as empty where false;
			create temp table t(v text);
			do $body$ begin raise notice 'notice;inside'; end $body$;
			insert into t values ('a'), ('b') returning v; select * from t order by v;`);
		expect(result.error).toBeNull();
		expect(result.transaction).toBe('idle');
		expect(result.results.map((r) => r.command)).toEqual(['SELECT', 'SELECT', 'CREATE', 'DO', 'INSERT', 'SELECT']);
		expect(result.results[0].fields.slice(0, 3).map((f) => f.name)).toEqual(['x', 'x', '__proto__']);
		expect(result.results[0].rows).toEqual([[
			'9007199254740993', '123456789.123456789', '{ "n": 9007199254740993, "n": 2 }',
			null, '{"a,b",""}', '2024-02-29 12:34:56.123456', "semi;colon ' quote"
		]]);
		expect(result.results[1]).toMatchObject({ fields: [{ name: 'empty', typeOid: 23 }], rows: [], rowCount: 0 });
		expect(result.results[4].rowCount).toBe(2);
		expect(result.notices).toEqual(['notice;inside']);
		expect(result.truncated).toBe(false);
		expect((await run(sessions, session, '-- comment only')).results).toEqual([]);
	});

	test('row/result/UTF-8 byte/notice bounds truncate previews without cancelling writes', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		const rows = await run(sessions, session, `create temp table bounded(v int);
			insert into bounded select generate_series(1, ${SQL_MAX_ROWS + 50}) returning v; select count(*) from bounded`);
		expect(rows.error).toBeNull();
		expect(rows.results[1].rows).toHaveLength(SQL_MAX_ROWS);
		expect(rows.results[1].rowCount).toBe(SQL_MAX_ROWS + 50);
		expect(rows.results[1].truncated).toBe(true);
		expect(rows.results[2].rows).toEqual([[String(SQL_MAX_ROWS + 50)]]);
		const bytes = await run(sessions, session, `select repeat('雪', 10000) from generate_series(1, 200); insert into bounded values (9999)`);
		expect(bytes.error).toBeNull();
		expect(bytes.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(bytes))).toBeLessThan(SQL_MAX_BYTES);
		expect((await run(sessions, session, 'select count(*) from bounded')).results[0].rows).toEqual([[String(SQL_MAX_ROWS + 51)]]);
		const many = await run(sessions, session, 'select 1 where false;'.repeat(SQL_MAX_RESULTS + 10) + 'insert into bounded values (10000)');
		expect(many.error).toBeNull();
		expect(many.results).toHaveLength(SQL_MAX_RESULTS);
		expect(many.truncated).toBe(true);
		expect((await run(sessions, session, 'select count(*) from bounded')).results[0].rows).toEqual([[String(SQL_MAX_ROWS + 52)]]);
		const notices = await run(sessions, session, `do $$ begin for i in 1..100 loop raise notice '%', repeat('雪', 20000); end loop; end $$`);
		expect(notices.error).toBeNull();
		expect(notices.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(notices))).toBeLessThan(SQL_MAX_BYTES);
		const hugeError = await run(sessions, session, `select repeat('x', 1900) from generate_series(1, 1000);
			do $$ begin raise exception '%', repeat('雪', 1000000); end $$`);
		expect(hugeError.error).toContain('[error truncated]');
		expect(Buffer.byteLength(JSON.stringify(hugeError))).toBeLessThan(SQL_MAX_BYTES);
	});

	test('error reservation covers JSON control-character escaping', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		const result = await run(sessions, session, `select repeat('x', 1930) from generate_series(1, 999);
			do $$ begin raise exception '%', repeat(chr(1), 20000); end $$`);
		expect(result.error).toContain('[error truncated]');
		expect(result.transaction).toBe('idle');
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(SQL_MAX_BYTES);
	});

	test('startup forces UTF8 despite client/env/role defaults and labels SQL connections', async () => {
		const role = `${schema}_encoding`;
		let roleCreated = false;
		const previous = process.env.PGCLIENTENCODING;
		try {
			await pool.query(`create role "${role}" login password 'sql-encoding-test';
				alter role "${role}" set client_encoding = 'LATIN1'`);
			roleCreated = true;
			const configUrl = new URL(url!);
			configUrl.username = role;
			configUrl.password = 'sql-encoding-test';
			configUrl.searchParams.set('client_encoding', 'LATIN1');
			configUrl.searchParams.set('application_name', 'overridden');
			process.env.PGCLIENTENCODING = 'LATIN1';
			const sessions = manager({
				connectionString: configUrl.toString(), client_encoding: 'LATIN1',
				options: '-c client_encoding=LATIN1', application_name: 'overridden'
			});
			const { session } = await sessions.open();
			const result = await run(sessions, session, "show client_encoding; show application_name; select 'é雪' as exact");
			expect(result.error).toBeNull();
			expect(result.results.map((r) => r.rows)).toEqual([[['UTF8']], [['superbase SQL']], [['é雪']]]);
			sessions.dispose();
		} finally {
			if (previous === undefined) delete process.env.PGCLIENTENCODING;
			else process.env.PGCLIENTENCODING = previous;
			if (roleCreated) await pool.query(`drop role "${role}"`);
		}
	});

	test('encoding changes close the session and discard same-buffer previews before any later run', async () => {
		for (const sql of [
			'set client_encoding = LATIN1',
			"select 'before'; set client_encoding = LATIN1; select 'é'; do $$ begin raise notice 'é'; end $$"
		]) {
			const sessions = manager();
			const { session } = await sessions.open();
			const result = await run(sessions, session, sql);
			expect(result.error).toContain('Unsupported client encoding');
			expect(result.error).toContain('outcome unknown');
			expect(result.transaction).toBe('closed');
			expect(result.results).toEqual([]);
			expect(result.notices).toEqual([]);
			await expect(run(sessions, session, `insert into ${table} values ('é')`)).rejects.toThrow('Unknown or closed');
		}
		expect((await pool.query(`select id from ${table} where id in ('é', 'Ã©')`)).rows).toEqual([]);
	});

	test('binary cursors retire the session without returning buffered binary rows; text cursors remain exact', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		const binary = await run(sessions, session, `begin; select 'before';
			declare c binary cursor for select 123456::integer;
			fetch all from c; rollback; select 'after'`);
		expect(binary.error).toContain('Binary SQL results are unsupported');
		expect(binary.transaction).toBe('closed');
		expect(binary.results.flatMap((r) => r.rows)).toEqual([['before']]);
		await expect(run(sessions, session, 'select 1')).rejects.toThrow('Unknown or closed');
		const fresh = (await sessions.open()).session;
		const text = await run(sessions, fresh, `begin;
			declare c cursor for select 123456::integer, 'é雪' as exact;
			fetch all from c; rollback`);
		expect(text.error).toBeNull();
		expect(text.transaction).toBe('idle');
		expect(text.results.flatMap((r) => r.rows)).toEqual([['123456', 'é雪']]);
	});

	test('metadata also fits the aggregate budget, and pg retains only the current result', async () => {
		const sessions = manager();
		let query: unknown;
		nextClient(sessions, (client) => {
			const original = client.query.bind(client);
			client.query = ((value: unknown) => { query = value; return original(value as pg.Query); }) as typeof client.query;
		});
		const { session } = await sessions.open();
		const columns = Array.from({ length: 1000 }, (_, i) => `1 as "${String(i).padStart(63, 'a')}"`).join(',');
		expect((await run(sessions, session, `create temp view wide as select ${columns} where false`)).error).toBeNull();
		const result = await run(sessions, session, 'select * from wide;'.repeat(40));
		expect(result.error).toBeNull();
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(SQL_MAX_BYTES);
		expect(Array.isArray((query as { _results: unknown })._results)).toBe(false);
	});

	test('ReadyForQuery reports failed transactions, rollback recovery and prior explicit commits honestly', async () => {
		const sessions = manager();
		let holdReady = false;
		const arrived = gate();
		const release = gate();
		nextClient(sessions, (client) => {
			const emit = client.connection.emit.bind(client.connection);
			client.connection.emit = (event: string | symbol, ...args: unknown[]) => {
				if (event === 'readyForQuery' && holdReady) {
					holdReady = false;
					arrived.release();
					void release.promise.then(() => emit(event, ...args));
					return true;
				}
				return emit(event, ...args);
			};
		});
		const { session } = await sessions.open();
		expect((await run(sessions, session, 'begin')).transaction).toBe('transaction');
		holdReady = true;
		let finished = false;
		const pending = run(sessions, session, 'select 1 / 0').then((result) => { finished = true; return result; });
		await arrived.promise;
		expect(finished).toBe(false);
		await expect(run(sessions, session, 'select 1')).rejects.toThrow('busy');
		release.release();
		const failed = await pending;
		expect(failed.error).toContain('division by zero');
		expect(failed.transaction).toBe('failed');
		expect((await run(sessions, session, 'select 1')).transaction).toBe('failed');
		expect((await run(sessions, session, 'rollback')).transaction).toBe('idle');
		const committed = await run(sessions, session, `begin; insert into ${table} values ('committed'); commit; select 10/x from (values (1),(0)) as v(x)`);
		expect(committed.results.map((r) => r.command)).toEqual(['BEGIN', 'INSERT', 'COMMIT', '']);
		expect(committed.error).toContain('division by zero');
		expect(committed.transaction).toBe('idle');
		expect((await pool.query(`select id from ${table} where id = 'committed'`)).rowCount).toBe(1);
		const redacted = await run(sessions, session, `do $$ begin raise exception 'secret-marker'; end $$`);
		expect(redacted.error).toBe('[redacted]');
		expect((await run(sessions, session, '\\dt')).error).toContain('syntax error');
	});

	test('dedicated sessions preserve SET/temp state but do not share it', async () => {
		const sessions = manager();
		const a = (await sessions.open()).session;
		const b = (await sessions.open()).session;
		await run(sessions, a, "set application_name = 'tab-a'; create temp table local_only(v int); insert into local_only values (7)");
		expect((await run(sessions, a, 'select * from local_only')).results[0].rows).toEqual([['7']]);
		expect((await run(sessions, a, 'show application_name')).results[0].rows).toEqual([['tab-a']]);
		expect((await run(sessions, b, 'select * from local_only')).error).toContain('does not exist');
		expect((await run(sessions, b, 'show application_name')).results[0].rows).not.toEqual([['tab-a']]);
		expect((await run(sessions, a, 'show statement_timeout; show idle_in_transaction_session_timeout')).results.map((r) => r.rows)).toEqual([[['30s']], [['5min']]]);
	});

	test('concurrent work rejects, real cancellation recovers, stale/idle cancels never affect later runs', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		const id = crypto.randomUUID();
		const pending = run(sessions, session, 'select pg_sleep(10)', id);
		await expect(run(sessions, session, 'select 2')).rejects.toThrow('busy');
		await delay(30);
		await sessions.cancel({ session, run: id });
		const result = await pending;
		expect(result.error).toContain('canceling statement');
		expect(result.transaction).toBe('idle');
		await sessions.cancel({ session, run: id });
		const later = run(sessions, session, 'select pg_sleep(0.05), 42');
		await sessions.cancel({ session, run: id });
		expect((await later).error).toBeNull();
	});

	test('a slow cancellation connection fences busy until completion and rechecks the run after connecting', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		const ready = gate();
		const release = gate();
		nextClient(sessions, (client) => {
			const connect = client.connect.bind(client);
			client.connect = (async () => { await connect(); ready.release(); await release.promise; return client; }) as typeof client.connect;
		});
		const id = crypto.randomUUID();
		const pending = run(sessions, session, 'select pg_sleep(0.1)', id);
		const cancel = sessions.cancel({ session, run: id });
		await ready.promise;
		await delay(200);
		await expect(run(sessions, session, 'select 2')).rejects.toThrow('busy');
		release.release();
		await cancel;
		expect((await pending).error).toBeNull();
		expect((await run(sessions, session, 'select pg_sleep(0.05), 3')).error).toBeNull();
	});

	test('cancel connection failures release busy safely', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		nextClient(sessions, (client) => {
			client.connect = (async () => { throw new Error('cancel connection unavailable'); }) as typeof client.connect;
		});
		const id = crypto.randomUUID();
		const pending = run(sessions, session, 'select pg_sleep(0.05)', id);
		await expect(sessions.cancel({ session, run: id })).rejects.toThrow('unavailable');
		expect((await pending).error).toBeNull();
		expect((await run(sessions, session, 'select 1')).error).toBeNull();
	});

	test('dispose closes pending cancellation sockets as well as the executing session', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		const connected = gate();
		const release = gate();
		let cancellationClient!: pg.Client;
		nextClient(sessions, (client) => {
			cancellationClient = client;
			const connect = client.connect.bind(client);
			client.connect = (async () => { await connect(); connected.release(); await release.promise; return client; }) as typeof client.connect;
		});
		const id = crypto.randomUUID();
		const pending = run(sessions, session, 'select pg_sleep(0.1)', id);
		const cancellation = sessions.cancel({ session, run: id });
		await connected.promise;
		sessions.dispose();
		expect(cancellationClient.connection.stream.destroyed).toBe(true);
		release.release();
		await cancellation;
		expect((await pending).transaction).toBe('closed');
	});

	test('application wall timer destroys sessions even after SQL disables the server timeout', async () => {
		const sessions = manager();
		const { session } = await sessions.open();
		await run(sessions, session, 'set statement_timeout = 0');
		const original = globalThis.setTimeout;
		let wall!: NodeJS.Timeout & { _onTimeout(): void };
		let pending!: ReturnType<typeof run>;
		try {
			globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
				const timer = original(...args);
				if (args[1] === 60_000) wall = timer as typeof wall;
				return timer;
			}) as typeof setTimeout;
			pending = run(sessions, session, 'select pg_sleep(0.1)');
		} finally {
			globalThis.setTimeout = original;
		}
		expect(wall.hasRef()).toBe(false);
		wall._onTimeout();
		const result = await pending;
		expect(result.error).toContain('60-second wall-time');
		expect(result.transaction).toBe('closed');
		await expect(run(sessions, session, 'select 1')).rejects.toThrow('Unknown or closed');
	});

	test('close/dispose roll back transactions and lost connections return closed with unknown outcome', async () => {
		const sessions = manager();
		const a = (await sessions.open()).session;
		await run(sessions, a, `begin; insert into ${table} values ('close-rollback')`);
		sessions.close(a);
		sessions.close(a);
		await expect(run(sessions, a, 'select 1')).rejects.toThrow('Unknown or closed');
		const b = (await sessions.open()).session;
		await run(sessions, b, `begin; insert into ${table} values ('dispose-rollback')`);
		// PostgreSQL notices a severed socket at its next socket check, not necessarily mid-sleep.
		const pending = run(sessions, b, 'select pg_sleep(0.1)');
		sessions.dispose();
		expect((await pending).transaction).toBe('closed');
		await pool.query(`set lock_timeout = '2s'; insert into ${table} values ('close-rollback'), ('dispose-rollback')`);
		const fresh = manager();
		const c = (await fresh.open()).session;
		const pid = (await run(fresh, c, 'select pg_backend_pid()')).results[0].rows[0][0];
		const lost = run(fresh, c, 'select pg_sleep(10)');
		await pool.query('select pg_terminate_backend($1)', [pid]);
		const result = await lost;
		expect(result.transaction).toBe('closed');
		expect(result.error).toContain('outcome unknown');
		await expect(run(fresh, c, 'select 1')).rejects.toThrow('Unknown or closed');
	});

	test('COPY IN and OUT fail explicitly and retire only the affected SQL session', async () => {
		for (const sql of ['copy (select 1) to stdout', `copy ${table} from stdin`]) {
			const sessions = manager();
			const { session } = await sessions.open();
			const result = await run(sessions, session, sql);
			expect(result.error).toContain('COPY STDIN/STDOUT is not supported');
			expect(result.transaction).toBe('closed');
			await expect(run(sessions, session, 'select 1')).rejects.toThrow('Unknown or closed');
		}
	});

	test('connecting clients count toward the limit, dispose cannot resurrect them, and idle expiry is terminal', async () => {
		const sessions = manager();
		const opened = Array.from({ length: 4 }, () => sessions.open());
		await expect(sessions.open()).rejects.toThrow('At most 4');
		const tabs = await Promise.all(opened);
		sessions.close(tabs[0].session);
		const tab = await sessions.open();
		const internal = sessions as unknown as { sessions: Map<string, { idle: NodeJS.Timeout & { _onTimeout(): void } }> };
		const timer = internal.sessions.get(tab.session)!.idle;
		expect(timer.hasRef()).toBe(false);
		timer._onTimeout();
		await expect(run(sessions, tab.session, 'select 1')).rejects.toThrow('Unknown or closed');
		const late = manager();
		const connected = gate();
		const release = gate();
		nextClient(late, (client) => {
			const connect = client.connect.bind(client);
			client.connect = (async () => { await connect(); connected.release(); await release.promise; return client; }) as typeof client.connect;
		});
		const opening = late.open();
		await connected.promise;
		late.dispose();
		release.release();
		await expect(opening).rejects.toThrow('closed while connecting');
		await expect(late.open()).rejects.toThrow('disposed');
	});
});
