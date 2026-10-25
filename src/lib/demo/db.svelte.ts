/**
 * Demo build (`--mode demo`): replaces db.remote.ts with PostgreSQL running in this tab (PGlite).
 * The query modules run unchanged against a pg-shaped pool. PGlite has a single session, so
 * every operation is serialized and SQL console transactions can't outlive a run.
 * The database lives in memory: a reload starts over.
 */
import { PGlite, type QueryOptions } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_stat_statements } from '@electric-sql/pglite/contrib/pg_stat_statements';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { tablefunc } from '@electric-sql/pglite/contrib/tablefunc';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import type pg from 'pg';
import * as db from '#lib/queries/db.js';
import * as schemaDb from '#lib/queries/schema.js';
import * as databaseDb from '#lib/queries/database.js';
import { exportCsv } from '#lib/queries/export.js';
import { SQL_MAX_RESULTS, SQL_MAX_ROWS, type SqlRunArgs, type SqlRunResult } from '#lib/sql.js';
import type { ConnectionStatus, CsvExportArgs } from '#lib/types.js';
import seed from './seed.sql?raw';

type Demo = { pglite: PGlite; pool: pg.Pool; text: Pick<QueryOptions, 'parsers' | 'serializers'> };
let started: Promise<Demo> | undefined;
let queue = Promise.resolve();

/** Wait for the single session; the caller must release it. */
function exclusive(): Promise<() => void> {
	let release!: () => void;
	const held = new Promise<void>((resolve) => release = resolve);
	const acquired = queue.then(() => release);
	queue = queue.then(() => held);
	return acquired;
}

/** pg's parameter text: JS arrays become array literals, anything else its string form. */
const encode = (value: unknown): string => Array.isArray(value)
	? `{${value.map((item) => item === null ? 'NULL' : Array.isArray(item) ? encode(item) : `"${String(item).replace(/[\\"]/g, '\\$&')}"`).join(',')}}`
	: String(value);

async function start(): Promise<Demo> {
	const pglite = await PGlite.create({ extensions: { citext, fuzzystrmatch, hstore, ltree, pg_stat_statements, pg_trgm, tablefunc, uuid_ossp } });
	await pglite.exec(seed);
	// Like pg: parameters go as given and `types: textTypes` keeps exact text. PGlite only lets
	// per-query handlers override its defaults by oid, so map every type that exists now.
	const oids = (await pglite.query<{ oid: number }>('select oid::int from pg_type')).rows.map((row) => row.oid);
	const text = {
		parsers: Object.fromEntries(oids.map((oid) => [oid, (value: string) => value])),
		serializers: Object.fromEntries(oids.map((oid) => [oid, encode]))
	};

	type Config = string | { text: string; values?: unknown[]; rowMode?: 'array'; types?: unknown };
	async function query(config: Config, values?: unknown[]) {
		const { text: sql, values: params = values, rowMode, types } = typeof config === 'string' ? { text: config } : config;
		const options: QueryOptions = { rowMode, serializers: text.serializers, ...(types ? { parsers: text.parsers } : {}) };
		// As in pg, only queries without parameters use the simple protocol (several statements allowed).
		const result = params?.length ? await pglite.query(sql, params, options) : (await pglite.exec(sql, options)).at(-1)!;
		return { ...result, rowCount: result.rowCount ?? null };
	}
	const pool = {
		async query(config: Config, values?: unknown[]) {
			const release = await exclusive();
			try { return await query(config, values); } finally { release(); }
		},
		async connect() {
			const release = await exclusive();
			return {
				query,
				// pg ends an abandoned transaction with the destroyed connection; here the session lives on.
				release: () => void (pglite.isInTransaction() ? pglite.exec('rollback') : Promise.resolve()).finally(release)
			};
		}
	} as unknown as pg.Pool;
	return { pglite, pool, text };
}

const demo = () => started ??= start();
const withPool = <A, T>(operation: (pool: pg.Pool, args: A) => Promise<T>) => async (args: A) => operation((await demo()).pool, args);

/** The parts of SvelteKit's RemoteQuery the app uses: await, ready/current/error and refresh(). */
class DemoQuery<T> {
	ready = $state(false);
	current = $state.raw<T>();
	error = $state.raw<unknown>();
	#load: () => Promise<T>;
	#pending: Promise<void> | undefined;

