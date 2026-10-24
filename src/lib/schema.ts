import type { RowQuery, TableTarget } from './types.js';

/** Catalog identities, never user-supplied SQL type expressions. */
export interface SchemaType {
	oid: string;
	schema: string;
	name: string;
	label: string;
	kind: 'base' | 'enum' | 'domain' | 'array';
	/** Real catalog relationships; domains over arrays remain domains. */
	elementOid: string | null;
	arrayOid: string | null;
	enumValues: string[];
}
export interface SchemaCatalog {
	schemas: string[];
	types: SchemaType[];
}
export interface SchemaColumn {
	name: string;
	type: string;
	typeOid: string;
	/** Decoded editable modifiers; null means an unsupported existing modifier. */
	typeModifiers: number[] | null;
	nullable: boolean;
	defaultValue: string | null;
	generated: boolean;
	identity: 'always' | 'by-default' | null;
	comment: string | null;
	primaryKey: boolean;
}
/** Native index definitions are inspection-only; structured creation accepts plain columns. */
export interface SchemaIndex {
	oid: string;
	name: string;
	method: string;
	definition: string;
	unique: boolean;
	primary: boolean;
	valid: boolean;
	ready: boolean;
	clustered: boolean;
	replicaIdentity: boolean;
	/** Owning PK/UNIQUE/exclusion constraint, not referencing foreign keys. */
	constraint: string | null;
	comment: string | null;
}
export const INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'] as const;

/** version fingerprints semantic catalog metadata, including the table OID. */
export interface SchemaDefinition {
	schema: string;
	table: string;
	oid: string;
	version: string;
	editable: boolean;
	reason: string | null;
	columns: SchemaColumn[];
	primaryKey: string[];
	indexes: SchemaIndex[];
}
export type ColumnDefault =
	| { kind: 'keep' | 'none' | 'now' | 'today' | 'currentTime' | 'uuid' | 'identity' }
	| { kind: 'literal'; value: string };
/** null typeOid preserves an existing exact type/modifiers; never valid for a new column. */
export interface ColumnSpec {
	name: string;
	typeOid: string | null;
	/** Whitelisted numeric modifiers; [] when keeping the existing type. */
	typeModifiers: number[];
	nullable: boolean;
	default: ColumnDefault;
	comment: string;
	primaryKey: boolean;
}
export interface SchemaExport {
	sql: string;
	/** Scope/prerequisites also included as SQL comments in the copied text. */
	warnings: string[];
}

export const DUPLICATE_NOTICE = 'Copies columns, defaults, generated expressions, checks, indexes and comments, with independent owned sequences. Foreign keys, triggers, rules, policies, grants and ownership are not copied. RLS flags are retained; without policies, access may be denied. External types, functions and unowned sequences remain shared. Destination privileges follow PostgreSQL defaults.';

export type SchemaOperation =
	| { kind: 'createTable'; columns: ColumnSpec[] }
	| { kind: 'duplicateTable'; name: string; includeRows: boolean }
	| { kind: 'renameTable'; name: string }
	| { kind: 'dropTable' }
	| { kind: 'addColumn'; column: ColumnSpec }
	| { kind: 'alterColumn'; column: string; changes: ColumnSpec }
	| { kind: 'dropColumn'; column: string }
	| { kind: 'addPrimaryKey'; columns: string[] }
	| { kind: 'createIndex'; name: string; method: typeof INDEX_METHODS[number]; unique: boolean; columns: string[] }
	| { kind: 'dropIndex'; indexOid: string };
export interface SchemaChangeArgs extends TableTarget {
	/** null only for CREATE; existing targets require the last-read fingerprint. */
	expected: string | null;
	operation: SchemaOperation;
}
export type SchemaEditMode =
	| { kind: 'createTable' | 'renameTable' | 'dropTable' | 'addColumn' | 'addPrimaryKey' | 'duplicateTable' | 'copySchema' | 'indexes' }
	| { kind: 'exportCsv'; query?: RowQuery; options?: boolean }
	| { kind: 'alterColumn' | 'dropColumn'; column: string };
