import { isIP } from 'node:net';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { safeErrorMessage } from '#lib/server/connections.js';

const loopback = (host: string) => host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
// Bound to loopback (the default), require a local Host header: blocks DNS-rebinding pages from
// driving the server. Any other HOST is a deliberate deployment behind external auth.
const guarded = !building && loopback(process.env.HOST || '127.0.0.1');

export const handle: Handle = async ({ event, resolve }) => {
	const host = URL.parse(`http://${event.request.headers.get('host')}`)?.hostname.replace(/^\[|\]$/g, '') ?? '';
	if (guarded && !loopback(host)) {
		return new Response('Superbase is local-only. Open it via localhost or 127.0.0.1.', { status: 403 });
	}
	return resolve(event);
};

export const handleError: HandleServerError = ({ error }) => ({ message: safeErrorMessage(error) });
