import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
	SQL_MAX_BYTES, SQL_MAX_LENGTH, SQL_MAX_RESULTS, SQL_MAX_ROWS,
	type SqlResult, type SqlRunResult, type SqlSessionInfo, type SqlTransaction
} from '../sql.js';

type ActiveRun = {
	id: string;
	done: boolean;
	cancels: Set<Promise<void>>;
	finish: () => void;
	discardPreview: () => void;
};
type Session = {
	id: string;
	client: pg.Client;
	ready: boolean;
	closed: boolean;
	error: string | null;
	idle?: ReturnType<typeof setTimeout>;
	active?: ActiveRun;
	cancellers: Set<pg.Client>;
};

// pg 8.23.1 retains every statement's metadata in _results, even with a row listener.
// Keep only its current parser/result; the independently bounded preview lives below.
type QueryInternals = { _result: pg.QueryResult; _results: pg.QueryResult | pg.QueryResult[] };
class StreamingQuery extends pg.Query {
	_checkForMultirow() {
		const query = this as unknown as QueryInternals;
		query._results = query._result;
		(pg.Query.prototype as unknown as { _checkForMultirow(): void })._checkForMultirow.call(this);
		query._results = query._result;
	}
}

/** Dedicated, non-reconnecting SQL clients belonging to one browser connection generation. */
export class SqlSessions {
	private sessions = new Map<string, Session>();
	private disposed = false;
	private config: pg.ClientConfig;
	private redact: (error: unknown) => string;

	constructor(config: pg.ClientConfig, redact: (error: unknown) => string) {
		this.config = { ...config };
		this.redact = redact;
	}

	private errorText(error: unknown) {
		const text = this.redact(error);
		return text.length > 16_384 ? `${text.slice(0, 16_384)}… [error truncated]` : text;
	}

	private client() {
		const client = new pg.Client({
			...this.config, pipeline: false, connectionTimeoutMillis: 10_000,
			client_encoding: 'UTF8', application_name: 'superbase SQL',
			statement_timeout: 30_000, idle_in_transaction_session_timeout: 300_000,
			// pg's read timeout installs a callback, which would accumulate every row.
			query_timeout: 0
		});
		// pg lets connectionString parameters override explicit config; enforce these after parsing.
		Object.assign((client as pg.Client & { connectionParameters: pg.ClientConfig }).connectionParameters, {
			client_encoding: 'UTF8', application_name: 'superbase SQL',
			query_timeout: 0, statement_timeout: 30_000, idle_in_transaction_session_timeout: 300_000
		});
		return client;
	}

	private status(session: Session): SqlTransaction {
		if (session.closed) return 'closed';
		switch (session.client.getTransactionStatus()) {
			case 'I': return 'idle';
			case 'T': return 'transaction';
			case 'E': return 'failed';
			default: return 'closed';
		}
	}

	private get(id: string) {
		const session = this.sessions.get(id);
		if (!session || session.closed || !session.ready) throw new Error('Unknown or closed SQL session');
		return session;
	}

	private expire(session: Session) {
		clearTimeout(session.idle);
		if (!session.closed) {
			session.idle = setTimeout(() => this.destroy(session, 'SQL session expired'), 15 * 60_000);
			session.idle.unref();
		}
	}

	private destroy(session: Session, reason: string) {
		if (session.closed) return;
		session.closed = true;
		session.error = reason;
		clearTimeout(session.idle);
		this.sessions.delete(session.id);
		// Force close even during connect/COPY or after ErrorResponse, when pg has no activeQuery.
		session.client.connection.stream.destroy();
		for (const client of session.cancellers) client.connection.stream.destroy();
		session.active?.finish();
	}

