import { cancelSql, closeSql, openSql, runSql } from '#lib/db.remote.js';
import type { SqlRunResult, SqlTransaction } from '#lib/sql.js';
import { message } from '#lib/utils.js';
import type { ConnectionInfo } from '#lib/types.js';

/** A saved SQL snippet, shared by every database and tab of this browser (localStorage). */
export interface SqlSnippet {
	id: string;
	name: string;
	sql: string;
	favorite: boolean;
}
const LIBRARY_KEY = 'superbase.sql-snippets';
const COMPLETION_KEY = 'superbase.sql-completion';

/** One SQL workspace. The draft (and which snippet it came from) persists per database; sessions stay in memory. */
export class SqlState {
	draft = $state('');
	/** Saved snippet the draft was opened from or saved as; null for untitled text. */
	snippet = $state<string | null>(null);
	snippets = $state.raw<SqlSnippet[]>([]);
	/** Autocomplete preference for this browser. */
	completion = $state(true);
	session = $state<string | null>(null);
	transaction = $state<SqlTransaction>('closed');
	busy = $state(false);
	running = $state(false);
	cancelling = $state(false);
	result = $state.raw<SqlRunResult | null>(null);
	error = $state('');
	readonly connection: string;
	readonly #draftKey: string;
	/** Text as last opened (e.g. an example), so an untouched copy is not "unsaved". */
	#opened = '';

	constructor(connection: ConnectionInfo) {
		this.connection = connection.key;
		this.#draftKey = `superbase.sql-draft:${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
		try {
			const saved = JSON.parse(localStorage.getItem(this.#draftKey) ?? 'null');
			if (saved) ({ sql: this.draft, snippet: this.snippet } = saved);
			this.completion = localStorage.getItem(COMPLETION_KEY) !== 'false';
		} catch { /* Storage denied or unreadable: start empty. */ }
		this.loadLibrary();
	}

	get current() { return this.snippets.find((snippet) => snippet.id === this.snippet) ?? null; }
	/** Text that would be lost by opening something else. */
	get unsaved() { return this.current ? this.current.sql !== this.draft : !!this.draft.trim() && this.draft !== this.#opened; }

	/** Open or failed transactions and lost sessions are worth a reload warning; saved drafts are not. */
	get protectedWork() { return this.busy || this.transaction === 'transaction' || this.transaction === 'failed' || this.needsReset; }
	get needsReset() { return this.session !== null && this.transaction === 'closed'; }

	updateDraft(value: string) {
		this.draft = value;
		this.#storeDraft();
	}

	#storeDraft() {
		try {
			if (this.draft || this.snippet) localStorage.setItem(this.#draftKey, JSON.stringify({ sql: this.draft, snippet: this.snippet }));
			else localStorage.removeItem(this.#draftKey);
		} catch { /* Quota or denied storage: keep editing in memory. */ }
	}

	setCompletion(enabled: boolean) {
		this.completion = enabled;
		try { localStorage.setItem(COMPLETION_KEY, String(enabled)); } catch { /* Keep the choice for this page only. */ }
	}

	/** Load text into the editor (never runs it); `snippet` links it for later saves. */
	open(sql: string, snippet: string | null) {
		this.draft = this.#opened = sql;
		this.snippet = snippet;
		this.#storeDraft();
	}

	loadLibrary() {
		try { this.snippets = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]'); } catch { this.snippets = []; }
	}

	/** Re-read before writing so changes made in other tabs survive. */
	#updateLibrary(change: (snippets: SqlSnippet[]) => SqlSnippet[]) {
		this.loadLibrary();
		this.snippets = change(this.snippets).sort((a, b) => a.name.localeCompare(b.name));
		localStorage.setItem(LIBRARY_KEY, JSON.stringify(this.snippets));
	}

	/** Save the draft into the open snippet, or as a new snippet when a name is given. */
	save(name?: string) {
		if (name) {
			const id = crypto.randomUUID();
			this.#updateLibrary((snippets) => [...snippets, { id, name, sql: this.draft, favorite: false }]);
			this.snippet = id;
			this.#storeDraft();
		} else if (this.current) {
			this.#updateLibrary((snippets) => snippets.map((item) => item.id === this.snippet ? { ...item, sql: this.draft } : item));
		}
	}

	editSnippet(id: string, change: Partial<Pick<SqlSnippet, 'name' | 'favorite'>>) {
		this.#updateLibrary((snippets) => snippets.map((item) => item.id === id ? { ...item, ...change } : item));
	}

	removeSnippet(id: string) {
		this.#updateLibrary((snippets) => snippets.filter((item) => item.id !== id));
		if (this.snippet === id) { this.snippet = null; this.#storeDraft(); }
	}

	async run(sql: string) {
		if (this.busy || this.needsReset || !sql.trim()) return;
		this.busy = true;
		this.error = '';
		this.result = null;
		try {
			if (!this.session) {
				const opened = await openSql({ connection: this.connection });
				this.session = opened.session;
				this.transaction = opened.transaction;
			}
			this.running = true;
			this.result = await runSql({ connection: this.connection, session: this.session, sql });
			this.transaction = this.result.transaction;
		} catch (error) {
			this.error = message(error) + (this.running ? ' The outcome is unknown; reset the session before retrying.' : '');
			// Never transparently reopen and replay after a lost response.
			this.transaction = 'closed';
		} finally {
			this.running = false;
			this.busy = false;
		}
	}

	async cancel() {
		if (!this.session || !this.running || this.cancelling) return;
		this.cancelling = true;
		try {
			await cancelSql({ connection: this.connection, session: this.session });
		} catch (error) {
			this.error = `Cancellation failed: ${message(error)}`;
		} finally {
			this.cancelling = false;
		}
	}

	async reset() {
		if (this.busy) return;
		this.error = '';
		this.result = null;
		const session = this.session;
		this.session = null;
		this.transaction = 'closed';
		if (session) await closeSql({ connection: this.connection, session }).catch(() => {});
	}
}
