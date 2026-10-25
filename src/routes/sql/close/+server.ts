import type { RequestHandler } from '@sveltejs/kit';
import { activeSql } from '#lib/server/connections.js';

/** pagehide cleanup via sendBeacon (text/plain, so SvelteKit's origin check applies). */
export const POST: RequestHandler = async ({ request }) => {
	const { connection, session } = await request.json();
	activeSql(connection).close(session);
	return new Response(null, { status: 204 });
};