	async open(): Promise<SqlSessionInfo> {
		if (this.disposed) throw new Error('SQL sessions disposed');
		if (this.sessions.size >= 4) throw new Error('At most 4 SQL sessions may be open');
		const session: Session = {
			id: randomUUID(), client: this.client(), ready: false, closed: false,
			error: null, cancellers: new Set()
		};
		this.sessions.set(session.id, session);
		session.client.on('error', (error) => this.destroy(session,
			`SQL connection lost; outcome unknown. ${this.errorText(error)}`));
		session.client.on('end', () => this.destroy(session, 'SQL connection lost; outcome unknown.'));
		// pg-protocol's startup packet explicitly requests UTF8, overriding role/env defaults.
		// Later changes are reported only at ReadyForQuery: discard this run's earlier bytes too.
		// Change-and-restore within one buffer emits no update and cannot be detected here.
		session.client.connection.on('parameterStatus', (message: { parameterName: string; parameterValue: string }) => {
			if (!session.closed && message.parameterName === 'client_encoding' && message.parameterValue !== 'UTF8') {
				session.active?.discardPreview();
				this.destroy(session, 'Unsupported client encoding; SQL session closed; outcome unknown for unfinished work.');
			}
		});
		try {
			await session.client.connect();
			if (session.closed || this.disposed) throw new Error('SQL session closed while connecting');
			session.ready = true;
			this.expire(session);
			return { session: session.id, transaction: this.status(session) };
		} catch (error) {
			const reason = session.closed ? session.error : null;
			this.destroy(session, 'SQL session connection failed');
			throw new Error(this.errorText(error) + (reason ? `. ${reason}` : ''));
		}
	}

	async run(args: { session: string; run: string; sql: string }): Promise<SqlRunResult> {
		if (typeof args.run !== 'string' || !/^[\w-]{1,128}$/.test(args.run)) throw new Error('Invalid SQL run ID');
		if (typeof args.sql !== 'string' || !args.sql.trim() || args.sql.length > SQL_MAX_LENGTH || args.sql.includes('\0')) {
			throw new Error('SQL must be nonempty, contain no NUL, and fit the SQL length limit');
		}
		const session = this.get(args.session);
		if (session.active) throw new Error('SQL session is busy');
		clearTimeout(session.idle);
		const started = performance.now();
		const output: SqlRunResult = {
			session: session.id, transaction: 'idle', results: [], notices: [],
			error: null, durationMs: 0, truncated: false
		};
		let finish!: () => void;
		const completed = new Promise<void>((resolve) => { finish = resolve; });
		const active: ActiveRun = {
			id: args.run, done: false, cancels: new Set(),
			finish: () => { active.done = true; finish(); },
			discardPreview: () => {
				output.results = [];
				output.notices = [];
				output.truncated = true;
			}
		};
		session.active = active;
		// JSON control escapes cost six bytes per error character, plus suffix/envelope.
		let bytes = 6 * 16_384 + 1024;
		let exhausted = false;
		let current: SqlResult | undefined;
		let described = false;
		const take = (value: unknown, reserve = 1) => {
			if (exhausted) return false;
			const size = Buffer.byteLength(JSON.stringify(value)) + reserve;
			if (bytes + size > SQL_MAX_BYTES) {
				exhausted = output.truncated = true;
				return false;
			}
			bytes += size;
			return true;
		};
		const begin = (fields: SqlResult['fields']) => {
			current = undefined;
			if (output.results.length >= SQL_MAX_RESULTS) { output.truncated = true; return; }
			const result: SqlResult = { command: '', rowCount: null, fields, rows: [], truncated: false };
			// Reserve room for the final command tag/count and JSON separators.
			if (take(result, 128)) { current = result; output.results.push(result); }
		};
		const queryConfig: pg.QueryArrayConfig = {
			text: args.sql, rowMode: 'array', types: { getTypeParser: () => (value: string) => value }
		};
		const query = new StreamingQuery(queryConfig);
		query.on('row', (row: (string | null)[]) => {
			if (session.closed || !current) return;
			if (current.rows.length < SQL_MAX_ROWS && take(row)) current.rows.push(row);
			else current.truncated = output.truncated = true;
		});
		query.on('error', (error) => { if (!session.closed) output.error = this.errorText(error); });
		const description = (message: { fields: pg.FieldDef[] }) => {
			if (session.closed) return;
			if (message.fields.some((field) => field.format === 'binary')) {
				this.destroy(session, 'Binary SQL results are unsupported; SQL session closed; outcome unknown for unfinished work.');
				return;
			}
			described = true;
			begin(message.fields.map((field) => ({ name: field.name, typeOid: field.dataTypeID })));
		};
		const command = () => {
			if (session.closed) return;
			if (!described) begin([]);
			if (current) {
				const result = (query as unknown as QueryInternals)._result;
				current.command = result.command;
				current.rowCount = result.rowCount;
			}
			described = false;
			current = undefined;
		};
		const notice = (message: { message?: string }) => {
			if (session.closed) return;
			const text = this.redact(new Error(message.message));
			if (output.notices.length < SQL_MAX_RESULTS && take(text)) output.notices.push(text);
			else output.truncated = true;
		};
		const copy = () => this.destroy(session, 'COPY STDIN/STDOUT is not supported; SQL session closed. Outcome unknown.');
		const connection = session.client.connection;
		connection.on('rowDescription', description);
		connection.on('commandComplete', command);
		connection.on('copyInResponse', copy);
		connection.on('copyOutResponse', copy);
		connection.on('copyBothResponse', copy);
		// Query emits error BEFORE ReadyForQuery. Listen after pg updates getTransactionStatus().
		connection.once('readyForQuery', active.finish);
		session.client.on('notice', notice);
		const wall = setTimeout(() => this.destroy(session,
			'SQL exceeded the 60-second wall-time limit; connection closed. Outcome unknown.'), 60_000);
		wall.unref();
		try {
			// No parameters/name/portal: pg sends the original buffer using simple protocol.
			// One protocol frame/value can still be large before this preview budget is applied.
			session.client.query(query);
			await completed;
			// A cancellation already connecting must finish before this client can run again.
			await Promise.allSettled(active.cancels);
			output.error = session.closed ? session.error : output.error;
			output.transaction = this.status(session);
			output.durationMs = Math.round(performance.now() - started);
			return output;
		} finally {
			clearTimeout(wall);
			connection.off('rowDescription', description);
			connection.off('commandComplete', command);
			connection.off('copyInResponse', copy);
			connection.off('copyOutResponse', copy);
			connection.off('copyBothResponse', copy);
			connection.off('readyForQuery', active.finish);
			session.client.off('notice', notice);
			session.active = undefined;
			this.expire(session);
		}
	}

