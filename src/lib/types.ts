/** How a value should be rendered and edited. */
export type ColumnKind =
	| 'text'
	| 'number'
	| 'boolean'
	| 'timestamp'
	| 'json'
	| 'array'
	| 'uuid'
	| 'enum';

export interface ForeignKey {
	schema: string;
	table: string;
	column: string;
}

export interface Column {
	name: string;
	/** Postgres type as shown in the grid header, e.g. `timestamptz`. */
	type: string;
	kind: ColumnKind;
	nullable: boolean;
	primaryKey?: boolean;
	foreignKey?: ForeignKey;
	enumValues?: string[];
	defaultValue?: string | null;
	comment?: string | null;
}

export interface Table {
	schema: string;
	name: string;
	columns: Column[];
	rowCount: number;
}

/** A single row of a table. `__key` is a stable identity for edits/selection. */
export type Row = Record<string, unknown> & { __key: string };

export type SortDirection = 'asc' | 'desc';

export interface Sort {
	column: string;
	direction: SortDirection;
}
