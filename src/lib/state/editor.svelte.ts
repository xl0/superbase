import { deleteRows, saveTable, tableRows } from '#lib/db.remote.js';
import type { Row, ServerInfo, Sort, Table } from '#lib/types.js';

const EMPTY_TABLE: Table = { schema: '', name: '', columns: [], rowCount: 0 };

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class EditorState {
	tables = $state<Table[]>([]);
	server = $state<ServerInfo | null>(null);

	activeSchema = $state('');
	activeTableName = $state('');
	page = $state(0);
	pageSize = $state(100);
	sort = $state<Sort | null>(null);
	search = $state('');

	rows = $state<Row[]>([]);
	total = $state(0);
	loading = $state(false);
	saving = $state(false);
	error = $state<string | null>(null);
	savedAt = $state<number | null>(null);

	/** tableKey -> rowKey -> true */
	rowSelection = $state<Record<string, Record<string, true>>>({});
	/** tableKey -> rowKey -> column -> value */
	edits = $state<Record<string, Record<string, Record<string, unknown>>>>({});
	/** tableKey -> locally inserted rows */
	drafts = $state<Record<string, Row[]>>({});

	#initialized = false;
	#request = 0;

	tableKey = $derived(`${this.activeSchema}.${this.activeTableName}`);

	table = $derived(
		this.tables.find((t) => t.schema === this.activeSchema && t.name === this.activeTableName) ??
			this.tables[0] ??
			EMPTY_TABLE
	);

	schemas = $derived([...new Set(this.tables.map((t) => t.schema))]);
	schemaTables = $derived(this.tables.filter((t) => t.schema === this.activeSchema));

	draftsForTable = $derived(this.drafts[this.tableKey] ?? []);

	pageRows = $derived(
		this.page === 0 ? [...this.draftsForTable, ...this.rows] : this.rows
	);

	pageCount = $derived(Math.max(1, Math.ceil(this.total / this.pageSize)));

	get draftCount() {
		return this.draftsForTable.length;
	}

	get rowCount() {
		return this.total + this.draftCount;
	}

	get dirtyCount() {
		const edits = this.edits[this.tableKey];
		if (!edits) return 0;
		return Object.values(edits).reduce((total, row) => total + Object.keys(row).length, 0);
	}

	get hasChanges() {
		return this.dirtyCount > 0 || this.draftCount > 0;
	}

	get selectedCount() {
		const rows = this.rowSelection[this.tableKey];
		return rows ? Object.keys(rows).length : 0;
	}

	init(data: { tables: Table[]; server: ServerInfo }) {
		if (this.#initialized) return;
		this.#initialized = true;
		this.tables = data.tables;
		this.server = data.server;

		const initial =
			data.tables.find((table) => table.schema === 'public' && table.name === 'users') ??
			data.tables.find((table) => table.schema === 'public') ??
			data.tables[0];

		if (initial) {
			this.activeSchema = initial.schema;
			this.activeTableName = initial.name;
		}
		void this.fetch();
	}

	async fetch(): Promise<void> {
		if (!this.activeSchema || !this.activeTableName) return;
		const request = ++this.#request;
		this.loading = true;
		this.error = null;
		try {
			const args = {
				schema: this.activeSchema,
				table: this.activeTableName,
				page: this.page,
				pageSize: this.pageSize,
				sort: this.sort,
				search: this.search
			};
			const resource = tableRows(args);
			await resource.refresh();
			const page = resource.current;
			if (request !== this.#request) return;
			if (!page) throw new Error('No response from the database');
			if (page.rows.length === 0 && this.page > 0) {
				this.page = Math.max(0, Math.ceil(page.total / this.pageSize) - 1);
				return this.fetch();
			}
			this.rows = page.rows;
			this.total = page.total;
		} catch (error) {
			if (request === this.#request) this.error = message(error);
		} finally {
			if (request === this.#request) this.loading = false;
		}
	}

	async selectTable(schema: string, name: string) {
		if (schema === this.activeSchema && name === this.activeTableName) return;
		this.activeSchema = schema;
		this.activeTableName = name;
		this.page = 0;
		this.sort = null;
		this.search = '';
		this.error = null;
		await this.fetch();
	}

	async setSchema(schema: string) {
		const first = this.tables.find((table) => table.schema === schema);
		if (first) await this.selectTable(schema, first.name);
	}

	async setPage(page: number) {
		this.page = Math.min(Math.max(0, page), this.pageCount - 1);
		await this.fetch();
	}

	async setPageSize(pageSize: number) {
		this.pageSize = pageSize;
		this.page = 0;
		await this.fetch();
	}

	async setSearch(search: string) {
		this.search = search;
		this.page = 0;
		await this.fetch();
	}

	async toggleSort(column: string) {
		if (this.sort?.column !== column) {
			this.sort = { column, direction: 'asc' };
		} else if (this.sort.direction === 'asc') {
			this.sort = { column, direction: 'desc' };
		} else {
			this.sort = null;
		}
		this.page = 0;
		await this.fetch();
	}

	async setSort(column: string) {
		this.sort = column
			? this.sort?.column === column
				? this.sort
				: { column, direction: 'asc' }
			: null;
		this.page = 0;
		await this.fetch();
	}

	async toggleSortDirection() {
		if (!this.sort) return;
		this.sort = {
			...this.sort,
			direction: this.sort.direction === 'asc' ? 'desc' : 'asc'
		};
		await this.fetch();
	}

	async reload() {
		this.page = 0;
		await this.fetch();
	}

	getEdit(rowKey: string, column: string) {
		return this.edits[this.tableKey]?.[rowKey]?.[column];
	}

	hasEdit(rowKey: string, column: string) {
		const edits = this.edits[this.tableKey];
		return edits !== undefined && edits[rowKey] !== undefined && column in edits[rowKey];
	}

	editCell(rowKey: string, column: string, value: unknown) {
		const edits = this.edits[this.tableKey] ?? {};
		const rowEdits = edits[rowKey] ?? {};
		rowEdits[column] = value;
		edits[rowKey] = rowEdits;
		this.edits[this.tableKey] = edits;
		this.savedAt = null;
	}

	isDraft(rowKey: string) {
		return this.draftsForTable.some((row) => row.__key === rowKey);
	}

	insertRow() {
		const draft: Row = {
			__key: `draft:${crypto.randomUUID()}`,
			__draft: true
		};
		for (const column of this.table.columns) {
			draft[column.name] = column.kind === 'boolean' ? false : null;
		}
		this.drafts[this.tableKey] = [draft, ...this.draftsForTable];
		this.page = 0;
		this.savedAt = null;
	}

	async save() {
		if (!this.hasChanges || this.saving) return;
		this.saving = true;
		this.error = null;
		try {
			const edits = this.edits[this.tableKey] ?? {};
			const drafts = this.draftsForTable;
			const draftKeys = new Set(drafts.map((row) => row.__key));

			const updates: { pk: Record<string, unknown>; changes: Record<string, unknown> }[] = [];
			for (const [rowKey, changes] of Object.entries(edits)) {
				if (draftKeys.has(rowKey)) continue;
				const row = this.rows.find((candidate) => candidate.__key === rowKey);
				if (row?.__pk) updates.push({ pk: row.__pk, changes });
			}

			const inserts = drafts.map((draft) => {
				const values: Record<string, unknown> = {};
				for (const column of this.table.columns) {
					const value =
						edits[draft.__key] && column.name in edits[draft.__key]
							? edits[draft.__key][column.name]
							: draft[column.name];
					// A null cell with a database default means "use the default".
					if (value === null && column.defaultValue != null) continue;
					values[column.name] = value;
				}
				return values;
			});

			await saveTable({
				schema: this.activeSchema,
				table: this.activeTableName,
				updates,
				inserts
			});

			this.edits[this.tableKey] = {};
			this.drafts[this.tableKey] = [];
			this.savedAt = Date.now();
			await this.fetch();
		} catch (error) {
			this.error = message(error);
		} finally {
			this.saving = false;
		}
	}

	async revert() {
		this.edits[this.tableKey] = {};
		this.drafts[this.tableKey] = [];
		this.savedAt = null;
	}

	isRowSelected(rowKey: string) {
		return this.rowSelection[this.tableKey]?.[rowKey] === true;
	}

	toggleRowSelection(rowKey: string) {
		const rows = this.rowSelection[this.tableKey] ?? {};
		if (rows[rowKey]) {
			delete rows[rowKey];
		} else {
			rows[rowKey] = true;
		}
		this.rowSelection[this.tableKey] = rows;
	}

	setRowsSelected(rowKeys: string[], selected: boolean) {
		const rows = this.rowSelection[this.tableKey] ?? {};
		for (const rowKey of rowKeys) {
			if (selected) rows[rowKey] = true;
			else delete rows[rowKey];
		}
		this.rowSelection[this.tableKey] = rows;
	}

	clearRowSelection() {
		delete this.rowSelection[this.tableKey];
	}

	async deleteSelected() {
		const selected = this.rowSelection[this.tableKey];
		if (!selected) return;
		const keys = Object.keys(selected);
		if (keys.length === 0) return;

		const draftKeys = new Set(this.draftsForTable.map((row) => row.__key));
		const removingDrafts = keys.filter((key) => draftKeys.has(key));
		const removingRows = keys.filter((key) => !draftKeys.has(key));
		const pks = this.rows
			.filter((row) => removingRows.includes(row.__key))
			.map((row) => row.__pk)
			.filter((pk): pk is Record<string, unknown> => pk !== undefined);

		this.error = null;
		if (pks.length > 0) {
			try {
				await deleteRows({
					schema: this.activeSchema,
					table: this.activeTableName,
					pks
				});
			} catch (error) {
				this.error = message(error);
				return;
			}
		}

		if (removingDrafts.length > 0) {
			this.drafts[this.tableKey] = this.draftsForTable.filter(
				(row) => !removingDrafts.includes(row.__key)
			);
		}
		const edits = this.edits[this.tableKey];
		if (edits) for (const key of keys) delete edits[key];
		delete this.rowSelection[this.tableKey];
		this.table.rowCount = Math.max(0, this.table.rowCount - keys.length);
		if (pks.length > 0) await this.fetch();
	}
}

export const editor = new EditorState();
