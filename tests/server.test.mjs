import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { get } from 'node:http';
import test from 'node:test';
import { stringify } from 'devalue';
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
		for (const [name, args] of [
			['openSql', { connection: 'stale' }],
			['runSql', { connection: 'stale', session: 'missing', run: 'run-1', sql: 'SELECT 1' }],
			['cancelSql', { connection: 'stale', session: 'missing', run: 'run-1' }],
			['closeSql', { connection: 'stale', session: 'missing' }]
		]) {
			const sqlBody = JSON.stringify({ payload: Buffer.from(stringify(args)).toString('base64url'), refreshes: [] });
			const sqlEndpoint = `${origin}/_app/remote/${id}/${name}`;
			const stale = await fetch(sqlEndpoint, { method: 'POST', headers, body: sqlBody });
			assert.match(await stale.text(), /Connection changed in another tab/, `${name} must check the generation`);
			const crossOrigin = await fetch(sqlEndpoint, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: sqlBody });
			assert.equal(crossOrigin.status, 403, `${name} must reject cross-origin execution`);
		}
		const cleanup = `${origin}/sql/close`;
		const cleanupBody = JSON.stringify({ connection: 'stale', session: 'missing' });
		assert.equal((await fetch(cleanup, { method: 'POST', headers, body: cleanupBody })).status, 400);
		assert.equal((await fetch(cleanup, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: cleanupBody })).status, 403);
		assert.equal((await fetch(cleanup, { method: 'POST', headers: { ...headers, Origin: '' }, body: cleanupBody })).status, 403);
		assert.equal((await fetch(cleanup, { method: 'POST', headers, body: '{' })).status, 400);
		const downloadUrl = `${origin}/export?connection=stale&schema=public&table=items`;
		const staleDownload = await fetch(downloadUrl, { headers: { Cookie: cookie } });
		assert.equal(staleDownload.status, 400);
		assert.equal(staleDownload.headers.has('content-disposition'), false);
		assert.match(await staleDownload.text(), /Connection changed in another tab/);
		const foreignDownload = await fetch(downloadUrl, { headers: { Cookie: cookie, Origin: 'http://evil.example' } });
		assert.equal(foreignDownload.status, 403);
		assert.equal(foreignDownload.headers.has('content-disposition'), false);
		const exportBody = new URLSearchParams({ export: JSON.stringify({
			connection: 'stale', schema: 'public', table: 'items',
			query: { search: '', sort: [], filters: [] }
		}) });
		const exportHeaders = { Origin: origin, Cookie: cookie };
		const staleFiltered = await fetch(`${origin}/export`, { method: 'POST', headers: exportHeaders, body: exportBody });
		assert.equal(staleFiltered.status, 400);
		assert.equal(staleFiltered.headers.has('content-disposition'), false);
		assert.match(await staleFiltered.text(), /Connection changed in another tab/);
		for (const Origin of ['http://evil.example', '']) {
			const forbidden = await fetch(`${origin}/export`, {
				method: 'POST', headers: { ...exportHeaders, Origin }, body: exportBody
			});
			assert.equal(forbidden.status, 403);
		}
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
