import type { RequestHandler } from '@sveltejs/kit';
import { activePool, safeErrorMessage } from '#lib/server/connections.js';
import { exportCsv } from '#lib/server/export.js';
import { schemaTargetSchema } from '#lib/schema-validation.js';

export const GET: RequestHandler = async ({ request, url }) => {
	const headers = {
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		'cross-origin-resource-policy': 'same-origin'
	};
	const origin = request.headers.get('origin');
	const site = request.headers.get('sec-fetch-site');
	if ((origin !== null && origin !== url.origin)
		|| (site !== null && site !== 'same-origin' && site !== 'none')) {
		return new Response('CSV export requires a same-origin request.', {
			status: 403, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }
		});
	}
	try {
		const params = url.searchParams;
		const keys = ['connection', 'schema', 'table'];
		if ([...params].length !== keys.length || keys.some((key) => params.getAll(key).length !== 1)) {
			throw new Error('Expected exactly one connection, schema and table parameter');
		}
		const parsed = schemaTargetSchema['~standard'].validate(Object.fromEntries(params));
		if ('issues' in parsed) throw new Error(parsed.issues[0].message);
		const target = parsed.value;
		const pool = activePool(target.connection);
		const stream = await exportCsv(pool, target, request.signal);
		const filename = `${target.table.replace(/[/\\<>:"|?*\x00-\x1f\x7f]/g, '_')}.csv`;
		const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
			(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
		return new Response(stream, {
			headers: {
				...headers,
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encoded}`
			}
		});
	} catch (error) {
		return new Response(`CSV export failed: ${safeErrorMessage(error)}`, {
			status: 400, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }
		});
	}
};
