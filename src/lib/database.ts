/** An index anywhere in the database (outside system schemas). */
export interface DatabaseIndex {
	schema: string;
	table: string;
	name: string;
	/** Key columns or expressions. */
	columns: string[];
	definition: string;
	/** Owning PK/UNIQUE/exclusion constraint: drop that instead. */
	constraint: string | null;
}

export type PolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete';
/** A row-level security policy. Roles are names; `public` means every role. */
export interface Policy {
	name: string;
	command: PolicyCommand;
	permissive: boolean;
	roles: string[];
	/** Rows visible/affected (null when absent); not allowed for insert. */
	using: string | null;
	/** Rows that may be written; not allowed for select/delete. */
	check: string | null;
}
export interface PolicyTable {
	schema: string;
	table: string;
	owner: string;
	/** RLS on; `forced` also applies it to the owner. */
	enabled: boolean;
	forced: boolean;
	policies: Policy[];
	/** Explicit privileges of roles other than the owner (`public` = everyone). */
	grants: { role: string; privilege: string }[];
}
/** `bypass`: the connected role skips RLS everywhere (superuser or BYPASSRLS); owners also skip unforced tables. */
export interface Policies {
	role: string;
	bypass: boolean;
	roles: string[];
	tables: PolicyTable[];
}

/** A role (server-wide). `memberOf` lists roles whose privileges it can use. */
export interface Role {
	name: string;
	login: boolean;
	superuser: boolean;
	bypass: boolean;
	createdb: boolean;
	createrole: boolean;
	memberOf: string[];
	/** The connection's own role. */
	current: boolean;
}

/** A non-system schema with counts of what `drop … cascade` would take with it. */
export interface SchemaInfo {
	name: string;
	owner: string;
	/** Tables, views, materialized views and foreign tables. */
	tables: number;
	functions: number;
}

/** A user trigger (not the internal ones behind foreign keys). */
export interface Trigger {
	schema: string;
	table: string;
	name: string;
	enabled: boolean;
	timing: 'before' | 'after' | 'instead of';
	events: ('insert' | 'update' | 'delete' | 'truncate')[];
	forEachRow: boolean;
	/** Signature, schema-qualified unless on the search_path. */
	function: string;
	definition: string;
	functionDefinition: string;
}

/** A user-defined enum type; `columns` counts table columns using it. */
export interface EnumType {
	schema: string;
	name: string;
	values: string[];
	columns: number;
}

/** One normalized statement from pg_stat_statements (times in milliseconds). */
export interface QueryStat {
	query: string;
	role: string;
	calls: number;
	totalTime: number;
	meanTime: number;
	minTime: number;
	maxTime: number;
	rows: number;
	/** Shared-buffer hit ratio, 0–1; null when it touched no buffers. */
	hitRate: number | null;
}
export type QueryStats =
	| { available: true; queries: QueryStat[]; hitRate: number | null }
	/** The extension is missing (`installed` false) or installed but not preloaded by the server. */
	| { available: false; installed: boolean; reason: string };

/** A client session on the current database (pg_stat_activity), other than the one asking. */
export interface Session {
	pid: number;
	role: string | null;
	application: string;
	client: string | null;
	/** active, idle, idle in transaction, … (null when the role may not see it). */
	state: string | null;
	/** Seconds in the current state (for active sessions: the running query). */
	duration: number | null;
	waitType: string | null;
	wait: string | null;
	/** Sessions holding locks this one waits for. */
	blockedBy: number[];
	query: string;
}
/** Sessions of this database plus server-wide client connections against max_connections. */
export interface Activity {
	sessions: Session[];
	connections: number;
	maxConnections: number;
}

export interface Extension {
	name: string;
	comment: string | null;
	defaultVersion: string;
	installedVersion: string | null;
	/** Schema it is installed in. */
	schema: string | null;
	/** Fixed schema for non-relocatable extensions. */
	requiredSchema: string | null;
	requires: string[];
}

/** Defaults most worth changing from a UI; anything else belongs in the SQL editor. */
export const CONFIG_SETTINGS = ['search_path', 'TimeZone', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'work_mem'];

export interface DatabaseSetting {
	name: string;
	description: string;
	unit: string | null;
	/** Value in the app's own session (its pool sets statement_timeout itself). */
	current: string;
	databaseDefault: string | null;
	roleDefault: string | null;
}
