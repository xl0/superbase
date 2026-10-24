/** SQL console values are exact PostgreSQL text; positional rows preserve duplicate names. */
export type SqlTransaction = 'idle' | 'transaction' | 'failed' | 'closed';
export type SqlSessionInfo = { session: string; transaction: SqlTransaction };
export type SqlResult = {
	command: string;
	rowCount: number | null;
	fields: { name: string; typeOid: number }[];
	rows: (string | null)[][];
	truncated: boolean;
};
export type SqlRunResult = SqlSessionInfo & {
	results: SqlResult[];
	notices: string[];
	/** A statement error does not imply earlier explicit commits were rolled back. */
	error: string | null;
	durationMs: number;
	truncated: boolean;
};
export type SqlTarget = { connection: string; session: string };
export type SqlRunArgs = SqlTarget & { run: string; sql: string };
export type SqlCancelArgs = SqlTarget & { run: string };

export const SQL_MAX_LENGTH = 100_000;
export const SQL_MAX_ROWS = 1_000;
export const SQL_MAX_BYTES = 2_000_000;
export const SQL_MAX_RESULTS = 50;
