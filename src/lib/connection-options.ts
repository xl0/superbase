export const SSL_MODES = {
	disable: 'Disabled',
	prefer: 'If available',
	require: 'Required',
	'verify-full': 'Verify certificate'
} as const;
export type SslMode = keyof typeof SSL_MODES;
export interface ConnectionOptions { url: string; sslMode: SslMode }

/** Import a URL's sslmode once; controls and storage then keep SSL separate from credentials. */
export function connectionOptions(input: string, sslMode?: unknown): ConnectionOptions {
	let parsed: URL;
	try { parsed = new URL(input.trim()); }
	catch { throw new Error('Enter a valid Postgres connection URL.'); }
	const options = [...parsed.searchParams];
	if (input.length > 8192 || !['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname ||
		!parsed.pathname.slice(1) || parsed.hash || options.length > 1 || options.some(([key]) => key !== 'sslmode')) {
		throw new Error('Use a Postgres URL with a host, database and only an optional sslmode.');
	}
	const imported = parsed.searchParams.get('sslmode');
	const mode = sslMode === undefined ? imported ?? 'require' : sslMode;
	if (typeof mode !== 'string' || !Object.hasOwn(SSL_MODES, mode) ||
		(imported !== null && !Object.hasOwn(SSL_MODES, imported))) throw new Error('Invalid SSL mode.');
	if (sslMode !== undefined && imported !== null && sslMode !== imported) {
		throw new Error('The URL sslmode conflicts with the selected SSL mode.');
	}
	const url = input.trim();
	return { url: imported === null ? url : url.slice(0, url.indexOf('?')), sslMode: mode as SslMode };
}
