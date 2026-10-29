import { database, deleteRows, saveTable, tableRows, changeSchema } from '#lib/db.remote.js';
import { fresh, message } from '#lib/utils.js';
import type { SchemaChange } from '#lib/schema.js';
import type { TableView } from '#lib/view.js';
import { qualify, realtimeSql } from '#lib/ddl.js';
import { editable, tableKey, writable, type CellValue, type Column, type Row, type RowIdentity, type RowFilter, type SaveArgs, type Sort, type Table, type Values, type ViewAs } from '#lib/types.js';

const EMPTY_TABLE: Table = { schema: '', name: '', kind: 'table', rls: false, realtime: false, columns: [], rowCount: 0 };

// Plain copies: identities are kept in $state and sent to the server later.
const copyIdentity = (identity: RowIdentity): RowIdentity => ({ ...identity, pk: { ...identity.pk } });

/** One browser workspace. Mutations capture row identities, never page indexes. */
export class EditorState {
	connection = $state('');
	tables = $state<Table[]>([]);
	version = $state('');
	/** The connection role, whether it bypasses RLS, and the roles "view as" can pick. */
	role = $state('');
	bypass = $state(false);
	roles = $state<string[]>([]);
	/** Usable schemas, including ones without tables. */
	schemas = $state<string[]>([]);
	/** Grid reads and writes act as this role (RLS testing); null = the connection role as is. */
	viewAs = $state.raw<ViewAs | null>(null);
	ready = $state(false);
	activeSchema = $state('');
	activeTableName = $state('');
	page = $state(0);
	/** Page belonging to displayed rows, which can lag behind a pending sort. */
	rowsPage = $state(0);
	pageSize = $state(100);
	sort = $state<Sort[]>([]);
	filters = $state<RowFilter[]>([]);
	/** Exact referenced-record match from FK navigation; separate from user `filters`. */
	reference = $state<Values | null>(null);
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
	/** The realtime event stream is connected (EditorApp); realtime tables then skip the timed poll. */
	realtime = $state(false);
	/** Why realtime cannot work on this database (notifications never arrive), or null. */
	realtimeIssue = $state<string | null>(null);
	externalChange = $state(false);
	liveError = $state<string | null>(null);
	error = $state<string | null>(null);
	savedAt = $state<number | null>(null);

	/** Selections own their captured identities across pages. */
	rowSelection = $state<Record<string, Record<string, RowIdentity>>>({});
	#request = 0;
	/** Metadata reloads count separately: a row read started meanwhile must not discard the new metadata. */
	#metadata = 0;
	#liveGeneration = 0;
	/** A poll was asked for while one ran, which may have read before the change: poll again after it. */
	#pollAgain = false;

	tableKey = $derived(tableKey(this.activeSchema, this.activeTableName));
	table = $derived(this.tables.find((table) => table.schema === this.activeSchema && table.name === this.activeTableName) ?? EMPTY_TABLE);
	tableEditable = $derived(editable(this.table));
	schemaTables = $derived(this.tables.filter((table) => table.schema === this.activeSchema));
	get navigationBlocked() { return this.busy || this.editing || this.inserting || this.schemaEditing; }
	get hasFilters() { return this.filters.length > 0 || this.reference !== null; }
	get selectedCount() { return Object.keys(this.rowSelection[this.tableKey] ?? {}).length; }
	/** Spread into row requests. */
	get #as() { return this.viewAs ? { as: this.viewAs } : {}; }
	/** What the URL records; see EditorApp for the sync. */
	get view(): TableView {
		return { schema: this.activeSchema, table: this.activeTableName, filters: this.filters, sort: this.sort, page: this.page, reference: this.reference };
	}

	/** `view` comes from the URL; an unknown table falls back to the schema's first one (none in an empty schema). */
	async initialize(connection: string, view?: TableView) {
		this.connection = connection;
		if (view) this.#assign(view);
		await this.reload();
	}

