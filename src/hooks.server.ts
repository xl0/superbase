import { isIP } from 'node:net';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { prepareConnection, safeErrorMessage } from '#lib/server/connections.js';

function loopback(address: string): boolean {
	if (isIP(address) === 4) return address.startsWith('127.');
	if (isIP(address) !== 6) return false;
	const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
	return normalized === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized);
}

function localHost(value: string | null): boolean {
	if (!value || /[\s/@\\?#]/.test(value)) return false;
	try {
		const url = new URL(`http://${value}`);
		const host = url.hostname.replace(/^\[|\]$/g, '');
		return host === 'localhost' || loopback(host);
	} catch {
		return false;
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	// Use the socket peer and original Host, never proxy-supplied identities/origins.
	if (process.env.ADDRESS_HEADER || process.env.HOST_HEADER || process.env.PORT_HEADER) {
		return new Response('Local-only access requires ADDRESS_HEADER, HOST_HEADER and PORT_HEADER to be unset.', { status: 403 });
	}
	if (!loopback(event.getClientAddress()) || !localHost(event.request.headers.get('host'))) {
		return new Response('Superbase is local-only. Use localhost or a loopback address from this machine.', { status: 403 });
	}
	prepareConnection(event);
	return resolve(event);
};

// Preserve useful SQL/constraint errors, but never echo connection URLs or credentials.
export const handleError: HandleServerError = ({ error }) => ({ message: safeErrorMessage(error) });
