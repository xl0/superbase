import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import pg from 'pg';

// Exercise the real module with only pg's I/O and SvelteKit's request context replaced.
// No test database, framework runtime, private environment file, or extra dependency is needed.
let serial = 0;
async function fixture(defaultUrl = '') {
	const key = `__connectionTest${serial++}`;
	const state: any = { now: 0, event: null, pools: [], sqlGroups: [], deferred: [], timer: null, unref: false };
	state.SqlSessions = class {
		disposed = false;
		config: any;
		redact: (error: unknown) => string;
		constructor(config: any, redact: (error: unknown) => string) {
			this.config = config; this.redact = redact; state.sqlGroups.push(this);
		}
		dispose() { this.disposed = true; }
	};
	class Pool extends EventEmitter {
		config: any;
		ended = false;
		client: any;
		constructor(config: any) { super(); this.config = config; state.pools.push(this); }
		query() {
			if (this.ended) return Promise.reject(new Error('Pool is closed'));
			this.client ??= { ended: false, end: async () => { this.client.ended = true; } };
			this.emit('connect', this.client);
			return state.deferred.shift()?.promise ?? Promise.resolve({ rows: [] });
		}
		async end() { this.ended = true; }
	}
	state.pg = { Client: pg.Client, Pool };
	state.getRequestEvent = () => { assert.ok(state.event); return state.event; };
	state.DATABASE_URL = defaultUrl;
	state.setInterval = (fn: () => void) => { state.timer = fn; return { unref: () => { state.unref = true; } }; };
	(globalThis as any)[key] = state;
	const source = (await readFile(new URL('../src/lib/server/connections.ts', import.meta.url), 'utf8'))
		.replace("import pg from 'pg';", '')
		.replace("import { SqlSessions } from './sql.js';", '')
		.replace("import { getRequestEvent } from '$app/server';", '')
		.replace("import { DATABASE_URL } from '$app/env/private';", '')
		.replaceAll('Date.now()', 'testState.now');
	const compiled = ts.transpileModule(`const testState = globalThis[${JSON.stringify(key)}];\nconst { pg, getRequestEvent, DATABASE_URL, setInterval, SqlSessions } = testState;\n${source}`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
	}).outputText;
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
	const api = await import(moduleUrl);
	const hookSource = (await readFile(new URL('../src/hooks.server.ts', import.meta.url), 'utf8'))
		.replace("'#lib/server/connections.js'", JSON.stringify(moduleUrl));
	const hooks = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(hookSource, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
	}).outputText).toString('base64')}`);
	function browser(cookie?: string) {
		return new Map(cookie === undefined ? [] : [['superbase_connection', cookie]]);
	}
	function event(jar: Map<string, string>, host = 'localhost:5173', peer = '127.0.0.1') {
		const snapshot = new Map(jar);
		return {
			url: new URL('http://localhost:5173/'),
			request: new Request('http://localhost:5173/', { headers: { host, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' } }),
			getClientAddress: () => peer,
			cookies: {
				get: (key: string) => snapshot.get(key),
				set: (key: string, value: string, options: any) => {
					assert.equal(options.httpOnly, true);
					assert.equal(options.sameSite, 'strict');
					snapshot.set(key, value); jar.set(key, value);
				}
			}
		};
	}
	function request(jar: Map<string, string>, fn: () => any, prepare = true) {
		state.event = event(jar);
		if (prepare) api.prepareConnection(state.event);
		return fn();
	}
	function defer() {
		let resolve!: (value?: any) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise((a, b) => { resolve = a; reject = b; });
		const result = { promise, resolve, reject };
		state.deferred.push(result);
		return result;
	}
	return { state, api, hooks, browser, request, event, defer };
}
const url = 'postgresql://reader:synthetic-pass@db.example/app?sslmode=disable';
const envUrl = 'postgresql://env_reader:synthetic-env-pass@default.example/default_db?sslmode=disable';

test('isolated browser lifecycle, separate bearer/generation, explicit disconnect/default, stale tabs', async () => {
	const { api, state, browser, request } = await fixture(envUrl);
	const a = browser(), b = browser();
	const initial = request(a, api.connectionStatus);
	assert.equal(initial.connection.source, 'env');
	assert.equal(state.pools.length, 0, 'status does not allocate pools');
	assert.notEqual(initial.connection.id, a.get('superbase_connection'));
	const other = request(b, api.connectionStatus);
	assert.notEqual(other.connection.id, initial.connection.id);
	const old = request(a, () => api.activePool(initial.connection.id));
	await old.query('select 1');
	const connected = await request(a, () => api.connect({ url, expected: initial.connection.id }));
	assert.equal(connected.connection.source, 'session');
	assert.equal(connected.connection.host, 'db.example');
	assert.equal(old.ended, true);
	assert.equal(old.client.ended, true, 'retirement ends checked-out clients, not only pool');
	assert.equal(state.pools.at(-1).ended, false, 'successful candidate is not retired');
	assert.equal(request(b, api.connectionStatus).connection.id, other.connection.id);
	assert.throws(() => request(a, () => api.activePool(initial.connection.id)), /changed/);
	await assert.rejects(request(a, () => api.disconnect({ expected: initial.connection.id })), /changed/);
	const disconnected = await request(a, () => api.disconnect({ expected: connected.connection.id }));
	assert.deepEqual(disconnected, { connection: null, defaultAvailable: true, expired: false });
	assert.ok(a.get('superbase_connection'));
	assert.equal(request(a, api.connectionStatus).connection, null, 'disconnect must not restore environment');
	const restored = await request(a, () => api.useDefault({ expected: null }));
	assert.equal(restored.connection.source, 'env');
	assert.notEqual(restored.connection.id, initial.connection.id);
	assert.equal(JSON.stringify(restored).includes('synthetic'), false);
});

test('missing environment is normal; invalid, empty, and expired cookies never restore default', async () => {
	const none = await fixture();
	assert.deepEqual(none.request(none.browser(), none.api.connectionStatus), { connection: null, defaultAvailable: false, expired: false });
	const { api, state, browser, request } = await fixture(envUrl);
	for (const cookie of ['unknown-bearer', '']) {
		const jar = browser(cookie);
		assert.deepEqual(request(jar, api.connectionStatus), { connection: null, defaultAvailable: true, expired: true });
	}
	const jar = browser();
	const original = request(jar, api.connectionStatus);
	const pool = request(jar, () => api.activePool(original.connection.id));
	state.now += 2 * 60 * 60 * 1000;
	assert.deepEqual(request(jar, api.connectionStatus, false), { connection: null, defaultAvailable: true, expired: true });
	assert.equal(pool.ended, true);
	assert.throws(() => request(jar, () => api.activePool(original.connection.id), false), /expired/);
	assert.equal(request(jar, api.connectionStatus).expired, true);
	assert.equal(request(jar, api.connectionStatus).connection, null);
	const connected = await request(jar, () => api.connect({ url, expected: null }));
	assert.equal(connected.expired, false);
	assert.equal(state.unref, true);
	state.now += 2 * 60 * 60 * 1000;
	state.timer();
	assert.equal(state.pools.at(-1).ended, true, 'periodic cleanup works without requests');
});

test('malformed environment keeps onboarding usable and an explicit connection clears its error', async () => {
	const { api, hooks, state, browser, event, request } = await fixture('postgresql://reader:synthetic-secret@[invalid/db');
	const jar = browser();
	const response = await hooks.handle({ event: event(jar), resolve: async () => new Response('onboarding') });
	assert.equal(response.status, 200);
	const initial = request(jar, api.connectionStatus);
	assert.deepEqual(initial, {
		connection: null, defaultAvailable: true, expired: false,
		error: 'Default database configuration is invalid. Choose another connection.'
	});
	assert.equal(state.pools.length, 0);
	await assert.rejects(request(jar, () => api.useDefault({ expected: null })), /Default database configuration is invalid/);
	assert.deepEqual(request(jar, api.connectionStatus), initial);
	const connected = await request(jar, () => api.connect({ url, expected: null }));
	assert.equal(connected.connection.source, 'session');
	assert.equal(connected.error, undefined);
	assert.equal(connected.defaultAvailable, true);
	assert.equal(request(jar, api.connectionStatus).error, undefined);
});

test('async connect captures request, checks generation twice, and cannot resurrect after disconnect', async () => {
	const { api, state, browser, request, defer } = await fixture();
	const a = browser(), b = browser();
	request(a, api.connectionStatus);
	const wait = defer();
	const first = request(a, () => api.connect({ url, expected: null }));
	request(b, api.connectionStatus); // ambient request has changed during await
	wait.resolve();
	const connected = await first;
	assert.equal(request(a, api.connectionStatus).connection.id, connected.connection.id);
	assert.equal(request(b, api.connectionStatus).connection, null);
	const pending = defer();
	const late = request(a, () => api.connect({ url, expected: connected.connection.id }));
	await request(a, () => api.disconnect({ expected: connected.connection.id }));
	pending.resolve();
	await assert.rejects(late, /changed/);
	assert.equal(request(a, api.connectionStatus).connection, null);
	assert.equal(state.pools.at(-1).ended, true);
	const nullWait = defer();
	const fromNull = request(a, () => api.connect({ url, expected: null }));
	await request(a, () => api.disconnect({ expected: null }));
	nullWait.resolve();
	await assert.rejects(fromNull, /changed/, 'revision also detects null -> null disconnect');
});

test('competing connects and expiry during testing cannot publish stale candidates', async () => {
	const { api, state, browser, request, defer } = await fixture();
	const jar = browser();
	request(jar, api.connectionStatus);
	const one = defer();
	const first = request(jar, () => api.connect({ url, expected: null }));
	const two = defer();
	const second = request(jar, () => api.connect({ url, expected: null }));
	two.resolve();
	const winner = await second;
	one.resolve();
	await assert.rejects(first, /changed/);
	assert.equal(request(jar, api.connectionStatus).connection.id, winner.connection.id);
	const wait = defer();
	const expired = request(jar, () => api.connect({ url, expected: winner.connection.id }));
	state.now += 2 * 60 * 60 * 1000;
	wait.resolve();
	await assert.rejects(expired, /expired/);
	assert.equal(state.pools.at(-1).ended, true);
	assert.equal(request(jar, api.connectionStatus).expired, true);
});

test('strict URL option allowlist and TLS policy; failures neither allocate pools nor expose secrets', async () => {
	const { api, state, browser, request, defer } = await fixture();
	const jar = browser();
	request(jar, api.connectionStatus);
	const invalid = [
		'http://reader:secret@db.example/db', 'db.example/db', 'postgresql:///db', 'postgresql://db.example/',
		'postgresql://db.example/db#fragment', 'postgresql://%2fetc/db', 'postgresql://db.example:0/db',
		...['abc', '1.5', '1e3', '65536'].map((port) => `postgresql://db.example:${port}/db`),
		'postgresql://db.example/%00', 'postgresql://reader:%zz@db.example/db',
		...['sslcert=/etc/passwd', 'sslkey=/etc/passwd', 'sslrootcert=/etc/passwd', 'host=elsewhere',
			'password=secret', 'options=-csearch_path=public', 'sslmode=no-verify', 'sslmode=prefer',
			'sslmode=disable&sslmode=require', 'ssl=true'].map((option) => `postgresql://db.example/db?${option}`)
	];
	for (const value of invalid) await assert.rejects(request(jar, () => api.connect({ url: value, expected: null })));
	assert.equal(state.pools.length, 0);
	const wait = defer();
	const failed = request(jar, () => api.connect({ url, expected: null }));
	wait.reject(new Error(`ECONNREFUSED ${url} password synthetic-pass`));
	await assert.rejects(failed, (error: Error) => {
		assert.match(error.message, /ECONNREFUSED/);
		assert.doesNotMatch(error.message, /synthetic-pass|postgresql:\/\//);
		return true;
	});
	assert.equal(state.pools.at(-1).ended, true);
	assert.equal(request(jar, api.connectionStatus).connection, null);
	const connected = await request(jar, () => api.connect({ url: 'postgresql://reader:p%40ss@db.example/my%2Fdb?sslmode=require', expected: null }));
	assert.equal(connected.connection.database, 'my/db');
	assert.deepEqual(state.pools.at(-1).config.ssl, { rejectUnauthorized: false });
	for (const [query, ssl] of [
		['', { rejectUnauthorized: false }],
		['?sslmode=verify-full', { rejectUnauthorized: true }],
		['?sslmode=disable', false]
	] as const) {
		const expected = request(jar, api.connectionStatus).connection.id;
		await request(jar, () => api.connect({ url: `postgresql://db.example/app${query}`, expected }));
		assert.deepEqual(state.pools.at(-1).config.ssl, ssl);
	}
});

