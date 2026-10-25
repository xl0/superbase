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