	constructor(load: () => Promise<T>) {
		this.#load = load;
		void this.refresh();
	}

	/** Joins a load in flight, so `fresh(query(args))` reads once. */
	refresh(): Promise<void> {
		return this.#pending ??= this.#load().then(
			(value) => { this.current = value; this.error = undefined; this.ready = true; },
			(error) => { this.error = error; }
		).finally(() => { this.#pending = undefined; });
	}

	then<R1 = T, R2 = never>(resolve?: (value: T) => R1 | PromiseLike<R1>, reject?: (error: unknown) => R2 | PromiseLike<R2>) {
		return this.refresh().then(() => {
			if (this.error) throw this.error;
			return this.current as T;
		}).then(resolve, reject);
	}
}

const query = <A, T>(load: (args: A) => Promise<T>) => (args: A) => new DemoQuery(() => load(args));

export const connectionStatus = () => new DemoQuery<ConnectionStatus>(async () => ({
	connection: { id: 'demo', host: 'PGlite', port: '', database: 'postgres', user: 'postgres' }, locked: false
}));
export const connect = async (): Promise<ConnectionStatus> => { throw new Error('The demo has one built-in database.'); };

export const database = query(withPool((pool) => db.listTables(pool)));
export const tableRows = query(withPool(db.listRows));
export const saveTable = withPool(db.saveTable);
export const deleteRows = withPool(db.deleteRows);
export const schemaCatalog = query(withPool((pool) => schemaDb.listSchemaCatalog(pool)));
export const schemaDefinition = query(withPool(schemaDb.getSchemaDefinition));
export const indexes = query(withPool((pool) => databaseDb.listIndexes(pool)));
export const queryStats = query(withPool((pool) => databaseDb.queryStats(pool)));
export const extensions = query(withPool((pool) => databaseDb.listExtensions(pool)));
export const settings = query(withPool((pool) => databaseDb.listSettings(pool)));
export const changeSchema = withPool((pool, { sql }: { sql: string }) => schemaDb.executeDdl(pool, sql));

export const openSql = async () => ({ session: crypto.randomUUID(), transaction: 'idle' as const });
export const cancelSql = async () => { throw new Error('Queries run inside this tab in the demo and cannot be cancelled.'); };
export const closeSql = async () => {};

export async function runSql({ sql }: SqlRunArgs): Promise<SqlRunResult> {
	const { pglite, text } = await demo();
	const release = await exclusive();
	const started = performance.now();
	const output: SqlRunResult = { transaction: 'idle', results: [], notices: [], error: null, durationMs: 0, truncated: false };
	try {
		const results = await pglite.exec(sql, {
			rowMode: 'array', ...text,
			onNotice: (notice) => { if (output.notices.length < SQL_MAX_RESULTS) output.notices.push(notice.message ?? ''); }
		});
		output.results = results.filter((result) => result.command || result.fields.length).slice(0, SQL_MAX_RESULTS).map((result) => ({
			command: result.command ?? '', rowCount: result.rowCount ?? null,
			fields: result.fields.map((field) => ({ name: field.name, typeOid: field.dataTypeID })),
			rows: (result.rows as unknown as (string | null)[][]).slice(0, SQL_MAX_ROWS),
			truncated: result.rows.length > SQL_MAX_ROWS
		}));
		output.truncated = output.results.some((result) => result.truncated);
	} catch (error) {
		output.error = (error as Error).message;
	}
	try {
		// The table editor shares this session, so a console transaction must end with its run.
		if (pglite.isInTransaction()) {
			await pglite.exec('rollback');
			output.error = `${output.error ? `${output.error}\n` : ''}The demo has a single database session, so a transaction cannot stay open between runs. It was rolled back.`;
		}
	} finally {
		release();
	}
	output.durationMs = Math.round(performance.now() - started);
	return output;
}

/** CSV export without the server endpoint: build the file here and hand it to the browser. */
export async function downloadCsv(target: CsvExportArgs): Promise<void> {
	const blob = await new Response(await exportCsv((await demo()).pool, target)).blob();
	const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${target.table}.csv` });
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
