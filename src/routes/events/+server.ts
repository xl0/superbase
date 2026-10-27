import type { RequestHandler } from '@sveltejs/kit';
import { safeErrorMessage, subscribeChanges } from '#lib/server/connections.js';

/** Realtime as server-sent events: one `data:` line per change notification of the named database; an
 * `unavailable` event (then close) when notifications cannot be delivered, so the browser stops retrying. */
export const GET: RequestHandler = ({ url, request }) => {
	const encoder = new TextEncoder();
	let stop = () => {};
	try {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { stop(); } };
				// Proxies close idle connections; a comment line every 25 s keeps the stream open.
				const ping = setInterval(() => send(': ping\n\n'), 25_000);
				const unsubscribe = subscribeChanges(url.searchParams.get('connection') ?? '', (payload) => send(`data: ${payload}\n\n`), (reason) => {
					if (reason) send(`event: unavailable\ndata: ${reason}\n\n`);
					stop();
					try { controller.close(); } catch { /* Already closed. */ }
				});
				stop = () => { clearInterval(ping); unsubscribe(); stop = () => {}; };
				request.signal.addEventListener('abort', () => stop());
				send(': connected\n\n');
			},
			cancel() { stop(); }
		});
		return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
	} catch (error) {
		return new Response(safeErrorMessage(error), { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
};
