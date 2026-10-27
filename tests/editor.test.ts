import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';
import type { Row, RowsPage, Table } from '../src/lib/types.ts';

// Compile the actual runes class, substituting only its remote I/O boundary.
let serial = 0;
async function fixture() {
	const calls: { kind: string; args: any }[] = [];
	let save: (() => Promise<void>) | undefined;
	let ddl: ((args: any) => Promise<void>) | undefined;
	let read: ((args: any) => Promise<{ rows: Row[]; hasMore: boolean }>) | undefined;
	const column = (name: string, primaryKey = false) => ({ name, primaryKey, type: 'text', kind: 'text' as const, nullable: !primaryKey, generated: false, identity: null, defaultValue: null });
	const tables: Table[] = ['a', 'b'].map((name) => ({ schema: 'public', name, kind: 'table' as const, rls: false, rowCount: 200, columns: [column('id', true), column('value'), column('__proto__'), column('constructor')] }));
	const row = (id: string, value = 'original'): Row => ({ key: id, values: { id, value }, identity: { pk: { id }, version: '1', relation: '123' } });
	const api = {
		database: () => ({ refresh: async () => {}, current: { tables, version: '18' } }),
		tableRows: (args: any) => {
			const resource = { current: null as any, refresh: async () => { resource.current = await (read?.(args) ?? Promise.resolve({ rows: [row(args.page ? '2' : '1')], hasMore: true })); } };
			return resource;
		},
		saveTable: async (args: any) => { calls.push({ kind: 'save', args: structuredClone(args) }); await save?.(); },
		deleteRows: async (args: any) => { calls.push({ kind: 'delete', args: structuredClone(args) }); },
		changeSchema: async (args: any) => { calls.push({ kind: 'schema', args: structuredClone(args) }); await ddl?.(args); }
	};
	const key = `__editorTest${serial++}`;
	(globalThis as any)[key] = api;
	let source = await readFile(new URL('../src/lib/state/editor.svelte.ts', import.meta.url), 'utf8');
	source = source.replace(/^import \{ database, deleteRows, saveTable, tableRows, changeSchema \}.*$/m, `const { database, deleteRows, saveTable, tableRows, changeSchema } = globalThis[${JSON.stringify(key)}];`)
		.replace("'#lib/types.js'", JSON.stringify(new URL('../src/lib/types.ts', import.meta.url).href))
		.replace("'#lib/utils.js'", JSON.stringify(new URL('../src/lib/utils.ts', import.meta.url).href));
	const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	const compiled = compileModule(js, { filename: 'editor.svelte.js', generate: 'client' }).js.code
		.replace(/(['"])svelte\/internal\/client\1/, JSON.stringify(import.meta.resolve('svelte/internal/client')));
	const { EditorState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
	delete (globalThis as any)[key];
	const editor = new EditorState();
	await editor.initialize('connection-1');
	return { editor, calls, tables, row, deferSave: (fn: () => Promise<void>) => save = fn, deferRead: (fn: typeof read) => read = fn, deferSchema: (fn: typeof ddl) => ddl = fn };
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test('table/page loads clear stale rows and reject out-of-order responses', async () => {
	const { editor: s, deferRead, row } = await fixture();
	const slow = deferred<{ rows: Row[]; hasMore: boolean }>();
	deferRead((args) => args.table === 'b' ? slow.promise : Promise.resolve({ rows: [row('latest')], hasMore: false }));
	const pending = s.selectTable('public', 'b');
	assert.equal(s.rows.length, 0);
	assert.equal(s.loading, true);
	await s.selectTable('public', 'a');
	slow.resolve({ rows: [row('stale')], hasMore: true }); await pending;
	assert.equal(s.rows[0].key, 'latest');
	assert.equal(s.hasMore, false);
});

test('sorting retains displayed rows, blocks writes and ignores superseded results', async () => {
	const { editor: s, deferRead, row, calls } = await fixture();
	await s.setPage(1);
	const old = s.rows[0];
	const slow = deferred<{ rows: Row[]; hasMore: boolean }>();
	deferRead(() => slow.promise);
	const sorting = s.toggleSort('value');
	assert.equal(s.rows[0].key, old.key);
	assert.equal(s.rowsPage, 1);
	assert.equal(s.loading, true);
	await assert.rejects(s.updateRows([{ row: old, values: { value: 'blocked' } }]), /not ready/);
	s.startInsert();
	assert.equal(s.inserting, false);
	assert.equal(calls.length, 0);
	deferRead(async () => ({ rows: [row('replacement')], hasMore: false }));
	await s.selectTable('public', 'b');
	slow.resolve({ rows: [row('old-sort')], hasMore: true });
	await sorting;
	assert.equal(s.rows[0].key, 'replacement');
	assert.equal(s.rowsPage, 0);
	assert.equal(s.loading, false);
});

test('schema changes send SQL, block work while running, and select the resulting table', async () => {
	const { editor: s, calls, tables, deferSchema, deferRead } = await fixture();
	s.toggleRowSelection(s.rows[0]);
	s.schemaEditing = true;
	await assert.rejects(s.updateRows([{ row: s.rows[0], values: { value: 'blocked' } }]), /not ready/);
	const pending = deferred();
	deferSchema(async () => { await pending.promise; tables[0].name = 'renamed'; });
	deferRead(async () => { throw new Error('read refresh failed'); });
	const saving = s.applySchema({ sql: 'alter table a rename to renamed;', select: { schema: 'public', table: 'renamed' } });
	assert.equal(s.busy, true);
	assert.equal(s.navigationBlocked, true);
	assert.deepEqual(calls[0].args, { connection: 'connection-1', sql: 'alter table a rename to renamed;' });
	pending.resolve();
	await saving;
	assert.equal(s.activeTableName, 'renamed');
	assert.equal(s.selectedCount, 0);
	assert.equal(s.error, 'read refresh failed'); // The DDL itself succeeded.
	assert.equal(typeof s.savedAt, 'number');
	deferRead(undefined);
	deferSchema(async () => { tables.splice(0, 1); });
	await s.applySchema({ sql: 'drop table renamed;' });
	assert.equal(s.activeTableName, 'b');
	deferSchema(async () => { throw new Error('syntax error'); });
	await assert.rejects(s.applySchema({ sql: 'bad' }), /syntax error/);
	assert.equal(s.activeTableName, 'b');
	assert.equal(s.busy, false);
});

test('post-commit refresh failures resolve the write and never retry it', async () => {
	for (const insert of [false, true]) {
		const { editor: s, calls, deferRead } = await fixture();
		deferRead(async () => { throw new Error('Refresh failed'); });
		if (insert) s.startInsert();
		else s.editing = true;
		await (insert ? s.insertRow({ value: 'once' }) : s.updateRows([{ row: s.rows[0], values: { value: 'once' } }]));
		assert.equal(calls.length, 1);
		assert.equal(s.error, 'Refresh failed');
		assert.equal(typeof s.savedAt, 'number');
		assert.equal(s.busy, false);
		assert.equal(s.loading, false);
		assert.equal(insert ? s.inserting : s.editing, true);
	}
});

test('live polls refresh current query, preserve unchanged arrays and update idle pages', async () => {
	const { editor: s, deferRead, row } = await fixture();
	assert.equal(s.live, true);
	assert.equal(s.polling, false);
	assert.equal(s.externalChange, false);
	assert.equal(s.liveError, null);
	assert.equal(s.cellSelected, false);
	await s.selectTable('public', 'b', { id: 'exact' });
	await s.setFilters([{ column: 'value', operator: 'ilike', value: '%query%' }]);
	await s.setSort([{ column: 'value', direction: 'asc' }, { column: 'id', direction: 'desc' }]);
	await s.setPageSize(250);
	await s.setPage(1);
	const original = s.rows;
	const calls: any[] = [];
	let result: RowsPage = { rows: [row('2')], hasMore: true };
	deferRead(async (args) => { calls.push(args); return result; });
	s.setLive(true);
	assert.equal(calls.length, 0);
	await s.poll();
	assert.equal(s.rows, original);
	assert.deepEqual(calls[0], {
		connection: 'connection-1', schema: 'public', table: 'b', page: 1, pageSize: 250,
		sort: [{ column: 'value', direction: 'asc' }, { column: 'id', direction: 'desc' }], reference: { id: 'exact' },
		filters: [{ column: 'value', operator: 'ilike', value: '%query%' }]
	});
	result = { rows: [row('updated')], hasMore: false };
	await s.poll();
	assert.equal(calls.length, 2);
	assert.equal(s.rows[0].key, 'updated');
	assert.equal(s.rowsPage, 1);
	assert.equal(s.hasMore, false);
	// An emptied page is applied as returned, without a foreground page-zero fetch.
	result = { rows: [], hasMore: false };
	await s.poll();
	assert.equal(s.page, 1);
	assert.equal(s.rows.length, 0);
	assert.equal(calls.length, 3);
});

for (const protection of ['insert form', 'row selection', 'editor', 'cell selection']) {
	test(`live updates preserve ${protection}, including work begun in flight`, async () => {
		const { editor: s, deferRead, row } = await fixture();
		s.setLive(true);
		const original = s.rows;
		const slow = deferred<RowsPage>();
		deferRead(() => slow.promise);
		const polling = s.poll();
		if (protection === 'insert form') s.startInsert();
		else if (protection === 'row selection') s.toggleRowSelection(s.rows[0]);
		else if (protection === 'editor') s.editing = true;
		else s.cellSelected = true;
		const local = () => JSON.stringify({
			selection: s.rowSelection, inserting: s.inserting,
			editing: s.editing, cellSelected: s.cellSelected, page: s.page, rowsPage: s.rowsPage
		});
		const before = local();
		slow.resolve({ rows: [row('external')], hasMore: false });
		await polling;
		assert.equal(s.rows, original);
		assert.equal(s.hasMore, true);
		assert.equal(s.externalChange, true);
		assert.equal(local(), before);
		// Already-present work is protected on subsequent polls too.
		await s.poll();
		assert.equal(s.rows, original);
		assert.equal(local(), before);
		Object.assign(s, { rowSelection: {}, editing: false, inserting: false, cellSelected: false });
		await s.poll();
		assert.equal(s.rows[0].key, 'external');
		assert.equal(s.externalChange, false);
	});
}

test('foreground reads supersede polls without being superseded by them', async () => {
	const { editor: s, deferRead, row } = await fixture();
	s.setLive(true);
	for (const navigate of [
		() => s.selectTable('public', s.activeTableName === 'a' ? 'b' : 'a'),
		() => s.fetch(), () => s.reload(), () => s.initialize(s.connection + '-next')
	]) {
		for (const staleFirst of [true, false]) {
			const stale = deferred<RowsPage>();
			deferRead(() => stale.promise);
			const polling = s.poll();
			const fresh = deferred<RowsPage>();
			deferRead(() => fresh.promise);
			const reading = navigate();
			// Let reload's metadata request reach its rows request.
			await Promise.resolve();
			await s.poll();
			if (staleFirst) {
				stale.resolve({ rows: [row('stale')], hasMore: false });
				await polling;
				assert.equal(s.loading, true);
			}
			fresh.resolve({ rows: [row('foreground')], hasMore: true });
			await reading;
			const foreground = s.rows;
			if (!staleFirst) {
				stale.resolve({ rows: [row('stale')], hasMore: false });
				await polling;
			}
			assert.equal(s.rows, foreground);
			assert.equal(s.rows[0].key, 'foreground');
			assert.equal(s.hasMore, true);
			assert.equal(s.loading, false);
		}
	}
});

test('attempted writes invalidate older polls even after failed writes finish', async () => {
	for (const insert of [false, true]) {
		const { editor: s, deferRead, deferSave, row } = await fixture();
		s.setLive(true);
		const slow = deferred<RowsPage>();
		deferRead(() => slow.promise);
		const polling = s.poll();
		deferSave(async () => { throw new Error('save failure'); });
		await assert.rejects(insert ? s.insertRow({ value: 'local' }) : s.updateRows([{ row: s.rows[0], values: { value: 'local' } }]), /save failure/);
		// No form flags or foreground error mask a missing mutation-generation guard.
		assert.equal(s.error, null);
		assert.equal(s.navigationBlocked, false);
		const original = s.rows;
		slow.resolve({ rows: [row('before-save')], hasMore: false });
		await polling;
		assert.equal(s.rows, original);
		assert.equal(s.externalChange, false);
	}
});

