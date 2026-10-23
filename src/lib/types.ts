/** PostgreSQL text output, never coerced through JS numbers, dates, JSON or arrays. */
export type CellValue = string | null;
export type Values = Record<string, CellValue>;

/** Rendering hints only; PostgreSQL remains the authority for input validation. */
export type ColumnKind = 'text' | 'number' | 'boolean' | 'timestamp' | 'json' | 'array' | 'uuid' | 'enum';

export interface Column {
	name: string;
	type: string;
	kind: ColumnKind;
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

export interface ServerInfo {
	version: string;
	database: string;
	user: string;
	host: string | null;
	port: number | null;
}

/** id is a public generation, NOT the HttpOnly session bearer token. */
export interface ConnectionInfo {
	id: string;
	source: 'session' | 'env';
	host: string;
	port: string;
	database: string;
	user: string;
}

export interface ConnectionStatus {
	connection: ConnectionInfo | null;
	defaultAvailable: boolean;
	expired: boolean;
	error?: string;
}

export interface Sort {
	column: string;
	direction: 'asc' | 'desc';
}

export interface TableTarget {
	connection: string;
	schema: string;
	table: string;
}

export interface RowsArgs extends TableTarget {
	page: number;
	pageSize: number;
	sort: Sort | null;
	search: string;
	filter?: Values;
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
