import type pg from 'pg';
import type { SchemaCatalog, SchemaDefinition, SchemaType } from '../schema.js';
import type { TableTarget } from '../types.js';
import { invalidateMetadata } from './db.js';

export async function listSchemaCatalog(pool: pg.Pool): Promise<SchemaCatalog> {
	const schemas = await pool.query<{ schema: string }>(`
		select nspname as schema from pg_namespace
		where nspname !~ '^pg_' and nspname <> 'information_schema' and has_schema_privilege(oid, 'USAGE')
		order by nspname`);
	const types = await pool.query<SchemaType>(`
		with approved as (
			select t.oid, t.typarray from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where has_type_privilege(t.oid, 'USAGE') and ((n.nspname = 'pg_catalog' and t.typname in (
				'bool', 'int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money',
				'text', 'varchar', 'bpchar', 'bytea', 'date', 'time', 'timetz', 'timestamp',
				'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'inet', 'cidr', 'macaddr',
				'macaddr8', 'bit', 'varbit', 'xml', 'oid', 'tsvector', 'tsquery'))
				or (n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and t.typtype in ('e', 'd')))
		)
		select t.oid::text as oid, n.nspname as schema, t.typname as name, format_type(t.oid, null) as label,
		       case t.typtype when 'e' then 'enum' when 'd' then 'domain'
		         else case when e.oid is not null then 'array' else 'base' end end as kind,
		       case when t.typtype <> 'd' then e.oid::text end as "elementOid",
		       nullif(t.typarray, 0)::text as "arrayOid",
		       array(select enumlabel::text from pg_enum where enumtypid = t.oid order by enumsortorder) as "enumValues"
		from pg_type t join pg_namespace n on n.oid = t.typnamespace
		left join pg_type e on e.oid = t.typelem and e.typarray = t.oid
		where t.oid in (select oid from approved union select typarray from approved)
		order by n.nspname, label`);
	return { schemas: schemas.rows.map((row) => row.schema), types: types.rows };
}

const ACTION = `case %s when 'r' then 'restrict' when 'c' then 'cascade' when 'n' then 'set null' when 'd' then 'set default' else 'no action' end`;
const names = (relation: string, numbers: string) => `array(select a.attname::text from unnest(${numbers}) with ordinality k(num, position)
	join pg_attribute a on a.attrelid = ${relation} and a.attnum = k.num order by k.position)`;

export async function getSchemaDefinition(pool: pg.Pool, target: TableTarget): Promise<SchemaDefinition> {
	const result = await pool.query<{ definition: Omit<SchemaDefinition, 'schema' | 'table'> }>(`
		select jsonb_build_object(
			'columns', coalesce((select jsonb_agg(jsonb_build_object(
				'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'typeOid', a.atttypid::text,
				'nullable', not a.attnotnull, 'defaultValue', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated <> '',
				'identity', case a.attidentity when 'a' then 'always' when 'd' then 'by-default' end,
				'comment', col_description(a.attrelid, a.attnum)) order by a.attnum)
				from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
				where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'),
			'primaryKey', coalesce((select to_jsonb(${names('i.indrelid', '(i.indkey::smallint[])[0:i.indnkeyatts - 1]')})
				from pg_index i where i.indrelid = c.oid and i.indisprimary), '[]'),
			'indexes', coalesce((select jsonb_agg(jsonb_build_object(
				'name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid), 'unique', i.indisunique, 'primary', i.indisprimary,
				'constraint', (select conname from pg_constraint where conindid = i.indexrelid and conrelid = c.oid and contype in ('p', 'u', 'x'))
				) order by ic.relname) from pg_index i join pg_class ic on ic.oid = i.indexrelid where i.indrelid = c.oid), '[]'),
			'constraints', coalesce((select jsonb_agg(jsonb_build_object(
				'name', con.conname, 'kind', con.contype, 'definition', pg_get_constraintdef(con.oid),
				'columns', ${names('con.conrelid', 'con.conkey')}, 'expression', pg_get_expr(con.conbin, con.conrelid),
				'foreignKey', case when con.contype = 'f' then jsonb_build_object(
					'schema', rn.nspname, 'table', rc.relname, 'columns', ${names('con.confrelid', 'con.confkey')},
					'onUpdate', ${ACTION.replace('%s', 'con.confupdtype')}, 'onDelete', ${ACTION.replace('%s', 'con.confdeltype')}) end
				) order by con.conname) from pg_constraint con
				left join pg_class rc on rc.oid = con.confrelid left join pg_namespace rn on rn.oid = rc.relnamespace
				where con.conrelid = c.oid and con.contype in ('u', 'c', 'f')), '[]')
		) as definition
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, [target.schema, target.table]);
	if (!result.rows[0]) throw new Error(`Table ${target.schema}.${target.table} does not exist`);
	return { schema: target.schema, table: target.table, ...result.rows[0].definition };
}

/** Run one form-generated DDL script atomically. Short lock waits fail instead of queueing behind long reads. */
export async function executeDdl(pool: pg.Pool, sql: string): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("begin; set local lock_timeout = '3s'");
		await client.query(sql);
		await client.query('commit');
	} catch (error) {
		await client.query('rollback');
		throw error;
	} finally {
		client.release();
	}
	invalidateMetadata(pool);
}
