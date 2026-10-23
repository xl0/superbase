import { createServer } from 'node:http';

// adapter-node otherwise assumes HTTPS. Set this ourselves on the socket request,
// never trust a browser-supplied forwarding header or disable SvelteKit's CSRF check.
process.env.PROTOCOL_HEADER = 'x-superbase-protocol';
const { handler } = await import('./build/handler.js');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const server = createServer((request, response) => {
	request.headers['x-superbase-protocol'] = 'http';
	handler(request, response);
});
server.listen(port, '127.0.0.1', () => console.log(`Superbase: http://127.0.0.1:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 35_000).unref();
	});
}
