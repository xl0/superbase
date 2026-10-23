import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';
import type { Row, Table } from '../src/lib/types.ts';

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
