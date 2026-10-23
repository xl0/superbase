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
	let read: ((args: any) => Promise<{ rows: Row[]; hasMore: boolean }>) | undefined;
	const column = (name: string, primaryKey = false) => ({ name, primaryKey, type: 'text', kind: 'text' as const, nullable: !primaryKey, generated: false, identity: null, defaultValue: null });
	const tables: Table[] = ['a', 'b'].map((name) => ({ schema: 'public', name, rowCount: 200, columns: [column('id', true), column('value'), column('__proto__')] }));
	const row = (id: string, value = 'original'): Row => ({ key: id, values: { id, value }, identity: { pk: { id }, version: '1', relation: '123' } });
	const api = {
		database: () => ({ refresh: async () => {}, current: { tables, server: { database: 'test' } } }),
		tableRows: (args: any) => {
			const resource = { current: null as any, refresh: async () => { resource.current = await (read?.(args) ?? Promise.resolve({ rows: [row(args.page ? '2' : '1')], hasMore: true })); } };
			return resource;
		},
		saveTable: async (args: any) => { calls.push({ kind: 'save', args: structuredClone(args) }); await save?.(); },
		deleteRows: async (args: any) => { calls.push({ kind: 'delete', args: structuredClone(args) }); }
	};
	const key = `__editorTest${serial++}`;
	(globalThis as any)[key] = api;
	let source = await readFile(new URL('../src/lib/state/editor.svelte.ts', import.meta.url), 'utf8');
	source = source.replace(/^import \{ database, deleteRows, saveTable, tableRows \}.*$/m, `const { database, deleteRows, saveTable, tableRows } = globalThis[${JSON.stringify(key)}];`)
		.replace("'#lib/types.js'", JSON.stringify(new URL('../src/lib/types.ts', import.meta.url).href))
		.replace("'#lib/utils.js'", JSON.stringify(new URL('../src/lib/utils.ts', import.meta.url).href));
	const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	const compiled = compileModule(js, { filename: 'editor.svelte.js', generate: 'client' }).js.code
		.replace(/(['"])svelte\/internal\/client\1/, JSON.stringify(import.meta.resolve('svelte/internal/client')));
	const { EditorState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
	delete (globalThis as any)[key];
	const editor = new EditorState();
	await editor.initialize('connection-1');
	return { editor, calls, tables, row, deferSave: (fn: () => Promise<void>) => save = fn, deferRead: (fn: typeof read) => read = fn };
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test('off-page edits and row selections retain their original identities', async () => {
	const { editor: s, calls, tables } = await fixture();
	s.editCell(s.rows[0], tables[0].columns[1], 'changed');
	s.toggleRowSelection(s.rows[0]);
	await s.setPage(1);
	assert.equal(s.rows[0].key, '2');
	assert.equal(s.selectedCount, 1);
	await s.save();
	assert.equal(calls[0].args.updates[0].identity.pk.id, '1');
	assert.deepEqual(calls[0].args.updates[0].changes, { value: 'changed' });
	assert.equal(s.hasAnyChanges, false);
	await s.setPage(0);
	s.toggleRowSelection(s.rows[0]);
	await s.setPage(1);
	await s.deleteSelected();
	assert.equal(calls[1].args.identities[0].pk.id, '1');
	assert.equal(s.selectedCount, 0);
});

test('busy mutations block navigation/new edits and clean only their captured table', async () => {
	const { editor: s, tables, deferSave } = await fixture();
	s.editCell(s.rows[0], tables[0].columns[1], 'A');
	const a = s.tableKey;
	await s.selectTable('public', 'b');
	s.editCell(s.rows[0], tables[1].columns[1], 'B');
	const b = s.tableKey;
	await s.selectTable('public', 'a');
	const pending = deferred(); deferSave(() => pending.promise);
	const saving = s.save();
	assert.equal(s.busy, true);
	await s.selectTable('public', 'b');
	assert.equal(s.tableKey, a);
	s.editCell(s.rows[0], tables[0].columns[1], 'ignored while busy');
	assert.equal(s.getValue(s.rows[0], 'value'), 'A');
	// Even an external context change cannot make the old completion erase B.
	s.activeTableName = 'b'; pending.resolve(); await saving;
	assert.equal(s.edits[a], undefined);
	assert.equal(s.edits[b]['1'].changes.value, 'B');
});

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

test('sorting retains displayed rows, blocks edits and ignores superseded results', async () => {
	const { editor: s, deferRead, row, tables } = await fixture();
	await s.setPage(1);
	const old = s.rows[0];
	const slow = deferred<{ rows: Row[]; hasMore: boolean }>();
	deferRead(() => slow.promise);
	const sorting = s.toggleSort('value');
	assert.equal(s.rows[0].key, old.key);
	assert.equal(s.rowsPage, 1);
	assert.equal(s.loading, true);
	assert.equal(s.editCells(old, { value: 'ignored' }), false);
	s.editCell(old, tables[0].columns[1], 'also ignored');
	assert.equal(s.hasChanges, false);
	deferRead(async () => ({ rows: [row('replacement')], hasMore: false }));
	await s.selectTable('public', 'b');
	slow.resolve({ rows: [row('old-sort')], hasMore: true });
	await sorting;
	assert.equal(s.rows[0].key, 'replacement');
	assert.equal(s.rowsPage, 0);
	assert.equal(s.loading, false);
});

test('failed sort resets the displayed page so new drafts remain visible', async () => {
	const { editor: s, deferRead } = await fixture();
	await s.setPage(1);
	deferRead(async () => { throw new Error('Sort failed'); });
	await s.toggleSort('value');
	assert.equal(s.error, 'Sort failed');
	assert.equal(s.loading, false);
	assert.equal(s.rowsPage, 0);
	s.insertRow();
	assert.equal(s.pageRows.length, 1);
	assert.equal(s.pageRows[0].draft, true);
});

test('composite reference changes are atomic and navigation uses exact current values', async () => {
	const { editor: s, tables, deferRead } = await fixture();
	const fk = { schema: 'public', table: 'b', column: 'id', columns: ['id', 'value'], referencedColumns: ['id', 'value'] };
	tables[0].columns[0].foreignKey = fk;
	const row = s.rows[0];
	assert.equal(s.editCells(row, { id: '42', missing: 'invalid' }), false);
	assert.equal(s.hasChanges, false);
	assert.equal(s.editCells(row, { id: null, value: 'invalid' }), false);
	assert.equal(s.hasChanges, false);
	assert.equal(s.editCells(row, { id: '42', value: 'exact %_ value' }), true);
	let args: any;
	deferRead(async (value) => { args = value; return { rows: [], hasMore: false }; });
	await s.followReference(row, tables[0].columns[0]);
	assert.equal(s.activeTableName, 'b');
	assert.deepEqual(args.filter, { id: '42', value: 'exact %_ value' });
	assert.equal(s.editCells(row, { value: 'stale panel' }), false);
	await s.selectTable('public', 'b');
	assert.equal(s.filter, null);
	assert.equal(args.filter, undefined);
});

test('draft defaults, explicit null/empty, and arbitrary column names stay distinct', async () => {
	const { editor: s, calls, tables } = await fixture();
	s.insertRow();
	const draft = s.draftsForTable[0];
	assert.deepEqual(Object.keys(draft.values), []);
	s.editCell(draft, tables[0].columns[1], null);
	s.editCell(draft, tables[0].columns[2], 'literal prototype');
	assert.equal(Object.hasOwn(draft.values, '__proto__'), true);
	await s.save();
	assert.deepEqual(calls[0].args.inserts[0], Object.fromEntries([['value', null], ['__proto__', 'literal prototype']]));
	s.insertRow();
	s.editCell(s.draftsForTable[0], tables[0].columns[1], '');
	assert.equal(s.draftsForTable[0].values.value, '');
	s.editCell(s.draftsForTable[0], tables[0].columns[1], undefined);
	assert.equal(Object.hasOwn(s.draftsForTable[0].values, 'value'), false);
});

test('connection reinitialization cannot move pending edits to a new database', async () => {
	const { editor: s, tables } = await fixture();
	s.editCell(s.rows[0], tables[0].columns[1], 'keep on original database');
	await s.initialize('connection-2');
	assert.equal(s.connection, 'connection-1');
	assert.equal(s.hasAnyChanges, true);
	assert.match(s.error, /Connection changed/);
	s.discardAll();
	await s.initialize('connection-2');
	assert.equal(s.connection, 'connection-2');
	assert.equal(s.hasAnyChanges, false);
});

test('failed saves preserve pending changes and exact originals; editing back removes an overlay', async () => {
	const { editor: s, tables, deferSave } = await fixture();
	const original = s.rows[0];
	s.editCell(original, tables[0].columns[1], 'changed');
	deferSave(async () => { throw { message: 'Row conflict' }; });
	await s.save();
	assert.equal(s.error, 'Row conflict');
	assert.equal(s.hasChanges, true);
	assert.equal(s.busy, false);
	s.editCell(original, tables[0].columns[1], 'original');
	assert.equal(s.hasAnyChanges, false);
});

test('live polls refresh current query, preserve unchanged arrays and update idle pages', async () => {
	const { editor: s, deferRead, row, tables } = await fixture();
	assert.equal(s.live, false);
	assert.equal(s.polling, false);
	assert.equal(s.externalChange, false);
	assert.equal(s.liveError, null);
	assert.equal(s.cellSelected, false);
	// Work in another table does not prevent refreshing the active table.
	s.editCell(s.rows[0], tables[0].columns[1], 'local');
	await s.selectTable('public', 'b', { id: 'exact' });
	await s.setSearch('query');
	await s.setSort('value');
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
		sort: { column: 'value', direction: 'asc' }, search: 'query', filter: { id: 'exact' }
	});
	result = { rows: [row('updated')], hasMore: false };
	await s.poll();
	assert.equal(calls.length, 2);
	assert.equal(s.rows[0].key, 'updated');
	assert.equal(s.rowsPage, 1);
	assert.equal(s.hasMore, false);
	assert.equal(s.hasAnyChanges, true);
	// An emptied page is applied as returned, without a foreground page-zero fetch.
	result = { rows: [], hasMore: false };
	await s.poll();
	assert.equal(s.page, 1);
	assert.equal(s.rows.length, 0);
	assert.equal(calls.length, 3);
});

for (const protection of ['draft', 'edit', 'row selection', 'editor', 'cell selection']) {
	test(`live updates preserve ${protection}, including work begun in flight`, async () => {
		const { editor: s, deferRead, row, tables } = await fixture();
		s.setLive(true);
		const original = s.rows;
		const slow = deferred<RowsPage>();
		deferRead(() => slow.promise);
		const polling = s.poll();
		if (protection === 'draft') {
			s.insertRow();
			s.editCell(s.draftsForTable[0], tables[0].columns[1], 'draft buffer');
		} else if (protection === 'edit') s.editCell(s.rows[0], tables[0].columns[1], 'edit buffer');
		else if (protection === 'row selection') s.toggleRowSelection(s.rows[0]);
		else if (protection === 'editor') s.editing = true;
		else s.cellSelected = true;
		const local = () => JSON.stringify({
			edits: s.edits, drafts: s.drafts, selection: s.rowSelection,
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
		s.revert();
		s.editing = false;
		s.cellSelected = false;
		await s.poll();
		assert.equal(s.rows[0].key, 'external');
		assert.equal(s.externalChange, false);
	});
}

test('live polls skip ineligible states and never overlap, even across off/on', async () => {
	const { editor: s, deferRead, row } = await fixture();
	let reads = 0;
	const slow = deferred<RowsPage>();
	deferRead(() => { reads++; return slow.promise; });
	await s.poll();
	s.setLive(true);
	for (const [field, value] of [
		['ready', false], ['activeTableName', ''], ['loading', true], ['busy', true], ['error', 'foreground failure']
	] as const) {
		const original = s[field];
		s[field] = value;
		await s.poll();
		s[field] = original;
	}
	await s.poll(() => false);
	assert.equal(reads, 0);
	const original = s.rows;
	const polling = s.poll();
	assert.equal(s.polling, true);
	await s.poll();
	s.setLive(false);
	s.setLive(true);
	await s.poll();
	assert.equal(reads, 1);
	slow.resolve({ rows: [row('obsolete')], hasMore: false });
	await polling;
	assert.equal(s.polling, false);
	assert.equal(s.rows, original);
	await s.poll();
	assert.equal(reads, 2);
	assert.equal(s.rows[0].key, 'obsolete');
});

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

test('poll completions are ignored when inactive or busy, including stale errors', async () => {
	const { editor: s, deferRead, row } = await fixture();
	s.setLive(true);
	const original = s.rows;
	for (const guard of ['inactive', 'busy', 'error', 'not ready']) {
		for (const fail of [false, true]) {
			let active = true;
			const slow = deferred();
			deferRead(async () => {
				await slow.promise;
				if (fail) throw new Error('obsolete failure');
				return { rows: [row('obsolete')], hasMore: false };
			});
			const polling = s.poll(() => active);
			if (guard === 'inactive') active = false;
			else if (guard === 'busy') s.busy = true;
			else if (guard === 'error') s.error = 'foreground failure';
			else s.ready = false;
			slow.resolve();
			await polling;
			assert.equal(s.rows, original);
			assert.equal(s.liveError, null);
			assert.equal(s.externalChange, false);
			s.busy = false;
			s.error = null;
			s.ready = true;
		}
	}
});

test('a save invalidates an older poll even after the save finishes', async () => {
	const { editor: s, deferRead, deferSave, tables, row } = await fixture();
	s.setLive(true);
	const slow = deferred<RowsPage>();
	deferRead(() => slow.promise);
	const polling = s.poll();
	s.editCell(s.rows[0], tables[0].columns[1], 'local');
	deferSave(async () => { throw new Error('save failure'); });
	await s.save();
	// Remove the foreground error to isolate the mutation-generation guard.
	s.error = null;
	s.revert();
	const original = s.rows;
	slow.resolve({ rows: [row('before-save')], hasMore: false });
	await polling;
	assert.equal(s.rows, original);
	assert.equal(s.externalChange, false);
});

test('live errors preserve local work, recover, and clear on explicit view transitions', async () => {
	const { editor: s, deferRead, row, tables } = await fixture();
	s.setLive(true);
	s.editCell(s.rows[0], tables[0].columns[1], 'local');
	const original = s.rows;
	deferRead(async () => { throw new Error('offline'); });
	await s.poll();
	assert.equal(s.liveError, 'offline');
	assert.equal(s.error, null);
	assert.equal(s.rows, original);
	assert.equal(s.getValue(s.rows[0], 'value'), 'local');
	assert.equal(s.polling, false);
	deferRead(async () => ({ rows: [row('changed')], hasMore: false }));
	await s.poll();
	assert.equal(s.liveError, null);
	assert.equal(s.externalChange, true);
	assert.equal(s.rows, original);
	deferRead(async () => { throw new Error('offline again'); });
	await s.poll();
	s.setLive(false);
	assert.equal(s.liveError, null);
	assert.equal(s.externalChange, true);
	for (const transition of [() => s.fetch(), () => s.reload()]) {
		s.liveError = 'previous live error';
		s.externalChange = true;
		const slow = deferred<RowsPage>();
		deferRead(() => slow.promise);
		const reading = transition();
		assert.equal(s.liveError, null);
		assert.equal(s.externalChange, false);
		slow.resolve({ rows: [row('explicit')], hasMore: true });
		await reading;
		assert.equal(s.hasChanges, true);
	}
});
