import { cancelSql, closeSql, openSql, runSql } from '#lib/db.remote.js';
import { SQL_MAX_LENGTH, type SqlRunResult, type SqlTransaction } from '#lib/sql.js';
import { message } from '#lib/utils.js';

/** One mounted workspace/tab; drafts and dedicated session IDs are never persisted. */
export class SqlState {
	draft = $state('');
	session = $state<string | null>(null);
	transaction = $state<SqlTransaction>('closed');
	busy = $state(false);
	running = $state<string | null>(null);
	cancelling = $state(false);
	result = $state.raw<SqlRunResult | null>(null);
	error = $state('');

	constructor(readonly connection: string) {}
	get protectedWork() {
		return !!this.draft.length || this.busy || this.session !== null;
	}
	get needsReset() { return this.session !== null && this.transaction === 'closed'; }

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
