import { database, deleteRows, saveTable, tableRows } from '#lib/db.remote.js';
import { message } from '#lib/utils.js';
import { editable, tableKey, writable, type CellValue, type Column, type Row, type RowIdentity, type ServerInfo, type Sort, type Table, type Values } from '#lib/types.js';

const EMPTY_TABLE: Table = { schema: '', name: '', columns: [], rowCount: 0 };

type PendingRow = { identity: RowIdentity; original: Values; changes: Values };

/** One browser workspace. Pending mutations own their identities, not page indexes. */
export class EditorState {
	connection = $state('');
	tables = $state<Table[]>([]);
	server = $state<ServerInfo | null>(null);
	ready = $state(false);
	activeSchema = $state('');
	activeTableName = $state('');
	page = $state(0);
	/** Page belonging to displayed rows, which can lag behind a pending sort. */
	rowsPage = $state(0);
	pageSize = $state(100);
	sort = $state<Sort | null>(null);
	search = $state('');
	filter = $state<Values | null>(null);
	rows = $state<Row[]>([]);
	hasMore = $state(false);
	loading = $state(false);
	busy = $state(false);
	editing = $state(false);
	cellSelected = $state(false);
	live = $state(false);
	polling = $state(false);
	externalChange = $state(false);
	liveError = $state<string | null>(null);
	error = $state<string | null>(null);
	savedAt = $state<number | null>(null);

	/** Table keys and row keys are encoded tuples, never unescaped identifiers. */
	edits = $state<Record<string, Record<string, PendingRow>>>({});
	drafts = $state<Record<string, Row[]>>({});
	rowSelection = $state<Record<string, Record<string, Row>>>({});
	#request = 0;
	#liveGeneration = 0;

	tableKey = $derived(tableKey(this.activeSchema, this.activeTableName));
	table = $derived(this.tables.find((table) => table.schema === this.activeSchema && table.name === this.activeTableName) ?? EMPTY_TABLE);
	tableEditable = $derived(editable(this.table));
	schemas = $derived([...new Set(this.tables.map((table) => table.schema))]);
	schemaTables = $derived(this.tables.filter((table) => table.schema === this.activeSchema));
	draftsForTable = $derived(this.drafts[this.tableKey] ?? []);
	pageRows = $derived(this.rowsPage === 0 ? [...this.draftsForTable, ...this.rows] : this.rows);

	get draftCount() { return this.draftsForTable.length; }
	get dirtyCount() {
		return Object.values(this.edits[this.tableKey] ?? {}).reduce((count, row) => count + Object.keys(row.changes).length, 0);
	}
	get hasChanges() { return this.dirtyCount > 0 || this.draftCount > 0; }
	get hasAnyChanges() {
		return Object.values(this.edits).some((rows) => Object.keys(rows).length > 0) || Object.values(this.drafts).some((rows) => rows.length > 0);
	}
	get selectedCount() { return Object.keys(this.rowSelection[this.tableKey] ?? {}).length; }

	async initialize(connection: string) {
		if (this.connection === connection && this.ready) return;
		if (this.connection && this.connection !== connection) {
			if (this.hasAnyChanges) {
				this.ready = false;
				this.error = 'Connection changed. Reconnect or reload to discard local changes; they will not be sent to another database.';
				return;
			}
			this.discardAll();
			this.tables = [];
			this.activeSchema = this.activeTableName = '';
			this.ready = false;
		}
		this.connection = connection;
		await this.reload();
	}

