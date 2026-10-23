import { getMockRows, mockTables } from '#lib/data/mock.js';
import type { Row, Sort, Table } from '#lib/types.js';

function compare(a: unknown, b: unknown): number {
	if (a === b) return 0;
	if (a === null || a === undefined) return 1;
	if (b === null || b === undefined) return -1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	return String(a).localeCompare(String(b));
}

export class EditorState {
	tables = $state<Table[]>(mockTables);
	activeSchema = $state('public');
	activeTableName = $state('users');
	page = $state(0);
	pageSize = $state(100);
	sort = $state<Sort | null>(null);
	search = $state('');
	/** tableKey -> rowKey -> column -> value */
	edits = $state<Record<string, Record<string, Record<string, unknown>>>>({});
	savedAt = $state<number | null>(null);

	#loaded = $state<Record<string, Row[]>>({});
	#newRows = $state<Record<string, string[]>>({});

	tableKey = $derived(`${this.activeSchema}.${this.activeTableName}`);

	table = $derived(
		this.tables.find((t) => t.schema === this.activeSchema && t.name === this.activeTableName) ??
			this.tables[0]
	);

	schemas = $derived([...new Set(this.tables.map((t) => t.schema))]);

	schemaTables = $derived(this.tables.filter((t) => t.schema === this.activeSchema));

	rows = $derived(this.#loaded[this.tableKey] ?? []);

	filtered = $derived.by(() => {
		const query = this.search.trim().toLowerCase();
		if (!query) return this.rows;
		return this.rows.filter((row) =>
			this.table.columns.some((column) => {
				const value = row[column.name];
				return value !== null && String(value).toLowerCase().includes(query);
			})
		);
	});

	sorted = $derived.by(() => {
		const sort = this.sort;
		if (!sort) return this.filtered;
		const sorted = [...this.filtered];
		sorted.sort((a, b) => {
			const result = compare(a[sort.column], b[sort.column]);
			return sort.direction === 'asc' ? result : -result;
		});
		return sorted;
	});

	pageRows = $derived(this.sorted.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize));

	pageCount = $derived(Math.max(1, Math.ceil(this.sorted.length / this.pageSize)));

	get dirtyCount() {
		const edits = this.edits[this.tableKey];
		if (!edits) return 0;
		return Object.values(edits).reduce((total, row) => total + Object.keys(row).length, 0);
	}

	constructor() {
		this.ensureLoaded();
	}

	ensureLoaded() {
		if (!this.#loaded[this.tableKey]) {
			this.#loaded[this.tableKey] = getMockRows(this.table);
		}
	}

	reload() {
		this.#loaded[this.tableKey] = getMockRows(this.table);
		delete this.edits[this.tableKey];
		delete this.#newRows[this.tableKey];
		this.savedAt = null;
	}

	selectTable(schema: string, name: string) {
		if (schema === this.activeSchema && name === this.activeTableName) return;
		this.activeSchema = schema;
		this.activeTableName = name;
		this.page = 0;
		this.sort = null;
		this.search = '';
		this.ensureLoaded();
	}

	setSchema(schema: string) {
		const first = this.tables.find((t) => t.schema === schema);
		if (first) this.selectTable(schema, first.name);
	}

	setPage(page: number) {
		this.page = Math.min(Math.max(0, page), this.pageCount - 1);
	}

	toggleSort(column: string) {
		if (this.sort?.column !== column) {
			this.sort = { column, direction: 'asc' };
		} else if (this.sort.direction === 'asc') {
			this.sort = { column, direction: 'desc' };
		} else {
			this.sort = null;
		}
		this.page = 0;
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

	revert() {
		const newRows = new Set(this.#newRows[this.tableKey] ?? []);
		if (newRows.size > 0) {
			this.#loaded[this.tableKey] = this.rows.filter((row) => !newRows.has(row.__key));
		}
		delete this.edits[this.tableKey];
		delete this.#newRows[this.tableKey];
		this.savedAt = null;
	}

	save() {
		const edits = this.edits[this.tableKey] ?? {};
		for (const [rowKey, changes] of Object.entries(edits)) {
			const row = this.rows.find((candidate) => candidate.__key === rowKey);
			if (!row) continue;
			Object.assign(row, changes);
		}
		this.edits[this.tableKey] = {};
		this.#newRows[this.tableKey] = [];
		this.savedAt = Date.now();
	}

	insertRow() {
		const row: Row = { __key: `${this.tableKey}:new:${crypto.randomUUID()}` };
		const changes: Record<string, unknown> = {};
		for (const column of this.table.columns) {
			const value =
				column.kind === 'boolean' ? false : column.kind === 'number' ? null : column.kind === 'enum' ? (column.enumValues?.[0] ?? null) : null;
			row[column.name] = value;
			changes[column.name] = value;
		}
		this.#loaded[this.tableKey] = [row, ...this.rows];
		const edits = this.edits[this.tableKey] ?? {};
		edits[row.__key] = changes;
		this.edits[this.tableKey] = edits;
		this.#newRows[this.tableKey] = [...(this.#newRows[this.tableKey] ?? []), row.__key];
		this.page = 0;
		this.sort = null;
		this.savedAt = null;
	}
}

export const editor = new EditorState();
