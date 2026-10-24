import type { RequestHandler } from '@sveltejs/kit';
import { activeSql, safeErrorMessage } from '#lib/server/connections.js';
import { sqlTargetSchema } from '#lib/sql-validation.js';

/** pagehide cleanup uses a beacon; remote commands cannot request keepalive delivery. */
export const POST: RequestHandler = async ({ request, url }) => {
	const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
	const site = request.headers.get('sec-fetch-site');
	if (request.headers.get('origin') !== url.origin || (site !== null && site !== 'same-origin' && site !== 'none')) {
		return new Response('SQL session cleanup requires a same-origin request.', { status: 403, headers });
	}
	if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
		return new Response('Expected JSON.', { status: 415, headers });
	}
	try {
		const parsed = sqlTargetSchema['~standard'].validate(await request.json());
		if ('issues' in parsed) throw new Error(parsed.issues[0].message);
		const { connection, session } = parsed.value;
		activeSql(connection).close(session);
		return new Response(null, { status: 204, headers });
	} catch (error) {
		return new Response(safeErrorMessage(error), { status: 400, headers });
	}
};
