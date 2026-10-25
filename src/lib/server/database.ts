import type pg from 'pg';
import type { DatabaseIndex, DatabaseSetting, Extension } from '../database.js';
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
