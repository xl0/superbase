import type { RowQuery } from './types.js';

/** Approved column types for the type picker (builtins, enums, domains and their arrays). */
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
	nullable: boolean;
	defaultValue: string | null;
	generated: boolean;
	identity: 'always' | 'by-default' | null;
	comment: string | null;
}
export interface SchemaIndex {
	name: string;
	definition: string;
	unique: boolean;
	primary: boolean;
	/** Owning PK/UNIQUE/exclusion constraint: drop that instead of the index. */
	constraint: string | null;
}
export const REFERENTIAL_ACTIONS = ['no action', 'restrict', 'cascade', 'set null', 'set default'] as const;
export type ReferentialAction = typeof REFERENTIAL_ACTIONS[number];
/** UNIQUE, CHECK and FOREIGN KEY constraints owned by the table. */
export interface SchemaConstraint {
	name: string;
	kind: 'u' | 'c' | 'f';
	definition: string;
	columns: string[];
	expression: string | null;
	foreignKey: { schema: string; table: string; columns: string[]; onUpdate: ReferentialAction; onDelete: ReferentialAction } | null;
}
export interface SchemaDefinition {
	schema: string;
	table: string;
	columns: SchemaColumn[];
	primaryKey: string[];
	indexes: SchemaIndex[];
	constraints: SchemaConstraint[];
}

export type SchemaEditMode =
	| { kind: 'createTable' | 'renameTable' | 'dropTable' | 'duplicateTable' | 'addColumn' | 'addPrimaryKey' | 'indexes' | 'constraints' | 'refreshView' }
	| { kind: 'alterColumn' | 'dropColumn'; column: string }
	| { kind: 'exportCsv'; query?: RowQuery; options?: boolean };

/** What a schema form wants applied: one DDL script, run in a single transaction. */
export interface SchemaChange {
	sql: string;
	/** Table to show after applying (created/renamed/duplicated). */
	select?: { schema: string; table: string };
	destructive?: boolean;
}
