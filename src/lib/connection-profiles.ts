import type { ConnectionInfo } from './types.js';
import type { ConnectionOptions } from './connection-options.js';

/** Saved in this browser's localStorage, credentials included (unencrypted). */
export interface ConnectionProfile extends ConnectionOptions {
	id: string;
	name: string;
}
const KEY = 'superbase.connection-profiles.v1';

export function loadProfiles(): ConnectionProfile[] {
	try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function storeProfiles(profiles: ConnectionProfile[]): void {
	localStorage.setItem(KEY, JSON.stringify(profiles));
}

/** Password-free label: host:port/database · user. */
export function profileTarget(url: string): string {
	const parsed = URL.parse(url);
	if (!parsed) return '';
	const user = decodeURIComponent(parsed.username);
	return `${parsed.hostname}:${parsed.port || '5432'}${decodeURIComponent(parsed.pathname)}${user ? ` · ${user}` : ''}`;
}

export function connectionTarget(info: ConnectionInfo): string {
	return `${info.host}:${info.port}/${info.database} · ${info.user}`;
}
