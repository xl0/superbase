import type { RequestHandler } from '@sveltejs/kit';
import type { CsvExportArgs } from '#lib/types.js';
import { activePool, safeErrorMessage } from '#lib/server/connections.js';
import { exportCsv } from '#lib/server/export.js';

/** Native form POST (SvelteKit checks its origin) into a hidden frame: the browser streams the download. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const target: CsvExportArgs = JSON.parse(String((await request.formData()).get('export')));
		const stream = await exportCsv(activePool(target.connection), target, request.signal);
		return new Response(stream, {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(`${target.table}.csv`)}`,
				'cache-control': 'no-store'
			}
		});
	} catch (error) {
		return new Response(`CSV export failed: ${safeErrorMessage(error)}`, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
};
