import { connectionOptions, type ConnectionOptions } from './connection-options.js';

/** One browser-local credential, never a server-side persistence mechanism. */
export interface RememberedConnection extends ConnectionOptions {
	autoConnect: boolean;
	/** Saved profile that supplied this reconnect entry, if any. */
	profile?: string;
}

const KEY = 'superbase.connection';
export const RECONNECT_KEY = 'superbase.auto-reconnect';

export function autoReconnectEnabled(): boolean {
	const raw = localStorage.getItem(RECONNECT_KEY);
	if (raw === null) return rememberedConnection()?.autoConnect ?? false;
	if (raw !== 'true' && raw !== 'false') throw new Error('Automatic reconnect preference is unreadable.');
	return raw === 'true';
}

export function setAutoReconnect(enabled: boolean): void {
	// Disabling also fences a connection already in flight in another tab.
	if (!enabled) forgetConnection();
	localStorage.setItem(RECONNECT_KEY, String(enabled));
}

// Separate, non-secret consent: denied storage must not resurrect an old saved target.
// Cookies otherwise span ports, unlike localStorage.
function consentName(): string {
	return `superbase_reconnect_${location.protocol.slice(0, -1)}_${location.port || 'default'}`;
}

function hasConsent(value: string): boolean {
	return document.cookie.split(';').some((part) => part.trim() === `${consentName()}=${value}`);
}

/** Recheck a preference action after waiting for a browser storage lock. */
export function reconnectIntentCurrent(intent: string): boolean {
	return hasConsent(intent);
}

function consent(next: string): void {
	const value = `${consentName()}=${next}`;
	document.cookie = `${value}; Path=/; SameSite=Strict; Max-Age=31536000${location.protocol === 'https:' ? '; Secure' : ''}`;
	if (!hasConsent(next)) {
		throw new Error('Allow cookies for this site before changing connections.');
	}
}

export function restorationAllowed(): boolean {
	return hasConsent('1');
}

export function rememberedConnection(): RememberedConnection | null {
	const raw = localStorage.getItem(KEY);
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw);
		if (typeof value?.url === 'string' && value.url.length > 0 && value.url.length <= 8192 &&
			typeof value.autoConnect === 'boolean' &&
			(value.profile === undefined || (typeof value.profile === 'string' && /^[0-9a-f-]{36}$/.test(value.profile)))) return {
				...connectionOptions(value.url, value.sslMode),
				autoConnect: value.autoConnect && restorationAllowed(),
				...(value.profile === undefined ? {} : { profile: value.profile })
			};
	} catch { /* Do not include malformed credential text in an error. */ }
	throw new Error('Saved connection is unreadable. Forget it and connect again.');
}

export function rememberConnection(url: string, intent: string, profile?: string, sslMode?: ConnectionOptions['sslMode']): void {
	if (!hasConsent(intent)) return;
	localStorage.setItem(KEY, JSON.stringify({ ...connectionOptions(url, sslMode), autoConnect: true, ...(profile === undefined ? {} : { profile }) }));
	consent('1');
}

/** Pause before a manual change. Only this intent may persist its eventual result. */
export function pauseRememberedConnection(): string {
	const intent = crypto.randomUUID();
	consent(intent);
	try {
		const saved = rememberedConnection();
		if (saved) localStorage.setItem(KEY, JSON.stringify({ ...saved, autoConnect: false }));
	} catch (error) {
		// Nonpersistent connections still work when localStorage is denied. Consent stays off.
		if (!(error instanceof DOMException && error.name === 'SecurityError')) throw error;
	}
	return intent;
}

export function forgetConnection(intent?: string): void {
	if (intent !== undefined && !hasConsent(intent)) return;
	consent('0');
	localStorage.removeItem(KEY);
}
