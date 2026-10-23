import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import pg from 'pg';
import { getRequestEvent } from '$app/server';
import { DATABASE_URL } from '$app/env/private';
import type { RequestEvent } from '@sveltejs/kit';
import type { ConnectionInfo, ConnectionStatus } from '#lib/types.js';

const COOKIE = 'superbase_connection';
const IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const MAX_PENDING = 8;

type Settings = {
	config: pg.PoolConfig;
	info: Omit<ConnectionInfo, 'id' | 'source'>;
	password: string;
};
// The map key is an HttpOnly bearer. Only info.id (an independent generation) leaves the server.
type Session = {
	info: ConnectionInfo | null;
	settings: Settings | null;
	pool: pg.Pool | null;
	pending: Set<pg.Pool>;
	revision: number;
	lastUsed: number;
	expired: boolean;
	error: string | null;
};
const sessions = new Map<string, Session>();
const pools = new WeakMap<pg.Pool, { clients: Set<pg.PoolClient>; retired: boolean }>();
let pending = 0;
let defaultSettings: Settings | undefined;

function settings(url: string, browser: boolean): Settings {
	let config: pg.PoolConfig;
	let password = '';
	if (browser) {
		if (typeof url !== 'string' || url.length > 8192) throw new Error('Invalid Postgres URL.');
		let parsed: URL;
		try {
			parsed = new URL(url.trim());
		} catch {
			throw new Error('Enter a valid postgres:// or postgresql:// URL.');
		}
		if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
			throw new Error('Connection URL must use postgres:// or postgresql://.');
		}
		const host = parsed.hostname.replace(/^\[|\]$/g, '');
		if (!host || (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) || parsed.hash) {
			throw new Error('Connection URL must have a valid host and no fragment.');
		}
		if (!parsed.pathname.slice(1)) throw new Error('Connection URL must name a database.');
		const options = [...parsed.searchParams];
		if (options.some(([key]) => key !== 'sslmode') || options.length > 1) {
			throw new Error('Only the sslmode URL option is supported; certificate files are not allowed.');
		}
		const sslmode = parsed.searchParams.get('sslmode') ?? 'require';
		if (!['require', 'verify-full', 'disable'].includes(sslmode)) {
			throw new Error('sslmode must be require, verify-full, or disable.');
		}
		try {
			password = decodeURIComponent(parsed.password);
			config = {
				host,
				port: parsed.port ? Number(parsed.port) : 5432,
				database: decodeURIComponent(parsed.pathname.slice(1)),
				user: decodeURIComponent(parsed.username) || 'postgres',
				// An empty password must not silently inherit the server's PGPASSWORD.
				password: password || (() => ''),
				// Encryption and certificate verification are separate, explicit choices.
				ssl: sslmode === 'disable' ? false : { rejectUnauthorized: sslmode === 'verify-full' }
			};
		} catch {
			throw new Error('Connection URL has invalid percent encoding.');
		}
		if (!config.port || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
			/[\x00-\x1f\x7f]/.test(`${config.database}${config.user}${password}`)) {
			throw new Error('Connection URL contains an invalid port or control character.');
		}
	} else {
		config = { connectionString: url };
	}
	try {
		// Use pg's actual parsed defaults/overrides, especially for trusted environment URLs.
		const client = new pg.Client(config);
		return {
			config,
			info: { host: client.host, port: String(client.port), database: client.database ?? '', user: client.user ?? '' },
			password: password || (typeof client.password === 'string' ? client.password : '')
		};
	} catch {
		throw new Error(browser ? 'Invalid Postgres connection settings.' : 'Default database configuration is invalid.');
	}
}

function environment(): Settings {
	if (!DATABASE_URL) throw new Error('No default database is configured.');
	return defaultSettings ??= settings(DATABASE_URL, false);
}

/** Preserve useful database errors without exposing URL credentials or known passwords. */
export function safeErrorMessage(error: unknown, password = ''): string {
	let message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Internal Error';
	message = message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted connection URL]');
	const secrets = new Set([password, defaultSettings?.password ?? '']);
	for (const session of sessions.values()) secrets.add(session.settings?.password ?? '');
	for (const secret of secrets) {
		if (!secret) continue;
		message = message.split(secret).join('[redacted]');
		message = message.split(encodeURIComponent(secret)).join('[redacted]');
	}
	return message;
}

function newPool(config: pg.PoolConfig): pg.Pool {
	const pool = new pg.Pool({
		...config,
		max: 5,
		application_name: 'superbase',
		statement_timeout: 30_000,
		query_timeout: 30_000,
		connectionTimeoutMillis: 10_000
	});
	const state = { clients: new Set<pg.PoolClient>(), retired: false };
	pools.set(pool, state);
	pool.on('connect', (client) => {
		state.clients.add(client);
		if (state.retired) void client.end().catch(() => {});
	});
	pool.on('remove', (client) => state.clients.delete(client));
	// pg requires an idle-error listener. Do not log server-controlled errors/credentials.
	pool.on('error', () => {});
	return pool;
}

