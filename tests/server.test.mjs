import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { get } from 'node:http';
import test from 'node:test';
import { manifest } from '../build/server/manifest.js';

test('production HTTP supports same-origin commands without trusting forwarded headers', async () => {
	const socket = createServer();
	socket.listen(0, '127.0.0.1');
	await once(socket, 'listening');
	const port = socket.address().port;
	await new Promise((resolve) => socket.close(resolve));
	const server = spawn(process.execPath, ['server.mjs'], {
		cwd: new URL('..', import.meta.url),
		env: { ...process.env, PORT: String(port), DATABASE_URL: '' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	server.stderr.on('data', (data) => { output += data; });
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000);
			server.stdout.on('data', (data) => {
				output += data;
				if (output.includes('Superbase:')) { clearTimeout(timeout); resolve(); }
			});
			server.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
		});
		const origin = `http://127.0.0.1:${port}`;
		const page = await fetch(origin);
		assert.equal(page.status, 200);
		const cookie = page.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
		assert.ok(cookie.includes('superbase_connection='));
		const [id] = Object.keys(manifest.remotes);
		const endpoint = `${origin}/_app/remote/${id}/disconnect`;
		// SvelteKit's base64url/devalue wire representation of { expected: null }.
		const body = JSON.stringify({ payload: Buffer.from('[{"expected":1},null]').toString('base64url'), refreshes: [] });
		const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'x-superbase-protocol': 'https' };
		const result = await fetch(endpoint, { method: 'POST', headers, body });
		assert.equal(result.status, 200);
		assert.equal((await result.json()).type, 'result', 'actual command must run, not merely return an error envelope');
		const foreign = await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body });
		assert.equal(foreign.status, 403);
		const downloadUrl = `${origin}/export?connection=stale&schema=public&table=items`;
		const staleDownload = await fetch(downloadUrl, { headers: { Cookie: cookie } });
		assert.equal(staleDownload.status, 400);
		assert.equal(staleDownload.headers.has('content-disposition'), false);
		assert.match(await staleDownload.text(), /Connection changed in another tab/);
		const foreignDownload = await fetch(downloadUrl, { headers: { Cookie: cookie, Origin: 'http://evil.example' } });
		assert.equal(foreignDownload.status, 403);
		assert.equal(foreignDownload.headers.has('content-disposition'), false);
		// Fetch normalizes Host; raw HTTP is needed to exercise a forged Host header.
		const hostStatus = await new Promise((resolve, reject) => {
			get(origin, { headers: { Host: 'evil.example' } }, (response) => {
				response.resume();
				resolve(response.statusCode);
			}).on('error', reject);
		});
		assert.equal(hostStatus, 403);
	} finally {
		if (server.exitCode === null && server.signalCode === null) {
			const ended = once(server, 'exit');
			server.kill('SIGTERM');
			await ended;
		}
	}
});
