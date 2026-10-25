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

/** One normalized statement from pg_stat_statements (times in milliseconds). */
export interface QueryStat {
	query: string;
	role: string;
	calls: number;
	totalTime: number;
	meanTime: number;
	maxTime: number;
	rows: number;
	/** Shared-buffer hit ratio, 0–1; null when it touched no buffers. */
	hitRate: number | null;
}
export type QueryStats =
	| { available: true; queries: QueryStat[]; hitRate: number | null }
	/** The extension is missing or not preloaded; `reason` says which. */
	| { available: false; reason: string };

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
