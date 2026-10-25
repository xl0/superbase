export const SSL_MODES = {
	disable: 'Disabled',
	prefer: 'If available',
	require: 'Required',
	'verify-full': 'Verify certificate'
} as const;
export type SslMode = keyof typeof SSL_MODES;
export interface ConnectionOptions { url: string; sslMode: SslMode }

/** Split a pasted URL's sslmode into a separate setting; other URL options are rejected. */
export function connectionOptions(input: string, sslMode?: SslMode): ConnectionOptions {
	const url = input.trim();
	let parsed: URL;
	try { parsed = new URL(url); } catch { throw new Error('Enter a valid postgres:// URL.'); }
	if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Enter a valid postgres:// URL.');
	if ([...parsed.searchParams.keys()].some((key) => key !== 'sslmode')) throw new Error('Only the sslmode URL option is supported.');
	const imported = parsed.searchParams.get('sslmode');
	const mode = sslMode ?? imported ?? 'require';
	if (!Object.hasOwn(SSL_MODES, mode)) throw new Error(`Unsupported SSL mode: ${mode}`);
	return { url: imported === null ? url : url.slice(0, url.indexOf('?')), sslMode: mode as SslMode };
}
