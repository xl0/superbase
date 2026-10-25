import { forgetConnection, rememberedConnection } from './remembered-connection.js';
import { connectionOptions, type ConnectionOptions } from './connection-options.js';

/** Browser-local settings. Explicit Save stores the complete URL, including credentials. */
export interface ConnectionProfile extends ConnectionOptions {
	id: string;
	revision: string;
	name: string;
}
export const PROFILES_KEY = 'superbase.connection-profiles.v1';
export const ACTIVE_PROFILE_KEY = 'superbase.active-profile';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Display hint only: never used to choose a target or authorize a command. */
export function activeProfile(generation: string | undefined, profiles: ConnectionProfile[]): ConnectionProfile | null {
	const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
	if (!raw || !generation) return null;
	let value;
	try { value = JSON.parse(raw); }
	catch { return null; } // A damaged label must not hide the actual server-reported database.
	return value?.generation === generation
		? profiles.find((profile) => profile.id === value.id && profile.revision === value.revision) ?? null : null;
}

export function recordActiveProfile(generation: string | undefined, profile: ConnectionProfile | null): void {
	try {
		if (generation && profile) localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify({ generation, id: profile.id, revision: profile.revision }));
		else localStorage.removeItem(ACTIVE_PROFILE_KEY);
	} catch (error) {
		// Optional label only; the server-reported database remains available without browser storage.
		if (!(error instanceof DOMException && ['SecurityError', 'QuotaExceededError'].includes(error.name))) throw error;
	}
}

/** Safe picker text, deliberately excluding passwords and URL query strings. */
export function profileTarget(profile: Pick<ConnectionProfile, 'url'>): string {
	const url = new URL(profile.url);
	return `${url.hostname}:${url.port || '5432'}${url.pathname} · ${url.username || 'postgres'}`;
}

export function connectionProfiles(): ConnectionProfile[] {
	const raw = localStorage.getItem(PROFILES_KEY);
	if (raw === null) return [];
	try {
		const values: unknown = JSON.parse(raw);
		if (!Array.isArray(values) || values.length > 50) throw new Error();
		const ids = new Set<string>();
		const names = new Set<string>();
		for (const value of values) {
			if (!value ||
				typeof value.id !== 'string' || !uuid.test(value.id) ||
				typeof value.revision !== 'string' || !uuid.test(value.revision) ||
				typeof value.name !== 'string' || !value.name.trim() || value.name !== value.name.trim() || value.name.length > 100 ||
				typeof value.url !== 'string' ||
				value.url.trim() !== value.url || ids.has(value.id) || names.has(value.name.toLowerCase())) throw new Error();
			ids.add(value.id); names.add(value.name.toLowerCase());
		}
		return values.map(({ id, revision, name, url, sslMode }) => ({ id, revision, name, ...connectionOptions(url, sslMode) }));
	} catch {
		throw new Error('Saved profiles are unreadable. No changes were made; inspect or clear this site’s profile storage.');
	}
}

export function assertCurrentProfile(expected: ConnectionProfile): void {
	if (!connectionProfiles().some((profile) => profile.id === expected.id && profile.revision === expected.revision)) {
		throw new Error('This profile changed or was removed in another tab. Reload it before continuing.');
	}
}

function locked<T>(action: () => T): Promise<T> {
	if (!navigator.locks) throw new Error('Saving profiles requires browser Web Locks. Use a current browser on localhost.');
	return navigator.locks.request(PROFILES_KEY, action);
}

/** Recheck after connecting; removal/editing cannot race a late reconnect-credential write. */
export function withCurrentProfile<T>(expected: ConnectionProfile, action: () => T): Promise<T> {
	return locked(() => { assertCurrentProfile(expected); return action(); });
}

export function saveProfile(expected: ConnectionProfile | null, draft: { name: string; url: string; sslMode?: ConnectionProfile['sslMode'] }): Promise<ConnectionProfile> {
	const name = draft.name.trim();
	if (!name || name.length > 100) throw new Error('Profile names must contain 1–100 characters.');
	const { url, sslMode } = connectionOptions(draft.url, draft.sslMode);
	return locked(() => {
		const profiles = connectionProfiles();
		if (expected) assertCurrentProfile(expected);
		else if (profiles.length >= 50) throw new Error('At most 50 connection profiles can be saved.');
		if (profiles.some((profile) => profile.id !== expected?.id && profile.name.toLowerCase() === name.toLowerCase())) {
			throw new Error('A profile with this name already exists.');
		}
		const current = profiles.find((item) => item.id === expected?.id);
		if (current && current.name === name && current.url === url && current.sslMode === sslMode) return current;
		const profile = { id: expected?.id ?? crypto.randomUUID(), revision: crypto.randomUUID(), name, url, sslMode };
		// Updating settings invalidates their separate automatic-reconnect entry, not the live session.
		if (expected && rememberedConnection()?.profile === expected.id) forgetConnection();
		localStorage.setItem(PROFILES_KEY, JSON.stringify(expected
			? profiles.map((item) => item.id === expected.id ? profile : item) : [...profiles, profile]));
		return profile;
	});
}

export function removeProfile(expected: ConnectionProfile): Promise<void> {
	return locked(() => {
		assertCurrentProfile(expected);
		if (rememberedConnection()?.profile === expected.id) forgetConnection();
		localStorage.setItem(PROFILES_KEY, JSON.stringify(connectionProfiles().filter((profile) => profile.id !== expected.id)));
	});
}
