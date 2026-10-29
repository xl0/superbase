import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SQL_MAX_RESULTS, SQL_MAX_ROWS, type SqlResult, type SqlRunResult, type SqlTransaction } from '../sql.js';
import { textTypes } from '../queries/db.js';

const MAX_SESSIONS = 16;
const MAX_PREVIEW_CHARS = 10_000_000;
const IDLE_MS = 15 * 60_000;

type Session = { client: pg.Client; closed: boolean; run: number; running: boolean; idle?: NodeJS.Timeout };

/** Dedicated SQL console clients: SET, temp tables and transactions persist across runs. Never reconnect. */
export class SqlSessions {
	private sessions = new Map<string, Session>();

	constructor(private config: pg.ClientConfig, private redact: (error: unknown) => string) {}

	private get(id: string): Session {
		const session = this.sessions.get(id);
		if (!session || session.closed) throw new Error('SQL session is closed. Reset it to continue.');
		return session;
	}

	private status(session: Session): SqlTransaction {
		const status = session.closed ? null : session.client.getTransactionStatus();
		return status === 'I' ? 'idle' : status === 'T' ? 'transaction' : status === 'E' ? 'failed' : 'closed';
	}

	private touch(id: string, session: Session) {
		clearTimeout(session.idle);
		session.idle = setTimeout(() => this.close(id), IDLE_MS).unref();
	}

	async open(): Promise<{ session: string; transaction: SqlTransaction }> {
		if (this.sessions.size >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} SQL sessions can be open.`);
		const id = randomUUID();
		const session: Session = {
			// No statement or idle-in-transaction timeouts beyond the database's own: runs can be cancelled, and
			// an abandoned session (and its transaction) ends after IDLE_MS.
			client: new pg.Client({ ...this.config, application_name: 'superbase SQL', connectionTimeoutMillis: 10_000 }),
			closed: false, run: 0, running: false
		};
		session.client.on('error', () => this.close(id));
		session.client.on('end', () => this.close(id));
		this.sessions.set(id, session);
		try {
			await session.client.connect();
		} catch (error) {
			this.close(id);
			throw new Error(this.redact(error));
		}
		this.touch(id, session);
		return { session: id, transaction: this.status(session) };
	}

	/** The buffer goes to PostgreSQL unchanged (simple protocol); only the returned preview is bounded. */
	async run({ session: id, sql }: { session: string; sql: string }): Promise<SqlRunResult> {
		const session = this.get(id);
		if (session.running) throw new Error('SQL session is busy.');
		session.running = true;
		session.run++;
		clearTimeout(session.idle);
		const started = performance.now();
		const output: SqlRunResult = { transaction: 'idle', results: [], notices: [], error: null, durationMs: 0, truncated: false };
		const rows = new Map<pg.QueryResult, (string | null)[][]>();
		let chars = 0;
		const query = new pg.Query({ text: sql, rowMode: 'array', types: textTypes } as pg.QueryConfig);
		// With a row listener and no callback, pg does not accumulate rows itself.
		query.on('row', (row: (string | null)[], builder) => {
			const result = builder as unknown as pg.QueryResult;
			const list = rows.get(result) ?? rows.set(result, []).get(result)!;
			chars += row.reduce((sum, value) => sum + (value?.length ?? 0), 0);
			if (list.length < SQL_MAX_ROWS && chars <= MAX_PREVIEW_CHARS) list.push(row);
			else output.truncated = true;
		});
		query.on('error', (error) => { output.error = this.redact(error); });
		const notice = (message: { message?: string }) => {
			if (output.notices.length < SQL_MAX_RESULTS) output.notices.push(this.redact(message.message ?? ''));
			else output.truncated = true;
		};
		let done!: () => void;
		const ended = () => done();
		session.client.on('notice', notice);
		session.client.on('end', ended);
		try {
			// pg updates the transaction status in its own, earlier ReadyForQuery listener.
			await new Promise<void>((resolve) => {
				done = resolve;
				session.client.connection.once('readyForQuery', resolve);
				session.client.query(query);
			});
			if (session.closed) output.error = 'SQL connection lost; the outcome of unfinished work is unknown.';
			const results = [(query as unknown as { _results: pg.QueryResult | pg.QueryResult[] })._results].flat()
				.filter((result) => result.command || result.fields.length);
			if (results.length > SQL_MAX_RESULTS) output.truncated = true;
			output.results = results.slice(0, SQL_MAX_RESULTS).map((result): SqlResult => ({
				command: result.command, rowCount: result.rowCount,
				fields: result.fields.map((field) => ({ name: field.name, typeOid: field.dataTypeID })),
				rows: rows.get(result) ?? [],
				truncated: result.fields.length > 0 && (rows.get(result)?.length ?? 0) < (result.rowCount ?? 0)
			}));
			output.transaction = this.status(session);
			output.durationMs = Math.round(performance.now() - started);
			return output;
		} finally {
			session.client.off('notice', notice);
			session.client.off('end', ended);
			session.running = false;
			if (!session.closed) this.touch(id, session);
		}
	}

	async cancel(id: string): Promise<void> {
		const session = this.get(id);
		const run = session.run;
		if (!session.running) return;
		const client = new pg.Client({ ...this.config, connectionTimeoutMillis: 10_000 });
		try {
			await client.connect();
			// The run may have finished while we connected; never cancel a later one.
			if (session.running && session.run === run) {
				await client.query('select pg_cancel_backend($1)', [(session.client as pg.Client & { processID: number }).processID]);
			}
		} catch (error) {
			throw new Error(this.redact(error));
		} finally {
			void client.end().catch(() => {});
		}
	}

	close(id: string): void {
		const session = this.sessions.get(id);
		if (!session || session.closed) return;
		session.closed = true;
		clearTimeout(session.idle);
		this.sessions.delete(id);
		void session.client.end().catch(() => {});
	}

	dispose(): void {
		for (const id of [...this.sessions.keys()]) this.close(id);
	}
}
