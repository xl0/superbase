import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';

// Compile the actual runes class with only its remote boundary replaced.
let serial = 0;
const connection = { id: 'connection-1', source: 'session', host: 'localhost', port: '5432', database: 'db', user: 'user' };
function storage(data = new Map<string, string>()) {
	return { data, getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
function browserFixture() {
	const held = new Set<string>();
	return { localStorage: storage(), sessionStorage: storage(), navigator: { locks: {
		async request(name: string, _options: unknown, callback: (lock: unknown) => unknown) {
			await Promise.resolve();
			if (held.has(name)) return callback(null);
			held.add(name);
			try { return await callback({ name }); } finally { held.delete(name); }
		}
	} } };
}
async function fixture(browser = browserFixture(), info = connection) {
	const calls: { kind: string; args: any }[] = [];
	let execute: ((args: any) => Promise<any>) | undefined;
	let cancel: (() => Promise<void>) | undefined;
	const api = {
		browser,
		openSql: async (args: any) => { calls.push({ kind: 'open', args }); return { session: 'session-1', transaction: 'idle' }; },
		runSql: async (args: any) => { calls.push({ kind: 'run', args }); return await execute?.(args) ?? result(); },
		cancelSql: async (args: any) => { calls.push({ kind: 'cancel', args }); await cancel?.(); },
		closeSql: async (args: any) => { calls.push({ kind: 'close', args }); }
	};
	const key = `__sqlTest${serial++}`;
	(globalThis as any)[key] = api;
	const source = (await readFile(new URL('../src/lib/state/sql.svelte.ts', import.meta.url), 'utf8'))
		.replace(/^import \{ cancelSql, closeSql, openSql, runSql \}.*$/m, `const { cancelSql, closeSql, openSql, runSql, browser } = globalThis[${JSON.stringify(key)}]; const { localStorage, sessionStorage, navigator } = browser;`)
		.replace("'#lib/sql.js'", JSON.stringify(new URL('../src/lib/sql.ts', import.meta.url).href))
		.replace("'#lib/utils.js'", JSON.stringify(new URL('../src/lib/utils.ts', import.meta.url).href));
	const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	const compiled = compileModule(js, { filename: 'sql.svelte.js', generate: 'client' }).js.code
		.replace(/(['"])svelte\/internal\/client\1/, JSON.stringify(import.meta.resolve('svelte/internal/client')));
	const { SqlState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
	delete (globalThis as any)[key];
	return { state: new SqlState(info), browser, calls, execute: (fn: typeof execute) => execute = fn, cancel: (fn: typeof cancel) => cancel = fn };
}
const result = (transaction = 'idle', error: string | null = null) => ({ session: 'session-1', transaction, error, results: [], notices: [], truncated: false, durationMs: 1 });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => resolve = done);
	return { promise, resolve };
}

test('SQL text restores across reloads/generations, stays database scoped, and never executes on restore', async () => {
	const first = await fixture();
	await first.state.restoreDraft();
	const text = "BEGIN; -- é雪\r\nSELECT 9007199254740993;\r";
	first.state.updateDraft(text);
	assert.equal(first.state.reloadBlocked, false);
	assert.equal(first.calls.length, 0);
	first.state.prepareReload();
	assert.equal(first.state.reloadBlocked, false);
	const other = await fixture(first.browser, { ...connection, id: 'new-generation', database: 'other' });
	await other.state.restoreDraft();
	assert.equal(other.state.draft, '');
	other.state.updateDraft('other database SQL');
	other.state.pauseDraft();
	const restored = await fixture(first.browser, { ...connection, id: 'newer-generation' });
	await restored.state.restoreDraft();
	assert.equal(restored.state.draft, text);
	assert.equal(restored.calls.length, 0);
	assert.equal(restored.state.session, null);
	assert.equal(restored.state.reloadBlocked, false);
	restored.state.session = 'live-session'; restored.state.transaction = 'idle';
	assert.equal(restored.state.reloadBlocked, false);
	assert.equal(restored.state.protectedWork, true, 'connection changes still warn about losing SQL session state');
	for (const status of ['transaction', 'failed', 'closed']) {
		restored.state.transaction = status;
		assert.equal(restored.state.reloadBlocked, true);
	}
	restored.state.transaction = 'idle';
	for (const flag of ['busy', 'cancelling']) {
		restored.state[flag] = true; assert.equal(restored.state.reloadBlocked, true); restored.state[flag] = false;
	}
	restored.state.updateDraft('');
	restored.state.pauseDraft();
	const cleared = await fixture(first.browser);
	await cleared.state.restoreDraft();
	assert.equal(cleared.state.draft, '');
	assert.equal(cleared.state.reloadBlocked, false);
	cleared.state.pauseDraft();
});

test('duplicated tab storage forks without overwriting either live draft', async () => {
	const first = await fixture();
	await first.state.restoreDraft();
	first.state.updateDraft('original');
	const cloneBrowser = { ...first.browser, sessionStorage: storage(new Map(first.browser.sessionStorage.data)) };
	const clone = await fixture(cloneBrowser);
	await clone.state.restoreDraft();
	assert.equal(clone.state.draft, 'original');
	assert.notEqual(cloneBrowser.sessionStorage.getItem('superbase.sql.tab'), first.browser.sessionStorage.getItem('superbase.sql.tab'));
	first.state.updateDraft('first tab'); clone.state.updateDraft('second tab');
	first.state.pauseDraft(); clone.state.pauseDraft();
	const a = await fixture(first.browser), b = await fixture(cloneBrowser);
	await a.state.restoreDraft(); await b.state.restoreDraft();
	assert.equal(a.state.draft, 'first tab'); assert.equal(b.state.draft, 'second tab');
	a.state.pauseDraft(); b.state.pauseDraft();
});

test('save/clear failures retain protection, and unread or externally changed drafts are never overwritten', async () => {
	const { state: s, browser } = await fixture();
	await s.restoreDraft(); s.updateDraft('saved');
	const key = [...browser.localStorage.data.keys()][0];
	const set = browser.localStorage.setItem;
	browser.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
	s.updateDraft('unsaved');
	assert.equal(s.reloadBlocked, true); assert.match(s.draftError, /could not be saved/);
	assert.equal(browser.localStorage.getItem(key), 'saved');
	s.checkDraft(); // A cancelled reload must not turn our failed save into an external conflict.
	assert.equal(s.reloadBlocked, true);
	browser.localStorage.setItem = set;
	s.updateDraft('retry'); assert.equal(s.reloadBlocked, false);
	const remove = browser.localStorage.removeItem;
	browser.localStorage.removeItem = () => { throw new Error('Denied'); };
	s.updateDraft(''); assert.equal(s.reloadBlocked, true);
	assert.equal(browser.localStorage.getItem(key), 'retry');
	browser.localStorage.removeItem = remove;
	s.updateDraft(''); assert.equal(s.reloadBlocked, false);
	s.updateDraft('kept'); s.pauseDraft();
	const get = browser.localStorage.getItem;
	browser.localStorage.getItem = () => { throw new Error('Denied'); };
	const unread = await fixture(browser);
	await unread.state.restoreDraft();
	assert.match(unread.state.draftError, /unavailable/);
	browser.localStorage.getItem = get;
	unread.state.updateDraft('memory only');
	assert.equal(unread.state.reloadBlocked, true);
	assert.equal(browser.localStorage.getItem(key), 'kept');
	unread.state.pauseDraft();
	const fresh = await fixture(browser);
	await fresh.state.restoreDraft();
	browser.localStorage.setItem(key, 'changed elsewhere');
	fresh.state.checkDraft(key); fresh.state.updateDraft('do not overwrite');
	assert.equal(fresh.state.reloadBlocked, true);
	assert.equal(browser.localStorage.getItem(key), 'changed elsewhere');
	fresh.state.pauseDraft();
});

test('suspended/retired restores cannot write; BFCache conflicts preserve both versions', async () => {
	const { state: s, browser } = await fixture();
	const pending = s.restoreDraft(); s.pauseDraft(); await pending;
	assert.equal(s.draftReady, false); assert.equal(browser.localStorage.data.size, 0);
	await s.restoreDraft(); s.updateDraft('cached text');
	const key = [...browser.localStorage.data.keys()][0];
	s.pauseDraft(); browser.localStorage.setItem(key, 'newer text');
	await s.restoreDraft(true);
	assert.equal(s.draft, 'cached text'); assert.equal(s.reloadBlocked, true);
	assert.match(s.draftError, /suspended/);
	s.updateDraft('still in memory'); assert.equal(browser.localStorage.getItem(key), 'newer text');
	s.prepareReload(); assert.equal(s.reloadBlocked, false);
	await s.restoreDraft(); assert.equal(browser.localStorage.getItem(key), 'newer text');
});

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
