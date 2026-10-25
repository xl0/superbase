import { isHttpError } from '@sveltejs/kit';
import type { RemoteQuery } from '$app/server';

export { cn } from 'cn';

/** Remote commands throw HttpError; queries expose its body directly. */
export function message(error: unknown): string {
	if (isHttpError(error)) return error.body.message;
	return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

/** Remote queries are cached by argument; table data must always be read again. */
export async function fresh<T>(query: RemoteQuery<T>): Promise<T> {
	await query.refresh();
	if (query.error) throw query.error;
	return query.current as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
