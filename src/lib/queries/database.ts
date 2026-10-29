import type pg from 'pg';
import type { Activity, DatabaseIndex, DatabaseSetting, EnumType, Extension, PolicyTable, QueryStats, Role, SchemaInfo, Trigger } from '../database.js';
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
		  and not c.relispartition -- attached to a partitioned table's index, which owns it
		order by n.nspname, t.relname, c.relname`)).rows;
}

/** Tables with their RLS state, policies and grants. */
export async function listPolicies(pool: pg.Pool): Promise<PolicyTable[]> {
	return (await pool.query<{ tables: PolicyTable[] }>(`
		select coalesce((select json_agg(t order by t.schema, t.table) from (
		         select n.nspname as schema, c.relname as table, pg_get_userbyid(c.relowner) as owner,
		                c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
		                coalesce((select json_agg(json_build_object(
		                  'name', p.polname,
		                  'command', case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end,
		                  'permissive', p.polpermissive,
		                  'roles', array(select case when r = 0 then 'public' else pg_get_userbyid(r) end from unnest(p.polroles) r),
		                  'using', pg_get_expr(p.polqual, p.polrelid),
		                  'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname)
		                 from pg_policy p where p.polrelid = c.oid), '[]') as policies,
		                -- aclexplode has one row per grantor; a revoke removes only one grantor's grant.
		                coalesce((select json_agg(json_build_object(
		                  'role', case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end, 'privilege', a.privilege_type,
		                  'grantors', a.grantors))
		                 from (select grantee, privilege_type, array_agg(distinct pg_get_userbyid(grantor)) as grantors
		                       from aclexplode(c.relacl) where grantee <> c.relowner group by grantee, privilege_type) a), '[]') as grants
		         from pg_class c join pg_namespace n on n.oid = c.relnamespace
		         where c.relkind in ('r', 'p') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
		       ) t), '[]') as tables`)).rows[0].tables;
}

export async function listRoles(pool: pg.Pool): Promise<Role[]> {
	return (await pool.query<Role>(`
		select r.rolname as name, r.rolcanlogin as login, r.rolsuper as superuser, r.rolbypassrls as bypass,
		       r.rolcreatedb as createdb, r.rolname = current_user as current,
		       array(select distinct b.rolname::text from pg_auth_members m join pg_roles b on b.oid = m.roleid
		             where m.member = r.oid order by 1) as "memberOf"
		from pg_roles r where r.rolname !~ '^pg_' order by r.rolname`)).rows;
}

export async function listSchemas(pool: pg.Pool): Promise<SchemaInfo[]> {
	return (await pool.query<SchemaInfo>(`
		select n.nspname as name, pg_get_userbyid(n.nspowner) as owner,
		       (select count(*)::int from pg_class c where c.relnamespace = n.oid and c.relkind in ('r', 'p', 'v', 'm', 'f')) as tables,
		       (select count(*)::int from pg_proc p where p.pronamespace = n.oid) as functions
		from pg_namespace n
		where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
		order by n.nspname`)).rows;
}

export async function listTriggers(pool: pg.Pool): Promise<Trigger[]> {
	// tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead of.
	return (await pool.query<Trigger>(`
		select n.nspname as schema, c.relname as table, t.tgname as name, t.tgenabled <> 'D' as enabled,
		       case when t.tgtype & 2 <> 0 then 'before' when t.tgtype & 64 <> 0 then 'instead of' else 'after' end as timing,
		       array_remove(array[case when t.tgtype & 4 <> 0 then 'insert' end, case when t.tgtype & 16 <> 0 then 'update' end,
		         case when t.tgtype & 8 <> 0 then 'delete' end, case when t.tgtype & 32 <> 0 then 'truncate' end], null) as events,
		       t.tgtype & 1 <> 0 as "forEachRow", t.tgfoid::regprocedure::text as function,
		       pg_get_triggerdef(t.oid) as definition, pg_get_functiondef(t.tgfoid) as "functionDefinition"
		from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
		-- Partition clones follow their parent's trigger; realtime triggers belong to the table editor's ⚡.
		where not t.tgisinternal and t.tgparentid = 0 and t.tgname <> 'superbase_realtime' and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
		order by n.nspname, c.relname, t.tgname`)).rows;
}

export async function listEnums(pool: pg.Pool): Promise<EnumType[]> {
	return (await pool.query<EnumType>(`
		select n.nspname as schema, t.typname as name,
		       array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder) as values,
		       -- Directly or through a domain; inherited copies (partitions, children) count once, at the parent.
		       (select count(*)::int from pg_attribute a join pg_class c on c.oid = a.attrelid
		        where a.atttypid in (select d.oid from pg_type d where d.oid in (t.oid, t.typarray) or d.typbasetype in (t.oid, t.typarray))
		          and not a.attisdropped and a.attinhcount = 0 and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c')) as columns
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
		return { available: true, schema, queries: queries.rows, hitRate: database.rows[0]?.hitRate ?? null };
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
