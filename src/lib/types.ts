/** PostgreSQL text output, never coerced through JS numbers, dates, JSON or arrays. */
export type CellValue = string | null;
export type Values = Record<string, CellValue>;

/** Rendering hints only; PostgreSQL remains the authority for input validation. */
export type ColumnKind = 'text' | 'number' | 'boolean' | 'timestamp' | 'json' | 'array' | 'uuid' | 'enum';

export interface Column {
	name: string;
	type: string;
	kind: ColumnKind;
	/** Arrays only: the element kind when values can be shown as JSON (comma-delimited elements, not json/jsonb). */
	element?: ColumnKind;
	nullable: boolean;
	primaryKey: boolean;
	generated: boolean;
	identity: 'always' | 'by-default' | null;
	defaultValue: string | null;
	enumValues?: string[];
	comment?: string | null;
	foreignKey?: {
		schema: string;
		table: string;
		column: string;
		/** Ordered source/target tuples for this constraint, including this column. */
		columns: string[];
		referencedColumns: string[];
	};
}

export interface Table {
	schema: string;
	name: string;
	/** Views and materialized views are read-only; plain views have no system columns (xmin, ctid). */
	kind: 'table' | 'view' | 'materialized view';
	/** Row-level security is enabled. */
	rls: boolean;
	/** Has the `superbase_realtime` trigger: changes are pushed instead of polled. */
	realtime: boolean;
	columns: Column[];
	/** Catalog estimate, not an exact count. */
	rowCount: number;
}

/** Captured when a row is read. xmin detects concurrent changes; tableoid scopes inheritance. */
export interface RowIdentity {
	pk: Record<string, string>;
	version: string;
	relation: string;
}

/** Metadata is outside the user-controlled column namespace. Draft omissions mean DEFAULT. */
export interface Row {
	key: string;
	values: Values;
	identity: RowIdentity | null;
	draft?: boolean;
}

/** A database the server has open. `key` (`host:port/database · user · sslmode`, no password) names it in requests. */
export interface ConnectionInfo {
	key: string;
	host: string;
	port: string;
	database: string;
	user: string;
}

/** Every database the server has open. */
export interface ServerStatus {
	connections: ConnectionInfo[];
	locked: boolean;
}

/** Ordered, unique column rules; PostgreSQL applies each with NULLS LAST. */
export interface Sort {
	column: string;
	direction: 'asc' | 'desc';
}

export interface TableTarget {
	connection: string;
	schema: string;
	table: string;
	/** Read and write rows as another role (RLS testing); metadata is still read as the connection role. */
	as?: ViewAs;
}

/** Applied per transaction: `set local role` plus `set_config(name, value, true)` for each setting. */
export interface ViewAs {
	role: string;
	settings: Record<string, string>;
}

export const FILTER_OPERATORS = {
	eq: { label: 'Equals', sql: '=', group: 'Comparison', needsValue: true },
	neq: { label: 'Not equal', sql: '<>', group: 'Comparison', needsValue: true },
	gt: { label: 'Greater than', sql: '>', group: 'Comparison', needsValue: true },
	lt: { label: 'Less than', sql: '<', group: 'Comparison', needsValue: true },
	gte: { label: 'Greater or equal', sql: '>=', group: 'Comparison', needsValue: true },
	lte: { label: 'Less or equal', sql: '<=', group: 'Comparison', needsValue: true },
	like: { label: 'Like', sql: 'LIKE', group: 'Pattern matching', needsValue: true },
	ilike: { label: 'iLike', sql: 'ILIKE', group: 'Pattern matching', needsValue: true },
	isNull: { label: 'Is NULL', sql: 'IS NULL', group: 'Null checks', needsValue: false },
	isNotNull: { label: 'Is not NULL', sql: 'IS NOT NULL', group: 'Null checks', needsValue: false }
} as const;

export type FilterOperator = keyof typeof FILTER_OPERATORS;
/** AND-combined conditions. Values are exact PostgreSQL text; unary operators use ''. */
export interface RowFilter {
	column: string;
	operator: FilterOperator;
	value: string;
}

/** Shared selection/order for paginated reads and unpaginated CSV exports. */
export interface RowQuery {
	sort: Sort[];
	/** Broad text search across all columns (reference picker). */
	search?: string;
	/** Exact match on a referenced record (foreign-key navigation), ANDed with `filters`. */
	reference?: Values;
	filters?: RowFilter[];
}

export interface RowsArgs extends TableTarget, RowQuery {
	page: number;
	pageSize: number;
}

export interface CsvExportArgs extends TableTarget {
	/** Emitted in table column order. */
	columns: string[];
	/** The grid's filters and ordering. */
	query: RowQuery;
}

export interface SaveArgs extends TableTarget {
	updates: { identity: RowIdentity; changes: Values }[];
	inserts: Values[];
}

export interface DeleteArgs extends TableTarget {
	identities: RowIdentity[];
}

/** Fetch one extra row instead of counting/scanning the whole table on every page. */
export interface RowsPage {
	rows: Row[];
	hasMore: boolean;
}

export function tableKey(schema: string, table: string): string {
	return JSON.stringify([schema, table]);
}

export function writable(column: Column): boolean {
	return !column.generated && column.identity !== 'always';
}

export function editable(table: Table): boolean {
	return table.columns.some((column) => column.primaryKey);
}
