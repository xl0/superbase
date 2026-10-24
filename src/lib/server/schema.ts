import { createHash } from 'node:crypto';
import pg from 'pg';

import type { ColumnDefault, ColumnSpec, SchemaCatalog, SchemaChangeArgs, SchemaColumn, SchemaDefinition, SchemaType } from '../schema.js';
import type { TableTarget } from '../types.js';
import { schemaChangeSchema, schemaTargetSchema } from '../schema-validation.js';
import { columnOptionsError, elementType } from '../schema-options.js';
import { ident, invalidateMetadata, qualify } from './db.js';

// Both introspection and writes deparse expressions with the same, trusted search path.
async function transaction<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query('begin isolation level read committed');
		await client.query("set local search_path = pg_catalog; set local standard_conforming_strings = on; set local lock_timeout = '3s'");
		const result = await run(client);
		await client.query('commit');
		return result;
	} catch (error) {
		await client.query('rollback');
		throw error;
	} finally {
		client.release();
	}
}

async function catalog(client: pg.PoolClient): Promise<SchemaCatalog> {
	const schemas = await client.query<{ schema: string }>(`
		select nspname as schema from pg_namespace
		where nspname !~ '^pg_' and nspname <> 'information_schema'
		  and has_schema_privilege(oid, 'USAGE') order by nspname`);
	const types = await client.query<SchemaType>(`
		with approved as (
			select t.oid, t.typarray from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where has_schema_privilege(n.oid, 'USAGE') and has_type_privilege(t.oid, 'USAGE')
			  and ((n.nspname = 'pg_catalog' and t.typname in (
				'bool', 'int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money',
				'text', 'varchar', 'bpchar', 'bytea', 'date', 'time', 'timetz', 'timestamp',
				'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'inet', 'cidr', 'macaddr',
				'macaddr8', 'bit', 'varbit', 'xml', 'oid', 'tsvector', 'tsquery'))
				or (n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and t.typtype in ('e', 'd')))
		)
		select t.oid::text as oid, n.nspname as schema, t.typname as name,
		       format_type(t.oid, null) as label,
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

export async function listSchemaCatalog(pool: pg.Pool): Promise<SchemaCatalog> {
	return transaction(pool, catalog);
}

/** Internal semantic snapshot: no row data, statistics, or catalog xmin values. */
type Snapshot = {
	oid: string;
	kind: string;
	partition: boolean;
	inheritance: unknown[];
	columns: (SchemaColumn & { dropped: boolean })[];
	primaryKey: string[];
};

async function definition(client: pg.PoolClient, target: TableTarget): Promise<SchemaDefinition> {
	// One statement gives a single catalog snapshot, including dependencies not exposed in the UI.
	const result = await client.query<{ metadata: Snapshot }>(`
		select jsonb_build_object(
			'oid', c.oid::text, 'schema', n.nspname, 'table', c.relname,
			'kind', c.relkind, 'partition', c.relispartition,
			'persistence', c.relpersistence, 'options', c.reloptions,
			'replicaIdentity', c.relreplident, 'comment', obj_description(c.oid, 'pg_class'),
			'inheritance', coalesce((select jsonb_agg(jsonb_build_array(i.inhrelid::text, i.inhparent::text, i.inhseqno)
				order by i.inhrelid, i.inhseqno) from pg_inherits i
				where i.inhrelid = c.oid or i.inhparent = c.oid), '[]'::jsonb),
			'columns', coalesce((select jsonb_agg(jsonb_build_object(
				'number', a.attnum, 'name', a.attname, 'dropped', a.attisdropped,
				'type', format_type(a.atttypid, a.atttypmod), 'typeOid', a.atttypid::text,
				'typeModifier', a.atttypmod, 'dimensions', a.attndims, 'collation', a.attcollation::text,
				'typeModifiers', case when a.atttypmod = -1 then '[]'::jsonb
					when mt.typtype <> 'b' or mn.nspname <> 'pg_catalog' then null
					when mt.typname = 'numeric' then jsonb_build_array(
						((a.atttypmod - 4) >> 16) & 65535,
						(((a.atttypmod - 4) & 2047) # 1024) - 1024)
					when mt.typname in ('varchar', 'bpchar') then jsonb_build_array(a.atttypmod - 4)
					when mt.typname in ('timestamp', 'timestamptz', 'time', 'timetz', 'bit', 'varbit')
						then jsonb_build_array(a.atttypmod)
					else null end,
				'nullable', not a.attnotnull, 'defaultValue', pg_get_expr(d.adbin, d.adrelid),
				'generated', a.attgenerated <> '', 'generationKind', a.attgenerated,
				'identity', case a.attidentity when 'a' then 'always' when 'd' then 'by-default' else null end,
				'comment', col_description(a.attrelid, a.attnum),
				'primaryKey', exists(select 1 from pg_constraint pk
					where pk.conrelid = c.oid and pk.contype = 'p' and a.attnum = any(pk.conkey))
			) order by a.attnum) from pg_attribute a
			left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			left join pg_type t on t.oid = a.atttypid
			left join pg_type e on e.oid = t.typelem and e.typarray = t.oid and t.typtype <> 'd'
			left join pg_type mt on mt.oid = coalesce(e.oid, t.oid)
			left join pg_namespace mn on mn.oid = mt.typnamespace
			where a.attrelid = c.oid and a.attnum > 0), '[]'::jsonb),
			'primaryKey', coalesce((select jsonb_agg(a.attname order by k.position)
				from pg_constraint pk cross join lateral unnest(pk.conkey) with ordinality k(num, position)
				join pg_attribute a on a.attrelid = pk.conrelid and a.attnum = k.num
				where pk.conrelid = c.oid and pk.contype = 'p'), '[]'::jsonb),
			'constraints', coalesce((select jsonb_agg(jsonb_build_object(
				'oid', con.oid::text, 'name', con.conname, 'table', con.conrelid::text,
				'definition', pg_get_constraintdef(con.oid), 'validated', con.convalidated,
				'comment', obj_description(con.oid, 'pg_constraint')) order by con.oid)
				from pg_constraint con where con.conrelid = c.oid or con.confrelid = c.oid), '[]'::jsonb),
			'indexes', coalesce((select jsonb_agg(jsonb_build_object(
				'oid', i.indexrelid::text, 'definition', pg_get_indexdef(i.indexrelid),
				'valid', i.indisvalid, 'ready', i.indisready, 'clustered', i.indisclustered,
				'replicaIdentity', i.indisreplident, 'comment', obj_description(i.indexrelid, 'pg_class'))
				order by i.indexrelid) from pg_index i where i.indrelid = c.oid), '[]'::jsonb)
		) as metadata
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, [target.schema, target.table]);
	const raw = result.rows[0]?.metadata;
	if (!raw) throw new Error('Table does not exist');
	const editable = raw.kind === 'r' && !raw.partition && raw.inheritance.length === 0;
	return {
		schema: target.schema, table: target.table, oid: raw.oid,
		version: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
		editable, reason: editable ? null : 'Only ordinary standalone tables can be edited (no views, partitions or inheritance)',
		columns: raw.columns.filter((column) => !column.dropped).map((column) => ({
			name: column.name, type: column.type, typeOid: column.typeOid, typeModifiers: column.typeModifiers,
			nullable: column.nullable,
			defaultValue: column.defaultValue, generated: column.generated, identity: column.identity,
			comment: column.comment, primaryKey: column.primaryKey
		})),
		primaryKey: raw.primaryKey
	};
}

export async function getSchemaDefinition(pool: pg.Pool, target: TableTarget): Promise<SchemaDefinition> {
	const validated = schemaTargetSchema['~standard'].validate(target);
	if ('issues' in validated) throw new Error(validated.issues[0].message);
	return transaction(pool, (client) => definition(client, validated.value));
}

function defaultSql(value: ColumnDefault, type: SchemaType | undefined): string {
	switch (value.kind) {
		case 'literal': return pg.escapeLiteral(value.value);
		case 'now': return 'pg_catalog.now()';
		case 'today': return 'CURRENT_DATE';
		case 'currentTime': return type?.name === 'timetz' ? 'CURRENT_TIME' : 'LOCALTIME';
		case 'uuid': return `pg_catalog.gen_random_uuid()${type?.name === 'uuid' ? '' : '::pg_catalog.text'}`;
		default: throw new Error('This default cannot be used as an expression');
	}
}

export async function changeSchema(pool: pg.Pool, args: SchemaChangeArgs): Promise<void> {
	const validated = schemaChangeSchema['~standard'].validate(args);
	if ('issues' in validated) throw new Error(validated.issues[0].message);
	args = validated.value;
	await transaction(pool, async (client) => {
		const table = qualify(args.schema, args.table);
		const op = args.operation;
		const changedColumns = op.kind === 'createTable' ? op.columns
			: op.kind === 'addColumn' ? [op.column] : op.kind === 'alterColumn' ? [op.changes] : [];
		const typeOids = changedColumns.flatMap((column) => column.typeOid === null ? [] : [column.typeOid]);
		// Relation locks do not block namespace/type renames. Catalog tuple versions also
		// detect names changed and restored during execution; table/data xmin is irrelevant.
		const catalogVersion = async () => JSON.stringify((await client.query(`
			with selected as (
				select oid from pg_type where oid = any($2::oid[])
				union
				select e.oid from pg_type t join pg_type e on e.oid = t.typelem and e.typarray = t.oid
				where t.oid = any($2::oid[]) and t.typtype <> 'd'
			)
			select 'namespace' as kind, oid::text as oid, xmin::text as version from pg_namespace
			where nspname = $1 or oid in (select typnamespace from pg_type where oid in (select oid from selected))
			union all
			select 'type', oid::text, xmin::text from pg_type where oid in (select oid from selected)
			order by kind, oid`, [args.schema, typeOids])).rows);
		const before = await catalogVersion();
		let current: SchemaDefinition | undefined;
		if (op.kind !== 'createTable') {
			// ONLY avoids locking descendants before we reject inherited/partitioned tables.
			await client.query(`lock table only ${table} in access exclusive mode`);
			current = await definition(client, args);
			if (current.version !== args.expected) throw new Error('Table schema changed; reload its definition before applying');
			if (!current.editable) throw new Error(current.reason!);
		}
		const availableTypes = (await catalog(client)).types;
		const types = new Map(availableTypes.map((type) => [type.oid, type]));
		const resolveType = (oid: string | null): SchemaType => {
			const type = oid === null ? undefined : types.get(oid);
			if (!type) throw new Error('Type is not an approved catalog type; reload the type catalog');
			return type;
		};
		for (const column of changedColumns) {
			const old = op.kind === 'alterColumn' ? current!.columns.find((item) => item.name === op.column) : undefined;
			if (op.kind === 'alterColumn' && !old) throw new Error('Column does not exist');
			const error = columnOptionsError(column, availableTypes, old);
			if (error) throw new Error(error);
		}
		const typeSql = (column: ColumnSpec): string => {
			const type = resolveType(column.typeOid);
			const base = elementType(type, availableTypes);
			if (!base) throw new Error('Array element type is unavailable; reload the type catalog');
			// Only validated integer modifiers enter this grammar; type names are catalog identifiers.
			return qualify(base.schema, base.name)
				+ (column.typeModifiers.length ? `(${column.typeModifiers.join(', ')})` : '')
				+ (type.kind === 'array' ? '[]' : '');
		};
		const newColumn = (column: ColumnSpec): string => {
			const type = resolveType(column.typeOid);
			let sql = `${ident(column.name)} ${typeSql(column)}`;
			if (column.default.kind === 'identity') {
				sql += ' generated by default as identity';
			} else if (column.default.kind !== 'none') {
				sql += ` default ${defaultSql(column.default, type)}`;
			}
			if (!column.nullable || column.primaryKey) sql += ' not null';
			return sql;
		};
		const comment = async (column: ColumnSpec) => {
			await client.query(`comment on column ${table}.${ident(column.name)} is ${column.comment === '' ? 'null' : pg.escapeLiteral(column.comment)}`);
		};
		const addPrimaryKey = async (columns: string[]) => {
			if (current!.primaryKey.length) throw new Error('An existing primary key cannot be replaced');
			await client.query(`alter table ${table} add primary key (${columns.map(ident).join(', ')})`);
		};
		switch (op.kind) {
			case 'createTable': {
				const columns = op.columns.map(newColumn);
				const pk = op.columns.filter((column) => column.primaryKey).map((column) => ident(column.name));
				if (pk.length) columns.push(`primary key (${pk.join(', ')})`);
				await client.query(`create table ${table} (${columns.join(', ')})`);
				for (const column of op.columns) if (column.comment) await comment(column);
				break;
			}
			case 'renameTable':
				await client.query(`alter table ${table} rename to ${ident(op.name)}`);
				break;
			case 'dropTable':
				await client.query(`drop table ${table} restrict`);
				break;
			case 'addColumn':
				if (op.column.primaryKey && current!.primaryKey.length) throw new Error('An existing primary key cannot be replaced');
				await client.query(`alter table ${table} add column ${newColumn(op.column)}`);
				if (op.column.primaryKey) await addPrimaryKey([op.column.name]);
				if (op.column.comment) await comment(op.column);
				break;
			case 'dropColumn':
				await client.query(`alter table ${table} drop column ${ident(op.column)} restrict`);
				break;
			case 'addPrimaryKey':
				for (const name of op.columns) {
					if (!current!.columns.some((column) => column.name === name)) throw new Error('Unknown primary-key column');
				}
				await addPrimaryKey(op.columns);
				break;
			case 'alterColumn': {
				const old = current!.columns.find((column) => column.name === op.column);
				if (!old) throw new Error('Column does not exist');
				const next = op.changes;
				if (old.primaryKey && !next.primaryKey) throw new Error('An existing primary key cannot be replaced');
				if (!old.primaryKey && next.primaryKey && current!.primaryKey.length) throw new Error('An existing primary key cannot be replaced');
				const alter = `alter table ${table} alter column ${ident(old.name)}`;
				// Drop requested replacements before casting; install the new default against the new type.
				if (next.default.kind !== 'keep') await client.query(`${alter} drop default`);
				if (next.typeOid !== null) {
					const sql = typeSql(next);
					await client.query(`${alter} type ${sql} using ${ident(old.name)}::${sql}`);
				}
				if (next.default.kind !== 'keep' && next.default.kind !== 'none') {
					await client.query(`${alter} set default ${defaultSql(next.default, types.get(next.typeOid ?? old.typeOid))}`);
				}
				const nullable = next.nullable && !next.primaryKey;
				if (old.nullable !== nullable) await client.query(`${alter} ${nullable ? 'drop' : 'set'} not null`);
				if (!old.primaryKey && next.primaryKey) await addPrimaryKey([old.name]);
				if (next.name !== old.name) await client.query(`alter table ${table} rename column ${ident(old.name)} to ${ident(next.name)}`);
				if ((old.comment ?? '') !== next.comment) await comment(next);
				break;
			}
		}
		let targetChanged: boolean;
		if (op.kind === 'dropTable') {
			const remaining = await client.query('select oid from pg_class where oid = $1::oid', [current!.oid]);
			targetChanged = remaining.rows.length !== 0;
		} else {
			const after = await client.query<{ oid: string; name: string | null; typeOid: string | null }>(`
				select c.oid::text as oid, a.attname as name, a.atttypid::text as "typeOid"
				from pg_class c join pg_namespace n on n.oid = c.relnamespace
				left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
				where n.nspname = $1 and c.relname = $2`, [args.schema, op.kind === 'renameTable' ? op.name : args.table]);
			targetChanged = !after.rows[0] || (!!current && after.rows[0].oid !== current.oid)
				|| changedColumns.some((column) => column.typeOid !== null
					&& after.rows.find((row) => row.name === column.name)?.typeOid !== column.typeOid);
		}
		if (targetChanged || await catalogVersion() !== before) {
			throw new Error('Table, namespace or type catalog changed; reopen the schema editor before applying');
		}
	});
	invalidateMetadata(pool);
}