	async reload() {
		if (this.busy || !this.connection) return;
		const request = ++this.#request;
		this.loading = true;
		this.rows = [];
		this.error = null;
		this.liveError = null;
		this.externalChange = false;
		try {
			const resource = database({ connection: this.connection });
			await resource.refresh();
			if (request !== this.#request) return;
			if (resource.error) throw resource.error;
			if (!resource.current) throw new Error('No response from the database');
			this.tables = resource.current.tables;
			this.server = resource.current.server;
			this.ready = true;
			if (!this.table.columns.length) {
				const first = this.tables.find((table) => table.schema === 'public') ?? this.tables[0];
				this.activeSchema = first?.schema ?? '';
				this.activeTableName = first?.name ?? '';
				this.sort = null;
				this.search = '';
				this.filter = null;
			}
			this.page = 0;
			await this.fetch();
		} catch (error) {
			if (request === this.#request) this.error = message(error);
		} finally {
			if (request === this.#request) this.loading = false;
		}
	}

	async fetch(retainRows = false): Promise<void> {
		const request = ++this.#request;
		if (!retainRows) {
			this.rows = [];
			this.rowsPage = this.page;
		}
		this.hasMore = false;
		this.error = null;
		this.liveError = null;
		this.externalChange = false;
		if (!this.activeTableName) { this.loading = false; return; }
		this.loading = true;
		try {
			const resource = tableRows({
				connection: this.connection, schema: this.activeSchema, table: this.activeTableName,
				page: this.page, pageSize: this.pageSize, sort: this.sort, search: this.search,
				...(this.filter ? { filter: this.filter } : {})
			});
			await resource.refresh();
			if (request !== this.#request) return;
			if (resource.error) throw resource.error;
			const result = resource.current;
			if (!result) throw new Error('No response from the database');
			if (!result.rows.length && this.page > 0) {
				this.page = 0;
				return this.fetch();
			}
			this.rows = result.rows;
			this.rowsPage = this.page;
			this.hasMore = result.hasMore;
		} catch (error) {
			if (request === this.#request) {
				this.rows = [];
				this.rowsPage = this.page;
				this.error = message(error);
			}
		} finally {
			if (request === this.#request) this.loading = false;
		}
	}

	setLive(enabled: boolean) {
		this.live = enabled;
		this.#liveGeneration++;
		this.liveError = null;
	}

	async poll(isActive: () => boolean = () => true) {
		const eligible = () => this.live && this.ready && !!this.activeTableName &&
			!this.loading && !this.busy && !this.error && isActive();
		if (this.polling || !eligible()) return;
		const request = this.#request;
		const generation = this.#liveGeneration;
		const current = () => request === this.#request && generation === this.#liveGeneration && eligible();
		this.polling = true;
		try {
			const resource = tableRows({
				connection: this.connection, schema: this.activeSchema, table: this.activeTableName,
				page: this.page, pageSize: this.pageSize, sort: this.sort, search: this.search,
				...(this.filter ? { filter: this.filter } : {})
			});
			await resource.refresh();
			if (!current()) return;
			if (resource.error) throw resource.error;
			const result = resource.current;
			if (!result) throw new Error('No response from the database');
			this.liveError = null;
			if (JSON.stringify(result.rows) === JSON.stringify(this.rows) && result.hasMore === this.hasMore) {
				this.externalChange = false;
				return;
			}
			if (this.hasChanges || this.selectedCount || this.editing || this.cellSelected) {
				this.externalChange = true;
				return;
			}
			this.rows = result.rows;
			this.rowsPage = this.page;
			this.hasMore = result.hasMore;
			this.externalChange = false;
		} catch (error) {
			if (current()) this.liveError = message(error);
		} finally {
			this.polling = false;
		}
	}

	async selectTable(schema: string, name: string, filter: Values | null = null) {
		if (this.busy || (!filter && !this.filter && schema === this.activeSchema && name === this.activeTableName)) return;
		this.activeSchema = schema;
		this.activeTableName = name;
		this.page = 0;
		this.sort = null;
		this.search = '';
		this.filter = filter;
		this.savedAt = null;
		await this.fetch();
	}
	async clearFilter() {
		if (this.busy) return;
		this.filter = null;
		this.page = 0;
		await this.fetch();
	}
	async followReference(row: Row, column: Column) {
		const fk = column.foreignKey;
		if (this.busy || this.loading || !fk) return;
		const values = fk.columns.map((name) => this.getValue(row, name));
		if (values.some((value) => value == null)) return;
		await this.selectTable(fk.schema, fk.table, Object.fromEntries(
			fk.referencedColumns.map((name, i) => [name, values[i] as string])
		));
	}
	async setSchema(schema: string) {
		const first = this.tables.find((table) => table.schema === schema);
		if (first) await this.selectTable(schema, first.name);
	}
	async setPage(page: number) {
		if (this.busy || this.loading || page < 0 || !Number.isSafeInteger(page) || (page > this.page && !this.hasMore)) return;
		this.page = page;
		await this.fetch();
	}
	async setPageSize(size: number) {
		if (this.busy || ![100, 250, 500].includes(size)) return;
		this.pageSize = size;
		this.page = 0;
		await this.fetch();
	}
	async setSearch(search: string) {
		if (this.busy) return;
		this.search = search;
		this.page = 0;
		await this.fetch();
	}
	async toggleSort(column: string) {
		if (this.busy) return;
		this.sort = this.sort?.column !== column ? { column, direction: 'asc' } : this.sort.direction === 'asc' ? { column, direction: 'desc' } : null;
		this.page = 0;
		await this.fetch(true);
	}
	async setSort(column: string) {
		if (this.busy) return;
		this.sort = column ? { column, direction: 'asc' } : null;
		this.page = 0;
		await this.fetch(true);
	}
	async toggleSortDirection() {
		if (this.busy || !this.sort) return;
		this.sort = { ...this.sort, direction: this.sort.direction === 'asc' ? 'desc' : 'asc' };
		this.page = 0;
		await this.fetch(true);
	}

	getValue(row: Row, column: string): CellValue | undefined {
		const changes = this.edits[this.tableKey]?.[row.key]?.changes;
		return changes && Object.hasOwn(changes, column) ? changes[column]
			: Object.hasOwn(row.values, column) ? row.values[column] : undefined;
	}
	hasEdit(key: string, column: string) {
		return Object.hasOwn(this.edits[this.tableKey]?.[key]?.changes ?? {}, column);
	}

	/** Validate a whole reference tuple before applying any of its cells. */
	editCells(row: Row, values: Record<string, CellValue | undefined>): boolean {
		if (this.busy || this.loading || !this.tableEditable) return false;
		const current = this.pageRows.find((candidate) => candidate.key === row.key);
		if (!current || current.identity?.version !== row.identity?.version) return false;
		const changes = Object.entries(values).map(([name, value]) => ({ column: this.table.columns.find((column) => column.name === name), value }));
		if (changes.some(({ column, value }) => !column || !writable(column) ||
			(value === undefined && !row.draft) || (value === null && !column.nullable))) return false;
		for (const { column, value } of changes) this.editCell(current, column!, value);
		return true;
	}

	editCell(row: Row, column: Column, value: CellValue | undefined) {
		if (this.busy || this.loading || !this.tableEditable || !writable(column)) return;
		if (row.draft) {
			const draft = this.draftsForTable.find((candidate) => candidate.key === row.key);
			if (!draft) return;
			if (value === undefined) {
				draft.values = { ...draft.values };
				delete draft.values[column.name];
			} else draft.values = { ...draft.values, [column.name]: value };
		} else {
			if (value === undefined || !row.identity || !this.rows.some((candidate) => candidate.key === row.key)) return;
			const pending = this.edits[this.tableKey] ??= {};
			const change = pending[row.key] ??= {
				identity: $state.snapshot(row.identity), original: { ...row.values }, changes: {}
			};
			change.changes = { ...change.changes, [column.name]: value };
			if (value === change.original[column.name]) delete change.changes[column.name];
			if (!Object.keys(change.changes).length) delete pending[row.key];
		}
		this.savedAt = null;
	}

	insertRow() {
		if (this.busy || this.loading || !this.tableEditable) return;
		this.drafts[this.tableKey] = [{ key: `draft:${crypto.randomUUID()}`, values: {}, identity: null, draft: true }, ...this.draftsForTable];
		this.savedAt = null;
		if (this.page !== 0) { this.page = 0; void this.fetch(); }
	}

	async save() {
		if (this.busy || this.loading || !this.hasChanges) return;
		const key = this.tableKey;
		const args = {
			connection: this.connection, schema: this.activeSchema, table: this.activeTableName,
			updates: Object.values(this.edits[key] ?? {}).map((row) => ({ identity: $state.snapshot(row.identity), changes: { ...row.changes } })),
			inserts: this.draftsForTable.map((row) => ({ ...row.values }))
		};
		this.#liveGeneration++;
		this.busy = true;
		this.error = null;
		try {
			await saveTable(args);
			delete this.edits[key];
			delete this.drafts[key];
			delete this.rowSelection[key];
			this.savedAt = Date.now();
			if (this.tableKey === key && this.connection === args.connection) await this.fetch();
		} catch (error) {
			this.error = message(error);
		} finally { this.busy = false; }
	}

	revert() {
		if (this.busy) return;
		delete this.edits[this.tableKey];
		delete this.drafts[this.tableKey];
		delete this.rowSelection[this.tableKey];
		this.savedAt = null;
	}
	discardAll() {
		this.edits = {};
		this.drafts = {};
		this.rowSelection = {};
		this.editing = false;
	}

	clearRowSelection() {
		if (!this.busy) delete this.rowSelection[this.tableKey];
	}
	isRowSelected(key: string) { return Object.hasOwn(this.rowSelection[this.tableKey] ?? {}, key); }
	toggleRowSelection(row: Row) { this.setRowsSelected([row], !this.isRowSelected(row.key)); }
	setRowsSelected(rows: Row[], selected: boolean) {
		if (this.busy || this.loading || !this.tableEditable) return;
		const selection = this.rowSelection[this.tableKey] ??= {};
		for (const row of rows) {
			if (selected) selection[row.key] = $state.snapshot(row);
			else delete selection[row.key];
		}
	}
	async deleteSelected() {
		if (this.busy || this.loading || !this.selectedCount) return;
		const key = this.tableKey;
		const rows = Object.values(this.rowSelection[key]);
		const removing = new Set(rows.map((row) => row.key));
		const args = {
			connection: this.connection, schema: this.activeSchema, table: this.activeTableName,
			identities: rows.flatMap((row) => row.identity ? [$state.snapshot(row.identity)] : [])
		};
		this.#liveGeneration++;
		this.busy = true;
		this.error = null;
		try {
			if (args.identities.length) await deleteRows(args);
			this.drafts[key] = (this.drafts[key] ?? []).filter((row) => !removing.has(row.key));
			for (const row of rows) if (this.edits[key]) delete this.edits[key][row.key];
			delete this.rowSelection[key];
			if (args.identities.length && this.tableKey === key && this.connection === args.connection) await this.fetch();
		} catch (error) { this.error = message(error); }
		finally { this.busy = false; }
	}
}

export const editor = new EditorState();
