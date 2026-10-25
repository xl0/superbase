import { cancelSql, closeSql, openSql, runSql } from '#lib/db.remote.js';
import type { SqlRunResult, SqlTransaction } from '#lib/sql.js';
import { message } from '#lib/utils.js';
import type { ConnectionInfo } from '#lib/types.js';

/** One SQL workspace. Only the draft text persists (per database, shared by tabs); sessions stay in memory. */
export class SqlState {
	draft = $state('');
	session = $state<string | null>(null);
	transaction = $state<SqlTransaction>('closed');
	busy = $state(false);
	running = $state(false);
	cancelling = $state(false);
	result = $state.raw<SqlRunResult | null>(null);
	error = $state('');
	readonly connection: string;
	readonly #draftKey: string;

	constructor(connection: ConnectionInfo) {
		this.connection = connection.id;
		this.#draftKey = `superbase.sql:${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
		try { this.draft = localStorage.getItem(this.#draftKey) ?? ''; } catch { /* Storage denied: drafts are not kept. */ }
	}

	/** Open or failed transactions and lost sessions are worth a reload warning; saved drafts are not. */
	get protectedWork() { return this.busy || this.transaction === 'transaction' || this.transaction === 'failed' || this.needsReset; }
	get needsReset() { return this.session !== null && this.transaction === 'closed'; }

	updateDraft(value: string) {
		this.draft = value;
		try {
			if (value) localStorage.setItem(this.#draftKey, value);
			else localStorage.removeItem(this.#draftKey);
		} catch { /* Quota or denied storage: keep editing in memory. */ }
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