test('trusted environment metadata uses pg parsing, not URL-only guesses', async () => {
	const { api, browser, request } = await fixture('postgresql://reader:synthetic-pass@original/db?host=actual.example&port=6543&user=actual_user&sslmode=disable');
	const status = request(browser(), api.connectionStatus);
	assert.deepEqual({ ...status.connection, id: '' }, {
		id: '', source: 'env', host: 'actual.example', port: '6543', database: 'db', user: 'actual_user'
	});
});

test('session and pending-attempt limits apply before allocating additional pools', async () => {
	const { api, state, browser, request, defer } = await fixture();
	const jar = browser();
	request(jar, api.connectionStatus);
	const waits: ReturnType<typeof defer>[] = [];
	const attempts: Promise<any>[] = [];
	for (let i = 0; i < 8; i++) {
		waits.push(defer());
		attempts.push(request(jar, () => api.connect({ url, expected: null })));
	}
	await assert.rejects(request(jar, () => api.connect({ url, expected: null })), /Too many connection attempts/);
	assert.equal(state.pools.length, 8);
	await request(jar, () => api.disconnect({ expected: null }));
	for (const wait of waits) wait.resolve();
	await Promise.all(attempts.map((attempt) => assert.rejects(attempt, /changed/)));
	for (let i = 1; i < 32; i++) request(browser(), api.connectionStatus);
	assert.throws(() => request(browser(), api.connectionStatus), /Too many browser sessions/);
	assert.equal(state.pools.length, 8);
	state.now += 2 * 60 * 60 * 1000;
	assert.equal(request(browser(), api.connectionStatus).connection, null);
});

