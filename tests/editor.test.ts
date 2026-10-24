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
	const tables: Table[] = ['a', 'b'].map((name) => ({ schema: 'public', name, rowCount: 200, columns: [column('id', true), column('value'), column('__proto__'), column('constructor')] }));
	const row = (id: string, value = 'original'): Row => ({ key: id, values: { id, value }, identity: { pk: { id }, version: '1', relation: '123' } });
	const api = {
		database: () => ({ refresh: async () => {}, current: { tables, server: { database: 'test' } } }),
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

test('immediate updates retain unmodified selections across pages and remove only changed versions', async () => {
	const { editor: s, calls, row } = await fixture();
	s.toggleRowSelection(s.rows[0]);
	await s.setPage(1);
	assert.equal(s.rows[0].key, '2');
	s.toggleRowSelection(s.rows[0]);
	const unchanged = s.rows[0];
	s.rows.push(row('3'));
	const changed = s.rows[1];
	s.toggleRowSelection(changed);
	await s.updateRows([{ row: unchanged, values: { value: 'original' } }, { row: changed, values: { value: 'changed' } }]);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].args.updates, [{ identity: changed.identity, changes: { value: 'changed' } }]);
	assert.equal(s.isRowSelected('1'), true);
	assert.equal(s.isRowSelected('2'), true);
	assert.equal(s.isRowSelected('3'), false);
	await s.deleteSelected();
	assert.deepEqual(calls[1].args.identities.map((identity: any) => identity.pk.id), ['1', '2']);
	assert.equal(s.selectedCount, 0);
});

test('__proto__ primary keys survive update and cross-page delete identity capture', async () => {
	const { editor: s, calls } = await fixture();
	const row = s.rows[0];
	row.identity.pk = Object.fromEntries([['__proto__', 'key1']]);
	row.values = { ...row.values, ...row.identity.pk };
	await s.updateRows([{ row, values: { value: 'changed' } }]);
	assert.deepEqual(calls[0].args.updates[0].identity.pk, Object.fromEntries([['__proto__', 'key1']]));
	s.rows = [row];
	s.toggleRowSelection(row);
	row.identity.pk.__proto__ = 'changed after selection';
	await s.setPage(1);
	await s.deleteSelected();
	assert.deepEqual(calls[1].args.identities[0].pk, Object.fromEntries([['__proto__', 'key1']]));
	assert.equal(Object.getPrototypeOf(calls[1].args.identities[0].pk), Object.prototype);
});

