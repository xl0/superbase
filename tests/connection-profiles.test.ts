import { afterEach, beforeEach, expect, test } from 'bun:test';
import { connectionProfiles, saveProfile, removeProfile, withCurrentProfile, PROFILES_KEY, activeProfile, recordActiveProfile, profileTarget } from '../src/lib/connection-profiles';
import { connectionOptions } from '../src/lib/connection-options';
import { rememberConnection, rememberedConnection, pauseRememberedConnection, setAutoReconnect, autoReconnectEnabled, reconnectIntentCurrent } from '../src/lib/remembered-connection';

let originals: Map<string, PropertyDescriptor | undefined>;
let data: Map<string, string>;
let cookie: string;
let failWrite: boolean;
beforeEach(() => {
	originals = new Map(['localStorage', 'document', 'location', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	data = new Map(); cookie = ''; failWrite = false;
	let tail = Promise.resolve();
	const globals = {
		localStorage: {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => { if (failWrite) throw new DOMException('Full', 'QuotaExceededError'); data.set(key, value); },
			removeItem: (key: string) => data.delete(key)
		},
		document: { get cookie() { return cookie; }, set cookie(value: string) { cookie = value.split(';')[0]; } },
		location: { protocol: 'http:', port: '5174' },
		navigator: { locks: { request(_key: string, action: () => unknown) {
			const result = tail.then(action); tail = result.then(() => undefined, () => undefined); return result;
		} } }
	};
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
});
afterEach(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
const draft = (name = 'Local') => ({ name, url: 'postgresql://user:p%40ss@localhost:5432/db', sslMode: 'disable' as const });

test('explicit save preserves the complete URL while picker labels exclude credentials', async () => {
	const profile = await saveProfile(null, draft());
	expect(profile.url).toBe(draft().url);
	expect(data.get(PROFILES_KEY)).toContain('p%40ss');
	expect(connectionProfiles()[0].url).toBe(draft().url);
	expect(profileTarget(profile)).toBe('localhost:5432/db · user');
	expect(connectionOptions('  postgres://user:界@localhost/名字  ').url).toBe('postgres://user:界@localhost/名字');
});

test('invalid and oversized URLs fail without echoing credential text', () => {
	for (const url of ['secret-password', 'https://user:secret-password@host/db', 'postgres://host/db?password=secret-password',
		'postgres://host/db?sslmode=disable&sslmode=require', 'postgres://host/db#secret-password']) {
		expect(() => connectionOptions(url)).toThrow();
		try { connectionOptions(url); } catch (error) { expect(String(error)).not.toContain('secret-password'); }
	}
	expect(() => connectionOptions(`postgres://host/${'界'.repeat(8192)}`)).toThrow();
});

test('SSL imports without rewriting credentials, survives storage, and mode-only edits revoke reconnect', async () => {
	const url = 'postgres://User:p%40ss@DB.example/名字';
	for (const sslMode of ['disable', 'prefer', 'require', 'verify-full'] as const) {
		expect(connectionOptions(`${url}?sslmode=${sslMode}`)).toEqual({ url, sslMode });
		expect(connectionOptions(url, sslMode)).toEqual({ url, sslMode });
	}
	for (const mode of [null, false, {}, 'allow', 'no-verify', '__proto__']) {
		expect(() => connectionOptions(url, mode)).toThrow('SSL mode');
	}
	expect(() => connectionOptions(`${url}?sslmode=verify-full`, 'disable')).toThrow('conflicts');
	let profile = await saveProfile(null, draft());
	data.set(PROFILES_KEY, JSON.stringify([{ id: profile.id, revision: profile.revision, name: profile.name, url: `${profile.url}?sslmode=disable` }]));
	expect(connectionProfiles()).toEqual([profile]);
	rememberConnection(profile.url, pauseRememberedConnection(), profile.id, profile.sslMode);
	profile = await saveProfile(profile, { ...profile, sslMode: 'prefer' });
	expect(rememberedConnection()).toBeNull();
	expect(connectionProfiles()[0].sslMode).toBe('prefer');
	expect(connectionProfiles()[0].url).toBe(draft().url);
	rememberConnection(profile.url, pauseRememberedConnection(), profile.id, profile.sslMode);
	expect(rememberedConnection()?.sslMode).toBe('prefer');
});

test('serialized writes retain other profiles and reject stale edits/removals and duplicate names', async () => {
	const [a, b] = await Promise.all([saveProfile(null, draft('A')), saveProfile(null, draft('B'))]);
	expect(connectionProfiles()).toHaveLength(2);
	const renamed = await saveProfile(a, { ...draft(), name: 'Renamed' });
	expect(renamed.id).toBe(a.id);
	await expect(saveProfile(a, draft())).rejects.toThrow('changed or was removed');
	await expect(removeProfile(a)).rejects.toThrow('changed or was removed');
	await expect(saveProfile(null, draft('renamed'))).rejects.toThrow('already exists');
	await removeProfile(renamed);
	expect(connectionProfiles()).toEqual([b]);
});

test('editing/removing a profile revokes its reconnect entry and fences late credential writes', async () => {
	const a = await saveProfile(null, draft());
	const intent = pauseRememberedConnection();
	await withCurrentProfile(a, () => rememberConnection(a.url, intent, a.id));
	expect(rememberedConnection()?.profile).toBe(a.id);
	expect(await saveProfile(a, draft())).toEqual(a);
	expect(rememberedConnection()?.autoConnect).toBe(true);
	const updated = await saveProfile(a, { ...draft(), name: 'Updated' });
	expect(rememberedConnection()).toBeNull();
	await expect(withCurrentProfile(a, () => rememberConnection(a.url, intent, a.id))).rejects.toThrow('changed or was removed');
	const pending = pauseRememberedConnection();
	await removeProfile(updated);
	await expect(withCurrentProfile(updated, () => rememberConnection(a.url, pending, a.id))).rejects.toThrow('changed or was removed');
	expect(rememberedConnection()).toBeNull();
});

test('removing another profile does not erase the current reconnect entry', async () => {
	const a = await saveProfile(null, draft('A'));
	const b = await saveProfile(null, draft('B'));
	rememberConnection(a.url, pauseRememberedConnection(), a.id);
	await removeProfile(b);
	expect(rememberedConnection()?.profile).toBe(a.id);
});

test('failed storage and corrupt records never overwrite the saved list', async () => {
	const a = await saveProfile(null, draft());
	failWrite = true;
	await expect(saveProfile(a, draft('New'))).rejects.toThrow('Full');
	expect(connectionProfiles()).toEqual([a]);
	failWrite = false;
	const corrupt = JSON.stringify([{ ...a, url: 'not-a-postgres-url' }]);
	data.set(PROFILES_KEY, corrupt);
	expect(connectionProfiles).toThrow('unreadable');
	await expect(saveProfile(null, draft())).rejects.toThrow('unreadable');
	expect(data.get(PROFILES_KEY)).toBe(corrupt);
});

test('active labels require both the successful generation and unchanged profile revision', async () => {
	const profile = await saveProfile(null, draft());
	recordActiveProfile('generation-a', profile);
	expect(activeProfile('generation-a', connectionProfiles())).toEqual(profile);
	expect(activeProfile('generation-b', connectionProfiles())).toBeNull();
	await saveProfile(profile, draft('Renamed'));
	expect(activeProfile('generation-a', connectionProfiles())).toBeNull();
	expect(profileTarget(profile)).not.toContain('p%40ss');
});

test('reconnect preference survives disconnect pauses, but disabling fences late writes', () => {
	expect(autoReconnectEnabled()).toBe(false);
	setAutoReconnect(true);
	rememberConnection(draft().url, pauseRememberedConnection());
	pauseRememberedConnection();
	expect(autoReconnectEnabled()).toBe(true);
	expect(rememberedConnection()?.autoConnect).toBe(false);
	const late = pauseRememberedConnection();
	setAutoReconnect(false);
	rememberConnection(draft().url, late);
	expect(autoReconnectEnabled()).toBe(false);
	expect(rememberedConnection()).toBeNull();
});

test('queued opt-in cannot undo opt-out, and explicit clearing recovers corrupt reconnect data', async () => {
	const profile = await saveProfile(null, draft());
	let release!: () => void;
	const held = navigator.locks.request(PROFILES_KEY, () => new Promise<void>((resolve) => { release = resolve; }));
	await Promise.resolve();
	const intent = pauseRememberedConnection();
	const queued = withCurrentProfile(profile, () => {
		if (!reconnectIntentCurrent(intent)) return;
		setAutoReconnect(true);
		rememberConnection(profile.url, intent, profile.id);
	});
	setAutoReconnect(false);
	release(); await held; await queued;
	expect(autoReconnectEnabled()).toBe(false);
	expect(rememberedConnection()).toBeNull();
	data.set('superbase.connection', '{broken secret');
	expect(rememberedConnection).toThrow('unreadable');
	setAutoReconnect(false);
	expect(rememberedConnection()).toBeNull();
	expect(connectionProfiles()).toEqual([profile]);
});