function retire(pool: pg.Pool | null) {
	if (!pool) return;
	const state = pools.get(pool)!;
	if (state.retired) return;
	state.retired = true;
	// Pool.end() alone waits for checked-out clients: terminate them so old work cannot commit.
	for (const client of state.clients) void client.end().catch(() => {});
	void pool.end().catch(() => {});
}

function retireSession(session: Session) {
	retire(session.pool);
	for (const pool of session.pending) retire(pool);
}

function sweep() {
	const now = Date.now();
	for (const [bearer, session] of sessions) {
		if (now - session.lastUsed >= IDLE_MS) {
			sessions.delete(bearer);
			retireSession(session);
		}
	}
}
setInterval(sweep, 60_000).unref();

function current(event: RequestEvent): Session | undefined {
	sweep();
	const bearer = event.cookies.get(COOKIE);
	const session = bearer === undefined ? undefined : sessions.get(bearer);
	if (session) session.lastUsed = Date.now();
	return session;
}

/** Run in handle, before remote queries (which are forbidden from setting cookies). */
export function prepareConnection(event: RequestEvent): void {
	if (current(event)) return;
	if (sessions.size >= MAX_SESSIONS) throw new Error('Too many browser sessions. Close idle sessions and try again later.');
	const absent = event.cookies.get(COOKIE) === undefined;
	let initial: Settings | null = null;
	let error: string | null = null;
	if (absent && DATABASE_URL) {
		try {
			initial = environment();
		} catch {
			// A broken optional default must not prevent choosing a different database.
			error = 'Default database configuration is invalid. Choose another connection.';
		}
	}
	const session: Session = {
		info: initial ? { ...initial.info, id: randomUUID(), source: 'env' } : null,
		settings: initial,
		pool: null,
		pending: new Set(),
		revision: 0,
		lastUsed: Date.now(),
		expired: !absent,
		error
	};
	const bearer = randomUUID();
	event.cookies.set(COOKIE, bearer, {
		path: '/', httpOnly: true, sameSite: 'strict', secure: event.url.protocol === 'https:',
		// Keep the cookie beyond server TTL so expiry cannot silently restore the environment DB.
		maxAge: 60 * 60 * 24 * 30
	});
	sessions.set(bearer, session);
}

function status(session: Session | undefined, event: RequestEvent): ConnectionStatus {
	return {
		connection: session?.info ? { ...session.info } : null,
		defaultAvailable: Boolean(DATABASE_URL),
		expired: session?.expired ?? (event.cookies.get(COOKIE) !== undefined),
		...(session?.error ? { error: session.error } : {})
	};
}

function checked(event: RequestEvent, expected: string | null): Session {
	const session = current(event);
	if (!session) throw new Error('Connection expired. Reload before choosing a connection.');
	if ((session.info?.id ?? null) !== expected) throw new Error('Connection changed in another tab. Refresh and try again.');
	return session;
}

/** Cheap and read-only: no database round trip or pool allocation. */
export function connectionStatus(): ConnectionStatus {
	const event = getRequestEvent();
	return status(current(event), event);
}

/** Resolve once per operation. A captured pool is never redirected to a replacement database. */
export function activePool(expected: string): pg.Pool {
	const event = getRequestEvent();
	const session = checked(event, expected);
	if (!session.info || !session.settings) throw new Error('No database connected. Choose a connection first.');
	return session.pool ??= newPool(session.settings.config);
}

async function replace(event: RequestEvent, expected: string | null, next: Settings, source: ConnectionInfo['source']): Promise<ConnectionStatus> {
	const session = checked(event, expected);
	if (pending >= MAX_PENDING) throw new Error('Too many connection attempts. Try again shortly.');
	const revision = session.revision;
	const pool = newPool(next.config);
	pending++;
	session.pending.add(pool);
	try {
		await pool.query('select 1');
		if (checked(event, expected) !== session || session.revision !== revision) {
			throw new Error('Connection changed in another tab. Refresh and try again.');
		}
		session.pending.delete(pool);
		retireSession(session);
		session.pool = pool;
		session.settings = next;
		session.info = { ...next.info, id: randomUUID(), source };
		session.revision++;
		session.expired = false;
		session.error = null;
		return status(session, event);
	} catch (error) {
		retire(pool);
		throw new Error(safeErrorMessage(error, next.password));
	} finally {
		session.pending.delete(pool);
		pending--;
	}
}

export async function connect(args: { url: string; expected: string | null }): Promise<ConnectionStatus> {
	const event = getRequestEvent();
	checked(event, args.expected);
	return replace(event, args.expected, settings(args.url, true), 'session');
}

export async function disconnect(args: { expected: string | null }): Promise<ConnectionStatus> {
	const event = getRequestEvent();
	const session = checked(event, args.expected);
	retireSession(session);
	session.pool = null;
	session.settings = null;
	session.info = null;
	session.expired = false;
	session.error = null;
	session.revision++;
	// Retain the explicit disconnected bearer; deleting it would opt back into the default.
	return status(session, event);
}

export async function useDefault(args: { expected: string | null }): Promise<ConnectionStatus> {
	const event = getRequestEvent();
	checked(event, args.expected);
	return replace(event, args.expected, environment(), 'env');
}
