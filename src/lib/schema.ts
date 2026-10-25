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
	/** Ordered key columns (not INCLUDE); eligible native FK keys exclude partial/expression/deferrable indexes. */
	columns: string[];
	referenceable: boolean;
}
export const INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'] as const;

export const REFERENTIAL_ACTIONS = ['no action', 'restrict', 'cascade', 'set null', 'set default'] as const;
export type ReferentialAction = typeof REFERENTIAL_ACTIONS[number];
export interface ForeignKeyDefinition {
	schema: string;
	table: string;
	tableOid: string;
	columns: string[];
	match: 'simple' | 'full' | 'partial';
	onUpdate: ReferentialAction;
	onDelete: ReferentialAction;
}

/** Owned UNIQUE/CHECK/FK constraints; PK and exclusion definitions remain in index inspection. */
export interface SchemaConstraint {
	oid: string;
	name: string;
	kind: 'u' | 'c' | 'f';
	definition: string;
	columns: string[];
	expression: string | null;
	foreignKey: ForeignKeyDefinition | null;
	validated: boolean;
	enforced: boolean;
	deferrable: boolean;
	initiallyDeferred: boolean;
	noInherit: boolean;
	nullsNotDistinct: boolean;
	comment: string | null;
	indexOid: string | null;
	indexComment: string | null;
	/** Replacement would otherwise discard unsupported native index/constraint options. */
	replaceable: boolean;
}
export type ConstraintSpec =
	| { kind: 'unique'; name: string; columns: string[]; nullsNotDistinct: boolean; deferrable: boolean; initiallyDeferred: boolean }
	| { kind: 'check'; name: string; expression: string; notValid: boolean; noInherit: boolean }
	| { kind: 'foreignKey'; name: string; columns: string[];
		reference: { schema: string; table: string; oid: string; version: string; columns: string[] };
		match: 'simple' | 'full'; onUpdate: ReferentialAction; onDelete: ReferentialAction;
		notValid: boolean; deferrable: boolean; initiallyDeferred: boolean };
/** Column forms stage only additions, replacements and removals; the outer Apply owns the transaction. */
export type ColumnConstraintOperation =
	| { kind: 'addConstraint'; constraint: ConstraintSpec }
	| { kind: 'alterConstraint'; constraintOid: string; constraint: ConstraintSpec }
	| { kind: 'dropConstraint'; constraintOid: string };
export type ConstraintOperation = ColumnConstraintOperation
	| { kind: 'renameConstraint'; constraintOid: string; name: string }
	| { kind: 'validateConstraint'; constraintOid: string };

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
	constraints: SchemaConstraint[];
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

export type SchemaOperation = ConstraintOperation
	| { kind: 'createTable'; columns: ColumnSpec[] }
	| { kind: 'duplicateTable'; name: string; includeRows: boolean }
	| { kind: 'renameTable'; name: string }
	| { kind: 'dropTable' }
	| { kind: 'addColumn'; column: ColumnSpec }
	| { kind: 'alterColumn'; column: string; changes: ColumnSpec; constraints?: ColumnConstraintOperation[] }
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
	| { kind: 'createTable' | 'renameTable' | 'dropTable' | 'addColumn' | 'addPrimaryKey' | 'duplicateTable' | 'copySchema' | 'indexes' | 'constraints' }
	| { kind: 'exportCsv'; query?: RowQuery; options?: boolean }
	| { kind: 'alterColumn' | 'dropColumn'; column: string };
