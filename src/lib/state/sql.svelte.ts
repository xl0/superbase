import { cancelSql, closeSql, openSql, runSql } from '#lib/db.remote.js';
import { SQL_MAX_LENGTH, type SqlRunResult, type SqlTransaction } from '#lib/sql.js';
import { message } from '#lib/utils.js';
import type { ConnectionInfo } from '#lib/types.js';

const TAB_KEY = 'superbase.sql.tab';
const DRAFT_PREFIX = 'superbase.sql.draft.v1:';

/** Only SQL text is persisted; database session IDs and execution state stay in memory. */
export class SqlState {
	draft = $state('');
	session = $state<string | null>(null);
	transaction = $state<SqlTransaction>('closed');
	busy = $state(false);
	running = $state<string | null>(null);
	cancelling = $state(false);
	result = $state.raw<SqlRunResult | null>(null);
	error = $state('');

	draftReady = $state(false);
	draftError = $state('');
	#savedDraft = $state('');
	#draftKey: string | null = null;
	#tab: string | null = null;
	#release: (() => void) | null = null;
	#epoch = 0;
	#leaving = false;
	readonly connection: string;
	#database: string[];

	constructor(connection: ConnectionInfo) {
		this.connection = connection.id;
		// Generations/credentials are deliberately absent: reconnecting restores the same target's text.
		this.#database = [connection.host, connection.port, connection.database, connection.user];
	}
	get reloadBlocked() {
		return !this.#leaving && (this.draft !== this.#savedDraft ||
			(Boolean(this.draftError) && Boolean(this.draft || this.#savedDraft)) || this.busy || this.cancelling ||
			this.transaction === 'transaction' || this.transaction === 'failed' || this.needsReset);
	}
	get protectedWork() { return !this.#leaving && (this.reloadBlocked || this.session !== null); }
	get needsReset() { return this.session !== null && this.transaction === 'closed'; }

	/** Claim a tab slot before restoring. Duplicated tabs inherit sessionStorage, so UUIDs alone aren't enough. */
	async restoreDraft(resume = false) {
		if (this.#leaving) return;
		this.pauseDraft();
		const epoch = this.#epoch;
		let conflict = false;
		const key = (tab: string) => DRAFT_PREFIX + JSON.stringify([tab, ...this.#database]);
		const claim = (tab: string) => new Promise<boolean>((resolve, reject) => {
			void navigator.locks.request(`superbase.sql.owner:${tab}`, { ifAvailable: true }, (lock) => {
				if (!lock || epoch !== this.#epoch) { resolve(false); return; }
				return new Promise<void>((release) => { this.#release = release; resolve(true); });
			}).catch(reject);
		});
		try {
			if (!navigator.locks) throw new Error('Web Locks are unavailable');
			let tab = sessionStorage.getItem(TAB_KEY) ?? crypto.randomUUID();
			if (!/^[\da-f-]{36}$/i.test(tab)) throw new Error('Invalid draft tab identity');
			const source = key(tab);
			const owned = await claim(tab);
			if (epoch !== this.#epoch) return;
			const stored = localStorage.getItem(source) ?? '';
			// A cached page must not overwrite newer text or move the tab's other database drafts.
			if (resume && (!owned || tab !== this.#tab || stored !== this.#savedDraft)) {
				conflict = true;
				throw new Error('Draft changed while suspended');
			}
			if (!owned) {
				this.#release?.(); this.#release = null;
				tab = crypto.randomUUID();
				if (!await claim(tab)) throw new Error('Could not claim draft storage');
				if (epoch !== this.#epoch) return;
			}
			if (!resume) this.draft = stored;
			this.#savedDraft = key(tab) === source ? stored : '';
			sessionStorage.setItem(TAB_KEY, tab);
			this.#tab = tab;
			this.#draftKey = key(tab);
			this.saveDraft();
		} catch {
			if (epoch !== this.#epoch) return;
			this.#release?.(); this.#release = null;
			this.#draftKey = null;
			this.draftError = conflict
				? 'SQL draft changed while this page was suspended. Autosave is paused; copy your SQL before leaving.'
				: 'SQL draft storage is unavailable. Copy your SQL before leaving; reload protection remains enabled.';
		} finally {
			if (epoch === this.#epoch) this.draftReady = true;
		}
	}

	updateDraft(value: string) {
		this.draft = value;
		this.saveDraft();
	}

	private saveDraft() {
		if (!this.#draftKey) return;
		try {
			if (sessionStorage.getItem(TAB_KEY) !== this.#tab) throw new Error('Draft identity changed');
			// Synchronous writes keep the unload guard accurate, including the last keystroke and clearing text.
			if (this.draft) localStorage.setItem(this.#draftKey, this.draft);
			else localStorage.removeItem(this.#draftKey);
			this.#savedDraft = this.draft;
			this.draftError = '';
		} catch {
			this.draftError = 'SQL draft could not be saved locally. Copy your SQL before leaving; reload protection remains enabled.';
		}
	}

	/** Detect eviction, cleared site data or lost tab identity without silently recreating deleted storage. */
	checkDraft(changedKey: string | null = null) {
		if (!this.#draftKey || (changedKey !== null && changedKey !== this.#draftKey)) return;
		try {
			if (sessionStorage.getItem(TAB_KEY) !== this.#tab || (localStorage.getItem(this.#draftKey) ?? '') !== this.#savedDraft) {
				throw new Error('Saved draft changed');
			}
			if (this.draft === this.#savedDraft) this.draftError = '';
		} catch {
			this.#draftKey = null;
			this.draftError = 'SQL draft storage changed or became unavailable. Autosave is paused; copy your SQL before leaving.';
		}
	}

	pauseDraft() {
		this.#epoch++;
		this.draftReady = false;
		this.#draftKey = null;
		this.#release?.(); this.#release = null;
	}

	/** A confirmed, successful connection change retires the old workspace without erasing its saved draft. */
	prepareReload() {
		this.#leaving = true;
		this.session = null;
		this.pauseDraft();
	}

	async run(sql: string) {
		if (this.busy || this.cancelling || this.needsReset || !sql.trim()) return;
		if (sql.length > SQL_MAX_LENGTH) {
			this.error = `Run at most ${SQL_MAX_LENGTH.toLocaleString()} characters at once.`;
			return;
		}
		this.busy = true;
		this.error = '';
		this.result = null;
		try {
			if (!this.session) {
				const opened = await openSql({ connection: this.connection });
				this.session = opened.session;
				this.transaction = opened.transaction;
			}
			const run = this.running = crypto.randomUUID();
			const result = await runSql({ connection: this.connection, session: this.session, run, sql });
			this.result = result;
			this.transaction = result.transaction;
		} catch (error) {
			this.error = message(error) + (this.running
				? ' Execution outcome is unknown. Check the database before retrying; reset this session first.' : '');
			// Never transparently reopen/replay after a lost execution response.
			this.transaction = 'closed';
		} finally {
			this.running = null;
			this.busy = false;
		}
	}

	async cancel() {
		if (!this.session || !this.running || this.cancelling) return;
		this.cancelling = true;
		try {
			await cancelSql({ connection: this.connection, session: this.session, run: this.running });
		} catch (error) {
			this.error = `Cancellation failed: ${message(error)}`;
		} finally {
			this.cancelling = false;
		}
	}

	async reset() {
		if (this.busy || this.cancelling) return;
		this.busy = true;
		this.error = '';
		try {
			if (this.session) await closeSql({ connection: this.connection, session: this.session });
			this.session = null;
			this.transaction = 'closed';
			this.result = null;
		} catch (error) {
			this.error = message(error);
		} finally {
			this.busy = false;
		}
	}
}
