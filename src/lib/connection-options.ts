/** libpq SSL modes the connection form offers; the URL's `sslmode` is the setting (default `prefer`, as in psql). */
export const SSL_MODES = {
	disable: 'Disabled',
	prefer: 'If available',
	require: 'Required',
	'verify-full': 'Verify certificate'
} as const;

/** The URL is the whole connection setting; form controls only edit its query. */
export interface ConnectionOptions { url: string }

const split = (url: string) => {
	const i = url.indexOf('?');
	return { base: i < 0 ? url : url.slice(0, i), params: new URLSearchParams(i < 0 ? '' : url.slice(i + 1)) };
};

export const urlParam = (url: string, key: string) => split(url).params.get(key);

/** Sets (or, with null, removes) one query option, leaving the rest of the URL as typed. */
export function withParam(url: string, key: string, value: string | null): string {
	const { base, params } = split(url);
	if (value === null) params.delete(key);
	else params.set(key, value);
	const query = params.toString();
	return query ? `${base}?${query}` : base;
}

export function checkUrl(url: string): void {
	if (!/^postgres(ql)?:\/\//.test(url.trim())) throw new Error('Enter a valid postgres:// URL.');
}