	async cancel(args: { session: string; run: string }): Promise<void> {
		const session = this.get(args.session);
		const active = session.active;
		if (!active || active.id !== args.run || active.done) return;
		// Coalesce repeated cancellation requests: at most one extra socket per SQL session.
		if (active.cancels.size) { await Promise.all(active.cancels); return; }
		const client = this.client();
		session.cancellers.add(client);
		client.on('error', () => { client.connection.stream.destroy(); });
		const pid = (session.client as pg.Client & { processID: number }).processID;
		const cancellation = (async () => {
			const timeout = setTimeout(() => client.connection.stream.destroy(), 10_000);
			timeout.unref();
			try {
				await client.connect();
				// Check AFTER connecting: the old run may have completed while opening this socket.
				if (session.closed || session.active !== active || active.done) return;
				await client.query('select pg_cancel_backend($1)', [pid]);
			} catch (error) {
				throw new Error(this.errorText(error));
			} finally {
				clearTimeout(timeout);
				client.connection.stream.destroy();
				session.cancellers.delete(client);
			}
		})();
		active.cancels.add(cancellation);
		await cancellation;
	}

	close(id: string): void {
		const session = this.sessions.get(id);
		if (session) this.destroy(session, 'SQL session closed; outcome unknown for unfinished work.');
	}

	dispose(): void {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			this.destroy(session, 'SQL connection retired; outcome unknown for unfinished work.');
		}
	}
}
