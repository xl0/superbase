import type pg from 'pg';
import type { SchemaCatalog, SchemaDefinition, SchemaType } from '../schema.js';
import type { TableTarget } from '../types.js';
import { literal } from '../ddl.js';
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
				'name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid),
				'constraint', (select conname from pg_constraint where conindid = i.indexrelid and conrelid = c.oid and contype in ('p', 'u', 'x'))
				) order by ic.relname) from pg_index i join pg_class ic on ic.oid = i.indexrelid where i.indrelid = c.oid), '[]'),
			'constraints', coalesce((select jsonb_agg(jsonb_build_object(
				'name', con.conname, 'kind', con.contype, 'definition', pg_get_constraintdef(con.oid)
				) order by con.conname) from pg_constraint con
				where con.conrelid = c.oid and con.contype in ('u', 'c', 'f')), '[]')
		) as definition
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, [target.schema, target.table]);
	if (!result.rows[0]) throw new Error(`Table ${target.schema}.${target.table} does not exist`);
	return { schema: target.schema, table: target.table, ...result.rows[0].definition };
}

const POLICY_COMMANDS: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE' };

/** Readable DDL of a table or view rebuilt from the catalogs; not a dump (no grants, partitions, inheritance or storage options). */
export async function tableDefinition(pool: pg.Pool, target: TableTarget): Promise<string> {
	const client = await pool.connect();
	try {
		// Like pg_dump: with only pg_catalog on the path, every user object comes out schema-qualified.
		await client.query('begin read only; set local search_path = pg_catalog, pg_temp');
		return await buildDefinition(client, target);
	} finally {
		await client.query('rollback');
		client.release();
	}
}

async function buildDefinition(client: pg.PoolClient, target: TableTarget): Promise<string> {
	// Names come back quoted only where needed, like pg_get_*def output.
	type Relation = { oid: string; name: string; kind: string; rls: boolean; forced: boolean; comment: string | null; view: string | null; partition: string | null };
	const relation = (await client.query<Relation>(`
		select c.oid::text as oid, format('%I.%I', n.nspname, c.relname) as name, c.relkind as kind, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
		       obj_description(c.oid, 'pg_class') as comment,
		       case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end as view,
		       case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partition
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, [target.schema, target.table])).rows[0];
	if (!relation) throw new Error(`Table ${target.schema}.${target.table} does not exist`);
	type Column = { name: string; type: string; collation: string | null; notNull: boolean; identity: string; generated: string; default: string | null; comment: string | null };
	type Policy = { name: string; permissive: boolean; command: string; roles: string; using: string | null; check: string | null };
	const columns = await client.query<Column>(`
		select quote_ident(a.attname) as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
		       a.attidentity as identity, a.attgenerated as generated, pg_get_expr(d.adbin, d.adrelid) as default,
		       col_description(a.attrelid, a.attnum) as comment,
		       (select format('%I.%I', cn.nspname, co.collname) from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace
		        where co.oid = a.attcollation and a.attcollation <> t.typcollation) as collation
		from pg_attribute a join pg_type t on t.oid = a.atttypid
		left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
		where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [relation.oid]);
	const constraints = await client.query<{ name: string; definition: string }>(`
		select quote_ident(conname) as name, pg_get_constraintdef(oid, true) as definition from pg_constraint
		where conrelid = $1 and contype in ('p', 'u', 'c', 'x', 'f') order by position(contype::text in 'pucxf'), conname`, [relation.oid]);
	const indexes = await client.query<{ definition: string }>(`
		select pg_get_indexdef(i.indexrelid) as definition from pg_index i join pg_class ic on ic.oid = i.indexrelid
		where i.indrelid = $1 and not exists(select from pg_constraint con where con.conindid = i.indexrelid and con.conrelid = i.indrelid)
		order by ic.relname`, [relation.oid]);
	const triggers = await client.query<{ definition: string }>(`
		select pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid = $1 and not tgisinternal order by tgname`, [relation.oid]);
	const policies = await client.query<Policy>(`
		select quote_ident(polname) as name, polpermissive as permissive, polcmd as command,
		       pg_get_expr(polqual, polrelid) as using, pg_get_expr(polwithcheck, polrelid) as check,
		       case when polroles = '{0}' then 'public'
		         else (select string_agg(quote_ident(rolname), ', ' order by rolname) from pg_roles where oid = any(polroles)) end as roles
		from pg_policy where polrelid = $1 order by polname`, [relation.oid]);
	const name = relation.name;
	const kind = relation.kind === 'v' ? 'view' : relation.kind === 'm' ? 'materialized view' : 'table';
	const column = (c: Column) => [c.name, c.type, c.collation && `COLLATE ${c.collation}`,
		c.generated ? `GENERATED ALWAYS AS (${c.default})${c.generated === 's' ? ' STORED' : ' VIRTUAL'}` : c.default !== null && `DEFAULT ${c.default}`,
		c.identity && `GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`,
		c.notNull && 'NOT NULL'].filter(Boolean).join(' ');
	const lines = [...columns.rows.map(column), ...constraints.rows.map((c) => `CONSTRAINT ${c.name} ${c.definition}`)];
	const create = relation.view !== null ? `CREATE ${kind.toUpperCase()} ${name} AS\n${relation.view.trim().replace(/;$/, '')};`
		: `CREATE TABLE ${name} (\n${lines.map((line) => `  ${line}`).join(',\n')}\n)${relation.partition ? ` PARTITION BY ${relation.partition}` : ''};`;
	const blocks = [
		[create],
		indexes.rows.map((index) => `${index.definition};`),
		triggers.rows.map((trigger) => `${trigger.definition};`),
		[relation.rls ? `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;` : '', relation.forced ? `ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;` : '',
			...policies.rows.map((p) => `CREATE POLICY ${p.name} ON ${name}${p.permissive ? '' : ' AS RESTRICTIVE'}`
				+ `${p.command === '*' ? '' : ` FOR ${POLICY_COMMANDS[p.command]}`} TO ${p.roles}`
				+ `${p.using ? `\n  USING (${p.using})` : ''}${p.check ? `\n  WITH CHECK (${p.check})` : ''};`)],
		[relation.comment !== null ? `COMMENT ON ${kind.toUpperCase()} ${name} IS ${literal(relation.comment)};` : '',
			...columns.rows.filter((c) => c.comment !== null).map((c) => `COMMENT ON COLUMN ${name}.${c.name} IS ${literal(c.comment!)};`)]
	];
	return blocks.map((block) => block.filter(Boolean).join('\n')).filter(Boolean).join('\n\n') + '\n';
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
