import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';
import test from 'node:test';
import { stringify } from 'devalue';
import { manifest } from '../build/server/manifest.js';

// The production launcher must accept same-origin HTTP commands and reject cross-origin/rebinding requests.
test('production server: same-origin commands work; foreign origins and Host headers are rejected', async () => {
	const port = 30000 + Math.floor(Math.random() * 20000);
	const server = spawn(process.execPath, ['server.mjs'], {
		cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), DATABASE_URL: '', HOST: '', ORIGIN: '' },
		stdio: ['ignore', 'pipe', 'inherit']
	});
	try {
		await new Promise((resolve) => server.stdout.on('data', (data) => { if (String(data).includes('Superbase:')) resolve(); }));
		const origin = `http://127.0.0.1:${port}`;
		assert.equal((await fetch(origin)).status, 200);
		const [id] = Object.keys(manifest.remotes);
		const call = (name, args, headers = {}) => fetch(`${origin}/_app/remote/${id}/${name}`, {
			method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
			body: JSON.stringify({ payload: Buffer.from(stringify(args)).toString('base64url'), refreshes: [] })
		});
		// The command really runs: the connection attempt reaches the (closed) port.
		const connect = { url: 'postgres://x@127.0.0.1:1/db', sslMode: 'disable', expected: null };
		assert.match(await (await call('connect', connect)).text(), /ECONNREFUSED/);
		assert.match(await (await call('runSql', { connection: 'stale', session: 'x', sql: 'select 1' })).text(), /Connection changed/);
		assert.equal((await call('connect', connect, { Origin: 'http://evil.example' })).status, 403);
		const exportBody = new URLSearchParams({ export: JSON.stringify({ connection: 'stale', schema: 'public', table: 'items' }) });
		assert.equal((await fetch(`${origin}/export`, { method: 'POST', headers: { Origin: 'http://evil.example' }, body: exportBody })).status, 403);
		assert.match(await (await fetch(`${origin}/export`, { method: 'POST', headers: { Origin: origin }, body: exportBody })).text(), /Connection changed/);
		// fetch normalizes Host; raw HTTP exercises a DNS-rebinding style Host header.
		const status = await new Promise((resolve, reject) => {
			get(origin, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
		});
		assert.equal(status, 403);
	} finally {
		server.kill('SIGTERM');
		await once(server, 'exit');
	}
});
