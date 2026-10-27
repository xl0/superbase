import type { ConnectionInfo } from './types.js';
import type { ConnectionOptions } from './connection-options.js';

/** Saved in this browser's localStorage, credentials included (unencrypted). */
export interface ConnectionProfile extends ConnectionOptions {
	id: string;
	name: string;
	/** `connectionTarget` the server resolved the URL to (pg defaults for user, port, database applied), set on connect. */
	target?: string;
}
const KEY = 'superbase.connection-profiles.v1';
const LAST_KEY = 'superbase.last-profile';

export function loadProfiles(): ConnectionProfile[] {
	try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function storeProfiles(profiles: ConnectionProfile[]): void {
	localStorage.setItem(KEY, JSON.stringify(profiles));
}

/** The saved profile last switched to, reconnected automatically when the server has no connection. */
export function lastProfile(): ConnectionProfile | undefined {
	try {
		const id = localStorage.getItem(LAST_KEY);
		return loadProfiles().find((profile) => profile.id === id);
	} catch { return undefined; }
}

/** After a successful connect: the profile (null for a one-off URL) becomes the last one, and learns its target. */
export function rememberProfile(id: string | null, info: ConnectionInfo): void {
	try {
		if (!id) { localStorage.removeItem(LAST_KEY); return; }
		localStorage.setItem(LAST_KEY, id);
		storeProfiles(loadProfiles().map((profile) => profile.id === id ? { ...profile, target: connectionTarget(info) } : profile));
	} catch { /* Storage denied: no automatic reconnect. */ }
}

/** The URL id of a profile's database, once it has connected (see `target`). */
export const profileId = (profile: ConnectionProfile) => profile.target ? connectionId(profile.target) : null;

/** Password-free label from the URL alone: host:port/database · user. */
export function profileTarget(url: string): string {
	const parsed = URL.parse(url);
	if (!parsed) return '';
	const user = decodeURIComponent(parsed.username);
	return `${parsed.hostname}:${parsed.port || '5432'}${decodeURIComponent(parsed.pathname)}${user ? ` · ${user}` : ''}`;
}

export function connectionTarget(info: Pick<ConnectionInfo, 'host' | 'port' | 'database' | 'user'>): string {
	return `${info.host}:${info.port}/${info.database} · ${info.user}`;
}

/** Short, stable id for a password-free target, used in URLs (FNV-1a; not a secret, just no host names). */
export function connectionId(target: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(target)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	return hash.toString(16).padStart(8, '0');
}
