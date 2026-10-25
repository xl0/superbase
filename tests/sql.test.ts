import { afterEach, describe, expect, test } from 'bun:test';
import { SqlSessions } from '../src/lib/server/sql.ts';
import { SQL_MAX_ROWS } from '../src/lib/sql.ts';

const url = process.env.TEST_DATABASE_URL;
const managers: SqlSessions[] = [];
function open() {
	const sessions = new SqlSessions({ connectionString: url }, (error) => error instanceof Error ? error.message : String(error));
	managers.push(sessions);
	return sessions;
}
afterEach(() => { for (const sessions of managers.splice(0)) sessions.dispose(); });

(url ? describe : describe.skip)('SQL console sessions', () => {
	test('multi-statement buffers return exact text results, duplicate names and bounded previews', async () => {
		const sessions = open();
		const { session } = await sessions.open();
		const result = await sessions.run({ session, sql: `
			select 9007199254740993::numeric as n, '{"b":1, "a":2}'::json as doc, null as n;
			create temp table t(i int); insert into t select generate_series(1, ${SQL_MAX_ROWS + 500});
			select i from t;` });
		expect(result.error).toBeNull();
		expect(result.results.map((item) => item.command)).toEqual(['SELECT', 'CREATE', 'INSERT', 'SELECT']);
		expect(result.results[0].fields.map((field) => field.name)).toEqual(['n', 'doc', 'n']);
		expect(result.results[0].rows).toEqual([['9007199254740993', '{"b":1, "a":2}', null]]);
		expect(result.results[2].rowCount).toBe(SQL_MAX_ROWS + 500);
		expect(result.results[3].rows.length).toBe(SQL_MAX_ROWS);
		expect(result.results[3].truncated).toBe(true);
		expect(result.truncated).toBe(true);
	});

	test('transactions and session state span runs; errors report the native transaction status', async () => {
		const sessions = open();
		const { session } = await sessions.open();
		await sessions.run({ session, sql: 'create temp table t(i int)' });
		expect((await sessions.run({ session, sql: 'begin; insert into t values (1)' })).transaction).toBe('transaction');
		const failed = await sessions.run({ session, sql: 'select 1/0' });
		expect(failed.error).toMatch(/division by zero/);
		expect(failed.transaction).toBe('failed');
		expect((await sessions.run({ session, sql: 'rollback' })).transaction).toBe('idle');
		expect((await sessions.run({ session, sql: 'select count(*) from t' })).results[0].rows).toEqual([['0']]);
		// Earlier explicit commits in the same buffer survive a later error.
		const partial = await sessions.run({ session, sql: 'begin; insert into t values (2); commit; select 1/0;' });
		expect(partial.error).toMatch(/division by zero/);
		expect((await sessions.run({ session, sql: 'select count(*) from t' })).results[0].rows).toEqual([['1']]);
		const other = await sessions.open();
		expect((await sessions.run({ session: other.session, sql: 'select * from t' })).error).toMatch(/does not exist/);
	});

	test('cancel interrupts the running statement; closed sessions never reconnect', async () => {
		const sessions = open();
		const { session } = await sessions.open();
		const running = sessions.run({ session, sql: 'select pg_sleep(10)' });
		await Bun.sleep(200);
		await sessions.cancel(session);
		expect((await running).error).toMatch(/cancel/);
		await expect(sessions.run({ session, sql: 'select 1' })).resolves.toMatchObject({ error: null });
		sessions.close(session);
		await expect(sessions.run({ session, sql: 'select 1' })).rejects.toThrow(/closed/);
	});
});
