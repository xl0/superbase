import { database, deleteRows, saveTable, tableRows, changeSchema } from '#lib/db.remote.js';
import { message } from '#lib/utils.js';
import type { SchemaChangeArgs } from '#lib/schema.js';
import { editable, tableKey, writable, MAX_SORTS, type CellValue, type Column, type Row, type RowIdentity, type RowFilter, type SaveArgs, type ServerInfo, type Sort, type Table, type Values } from '#lib/types.js';

const EMPTY_TABLE: Table = { schema: '', name: '', columns: [], rowCount: 0 };

// Svelte's snapshot drops __proto__ keys; PK column names must survive capture exactly.
const copyIdentity = (identity: RowIdentity): RowIdentity => ({ ...identity, pk: { ...identity.pk } });

/** One browser workspace. Mutations capture row identities, never page indexes. */
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
	sort = $state<Sort[]>([]);
	filters = $state<RowFilter[]>([]);
	filter = $state<Values | null>(null);
	rows = $state<Row[]>([]);
	hasMore = $state(false);
	loading = $state(false);
	busy = $state(false);
	editing = $state(false);
	inserting = $state(false);
	schemaEditing = $state(false);
	cellSelected = $state(false);
	live = $state(true);
	polling = $state(false);
	externalChange = $state(false);
	liveError = $state<string | null>(null);
	error = $state<string | null>(null);
	savedAt = $state<number | null>(null);

	/** Selections own their captured identities across pages. */
	rowSelection = $state<Record<string, Record<string, RowIdentity>>>({});
	#request = 0;
	#liveGeneration = 0;

	tableKey = $derived(tableKey(this.activeSchema, this.activeTableName));
	table = $derived(this.tables.find((table) => table.schema === this.activeSchema && table.name === this.activeTableName) ?? EMPTY_TABLE);
	tableEditable = $derived(editable(this.table));
	schemas = $derived([...new Set(this.tables.map((table) => table.schema))]);
	schemaTables = $derived(this.tables.filter((table) => table.schema === this.activeSchema));
	get navigationBlocked() { return this.busy || this.editing || this.inserting || this.schemaEditing; }
	get hasFilters() { return this.filters.length > 0 || this.filter !== null; }
	get selectedCount() { return Object.keys(this.rowSelection[this.tableKey] ?? {}).length; }

	async initialize(connection: string) {
		if (this.connection === connection && this.ready) return;
		if (this.connection && this.connection !== connection) {
			if (this.navigationBlocked) {
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
		if (this.navigationBlocked || !this.connection) return;
		await this.#reload();
	}

	async #reload() {
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
			if (this.table === EMPTY_TABLE) {
				const first = this.tables.find((table) => table.schema === 'public') ?? this.tables[0];
				this.activeSchema = first?.schema ?? '';
				this.activeTableName = first?.name ?? '';
				this.sort = [];
				this.filters = [];
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
				page: this.page, pageSize: this.pageSize, sort: this.sort, search: '', filters: this.filters,
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
			!this.loading && !this.busy && !this.schemaEditing && !this.error && isActive();
		if (this.polling || !eligible()) return;
		const request = this.#request;
		const generation = this.#liveGeneration;
		const current = () => request === this.#request && generation === this.#liveGeneration && eligible();
		this.polling = true;
		try {
			const resource = tableRows({
				connection: this.connection, schema: this.activeSchema, table: this.activeTableName,
				page: this.page, pageSize: this.pageSize, sort: this.sort, search: '', filters: this.filters,
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
			if (this.inserting || this.selectedCount || this.editing || this.cellSelected) {
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
		if (this.navigationBlocked || (!filter && !this.filter && schema === this.activeSchema && name === this.activeTableName)) return;
		this.activeSchema = schema;
		this.activeTableName = name;
		this.page = 0;
		this.sort = [];
		this.filters = [];
		this.filter = filter;
		this.savedAt = null;
		await this.fetch();
	}
	async clearFilters() {
		if (this.navigationBlocked) return;
		this.filters = [];
		this.filter = null;
		this.page = 0;
		await this.fetch();
	}
	async followReference(row: Row, column: Column) {
		const fk = column.foreignKey;
		if (this.navigationBlocked || this.loading || !fk) return;
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
		if (this.navigationBlocked || this.loading || page < 0 || !Number.isSafeInteger(page) || (page > this.page && !this.hasMore)) return;
		this.page = page;
		await this.fetch();
	}
	async setPageSize(size: number) {
		if (this.navigationBlocked || ![100, 250, 500].includes(size)) return;
		this.pageSize = size;
		this.page = 0;
		await this.fetch();
	}
	async setFilters(filters: RowFilter[]) {
		if (this.navigationBlocked) return;
		this.filters = filters.map((filter) => ({ ...filter }));
		this.page = 0;
		await this.fetch();
	}
	async toggleSort(column: string) {
		if (this.navigationBlocked) return;
		const sort = [...this.sort];
		const index = sort.findIndex((rule) => rule.column === column);
		if (index < 0) {
			if (sort.length >= MAX_SORTS) return;
			sort.push({ column, direction: 'asc' });
		} else if (sort[index].direction === 'asc') sort[index] = { column, direction: 'desc' };
		else sort.splice(index, 1);
		await this.setSort(sort);
	}
	async setSort(sort: Sort[]) {
		if (this.navigationBlocked) return;
		this.sort = sort.map((rule) => ({ ...rule }));
		this.page = 0;
		await this.fetch(true);
	}

	async applySchemaChange(args: SchemaChangeArgs) {
		if (!this.schemaEditing || this.editing || this.inserting || this.busy || this.loading || !this.ready) {
			throw new Error('The workspace is not ready for schema editing');
		}
		if (args.connection !== this.connection) throw new Error('Connection changed; reopen the schema editor');
		// Schema intents contain JSON scalars only; snapshot before any asynchronous work.
		const submitted: SchemaChangeArgs = JSON.parse(JSON.stringify(args));
		this.#request++;
		this.#liveGeneration++;
		this.busy = true;
		this.savedAt = null;
		try {
			await changeSchema(submitted);
			this.savedAt = Date.now();
			this.rowSelection = {};
			this.cellSelected = false;
			this.filters = [];
			this.filter = null;
			this.sort = [];
			this.activeSchema = submitted.schema;
			this.activeTableName = submitted.operation.kind === 'renameTable' ? submitted.operation.name : submitted.table;
			// An acknowledged DDL write stays successful even if metadata refresh fails.
			await this.#reload();
		} finally { this.busy = false; }
	}

	getValue(row: Row, column: string): CellValue | undefined {
		return Object.hasOwn(row.values, column) ? row.values[column] : undefined;
	}

	/** One atomic write for a cell, composite reference, or rectangular paste. */
	async updateRows(changes: { row: Row; values: Record<string, CellValue | undefined> }[]) {
		if (this.inserting) throw new Error('Finish inserting the new row first');
		const key = this.tableKey;
		const updatedKeys: string[] = [];
		const updates = changes.map(({ row, values }) => {
			const current = this.rows.find((candidate) => candidate.key === row.key);
			if (!row.identity || !current || JSON.stringify(current.identity) !== JSON.stringify(row.identity)) {
				throw new Error('This row is no longer current. Cancel and refresh before editing again.');
			}
			const entries = Object.entries(values);
			for (const [name, value] of entries) {
				const column = this.table.columns.find((column) => column.name === name);
				if (!column || !writable(column)) throw new Error(`Column is not writable: ${name}`);
				if (value === undefined) throw new Error('DEFAULT is only available in the new-row form');
				if (value === null && !column.nullable) throw new Error(`${name} does not allow NULL`);
			}
			const changed = entries.filter(([name, value]) => value !== row.values[name]);
			if (changed.length) updatedKeys.push(row.key);
			return { identity: copyIdentity(row.identity), changes: Object.fromEntries(changed) as Values };
		}).filter((update) => Object.keys(update.changes).length);
		if (!updates.length) return;
		await this.#save(updates, []);
		// Updated versions must not remain selected for a later delete; unrelated selections survive.
		for (const rowKey of updatedKeys) if (this.rowSelection[key]) delete this.rowSelection[key][rowKey];
	}

	startInsert() {
		if (!this.navigationBlocked && !this.loading && this.ready && this.tableEditable) this.inserting = true;
	}

	async insertRow(values: Values) {
		await this.#save([], [{ ...values }]);
	}

	async #save(updates: SaveArgs['updates'], inserts: Values[]) {
		if (this.busy || this.loading || this.schemaEditing || !this.ready || !this.tableEditable) throw new Error('The table is not ready for editing');
		const key = this.tableKey;
		const args = { connection: this.connection, schema: this.activeSchema, table: this.activeTableName, updates, inserts };
		this.#liveGeneration++;
		this.busy = true;
		this.savedAt = null;
		this.error = null;
		try {
			await saveTable(args);
			this.savedAt = Date.now();
			// Read failure after an acknowledged write must not turn Save into a duplicate-write retry.
			if (this.tableKey === key && this.connection === args.connection) await this.fetch(true);
		} finally { this.busy = false; }
	}

	discardAll() {
		this.rowSelection = {};
		this.editing = false;
		this.inserting = false;
		this.schemaEditing = false;
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
			if (selected && row.identity) selection[row.key] = copyIdentity(row.identity);
			else delete selection[row.key];
		}
	}
	async deleteSelected() {
		if (this.navigationBlocked || this.loading || !this.selectedCount) return;
		const key = this.tableKey;
		const args = {
			connection: this.connection, schema: this.activeSchema, table: this.activeTableName,
			identities: Object.values(this.rowSelection[key]).map(copyIdentity)
		};
		this.#liveGeneration++;
		this.busy = true;
		this.error = null;
		try {
			if (args.identities.length) await deleteRows(args);
			delete this.rowSelection[key];
			if (args.identities.length && this.tableKey === key && this.connection === args.connection) await this.fetch();
		} catch (error) { this.error = message(error); }
		finally { this.busy = false; }
	}
}

export const editor = new EditorState();