test('SQL sessions are scoped to browser/generation and retired with their connection', async () => {
	const { api, state, browser, request, defer } = await fixture(url);
	const first = browser(), second = browser();
	const generation = request(first, api.connectionStatus).connection.id;
	const other = request(second, api.connectionStatus).connection.id;
	const group = request(first, () => api.activeSql(generation));
	assert.equal(request(first, () => api.activeSql(generation)), group);
	const otherGroup = request(second, () => api.activeSql(other));
	assert.notEqual(otherGroup, group);
	assert.throws(() => request(second, () => api.activeSql(generation)), /changed/);
	const failure = defer();
	const pending = request(first, () => api.connect({ url, expected: generation }));
	failure.reject(new Error('unavailable'));
	await assert.rejects(pending, /unavailable/);
	assert.equal(group.disposed, false);
	const next = await request(first, () => api.connect({ url, expected: generation }));
	assert.equal(group.disposed, true);
	assert.equal(otherGroup.disposed, false);
	assert.throws(() => request(first, () => api.activeSql(generation)), /changed/);
	const replacement = request(first, () => api.activeSql(next.connection.id));
	await request(first, () => api.disconnect({ expected: next.connection.id }));
	assert.equal(replacement.disposed, true);
	state.now += 2 * 60 * 60 * 1000;
	state.timer();
	assert.equal(otherGroup.disposed, true);
});