test('atomic multirow updates snapshot composite identities and values, skip no-ops, and block busy mutations', async () => {
	const { editor: s, calls, row, deferSave, deferRead } = await fixture();
	s.rows.push(row('2'));
	s.table.columns.push({ ...s.table.columns[0], name: 'tenant' });
	for (const row of s.rows) {
		row.values.tenant = 'tenant-1';
		row.identity.pk.tenant = 'tenant-1';
	}
	const first = s.rows[0];
	const second = s.rows[1];
	await s.updateRows([{ row: first, values: { value: 'original' } }]);
	assert.equal(calls.length, 0);
	const values = { id: '42', value: 'exact %_ value' };
	const identity = structuredClone({ ...first.identity, pk: { ...first.identity.pk } });
	const original = s.rows;
	s.toggleRowSelection(first);
	const pending = deferred(); deferSave(() => pending.promise);
	const secondValues = Object.fromEntries([['value', null], ['__proto__', ''], ['constructor', 'literal']]);
	const saving = s.updateRows([{ row: first, values }, { row: second, values: secondValues }]);
	assert.equal(s.busy, true);
	assert.equal(s.rows, original);
	assert.equal(s.getValue(first, 'value'), 'original');
	values.value = 'changed after submit';
	first.identity.pk.tenant = 'changed after submit';
	assert.deepEqual(calls[0].args, {
		connection: 'connection-1', schema: 'public', table: 'a', inserts: [],
		updates: [{ identity, changes: { id: '42', value: 'exact %_ value' } }, { identity: second.identity, changes: secondValues }]
	});
	await assert.rejects(s.updateRows([{ row: second, values: { value: 'blocked' } }]), /not ready/);
	await assert.rejects(s.insertRow({ value: 'blocked' }), /not ready/);
	await s.deleteSelected();
	s.clearRowSelection();
	s.toggleRowSelection(second);
	s.startInsert();
	await s.selectTable('public', 'b');
	assert.equal(s.activeTableName, 'a');
	assert.equal(s.selectedCount, 1);
	assert.equal(s.inserting, false);
	assert.equal(calls.length, 1);
	deferRead(async () => ({ rows: [row('committed', 'exact %_ value')], hasMore: false }));
	pending.resolve(); await saving;
	assert.equal(s.rows[0].key, 'committed');
	assert.equal(s.busy, false);
	assert.equal(typeof s.savedAt, 'number');
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

test('multi-sort snapshots rules and header cycling preserves the other priorities', async () => {
	const { editor: s } = await fixture();
	await s.setPage(1);
	const rules = [{ column: 'value', direction: 'asc' }, { column: 'id', direction: 'desc' }];
	await s.setSort(rules);
	rules[0].direction = 'desc';
	assert.equal(s.sort[0].direction, 'asc');
	assert.equal(s.page, 0);
	await s.toggleSort('value');
	assert.deepEqual(s.sort, [{ column: 'value', direction: 'desc' }, { column: 'id', direction: 'desc' }]);
	await s.toggleSort('value');
	assert.deepEqual(s.sort, [{ column: 'id', direction: 'desc' }]);
	await s.toggleSort('value');
	assert.deepEqual(s.sort, [{ column: 'id', direction: 'desc' }, { column: 'value', direction: 'asc' }]);
	await s.setSort([...s.sort].reverse());
	assert.deepEqual(s.sort, [{ column: 'value', direction: 'asc' }, { column: 'id', direction: 'desc' }]);
	await s.setFilters([{ column: 'value', operator: 'eq', value: 'original' }]);
	assert.equal(s.sort.length, 2);
	await s.selectTable('public', 'b');
	assert.deepEqual(s.sort, []);
});

test('DDL snapshots intent, protects navigation/polling, refreshes metadata and preserves acknowledged writes', async () => {
	const { editor: s, calls, tables, deferSchema, deferRead } = await fixture();
	s.toggleRowSelection(s.rows[0]);
	s.schemaEditing = true;
	let reads = 0;
	deferRead(async () => { reads++; throw new Error('read refresh failed'); });
	await s.poll();
	assert.equal(reads, 0);
	await assert.rejects(s.updateRows([{ row: s.rows[0], values: { value: 'blocked' } }]), /not ready/);
	const pending = deferred();
	deferSchema(async (args) => { await pending.promise; tables[0].name = args.operation.name; });
	const args = { connection: 'connection-1', schema: 'public', table: 'a', expected: 'fingerprint', operation: { kind: 'renameTable', name: 'renamed' } };
	await assert.rejects(s.applySchemaChange({ ...args, connection: 'wrong' }), /Connection changed/);
	const saving = s.applySchemaChange(args);
	args.operation.name = 'changed after submission';
	assert.equal(s.busy, true);
	assert.equal(s.navigationBlocked, true);
	assert.equal(calls[0].args.operation.name, 'renamed');
	pending.resolve();
	await saving;
	assert.equal(calls.length, 1);
	assert.equal(s.activeTableName, 'renamed');
	assert.equal(s.selectedCount, 0);
	assert.equal(s.error, 'read refresh failed');
	assert.equal(typeof s.savedAt, 'number');
	assert.equal(s.busy, false);
	assert.equal(s.schemaEditing, true); // The panel owns dismissal after acknowledgement.
	deferSchema(async () => { throw new Error('schema changed'); });
	await assert.rejects(s.applySchemaChange({ ...args, table: 'renamed' }), /schema changed/);
	assert.equal(s.activeTableName, 'renamed');
	assert.equal(s.schemaEditing, true);
	assert.equal(s.busy, false);
});

test('sidebar DDL targets inactive tables without switching away on an unrelated drop', async () => {
	const { editor: s, calls, tables, deferSchema } = await fixture();
	tables.push({ ...tables[0], name: 'c' });
	await s.selectTable('public', 'b');
	s.schemaEditing = true;
	deferSchema(async (args) => {
		const index = tables.findIndex((table) => table.schema === args.schema && table.name === args.table);
		assert.notEqual(index, -1);
		if (args.operation.kind === 'dropTable') tables.splice(index, 1);
		else tables[index].name = args.operation.name;
	});
	await s.applySchemaChange({ connection: 'connection-1', schema: 'public', table: 'c', expected: 'fingerprint', operation: { kind: 'dropTable' } });
	assert.equal(calls[0].args.table, 'c');
	assert.equal(s.activeTableName, 'b');
	await s.applySchemaChange({ connection: 'connection-1', schema: 'public', table: 'a', expected: 'fingerprint', operation: { kind: 'renameTable', name: 'renamed' } });
	assert.equal(calls[1].args.table, 'a');
	assert.equal(s.activeTableName, 'renamed');
	assert.equal(tables[1].name, 'b');
	await s.applySchemaChange({ connection: 'connection-1', schema: 'public', table: 'renamed', expected: 'fingerprint', operation: { kind: 'dropTable' } });
	assert.equal(s.activeTableName, 'b');
});

test('dropping the last column retains the table through DDL and manual refresh', async () => {
	const { editor: s, tables, deferSchema } = await fixture();
	await s.selectTable('public', 'b');
	s.schemaEditing = true;
	deferSchema(async () => { tables[1].columns = []; });
	await s.applySchemaChange({ connection: 'connection-1', schema: 'public', table: 'b', expected: 'fingerprint', operation: { kind: 'dropColumn', column: 'last' } });
	assert.equal(s.activeTableName, 'b');
	assert.equal(s.table.columns.length, 0);
	s.schemaEditing = false;
	await s.reload();
	assert.equal(s.activeTableName, 'b');
});

test('failed sort clears stale rows and resets their displayed page', async () => {
	const { editor: s, deferRead } = await fixture();
	await s.setPage(1);
	deferRead(async () => { throw new Error('Sort failed'); });
	await s.toggleSort('value');
	assert.equal(s.error, 'Sort failed');
	assert.equal(s.loading, false);
	assert.equal(s.rowsPage, 0);
	assert.equal(s.rows.length, 0);
});

test('invalid or stale batches fail before writing; reference navigation uses exact persisted values', async () => {
	const { editor: s, tables, deferRead, calls, row } = await fixture();
	const fk = { schema: 'public', table: 'b', column: 'id', columns: ['id', 'value'], referencedColumns: ['id', 'value'] };
	tables[0].columns[0].foreignKey = fk;
	s.rows.push(row('2'));
	const captured = s.rows[0];
	for (const values of [{ missing: 'invalid' }, { id: null }, { value: undefined }]) {
		await assert.rejects(s.updateRows([{ row: captured, values: { value: 'valid' } }, { row: s.rows[1], values }]));
	}
	for (const mode of ['generated', 'identity'] as const) {
		const column = s.table.columns[1];
		if (mode === 'generated') column.generated = true;
		else column.identity = 'always';
		await assert.rejects(s.updateRows([{ row: captured, values: { value: 'invalid' } }]), /not writable/);
		column.generated = false; column.identity = null;
	}
	await assert.rejects(s.updateRows([{ row: { ...captured, identity: { ...captured.identity, version: 'stale' } }, values: { value: 'stale' } }]), /no longer current/);
	await assert.rejects(s.updateRows([{ row: row('off-page'), values: { value: 'stale' } }]), /no longer current/);
	assert.equal(calls.length, 0);
	assert.equal(s.getValue(captured, 'value'), 'original');
	captured.values.id = '42'; captured.values.value = 'exact %_ value';
	let args: any;
	deferRead(async (value) => { args = value; return { rows: [], hasMore: false }; });
	await s.followReference(captured, tables[0].columns[0]);
	assert.equal(s.activeTableName, 'b');
	assert.deepEqual(args.filter, { id: '42', value: 'exact %_ value' });
	await assert.rejects(s.updateRows([{ row: captured, values: { value: 'stale panel' } }]), /no longer current/);
	await s.selectTable('public', 'b');
	assert.equal(s.filter, null);
	assert.equal(args.filter, undefined);
});

test('insert form never adds grid drafts and preserves sparse DEFAULT, NULL, empty and arbitrary names', async () => {
	const { editor: s, calls, deferSave } = await fixture();
	const original = s.rows;
	s.startInsert();
	assert.equal(s.inserting, true);
	assert.equal(s.rows, original);
	await assert.rejects(s.updateRows([{ row: s.rows[0], values: { value: 'blocked' } }]), /Finish inserting/);
	assert.equal(calls.length, 0);
	const values = Object.fromEntries([['value', ''], ['__proto__', null], ['constructor', 'literal constructor']]);
	const draft: Row = { key: 'local', values, identity: null, draft: true };
	assert.equal(s.getValue(draft, 'id'), undefined);
	assert.equal(s.getValue(draft, '__proto__'), null);
	assert.equal(s.getValue(draft, 'constructor'), 'literal constructor');
	assert.equal(s.getValue({ ...draft, values: {} }, 'constructor'), undefined);
	const pending = deferred(); deferSave(() => pending.promise);
	const saving = s.insertRow(values);
	values.value = 'changed after submit';
	assert.equal(s.rows, original);
	assert.deepEqual(calls[0].args.inserts, [Object.fromEntries([['value', ''], ['__proto__', null], ['constructor', 'literal constructor']])]);
	assert.deepEqual(calls[0].args.updates, []);
	assert.equal(Object.hasOwn(calls[0].args.inserts[0], 'id'), false);
	pending.resolve(); await saving;
	assert.equal(s.inserting, true); // The form, not persistence, owns closing / Create more.
	await s.insertRow({});
	assert.deepEqual(calls[1].args.inserts, [{}]);
});

test('open cell, insert and schema forms block navigation, reload and connection changes', async () => {
	for (const flag of ['editing', 'inserting', 'schemaEditing']) {
		const { editor: s, deferRead } = await fixture();
		let reads = 0;
		deferRead(async () => { reads++; return { rows: [], hasMore: false }; });
		s.sort = [{ column: 'value', direction: 'asc' }];
		s.filter = { id: '1' };
		s[flag] = true;
		const original = s.rows;
		await s.selectTable('public', 'b');
		await s.setSchema('public');
		await s.setPage(1);
		await s.setPageSize(250);
		await s.setFilters([{ column: 'value', operator: 'eq', value: 'blocked' }]);
		await s.toggleSort('id');
		await s.setSort([{ column: 'id', direction: 'asc' }]);
		await s.setSort([]);
		await s.clearFilters();
		await s.reload();
		await s.initialize('connection-2');
		assert.equal(reads, 0);
		assert.equal(s.rows, original);
		assert.equal(s.activeTableName, 'a');
		assert.equal(s.page, 0);
		assert.equal(s.pageSize, 100);
		assert.deepEqual(s.filters, []);
		assert.deepEqual(s.sort, [{ column: 'value', direction: 'asc' }]);
		assert.deepEqual(s.filter, { id: '1' });
		assert.equal(s.connection, 'connection-1');
		assert.equal(s[flag], true);
		assert.match(s.error, /Connection changed/);
		s.discardAll();
		await s.initialize('connection-2');
		assert.equal(s.connection, 'connection-2');
		assert.equal(s.navigationBlocked, false);
	}
});

test('write failures reject without changing displayed rows, selections or open form flags', async () => {
	for (const flag of ['editing', 'inserting']) {
		const { editor: s, calls, deferSave } = await fixture();
		const original = s.rows;
		s.toggleRowSelection(s.rows[0]);
		s[flag] = true;
		const values = { value: 'UI-owned buffer' };
		deferSave(async () => { throw new Error('Row conflict'); });
		await assert.rejects(flag === 'editing' ? s.updateRows([{ row: s.rows[0], values }]) : s.insertRow(values), /Row conflict/);
		assert.equal(s.rows, original);
		assert.equal(s.getValue(s.rows[0], 'value'), 'original');
		assert.deepEqual(values, { value: 'UI-owned buffer' });
		assert.equal(s.selectedCount, 1);
		assert.equal(s[flag], true);
		assert.equal(s.busy, false);
		assert.equal(s.error, null);
		assert.equal(s.savedAt, null);
		assert.equal(calls.length, 1);
	}
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

test('filters reset pagination, snapshot values, preserve FK constraints and clear on table changes', async () => {
	const { editor: s, deferRead, row } = await fixture();
	const calls: any[] = [];
	deferRead(async (args) => { calls.push(args); return { rows: [row('1')], hasMore: true }; });
	await s.selectTable('public', 'b', { id: 'exact' });
	await s.setPage(1);
	const filters = [{ column: 'value', operator: 'eq', value: 'literal %_ text' }];
	await s.setFilters(filters);
	filters[0].value = 'changed after submission';
	assert.equal(s.page, 0);
	assert.equal(s.hasFilters, true);
	assert.deepEqual(calls.at(-1).filter, { id: 'exact' });
	assert.deepEqual(calls.at(-1).filters, [{ column: 'value', operator: 'eq', value: 'literal %_ text' }]);
	await s.clearFilters();
	assert.equal(s.hasFilters, false);
	assert.equal(calls.at(-1).filter, undefined);
	assert.deepEqual(calls.at(-1).filters, []);
	await s.setFilters(filters);
	await s.selectTable('public', 'a');
	assert.equal(s.hasFilters, false);
	assert.deepEqual(s.filters, []);
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
		sort: [{ column: 'value', direction: 'asc' }, { column: 'id', direction: 'desc' }], search: '', filter: { id: 'exact' },
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
		s.discardAll();
		s.cellSelected = false;
		await s.poll();
		assert.equal(s.rows[0].key, 'external');
		assert.equal(s.externalChange, false);
	});
}

test('live polls skip ineligible states and never overlap, even across off/on', async () => {
	const { editor: s, deferRead, row } = await fixture();
	s.setLive(false);
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

test('live errors preserve local work, recover, and clear on explicit view transitions', async () => {
	const { editor: s, deferRead, row } = await fixture();
	s.setLive(true);
	s.editing = true;
	const original = s.rows;
	deferRead(async () => { throw new Error('offline'); });
	await s.poll();
	assert.equal(s.liveError, 'offline');
	assert.equal(s.error, null);
	assert.equal(s.rows, original);
	assert.equal(s.editing, true);
	assert.equal(s.polling, false);
	deferRead(async () => ({ rows: [row('changed')], hasMore: false }));
	await s.poll();
	assert.equal(s.liveError, null);
	assert.equal(s.externalChange, true);
	s.editing = false;
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
		assert.equal(s.rows[0].key, 'explicit');
	}
});
