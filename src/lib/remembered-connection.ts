/** One browser-local credential, never a server-side persistence mechanism. */
export interface RememberedConnection {
	url: string;
	autoConnect: boolean;
}

const KEY = 'superbase.connection';

// Separate, non-secret consent: denied storage must not resurrect an old saved target.
// Cookies otherwise span ports, unlike localStorage.
function consentName(): string {
	return `superbase_reconnect_${location.protocol.slice(0, -1)}_${location.port || 'default'}`;
}

function hasConsent(value: string): boolean {
	return document.cookie.split(';').some((part) => part.trim() === `${consentName()}=${value}`);
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
			typeof value.autoConnect === 'boolean') return {
				url: value.url,
				autoConnect: value.autoConnect && restorationAllowed()
			};
	} catch { /* Do not include malformed credential text in an error. */ }
	throw new Error('Saved connection is unreadable. Forget it and connect again.');
}

export function rememberConnection(url: string, intent: string): void {
	if (!hasConsent(intent)) return;
	localStorage.setItem(KEY, JSON.stringify({ url, autoConnect: true }));
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