test('local-only hook checks actual peer and Host, ignoring spoofed forwarded headers', async () => {
	const { hooks, browser, event } = await fixture();
	const resolve = async () => new Response('ok');
	for (const peer of ['127.0.0.1', '127.12.34.56', '::1', '::ffff:127.0.0.1', '::ffff:127.12.34.56']) {
		assert.equal((await hooks.handle({ event: event(browser(), 'localhost:5173', peer), resolve })).status, 200);
	}
	for (const host of ['127.0.0.1:5173', '127.2.3.4', '[::1]:5173', '[::ffff:127.0.0.1]:5173']) {
		assert.equal((await hooks.handle({ event: event(browser(), host), resolve })).status, 200);
	}
	for (const [host, peer] of [['localhost', '192.168.1.2'], ['localhost', '::ffff:192.168.1.2'],
		['rebind.example', '127.0.0.1'], ['localhost.evil', '127.0.0.1'], ['localhost@evil', '127.0.0.1'],
		['localhost/path', '127.0.0.1'], ['[::2]', '127.0.0.1'], ['', '127.0.0.1']]) {
		assert.equal((await hooks.handle({ event: event(browser(), host, peer), resolve })).status, 403);
	}
	const previous = process.env.ADDRESS_HEADER;
	try {
		process.env.ADDRESS_HEADER = 'x-forwarded-for';
		assert.equal((await hooks.handle({ event: event(browser()), resolve })).status, 403);
	} finally {
		if (previous === undefined) delete process.env.ADDRESS_HEADER;
		else process.env.ADDRESS_HEADER = previous;
	}
	assert.equal(hooks.handleError({ error: new Error('duplicate key violates unique constraint "accounts_pkey"') }).message,
		'duplicate key violates unique constraint "accounts_pkey"');
});
