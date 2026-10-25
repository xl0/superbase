#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const help = `Usage: superbase [postgres-url] [--port N] [--host H] [--no-open]

  postgres-url   Pin the app to this database (same as DATABASE_URL); otherwise choose in the browser.
  --port N       Port to listen on (default 3000, or the next free one).
  --host H       Interface to bind (default 127.0.0.1). Anything else expects auth in front of the app.
  --no-open      Don't open a browser.`;

const args = process.argv.slice(2);
let port = process.env.PORT ? Number(process.env.PORT) : undefined;
let open = true;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === '--help' || arg === '-h') { console.log(help); process.exit(0); }
	else if (arg === '--no-open') open = false;
	else if (arg === '--port') port = Number(args[++i]);
	else if (arg === '--host') process.env.HOST = args[++i];
	else if (/^postgres(ql)?:\/\//.test(arg)) process.env.DATABASE_URL = arg;
	else { console.error(`Unknown argument: ${arg}\n\n${help}`); process.exit(1); }
}
if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) { console.error('Invalid port'); process.exit(1); }
const host = process.env.HOST || '127.0.0.1';

// adapter-node assumes HTTPS unless ORIGIN is set. Mark direct requests as HTTP ourselves rather
// than trusting a forwarding header; behind a TLS proxy, set ORIGIN instead.
if (!process.env.ORIGIN) process.env.PROTOCOL_HEADER = 'x-superbase-protocol';
// Environment must be final before the app reads it.
const { handler } = await import(new URL('../build/handler.js', import.meta.url).href);

const server = createServer((request, response) => {
	if (!process.env.ORIGIN) request.headers['x-superbase-protocol'] = 'http';
	handler(request, response);
});

/** Without an explicit port, try 3000 and the next few if they are taken. */
function listen(candidate, attempts) {
	server.once('error', (error) => {
		if (error.code === 'EADDRINUSE' && attempts > 1) listen(candidate + 1, attempts - 1);
		else { console.error(`Cannot listen on ${host}:${candidate}: ${error.message}`); process.exit(1); }
	});
	server.listen(candidate, host, () => {
		const url = `http://${host.includes(':') ? `[${host}]` : host}:${candidate}`;
		console.log(`Superbase: ${url}`);
		if (open) {
			const [command, ...options] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
			spawn(command, [...options, url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
		}
	});
}
listen(port ?? 3000, port === undefined ? 10 : 1);

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
