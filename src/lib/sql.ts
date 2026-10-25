/** SQL console values are exact PostgreSQL text; positional rows preserve duplicate column names. */
export type SqlTransaction = 'idle' | 'transaction' | 'failed' | 'closed';
export type SqlResult = {
	command: string;
	rowCount: number | null;
	fields: { name: string; typeOid: number }[];
	rows: (string | null)[][];
	truncated: boolean;
};
export type SqlRunResult = {
	transaction: SqlTransaction;
	results: SqlResult[];
	notices: string[];
	/** A statement error does not imply earlier explicit commits were rolled back. */
	error: string | null;
	durationMs: number;
	truncated: boolean;
};
export type SqlTarget = { connection: string; session: string };
export type SqlRunArgs = SqlTarget & { sql: string };

export const SQL_MAX_ROWS = 1_000;
/** Caps result sets and notices kept per run. */
export const SQL_MAX_RESULTS = 50;
