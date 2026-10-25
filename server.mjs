import { createServer } from 'node:http';

// adapter-node assumes HTTPS unless ORIGIN is set. Mark local requests as HTTP ourselves rather
// than trusting a forwarding header; behind a proxy, set ORIGIN instead.
if (!process.env.ORIGIN) process.env.PROTOCOL_HEADER = 'x-superbase-protocol';
const { handler } = await import('./build/handler.js');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const server = createServer((request, response) => {
	if (!process.env.ORIGIN) request.headers['x-superbase-protocol'] = 'http';
	handler(request, response);
});
server.listen(port, host, () => console.log(`Superbase: http://${host.includes(':') ? `[${host}]` : host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
