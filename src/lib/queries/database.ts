import type pg from 'pg';
import type { Activity, DatabaseIndex, DatabaseSetting, EnumType, Extension, QueryStats } from '../database.js';
import { CONFIG_SETTINGS } from '../database.js';

export async function listIndexes(pool: pg.Pool): Promise<DatabaseIndex[]> {
	return (await pool.query<DatabaseIndex>(`
		select n.nspname as schema, t.relname as table, c.relname as name, pg_get_indexdef(i.indexrelid) as definition,
		       array(select pg_get_indexdef(i.indexrelid, k, true) from generate_series(1, i.indnkeyatts) k) as columns,
		       (select conname from pg_constraint where conindid = i.indexrelid and contype in ('p', 'u', 'x')) as constraint
		from pg_index i
		join pg_class c on c.oid = i.indexrelid
		join pg_class t on t.oid = i.indrelid
		join pg_namespace n on n.oid = t.relnamespace
		where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
		order by n.nspname, t.relname, c.relname`)).rows;
}

export async function listEnums(pool: pg.Pool): Promise<EnumType[]> {
	return (await pool.query<EnumType>(`
		select n.nspname as schema, t.typname as name,
		       array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder) as values,
		       (select count(*)::int from pg_attribute a join pg_class c on c.oid = a.attrelid
		        where a.atttypid = t.oid and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f')) as columns
		from pg_type t
		join pg_namespace n on n.oid = t.typnamespace
		where t.typtype = 'e' and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
		order by n.nspname, t.typname`)).rows;
}

/** Top statements of the current database by total execution time (PostgreSQL 13+ column names). */
export async function queryStats(pool: pg.Pool): Promise<QueryStats> {
	const schema = (await pool.query<{ schema: string }>(
		"select extnamespace::regnamespace::text as schema from pg_extension where extname = 'pg_stat_statements'")).rows[0]?.schema;
	if (!schema) return { available: false, installed: false, reason: 'The pg_stat_statements extension is not enabled.' };
	try {
		const [queries, database] = await Promise.all([
			pool.query(`
				select s.query, r.rolname as role, s.calls::float8 as calls, s.total_exec_time::float8 as "totalTime",
				       s.mean_exec_time::float8 as "meanTime", s.min_exec_time::float8 as "minTime",
				       s.max_exec_time::float8 as "maxTime", s.rows::float8 as rows,
				       s.shared_blks_hit::float8 / nullif(s.shared_blks_hit + s.shared_blks_read, 0) as "hitRate"
				from ${schema}.pg_stat_statements s
				left join pg_roles r on r.oid = s.userid
				where s.dbid = (select oid from pg_database where datname = current_database())
				order by s.total_exec_time desc limit 500`),
			pool.query(`select (blks_hit / nullif(blks_hit + blks_read, 0)::float8) as "hitRate"
				from pg_stat_database where datname = current_database()`)
		]);
		return { available: true, queries: queries.rows, hitRate: database.rows[0]?.hitRate ?? null };
	} catch (error) {
		// Installed but not in shared_preload_libraries: the view raises instead of returning rows.
		return { available: false, installed: true, reason: (error as Error).message };
	}
}

/** Client sessions on this database, active first; roles see others' queries only with privilege. */
export async function listActivity(pool: pg.Pool): Promise<Activity> {
	// One statement, so the only backend to leave out is this one.
	return (await pool.query<Activity>(`
		select (select count(*)::int from pg_stat_activity where backend_type = 'client backend') as connections,
		       current_setting('max_connections')::int as "maxConnections",
		       coalesce(json_agg(s order by s.state = 'active' desc, s.duration desc nulls last), '[]') as sessions
		from (
			select pid, usename as role, application_name as application, client_addr::text as client, state,
			       extract(epoch from now() - state_change)::float8 as duration,
			       wait_event_type as "waitType", wait_event as wait, pg_blocking_pids(pid) as "blockedBy", query
			from pg_stat_activity
			where datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid()
		) s`)).rows[0];
}

export async function listExtensions(pool: pg.Pool): Promise<Extension[]> {
	return (await pool.query<Extension>(`
		select a.name, a.comment, a.default_version as "defaultVersion", e.extversion as "installedVersion",
		       n.nspname as schema, v.schema as "requiredSchema", coalesce(v.requires::text[], '{}') as requires
		from pg_available_extensions a
		left join pg_extension e on e.extname = a.name
		left join pg_namespace n on n.oid = e.extnamespace
		left join pg_available_extension_versions v on v.name = a.name and v.version = a.default_version
		order by a.name`)).rows;
}

/** Curated settings: this session's value, plus database and current-role defaults (pg_db_role_setting). */
export async function listSettings(pool: pg.Pool): Promise<{ database: string; role: string; settings: DatabaseSetting[] }> {
	const [names, settings] = await Promise.all([
		pool.query<{ database: string; role: string }>('select current_database() as database, current_user as role'),
		pool.query<DatabaseSetting>(`
		with defaults as (
			select s.setdatabase, s.setrole, split_part(c, '=', 1) as name, substr(c, strpos(c, '=') + 1) as value
			from pg_db_role_setting s, unnest(s.setconfig) c
		)
		select p.name, p.short_desc as description, p.unit,
		       current_setting(p.name) as current,
		       (select value from defaults d join pg_database db on db.oid = d.setdatabase
		        where db.datname = current_database() and d.setrole = 0 and lower(d.name) = lower(p.name)) as "databaseDefault",
		       (select value from defaults d join pg_roles r on r.oid = d.setrole
		        where r.rolname = current_user and d.setdatabase = 0 and lower(d.name) = lower(p.name)) as "roleDefault"
		from pg_settings p where p.name = any($1) order by array_position($1, p.name)`, [CONFIG_SETTINGS])
	]);
	return { ...names.rows[0], settings: settings.rows };
}
