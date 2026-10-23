import { afterAll, beforeEach, expect, test } from 'bun:test';
import { rememberedConnection, rememberConnection, pauseRememberedConnection, forgetConnection } from '../src/lib/remembered-connection';

const originals = new Map(['localStorage', 'document', 'location'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let cookie = '';
Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', port: '5174' } });
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
	get cookie() { return cookie; },
	set cookie(value: string) { cookie = value.split(';')[0]; }
} });
const data = new Map<string, string>();
const storage = {
	getItem: (key: string) => data.get(key) ?? null,
	setItem: (key: string, value: string) => { data.set(key, value); },
	removeItem: (key: string) => { data.delete(key); }
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
beforeEach(() => { data.clear(); cookie = ''; });
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test('pause retains exact credentials without restoring; remembering again resumes; forget removes them', () => {
	const url = 'postgresql://user:p%40ss@localhost/test?sslmode=verify-full';
	expect(rememberedConnection()).toBeNull();
	rememberConnection(url, pauseRememberedConnection());
	expect(rememberedConnection()).toEqual({ url, autoConnect: true });
	pauseRememberedConnection();
	expect(rememberedConnection()).toEqual({ url, autoConnect: false });
	rememberConnection(url, pauseRememberedConnection());
	expect(rememberedConnection()?.autoConnect).toBe(true);
	forgetConnection();
	expect(rememberedConnection()).toBeNull();
	pauseRememberedConnection();
	expect(data.size).toBe(0);
});

test('corrupt browser data fails explicitly without leaking its credential text', () => {
	for (const raw of ['{"url":"secret-password', 'null', '{"url":42,"autoConnect":true}', '{"url":"secret-password","autoConnect":"false"}']) {
		data.set('superbase.connection', raw);
		expect(rememberedConnection).toThrow('Saved connection is unreadable. Forget it and connect again.');
	}
	forgetConnection();
	expect(rememberedConnection()).toBeNull();
});

test('failure to pause propagates, so a manual target change must not proceed', () => {
	rememberConnection('postgresql://localhost/old', pauseRememberedConnection());
	const setItem = storage.setItem;
	storage.setItem = () => { throw new Error('Storage is full'); };
	try {
		expect(pauseRememberedConnection).toThrow('Storage is full');
	} finally { storage.setItem = setItem; }
	expect(rememberedConnection()?.autoConnect).toBe(false);
	expect(JSON.parse(data.get('superbase.connection')!).autoConnect).toBe(true);
});

test('denied storage permits a nonpersistent change but cannot resurrect the old target later', () => {
	rememberConnection('postgresql://localhost/old', pauseRememberedConnection());
	const getItem = storage.getItem;
	storage.getItem = () => { throw new DOMException('Access denied', 'SecurityError'); };
	try {
		expect(pauseRememberedConnection).not.toThrow();
	} finally { storage.getItem = getItem; }
	expect(rememberedConnection()?.autoConnect).toBe(false);
	expect(JSON.parse(data.get('superbase.connection')!).autoConnect).toBe(true);
});

test('lost consent fails closed even if a stored URL still requests automatic restoration', () => {
	rememberConnection('postgresql://localhost/old', pauseRememberedConnection());
	cookie = '';
	expect(rememberedConnection()?.autoConnect).toBe(false);
});

test('a late connection response cannot overwrite a newer choice or undo Forget in another tab', () => {
	const older = pauseRememberedConnection();
	const newer = pauseRememberedConnection();
	rememberConnection('postgresql://localhost/new', newer);
	rememberConnection('postgresql://localhost/old', older);
	forgetConnection(older);
	expect(rememberedConnection()).toEqual({ url: 'postgresql://localhost/new', autoConnect: true });
	const pending = pauseRememberedConnection();
	forgetConnection();
	rememberConnection('postgresql://localhost/pending', pending);
	expect(rememberedConnection()).toBeNull();
});
