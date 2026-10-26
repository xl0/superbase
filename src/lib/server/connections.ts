import pg from 'pg';
import { DATABASE_URL } from '$app/env/private';
import type { ConnectionInfo, ServerStatus } from '#lib/types.js';
import { connectionOptions, type SslMode } from '#lib/connection-options.js';
import { connectionTarget } from '#lib/connection-profiles.js';
import { SqlSessions } from './sql.js';

/**
 * Open databases by key: `host:port/database · user · sslmode`, no password. Every request names
 * the key of the database its page shows, so it can only act on that one, and tabs on different
 * databases don't interfere. Idle pools hold no clients (pg closes them), so pools are never closed.
 */
type Connection = { info: ConnectionInfo; pool: pg.Pool; sql: SqlSessions };
const connections = new Map<string, Connection>();

/** Keep database errors useful without echoing connection URLs (which carry passwords). */
export function safeErrorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted connection URL]');
}

/** pg's own parsing (defaults included) names the target, so the key matches what it connects to. */
function describe(config: pg.ClientConfig, sslMode: string): ConnectionInfo {
	const client = new pg.Client(config);
	const target = { host: client.host, port: String(client.port), database: client.database ?? '', user: client.user ?? '' };
	return { ...target, key: `${connectionTarget(target)} · ${sslMode}` };
}

function open(config: pg.ClientConfig, info: ConnectionInfo): Connection {
	const pool = new pg.Pool({
		...config, max: 5, application_name: 'superbase',
		statement_timeout: 30_000, query_timeout: 30_000, connectionTimeoutMillis: 10_000
	});
	pool.on('error', () => {}); // pg requires an idle-client error listener.
	return { info, pool, sql: new SqlSessions(config, safeErrorMessage) };
}

function close(connection: Connection) {
	connection.sql.dispose();
	void connection.pool.end().catch(() => {});
}

/** DATABASE_URL pins the app to one database (container deployments); otherwise browsers choose. */
const locked = DATABASE_URL ? open({ connectionString: DATABASE_URL }, describe({ connectionString: DATABASE_URL }, 'pinned')) : null;

export function connectionStatus(): ServerStatus {
	return { connections: locked ? [locked.info] : [...connections.values()].map((connection) => connection.info), locked: !!locked };
}

function opened(key: string): Connection {
	const connection = locked ?? connections.get(key);
	if (connection?.info.key !== key) {
		throw new Error(locked ? 'This server is pinned to another database.'
			: 'The server is not connected to this database (it may have restarted). Reload the page to reconnect.');
	}
	return connection;
}

export const activePool = (key: string) => opened(key).pool;
export const activeSql = (key: string) => opened(key).sql;

/** Opens, or reuses, the pool for a URL. The returned key is what later requests name. */
export async function connect(args: { url: string; sslMode: SslMode }): Promise<ConnectionInfo> {
	if (locked) throw new Error('This server is pinned to DATABASE_URL.');
	// URL options would override `ssl`, so connectionOptions only allows an importable sslmode.
	const { url, sslMode } = connectionOptions(args.url, args.sslMode);
	const config = { connectionString: url, ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' } };
	const info = describe(config, sslMode);
	const existing = connections.get(info.key);
	if (existing) return existing.info;
	let next = open(config, info);
	try {
		try {
			await next.pool.query('select 1');
		} catch (error) {
			if (sslMode !== 'prefer' || (error as Error).message !== 'The server does not support SSL connections') throw error;
			close(next);
			next = open({ connectionString: url, ssl: false }, info);
			await next.pool.query('select 1');
		}
	} catch (error) {
		close(next);
		throw new Error(safeErrorMessage(error));
	}
	// Another tab may have opened the same database meanwhile.
	const raced = connections.get(info.key);
	if (raced) { close(next); return raced.info; }
	connections.set(info.key, next);
	return info;
}
