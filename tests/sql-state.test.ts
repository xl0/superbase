import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';

// Compile the actual runes class with only its remote boundary replaced.
let serial = 0;
async function fixture() {
	const calls: { kind: string; args: any }[] = [];
	let execute: ((args: any) => Promise<any>) | undefined;
	let cancel: (() => Promise<void>) | undefined;
	const api = {
		openSql: async (args: any) => { calls.push({ kind: 'open', args }); return { session: 'session-1', transaction: 'idle' }; },
		runSql: async (args: any) => { calls.push({ kind: 'run', args }); return await execute?.(args) ?? result(); },
		cancelSql: async (args: any) => { calls.push({ kind: 'cancel', args }); await cancel?.(); },
		closeSql: async (args: any) => { calls.push({ kind: 'close', args }); }
	};
	const key = `__sqlTest${serial++}`;
	(globalThis as any)[key] = api;
	const source = (await readFile(new URL('../src/lib/state/sql.svelte.ts', import.meta.url), 'utf8'))
		.replace(/^import \{ cancelSql, closeSql, openSql, runSql \}.*$/m, `const { cancelSql, closeSql, openSql, runSql } = globalThis[${JSON.stringify(key)}];`)
		.replace("'#lib/sql.js'", JSON.stringify(new URL('../src/lib/sql.ts', import.meta.url).href))
		.replace("'#lib/utils.js'", JSON.stringify(new URL('../src/lib/utils.ts', import.meta.url).href));
	const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	const compiled = compileModule(js, { filename: 'sql.svelte.js', generate: 'client' }).js.code
		.replace(/(['"])svelte\/internal\/client\1/, JSON.stringify(import.meta.resolve('svelte/internal/client')));
	const { SqlState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
	delete (globalThis as any)[key];
	return { state: new SqlState('connection-1'), calls, execute: (fn: typeof execute) => execute = fn, cancel: (fn: typeof cancel) => cancel = fn };
}
const result = (transaction = 'idle', error: string | null = null) => ({ session: 'session-1', transaction, error, results: [], notices: [], truncated: false, durationMs: 1 });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => resolve = done);
	return { promise, resolve };
}

test('SQL drafts survive native errors and session reset; lost responses never auto-reconnect or replay', async () => {
	const { state: s, calls, execute } = await fixture();
	s.draft = 'BEGIN; SELECT 1 / 0;';
	execute(async () => result('failed', 'division by zero'));
	await s.run(s.draft);
	assert.equal(s.transaction, 'failed');
	assert.equal(s.draft, 'BEGIN; SELECT 1 / 0;');
	assert.equal(s.result.error, 'division by zero');
	assert.equal(s.protectedWork, true);
	execute(async () => { throw new Error('response lost'); });
	await s.run('ROLLBACK');
	assert.equal(s.needsReset, true);
	assert.match(s.error, /outcome is unknown/);
	await s.run('SELECT 1');
	assert.equal(calls.filter((c) => c.kind === 'run').length, 2);
	await s.reset();
	assert.equal(s.needsReset, false);
	assert.equal(s.session, null);
	assert.equal(s.draft, 'BEGIN; SELECT 1 / 0;');
	execute(async () => result());
	await s.run('SELECT 1');
	assert.equal(calls.filter((c) => c.kind === 'open').length, 2);
});

test('SQL execution snapshots selection and cancellation ID and blocks duplicates through cancellation', async () => {
	const { state: s, calls, execute, cancel } = await fixture();
	const gate = deferred(), cancelled = deferred();
	execute(async () => { await gate.promise; return result(); });
	cancel(() => cancelled.promise);
	s.draft = 'SELECT 1; SELECT 2;';
	const pending = s.run('SELECT 2;');
	await Promise.resolve();
	assert.equal(s.busy, true);
	s.draft = 'new draft';
	await s.run('never sent');
	const stopping = s.cancel();
	assert.deepEqual(calls.find((c) => c.kind === 'cancel')?.args, {
		connection: 'connection-1', session: 'session-1', run: calls.find((c) => c.kind === 'run')?.args.run
	});
	gate.resolve();
	await pending;
	await s.run('also never sent');
	assert.equal(calls.filter((c) => c.kind === 'run').length, 1);
	assert.equal(calls.find((c) => c.kind === 'run')?.args.sql, 'SELECT 2;');
	assert.equal(s.draft, 'new draft');
	cancelled.resolve();
	await stopping;
	assert.equal(s.cancelling, false);
});