	/** Without sorts, filters and references on columns its table lacks (hand-edited or stale links). */
	validView(view: TableView): TableView {
		const table = this.tables.find((table) => table.schema === view.schema && table.name === view.table);
		if (!table) return view;
		const known = (name: string) => table.columns.some((column) => column.name === name);
		return { ...view,
			filters: view.filters.filter((filter) => known(filter.column)),
			sort: view.sort.filter((rule, i) => known(rule.column) && view.sort.findIndex((other) => other.column === rule.column) === i),
			reference: view.reference && Object.keys(view.reference).every(known) ? view.reference : null };
	}

	#assign(view: TableView) {
		this.activeSchema = view.schema;
		this.activeTableName = view.table;
		this.filters = view.filters.map((filter) => ({ ...filter }));
		this.sort = view.sort.map((rule) => ({ ...rule }));
		this.page = view.page;
		this.reference = view.reference && { ...view.reference };
	}

	/** Apply a view from the URL (link, Back/Forward); a no-op when nothing differs. */
	async show(view: TableView) {
		if (this.navigationBlocked || JSON.stringify(view) === JSON.stringify(this.view)) return;
		const known = this.tables.some((table) => table.schema === view.schema && table.name === view.table);
		const schema = this.schemas.includes(view.schema) ? view.schema : this.tables[0]?.schema;
		if (!schema) return;
		const first = this.tables.find((table) => table.schema === schema)?.name ?? '';
		this.#assign(known ? this.validView(view) : { schema, table: first, filters: [], sort: [], page: 0, reference: null });
		this.savedAt = null;
		await this.fetch();
	}

	async reload() {
		if (this.navigationBlocked || !this.connection) return;
		await this.#reload();
	}

	/** Reloads metadata, then the rows; the view (page, filters…) survives while its table exists. */
	async #reload(retainRows = true) {
		const reload = ++this.#metadata;
		const request = ++this.#request;
		this.loading = true;
		if (!retainRows) this.rows = [];
		this.error = null;
		this.liveError = null;
		this.externalChange = false;
		try {
			const result = await fresh(database({ connection: this.connection }));
			if (reload !== this.#metadata) return;
			this.tables = result.tables;
			this.version = result.version;
			this.role = result.role;
			this.bypass = result.bypass;
			this.roles = result.roles;
			this.schemas = result.schemas;
			this.ready = true;
			const replaced = this.table === EMPTY_TABLE;
			if (!replaced) this.#assign(this.validView(this.view));
			if (replaced) {
				// Keep an existing (possibly empty) schema; otherwise prefer public's tables.
				const schema = this.schemas.includes(this.activeSchema) ? this.activeSchema
					: (this.tables.find((table) => table.schema === 'public') ?? this.tables[0])?.schema ?? this.schemas[0] ?? '';
				this.activeSchema = schema;
				this.activeTableName = this.tables.find((table) => table.schema === schema)?.name ?? '';
				this.sort = [];
				this.filters = [];
				this.reference = null;
				this.page = 0;
			}
			// A navigation started meanwhile reads its own rows, unless its table is gone and the view was just replaced.
			if (request === this.#request || replaced) await this.fetch(retainRows && !replaced);
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
			const result = await this.#readRows();
			if (request !== this.#request) return;
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

	#readRows() {
		return fresh(tableRows({
			connection: this.connection, schema: this.activeSchema, table: this.activeTableName,
			page: this.page, pageSize: this.pageSize, sort: this.sort, filters: this.filters,
			...(this.reference ? { reference: this.reference } : {}), ...this.#as
		}));
	}

	setLive(enabled: boolean) {
		this.live = enabled;
		this.#liveGeneration++;
		this.liveError = null;
	}

	async poll(isActive: () => boolean = () => true) {
		if (this.polling) { this.#pollAgain = true; return; }
		const eligible = () => this.live && this.ready && !!this.activeTableName &&
			!this.loading && !this.busy && !this.schemaEditing && isActive();
		if (!eligible()) return;
		const request = this.#request;
		const generation = this.#liveGeneration;
		const current = () => request === this.#request && generation === this.#liveGeneration && eligible();
		this.polling = true;
		try {
			const result = await this.#readRows();
			if (!current()) return;
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
			this.error = null; // Fresh rows supersede an earlier read or action error.
		} catch (error) {
			if (current()) this.liveError = message(error);
		} finally {
			this.polling = false;
			if (this.#pollAgain) {
				this.#pollAgain = false;
				await this.poll(isActive);
			}
		}
	}

	async selectTable(schema: string, name: string, reference: Values | null = null) {
		if (this.navigationBlocked || (!reference && !this.reference && schema === this.activeSchema && name === this.activeTableName)) return;
		this.#assign({ schema, table: name, filters: [], sort: [], page: 0, reference });
		this.savedAt = null;
		await this.fetch();
	}
	async clearFilters() {
		if (this.navigationBlocked) return;
		this.filters = [];
		this.reference = null;
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
		await this.selectTable(schema, this.tables.find((table) => table.schema === schema)?.name ?? '');
	}
	/** Adds or drops the open table's realtime trigger right away; sort, filters and page survive. */
	async setRealtime(enable: boolean) {
		if (this.navigationBlocked || this.loading || this.table.kind !== 'table') return;
		this.busy = true;
		this.error = null;
		try {
			await changeSchema({ connection: this.connection, sql: realtimeSql(qualify(this.activeSchema, this.activeTableName), enable) });
		} catch (error) {
			this.error = message(error);
			return;
		} finally { this.busy = false; }
		this.table.realtime = enable;
	}

	/** Selections are dropped: their rows were read as the previous role. */
	async setViewAs(next: ViewAs | null) {
		if (this.navigationBlocked) return;
		this.viewAs = next;
		this.rowSelection = {};
		this.page = 0;
		await this.fetch();
	}
	async setPage(page: number) {
		if (this.navigationBlocked || this.loading || page < 0 || (page > this.page && !this.hasMore)) return;
		this.page = page;
		await this.fetch();
	}
	async setPageSize(size: number) {
		if (this.navigationBlocked) return;
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
		if (index < 0) sort.push({ column, direction: 'asc' });
		else if (sort[index].direction === 'asc') sort[index] = { column, direction: 'desc' };
		else sort.splice(index, 1);
		await this.setSort(sort);
	}
	async setSort(sort: Sort[]) {
		if (this.navigationBlocked) return;
		this.sort = sort.map((rule) => ({ ...rule }));
		this.page = 0;
		await this.fetch(true);
	}

	async applySchema(change: SchemaChange) {
		if (this.editing || this.inserting || this.busy || this.loading) throw new Error('Finish editing rows first');
		this.#liveGeneration++;
		this.busy = true;
		this.savedAt = null;
		try {
			await changeSchema({ connection: this.connection, sql: change.sql });
			this.savedAt = Date.now();
			this.rowSelection = {};
			this.filters = [];
			this.reference = null;
			this.sort = [];
			this.page = 0;
			if (change.select) {
				this.activeSchema = change.select.schema;
				this.activeTableName = change.select.table;
			}
			// The DDL is committed; a failed refresh below is a read error, not a failed change.
			await this.#reload(false);
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
		const args = { connection: this.connection, schema: this.activeSchema, table: this.activeTableName, updates, inserts, ...this.#as };
		this.#liveGeneration++;
		this.busy = true;
		this.savedAt = null;
		this.error = null;
		try {
			await saveTable(args);
			this.savedAt = Date.now();
			// Read failure after an acknowledged write must not turn Save into a duplicate-write retry.
			if (this.tableKey === key) await this.fetch(true);
		} finally { this.busy = false; }
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
			identities: Object.values(this.rowSelection[key]).map(copyIdentity), ...this.#as
		};
		this.#liveGeneration++;
		this.busy = true;
		this.error = null;
		try {
			await deleteRows(args);
			delete this.rowSelection[key];
			if (this.tableKey === key) await this.fetch();
		} catch (error) { this.error = message(error); }
		finally { this.busy = false; }
	}
}

export const editor = new EditorState();
