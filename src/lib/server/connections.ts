import { randomUUID } from 'node:crypto';
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
type Connection = {
	info: ConnectionInfo; config: pg.ClientConfig; pool: pg.Pool; sql: SqlSessions;
	changes?: Changes;
	/** Set when notifications proved undeliverable; realtime stays off until the server restarts. */
	realtimeUnavailable?: string;
};
/** One LISTEN client per database while browsers subscribe; `end` tells each subscriber its stream is over. */
type Changes = { client: pg.Client; subscribers: Map<(payload: string) => void, (reason?: string) => void> };
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

const password = (config: pg.ClientConfig) => new pg.Client(config).password;

function open(config: pg.ClientConfig, info: ConnectionInfo): Connection {
	const pool = new pg.Pool({
		...config, max: 5, application_name: 'superbase',
		statement_timeout: 30_000, query_timeout: 30_000, connectionTimeoutMillis: 10_000
	});
	pool.on('error', () => {}); // pg requires an idle-client error listener.
	return { info, config, pool, sql: new SqlSessions(config, safeErrorMessage) };
}

function close(connection: Connection) {
	connection.sql.dispose();
	stopChanges(connection);
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

/** Ends the LISTEN client and every subscriber's stream; with a `reason`, realtime stays off for this database. */
function stopChanges(connection: Connection, reason?: string) {
	const changes = connection.changes;
	if (reason) connection.realtimeUnavailable = reason;
	if (!changes) return;
	connection.changes = undefined;
	for (const end of changes.subscribers.values()) end(reason);
	void changes.client.end().catch(() => {});
}

const UNDELIVERED = 'Notifications from this database do not arrive (a transaction-mode connection pooler cannot deliver them; '
	+ 'connect directly or through a session pooler). Polling instead.';

/**
 * Realtime: `superbase` channel notifications of this database (see ddl.realtimeSql). Returns unsubscribe.
 * A self-addressed test notification must come back within 5 s, or realtime is marked unavailable: `end(reason)`.
 */
export function subscribeChanges(key: string, listener: (payload: string) => void, end: (reason?: string) => void): () => void {
	const connection = opened(key);
	if (connection.realtimeUnavailable) {
		queueMicrotask(() => end(connection.realtimeUnavailable));
		return () => {};
	}
	if (!connection.changes) {
		const client = new pg.Client({ ...connection.config, application_name: 'superbase realtime' });
		const changes: Changes = { client, subscribers: new Map() };
		connection.changes = changes;
		const ping = JSON.stringify({ ping: randomUUID() });
		const fail = (reason?: string) => { if (connection.changes === changes) stopChanges(connection, reason); };
		const timeout = setTimeout(() => fail(UNDELIVERED), 5_000);
		client.on('notification', (message) => {
			if (message.payload === ping) { clearTimeout(timeout); return; }
			for (const notify of changes.subscribers.keys()) notify(message.payload ?? '');
		});
		client.on('error', () => fail());
		client.on('end', () => { clearTimeout(timeout); fail(); });
		client.connect().then(() => client.query('listen superbase'))
			.then(() => connection.pool.query("select pg_notify('superbase', $1)", [ping]))
			.catch(() => { clearTimeout(timeout); fail(); });
	}
	const changes = connection.changes;
	changes.subscribers.set(listener, end);
	return () => {
		changes.subscribers.delete(listener);
		if (!changes.subscribers.size && connection.changes === changes) stopChanges(connection);
	};
}

/**
 * Opens, or reuses, the pool for a URL. The returned key is what later requests name. The key leaves out
 * the password, so a pool is reused only with the same one: a wrong password never "connects", and new
 * working credentials replace the pool (ending its SQL sessions; realtime streams reconnect).
 */
export async function connect(args: { url: string; sslMode: SslMode }): Promise<ConnectionInfo> {
	if (locked) throw new Error('This server is pinned to DATABASE_URL.');
	// URL options would override `ssl`, so connectionOptions only allows an importable sslmode.
	const { url, sslMode } = connectionOptions(args.url, args.sslMode);
	const config = { connectionString: url, ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' } };
	const info = describe(config, sslMode);
	const existing = connections.get(info.key);
	if (existing && password(existing.config) === password(config)) return existing.info;
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
	// Verified: the newest credentials win, also over a pool another tab opened meanwhile.
	const replaced = connections.get(info.key);
	connections.set(info.key, next);
	if (replaced) close(replaced);
	return info;
}
