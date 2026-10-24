import type { RequestHandler } from '@sveltejs/kit';
import { activePool, safeErrorMessage } from '#lib/server/connections.js';
import { exportCsv } from '#lib/server/export.js';
import { csvExportSchema } from '#lib/schema-validation.js';

const download: RequestHandler = async ({ request, url }) => {
	const headers = {
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		'cross-origin-resource-policy': 'same-origin'
	};
	const origin = request.headers.get('origin');
	const site = request.headers.get('sec-fetch-site');
	if ((request.method === 'POST' ? origin !== url.origin : origin !== null && origin !== url.origin)
		|| (site !== null && site !== 'same-origin' && site !== 'none')) {
		return new Response('CSV export requires a same-origin request.', {
			status: 403, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }
		});
	}
	try {
		let input: unknown;
		if (request.method === 'POST') {
			if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
				return new Response('CSV export requires a URL-encoded form.', {
					status: 415, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }
				});
			}
			// Native form downloads stream without a JS blob or filter values in URLs/history.
			const form = await request.formData();
			if (url.search || [...form].length !== 1 || typeof form.get('export') !== 'string') {
				throw new Error('Expected exactly one export form field and no URL parameters');
			}
			input = JSON.parse(form.get('export') as string);
		} else {
			const params = url.searchParams;
			const keys = ['connection', 'schema', 'table'];
			if ([...params].length !== keys.length || keys.some((key) => params.getAll(key).length !== 1)) {
				throw new Error('Expected exactly one connection, schema and table parameter');
			}
			input = Object.fromEntries(params);
		}
		const parsed = csvExportSchema['~standard'].validate(input);
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

export const GET = download;
export const POST = download;
