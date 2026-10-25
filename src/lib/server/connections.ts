import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DATABASE_URL } from '$app/env/private';
import type { ConnectionInfo, ConnectionStatus } from '#lib/types.js';
import { connectionOptions, type SslMode } from '#lib/connection-options.js';
import { SqlSessions } from './sql.js';

/** One database target per server process, shared by every tab. `info.id` changes on each switch. */
type Connection = { info: ConnectionInfo; pool: pg.Pool; sql: SqlSessions };
let current: Connection | null = null;
/** DATABASE_URL pins the app to one database (container deployments); otherwise browsers choose. */
const locked = !!DATABASE_URL;

/** Keep database errors useful without echoing connection URLs (which carry passwords). */
export function safeErrorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted connection URL]');
}

function open(config: pg.ClientConfig): Connection {
	const client = new pg.Client(config); // Resolves pg's defaults and URL parsing for display.
	const pool = new pg.Pool({
		...config, max: 5, application_name: 'superbase',
		statement_timeout: 30_000, query_timeout: 30_000, connectionTimeoutMillis: 10_000
	});
	pool.on('error', () => {}); // pg requires an idle-client error listener.
	return {
		info: { id: randomUUID(), host: client.host, port: String(client.port), database: client.database ?? '', user: client.user ?? '' },
		pool, sql: new SqlSessions(config, safeErrorMessage)
	};
}

function close(connection: Connection | null) {
	connection?.sql.dispose();
	void connection?.pool.end().catch(() => {});
}

if (locked) current = open({ connectionString: DATABASE_URL });

export function connectionStatus(): ConnectionStatus {
	return { connection: current ? { ...current.info } : null, locked };
}

/** Callers pass the generation they loaded, so a stale tab never acts on a newly selected database. */
function checked(expected: string | null): Connection | null {
	if ((current?.info.id ?? null) !== expected) throw new Error('Connection changed in another tab. Reload the page.');
	return current;
}

function active(expected: string): Connection {
	const connection = checked(expected);
	if (!connection) throw new Error('No database connected.');
	return connection;
}

export const activePool = (expected: string) => active(expected).pool;
export const activeSql = (expected: string) => active(expected).sql;

export async function connect(args: { url: string; sslMode: SslMode; expected: string | null }): Promise<ConnectionStatus> {
	if (locked) throw new Error('This server is pinned to DATABASE_URL.');
	checked(args.expected);
	// URL options would override `ssl`, so connectionOptions only allows an importable sslmode.
	const { url, sslMode } = connectionOptions(args.url, args.sslMode);
	let next = open({ connectionString: url, ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' } });
	try {
		try {
			await next.pool.query('select 1');
		} catch (error) {
			if (sslMode !== 'prefer' || (error as Error).message !== 'The server does not support SSL connections') throw error;
			close(next);
			next = open({ connectionString: url, ssl: false });
			await next.pool.query('select 1');
		}
		checked(args.expected);
	} catch (error) {
		close(next);
		throw new Error(safeErrorMessage(error));
	}
	close(current);
	current = next;
	return connectionStatus();
}
