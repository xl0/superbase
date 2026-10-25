import { createHash } from 'node:crypto';
import pg from 'pg';

import type { ColumnDefault, ColumnSpec, ConstraintOperation, ConstraintSpec, SchemaCatalog, SchemaChangeArgs, SchemaColumn, SchemaConstraint, SchemaDefinition, SchemaExport, SchemaIndex, SchemaType } from '../schema.js';
import type { TableTarget } from '../types.js';
import { schemaChangeSchema, schemaTargetSchema } from '../schema-validation.js';
import { columnOptionsError, elementType } from '../schema-options.js';
import { ident, invalidateMetadata, qualify } from './db.js';
import { actionMetadata, duplicateTable, ownedSequencesSql, schemaSql } from './table-actions.js';

// Explicit pg_temp last prevents implicit temporary-catalog shadowing. CHECKs use the role's path.
async function transaction<T>(pool: pg.Pool, run: (client: pg.PoolClient, searchPath: string) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query('begin isolation level read committed');
		const searchPath = (await client.query<{ search_path: string }>('show search_path')).rows[0].search_path;
		await client.query("set local search_path = pg_catalog, pg_temp; set local standard_conforming_strings = on; set local lock_timeout = '3s'");
		const result = await run(client, searchPath);
		await client.query('commit');
		return result;
	} catch (error) {
		await client.query('rollback');
		throw error;
	} finally {
		client.release();
	}
}

/** Parse one WHERE expression without planning/executing a SELECT or keeping session state.
 * The WHERE/CHECK grammar intersection rejects extra ALTER actions; Parse rejects statements.
 * Newlines prevent a trailing line comment from consuming either wrapper's closing parenthesis.
 * Native type-input routines can run during parsing; this is not a sandbox for SQL functions.
 */
function parseCheck(client: pg.PoolClient, table: string, expression: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const query = new pg.Query('', (error) => error ? reject(error) : resolve());
		query.submit = (connection) => {
			connection.parse({ text: `select 1 from only ${table} where (\n${expression}\n)`, name: '', types: [] }, false);
			connection.close({ type: 'S', name: '' }, false);
			connection.sync();
		};
		// pg.Query.submit uses the normal queue; errors precede ReadyForQuery, so the
		// enclosing transaction must await its queued rollback before releasing the client.
		client.query(query);
	});
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
	indexes: SchemaIndex[];
	constraints: (SchemaConstraint & { table: string })[];
};

// INCLUDE attributes are not key attributes. Native FK matching permits key permutations.
const referenceableIndexSql = `i.indisunique and i.indisvalid and i.indisready and i.indislive
	and i.indimmediate and not i.indisexclusion and i.indexprs is null and i.indpred is null
	and i.indnkeyatts = (select count(distinct k.num) from unnest(i.indkey) with ordinality k(num, position)
		where k.position <= i.indnkeyatts)
	and not exists(select 1 from pg_constraint p where p.conindid = i.indexrelid
		and p.conrelid = i.indrelid and coalesce((to_jsonb(p)->>'conperiod')::boolean, false))`;

// Native FK rebuilds discard RI-trigger customizations on either relation.
const customRiTriggersSql = `exists(select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
	where t.tgconstraint = con.oid and (t.tgenabled <> 'O'
		or obj_description(t.oid, 'pg_trigger') is not null
		or t.tgname <> 'RI_ConstraintTrigger_' || case
			when p.proname in ('RI_FKey_check_ins', 'RI_FKey_check_upd') then 'c' else 'a' end
			|| '_' || t.oid::text))`;

async function definition(client: pg.PoolClient, target: TableTarget, excludeIncomingFrom: string | null = null): Promise<SchemaDefinition> {
	// One statement gives a single catalog snapshot, including dependencies not exposed in the UI.
	const result = await client.query<{ metadata: Snapshot }>(`
		select jsonb_build_object(
			'oid', c.oid::text, 'schema', n.nspname, 'table', c.relname,
			'kind', c.relkind, 'partition', c.relispartition,
			'persistence', c.relpersistence, 'options', c.reloptions,
			'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
			'sequences', ${ownedSequencesSql},
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
				'primaryKey', exists(select 1 from pg_constraint pk join pg_index pi on pi.indexrelid = pk.conindid
					where pk.conrelid = c.oid and pk.contype = 'p' and a.attnum = any(pk.conkey[1:pi.indnkeyatts]))
			) order by a.attnum) from pg_attribute a
			left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			left join pg_type t on t.oid = a.atttypid
			left join pg_type e on e.oid = t.typelem and e.typarray = t.oid and t.typtype <> 'd'
			left join pg_type mt on mt.oid = coalesce(e.oid, t.oid)
			left join pg_namespace mn on mn.oid = mt.typnamespace
			where a.attrelid = c.oid and a.attnum > 0), '[]'::jsonb),
			'primaryKey', coalesce((select jsonb_agg(a.attname order by k.position)
				from pg_constraint pk join pg_index pi on pi.indexrelid = pk.conindid
				cross join lateral unnest(pk.conkey[1:pi.indnkeyatts]) with ordinality k(num, position)
				join pg_attribute a on a.attrelid = pk.conrelid and a.attnum = k.num
				where pk.conrelid = c.oid and pk.contype = 'p'), '[]'::jsonb),
			'constraints', coalesce((select jsonb_agg(jsonb_build_object(
				'oid', con.oid::text, 'name', con.conname, 'table', con.conrelid::text,
				'kind', con.contype, 'definition', pg_get_constraintdef(con.oid), 'validated', con.convalidated,
				'expression', pg_get_expr(con.conbin, con.conrelid),
				'columns', array(select a.attname from unnest(case when con.contype = 'u'
					then con.conkey[1:ci.indnkeyatts] else con.conkey end) with ordinality k(num, position)
					join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num order by k.position),
				'foreignKey', case when con.contype = 'f' then jsonb_build_object(
					'schema', rn.nspname, 'table', rc.relname, 'tableOid', con.confrelid::text,
					'columns', array(select a.attname from unnest(con.confkey) with ordinality k(num, position)
						join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.num order by k.position),
					'match', case con.confmatchtype when 'f' then 'full' when 'p' then 'partial' else 'simple' end,
					'onUpdate', case con.confupdtype when 'r' then 'restrict' when 'c' then 'cascade'
						when 'n' then 'set null' when 'd' then 'set default' else 'no action' end,
					'onDelete', case con.confdeltype when 'r' then 'restrict' when 'c' then 'cascade'
						when 'n' then 'set null' when 'd' then 'set default' else 'no action' end) end,
				'deferrable', con.condeferrable, 'initiallyDeferred', con.condeferred, 'noInherit', con.connoinherit,
				'enforced', coalesce((to_jsonb(con)->>'conenforced')::boolean, true),
				'nullsNotDistinct', con.contype = 'u' and coalesce((to_jsonb(ci)->>'indnullsnotdistinct')::boolean, false),
				'indexOid', case when con.contype <> 'f' then nullif(con.conindid, 0)::text end,
				'indexComment', case when con.contype <> 'f' then obj_description(con.conindid, 'pg_class') end,
				'riTriggers', coalesce((select jsonb_agg(jsonb_build_object(
					'oid', t.oid::text, 'table', t.tgrelid::text, 'name', t.tgname,
					'enabled', t.tgenabled, 'comment', obj_description(t.oid, 'pg_trigger')) order by t.oid)
					from pg_trigger t where con.contype = 'f' and t.tgconstraint = con.oid), '[]'::jsonb),
				'replaceable', con.conislocal and con.coninhcount = 0
					and coalesce((to_jsonb(con)->>'conenforced')::boolean, true)
					and (con.contype = 'c' or (con.contype = 'f'
						and con.confmatchtype in ('s', 'f')
						and rc.relkind = 'r' and not rc.relispartition
						and not exists(select 1 from pg_inherits h where h.inhrelid = rc.oid or h.inhparent = rc.oid)
						and not coalesce((to_jsonb(con)->>'conperiod')::boolean, false)
						and to_jsonb(con)->>'confdelsetcols' is null
						and not ${customRiTriggersSql})
						or (con.contype = 'u' and ca.amname = 'btree'
						and ci.indisvalid and ci.indisready and ci.indislive
						and not ci.indisreplident and not ci.indisclustered
						and ci.indnkeyatts = ci.indnatts and ci.indexprs is null and ci.indpred is null
						and cc.reloptions is null and cc.reltablespace = 0
						and not exists(select 1 from generate_series(0, ci.indnkeyatts - 1) k(num)
							join pg_opclass opc on opc.oid = ci.indclass[k.num]
							join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ci.indkey[k.num]
							where not opc.opcdefault or ci.indoption[k.num] <> 0 or ci.indcollation[k.num] <> a.attcollation)
						and not exists(select 1 from pg_attribute a where a.attrelid = ci.indexrelid and a.attoptions is not null))),
				'comment', obj_description(con.oid, 'pg_constraint')) order by con.oid)
				from pg_constraint con left join pg_index ci on ci.indexrelid = con.conindid
				left join pg_class cc on cc.oid = ci.indexrelid left join pg_am ca on ca.oid = cc.relam
				left join pg_class rc on rc.oid = con.confrelid left join pg_namespace rn on rn.oid = rc.relnamespace
				where (con.conrelid = c.oid or con.confrelid = c.oid)
					and ($3::oid is null or con.conrelid <> $3::oid)), '[]'::jsonb),
			'indexes', coalesce((select jsonb_agg(jsonb_build_object(
				'oid', i.indexrelid::text, 'name', ic.relname, 'method', am.amname,
				'definition', pg_get_indexdef(i.indexrelid), 'unique', i.indisunique, 'primary', i.indisprimary,
				'valid', i.indisvalid, 'ready', i.indisready, 'clustered', i.indisclustered,
				'columns', array(select a.attname from unnest(i.indkey) with ordinality k(num, position)
					join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.num
					where k.position <= i.indnkeyatts order by k.position),
				'referenceable', ${referenceableIndexSql},
				'replicaIdentity', i.indisreplident, 'comment', obj_description(i.indexrelid, 'pg_class'),
				'constraint', (select con.conname from pg_constraint con
					where con.conindid = i.indexrelid and con.conrelid = c.oid and con.contype in ('p', 'u', 'x')))
				order by i.indexrelid) from pg_index i join pg_class ic on ic.oid = i.indexrelid
				join pg_am am on am.oid = ic.relam where i.indrelid = c.oid), '[]'::jsonb)
		) as metadata
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, [target.schema, target.table, excludeIncomingFrom]);
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
		primaryKey: raw.primaryKey, indexes: raw.indexes,
		constraints: raw.constraints.filter((constraint) => constraint.table === raw.oid && ['u', 'c', 'f'].includes(constraint.kind))
	};
}

export async function getSchemaDefinition(pool: pg.Pool, target: TableTarget): Promise<SchemaDefinition> {
	const validated = schemaTargetSchema['~standard'].validate(target);
	if ('issues' in validated) throw new Error(validated.issues[0].message);
	return transaction(pool, (client) => definition(client, validated.value));
}

// Names used by read/clone actions include existing types, not only explicitly selected types.
async function sourceCatalogVersion(client: pg.PoolClient, target: TableTarget): Promise<string> {
	return JSON.stringify((await client.query(`
		with recursive selected(oid) as (
			select a.atttypid from pg_attribute a join pg_class c on c.oid = a.attrelid
			join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
			union
			select dep.oid from selected s join pg_type t on t.oid = s.oid
			cross join lateral (select t.typelem as oid where t.typelem <> 0
				union select t.typbasetype where t.typbasetype <> 0) dep
		)
		select 'namespace' as kind, oid::text as oid, xmin::text as version from pg_namespace
		where nspname = $1 or oid in (select typnamespace from pg_type where oid in (select oid from selected))
		union all
		select 'type', oid::text, xmin::text from pg_type where oid in (select oid from selected)
		order by kind, oid`, [target.schema, target.table])).rows);
}

export async function exportSchema(pool: pg.Pool, target: TableTarget): Promise<SchemaExport> {
	const validated = schemaTargetSchema['~standard'].validate(target);
	if ('issues' in validated) throw new Error(validated.issues[0].message);
	target = validated.value;
	return transaction(pool, async (client) => {
		const before = await sourceCatalogVersion(client, target);
		const initial = await definition(client, target);
		if (!initial.editable) throw new Error(initial.reason!);
		await client.query(`lock table only ${qualify(target.schema, target.table)} in access share mode`);
		const locked = await definition(client, target);
		if (locked.version !== initial.version) throw new Error('Table schema changed; reload its definition before exporting');
		const metadata = await actionMetadata(client, locked.oid);
		const result = schemaSql(metadata);
		if (await sourceCatalogVersion(client, target) !== before
			|| (await definition(client, target)).version !== locked.version
			|| JSON.stringify(await actionMetadata(client, locked.oid)) !== JSON.stringify(metadata)) {
			throw new Error('Table, namespace or type catalog changed; reopen the schema editor before exporting');
		}
		return result;
	});
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

/** One transaction, with every captured target checked before any destructive DDL.
 * Column changes run between removal and creation; names stay original until the caller renames.
 */
async function applyConstraints(
	client: pg.PoolClient, target: TableTarget, current: SchemaDefinition,
	operations: ConstraintOperation[], searchPath: string, alterColumn?: () => Promise<void>, typeChangingColumn?: string
): Promise<() => Promise<void>> {
	const table = qualify(target.schema, target.table);
	const trusted = () => client.query('set local search_path = pg_catalog, pg_temp; set local standard_conforming_strings = on');
	const kind = (spec: ConstraintSpec) => spec.kind === 'unique' ? 'u' : spec.kind === 'check' ? 'c' : 'f';
	const prepared = operations.map((op) => {
		const old = 'constraintOid' in op ? current.constraints.find((constraint) => constraint.oid === op.constraintOid) : undefined;
		if ('constraintOid' in op && !old) throw new Error('Constraint no longer belongs to this table; reopen the schema editor');
		const spec = 'constraint' in op ? op.constraint : undefined;
		if (op.kind === 'alterConstraint' && (!old!.replaceable || old!.kind !== kind(spec!))) {
			throw new Error('Use SQL to change this constraint’s native options or kind');
		}
		if ((op.kind === 'alterConstraint' || op.kind === 'dropConstraint') && old!.kind === 'u'
			&& current.indexes.some((index) => index.oid === old!.indexOid && index.replicaIdentity)) {
			throw new Error('Change the table replica identity before removing this constraint');
		}
		if (spec && spec.kind !== 'check') {
			for (const name of spec.columns) {
				if (!current.columns.some((column) => column.name === name)) throw new Error(`Unknown constraint column: ${name}`);
			}
		}
		return { op, old, spec, indexTablespace: undefined as string | undefined };
	});
	type Reference = {
		spec: Extract<ConstraintSpec, { kind: 'foreignKey' }>;
		namespace: string;
		attnums: number[];
		indexes: string;
		version: string;
		createdOid?: string;
	};
	const references = new Map<ConstraintSpec, Reference>();
	const namespaceVersion = async (schema: string) => JSON.stringify((await client.query(
		'select oid::text, xmin::text from pg_namespace where nspname = $1', [schema])).rows);
	type RelatedRelation = Pick<NonNullable<SchemaConstraint['foreignKey']>, 'schema' | 'table' | 'tableOid'>;
	const relationIdentity = async (ref: RelatedRelation) => (await client.query(`
		select c.oid::text as oid, n.oid::text as namespace, n.xmin::text as version
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, [ref.schema, ref.table])).rows[0];
	const relatedTables = new Map<string, { reference: RelatedRelation; identity: string }>();
	const indexVersion = async (oid: string) => JSON.stringify((await client.query(`
		select c.oid::text, c.xmin::text, c.relname, c.relnamespace::text,
			obj_description(c.oid, 'pg_class') as comment, to_jsonb(i) as properties
		from pg_index i join pg_class c on c.oid = i.indexrelid
		where i.indrelid = $1::oid order by c.oid`, [oid])).rows);
	const eligible = async (reference: Reference, indexOid?: string) => {
		const result = await client.query(`
			select i.indexrelid from pg_index i where i.indrelid = $1::oid
				and ($3::oid is null or i.indexrelid = $3::oid) and ${referenceableIndexSql}
				and i.indnkeyatts = cardinality($2::smallint[])
				and array(select k.num from unnest(i.indkey) with ordinality k(num, position)
					where k.position <= i.indnkeyatts order by k.num)
					= array(select num from unnest($2::smallint[]) num order by num)`,
		[reference.spec.reference.oid, reference.attnums, indexOid ?? null]);
		if (!result.rows.length) throw new Error('Referenced columns are not an eligible unique key; reload the target definition');
	};
	for (const { spec } of prepared) {
		if (spec?.kind !== 'foreignKey') continue;
		const ref = spec.reference, refTarget = { ...target, schema: ref.schema, table: ref.table };
		const namespace = await namespaceVersion(ref.schema);
		// Parse takes ACCESS SHARE until commit, without executing or requiring SELECT.
		// Explicit LOCK would require privileges beyond native REFERENCES. ADD FOREIGN KEY
		// later upgrades to its native lock; neither phase retries timeout/deadlock errors.
		await parseCheck(client, qualify(ref.schema, ref.table), 'true');
		const snapshot = await definition(client, refTarget);
		if (snapshot.oid !== ref.oid || snapshot.version !== ref.version) throw new Error('Referenced table schema changed; reload its definition before applying');
		if (!snapshot.editable) throw new Error(snapshot.reason!);
		const columns = await client.query<{ name: string; num: number }>(
			'select attname as name, attnum as num from pg_attribute where attrelid = $1::oid and attnum > 0 and not attisdropped', [ref.oid]);
		const attnums = ref.columns.map((name) => {
			const column = columns.rows.find((column) => column.name === name);
			if (!column) throw new Error(`Unknown referenced column: ${name}`);
			return column.num;
		});
		// Our source's incoming FK definitions can change through explicit replacements,
		// native type rebuilds and the final column rename. Other target changes cannot.
		const reference = { spec, namespace, attnums, indexes: await indexVersion(ref.oid),
			version: ref.oid === current.oid ? '' : (await definition(client, refTarget, current.oid)).version };
		await eligible(reference);
		if (await namespaceVersion(ref.schema) !== namespace || (await definition(client, refTarget)).version !== ref.version) {
			throw new Error('Referenced table or namespace changed; reopen the schema editor');
		}
		references.set(spec, reference);
	}
	// Type changes implicitly rebuild incoming AND outgoing FKs, even an explicit
	// same-type cast. Unrelated columns and deliberate removals are not implicit rebuilds.
	const implicitlyRebuilt = typeChangingColumn === undefined ? [] : (await client.query<RelatedRelation & { customized: boolean; ordinary: boolean }>(`
		select c.oid::text as "tableOid", n.nspname as schema, c.relname as table,
			${customRiTriggersSql} as customized,
			c.relkind = 'r' and not c.relispartition
				and not exists(select 1 from pg_inherits h where h.inhrelid = c.oid or h.inhparent = c.oid) as ordinary
		from pg_constraint con
		join pg_attribute a on a.attrelid = $1::oid and a.attname = $2 and a.attnum > 0 and not a.attisdropped
		join pg_class c on c.oid = case when con.conrelid = $1::oid then con.confrelid else con.conrelid end
		join pg_namespace n on n.oid = c.relnamespace
		where con.contype = 'f' and ((con.conrelid = $1::oid and a.attnum = any(con.conkey))
			or (con.confrelid = $1::oid and a.attnum = any(con.confkey)))
			and not (con.conrelid = $1::oid and con.oid = any($3::oid[]))
		order by con.oid`, [current.oid, typeChangingColumn, prepared.flatMap(({ op, old }) =>
			(op.kind === 'dropConstraint' || op.kind === 'alterConstraint') && old!.kind === 'f' ? [old!.oid] : [])])).rows;
	for (const ref of implicitlyRebuilt) {
		if (ref.customized || !ref.ordinary) {
			throw new Error('Use SQL to change this FK key type: native rebuilding would discard RI trigger options or involve non-standalone tables');
		}
	}
	// Explicit replacement protects its OLD target even when retargeting A -> B.
	// Implicit rebuilds protect the other end of every affected FK. ACCESS EXCLUSIVE
	// blocks COMMENT too; both cases deliberately require native LOCK privileges.
	// REFERENCES alone remains sufficient for creation. No weaker-lock fallback.
	const replacingForeignKey = prepared.some(({ op, old }) => op.kind === 'alterConstraint' && old!.kind === 'f');
	const relationsToLock = [...implicitlyRebuilt, ...prepared.flatMap(({ op, old }) =>
		op.kind === 'alterConstraint' && old!.kind === 'f' ? [old!.foreignKey!] : [])];
	for (const ref of relationsToLock) {
		if (ref.tableOid === current.oid || relatedTables.has(ref.tableOid)) continue;
		const before = await relationIdentity(ref);
		if (before?.oid !== ref.tableOid) throw new Error('Related table changed; reopen the schema editor');
		const identity = JSON.stringify(before);
		await client.query(`lock table only ${qualify(ref.schema, ref.table)} in access exclusive mode`);
		if (JSON.stringify(await relationIdentity(ref)) !== identity) {
			throw new Error('Related table or namespace changed; reopen the schema editor');
		}
		relatedTables.set(ref.tableOid, { reference: ref, identity });
	}
	if ((replacingForeignKey || implicitlyRebuilt.length) && (await definition(client, target)).version !== current.version) {
		throw new Error('Constraint changed; reopen the schema editor before applying');
	}
	// Lock replacement indexes and every eligible self-reference key before any drops/types.
	// Self keys can be rebuilt by our own type DDL, so an end-of-batch fingerprint alone
	// cannot distinguish that rebuild from an independent index rename adopted mid-batch.
	const indexLocks = new Set(prepared.flatMap((item) =>
		item.op.kind === 'alterConstraint' && item.spec?.kind === 'unique' ? [item.old!.indexOid!] : []));
	for (const reference of references.values()) {
		if (reference.spec.reference.oid !== current.oid) continue;
		for (const index of current.indexes) {
			if (index.referenceable && index.columns.length === reference.spec.reference.columns.length
				&& index.columns.every((name) => reference.spec.reference.columns.includes(name))) indexLocks.add(index.oid);
		}
	}
	// Every refreshed fingerprint below must still describe the complete original source.
	for (const oid of indexLocks) {
		const index = (await client.query<{ name: string; schema: string; xmin: string; tablespace: string; defaultTablespace: string }>(`
			select i.relname as name, n.nspname as schema, i.xmin::text as xmin,
				i.reltablespace::text as tablespace, s.spcname as "defaultTablespace"
			from pg_class i join pg_namespace n on n.oid = i.relnamespace
			cross join pg_database d join pg_tablespace s on s.oid = coalesce(nullif(i.reltablespace, 0), d.dattablespace)
			where i.oid = $1::oid and d.datname = current_database()`, [oid])).rows[0];
		const replacements = prepared.filter((item) => item.op.kind === 'alterConstraint' && item.old!.indexOid === oid);
		if (!index || (replacements.length && index.tablespace !== '0')) throw new Error('Constraint changed; reopen the schema editor before applying');
		// LOCK TABLE cannot lock indexes. This no-op obtains an exclusive index lock.
		// A raced tablespace move can do physical work; xmin and the fresh snapshot fence it.
		await client.query(`alter index ${qualify(index.schema, index.name)} set tablespace ${ident(index.defaultTablespace)}`);
		await trusted();
		const locked = await client.query<{ xmin: string }>('select xmin::text as xmin from pg_class where oid = $1::oid', [oid]);
		if (locked.rows[0]?.xmin !== index.xmin || (await definition(client, target)).version !== current.version) {
			throw new Error('Constraint changed; reopen the schema editor before applying');
		}
		for (const item of replacements) item.indexTablespace = index.defaultTablespace;
	}
	// Explicit FK removals precede unique removals; RESTRICT still protects unstaged dependencies.
	for (const { op, old } of [...prepared].sort((a, b) => Number(b.old?.kind === 'f') - Number(a.old?.kind === 'f'))) {
		if (op.kind !== 'dropConstraint' && op.kind !== 'alterConstraint') continue;
		await client.query(`alter table ${table} drop constraint ${ident(old!.name)} restrict`);
		if ((await client.query('select oid from pg_constraint where oid = $1::oid', [old!.oid])).rows.length) {
			throw new Error('Constraint changed; reopen the schema editor before applying');
		}
	}
	await alterColumn?.();
	// Recreated unique keys must exist before self-referencing FKs are installed.
	for (const { op, old, spec, indexTablespace } of [...prepared].sort((a, b) => Number(b.spec?.kind === 'unique') - Number(a.spec?.kind === 'unique'))) {
		if (spec) {
			if (spec.kind === 'check') {
				await client.query("select pg_catalog.set_config('search_path', $1, true)", [searchPath]);
				await parseCheck(client, table, spec.expression);
				await trusted();
			}
			if ((await client.query('select to_regclass($1)::oid::text as oid', [table])).rows[0].oid !== current.oid) {
				throw new Error('Table changed; reopen the schema editor');
			}
			const reference = references.get(spec);
			if (reference) {
				await eligible(reference);
				if (spec.kind === 'foreignKey' && spec.reference.oid !== current.oid
					&& await indexVersion(spec.reference.oid) !== reference.indexes) {
					throw new Error('Referenced index changed; reopen the schema editor');
				}
			}
			const deferral = spec.kind === 'check' ? '' : spec.deferrable
				? ` deferrable initially ${spec.initiallyDeferred ? 'deferred' : 'immediate'}` : ' not deferrable';
			const clause = spec.kind === 'unique'
				? `unique ${spec.nullsNotDistinct ? 'nulls not distinct ' : ''}(${spec.columns.map(ident).join(', ')})`
					+ (indexTablespace ? ` using index tablespace ${ident(indexTablespace)}` : '') + deferral
				: spec.kind === 'check'
					? `check (\n${spec.expression}\n)${spec.noInherit ? ' no inherit' : ''}${spec.notValid ? ' not valid' : ''}`
					: `foreign key (${spec.columns.map(ident).join(', ')}) references ${qualify(spec.reference.schema, spec.reference.table)}`
						+ ` (${spec.reference.columns.map(ident).join(', ')}) match ${spec.match}`
						+ ` on update ${spec.onUpdate} on delete ${spec.onDelete}${deferral}${spec.notValid ? ' not valid' : ''}`;
			if (spec.kind === 'check') await client.query("select pg_catalog.set_config('search_path', $1, true)", [searchPath]);
			await client.query(`alter table ${table} add constraint ${ident(spec.name)} ${clause}`);
			await trusted();
			const created = (await client.query<{
				oid: string; kind: string; indexSchema: string | null; indexName: string | null; tablespace: string | null;
				referenceOid: string; referenceColumns: number[]; indexOid: string;
			}>(`
				select con.oid::text as oid, con.contype as kind, n.nspname as "indexSchema", i.relname as "indexName",
					i.reltablespace::text as tablespace, con.confrelid::text as "referenceOid",
					con.confkey as "referenceColumns", con.conindid::text as "indexOid"
				from pg_constraint con left join pg_class i on i.oid = con.conindid
				left join pg_namespace n on n.oid = i.relnamespace
				where con.conrelid = $1::oid and con.conname = $2 and con.xmin = pg_current_xact_id()::xid`, [current.oid, spec.name])).rows[0];
			if (created?.kind !== kind(spec) || (indexTablespace !== undefined && created?.tablespace !== '0')) {
				throw new Error('Constraint or table changed; reopen the schema editor before applying');
			}
			if (reference) {
				if (created.referenceOid !== reference.spec.reference.oid
					|| JSON.stringify(created.referenceColumns) !== JSON.stringify(reference.attnums)) {
					throw new Error('Referenced table or columns changed; reopen the schema editor');
				}
				await eligible(reference, created.indexOid);
				reference.createdOid = created.oid;
			}
			if (old?.comment !== null && old?.comment !== undefined) {
				await client.query(`comment on constraint ${ident(spec.name)} on ${table} is ${pg.escapeLiteral(old.comment)}`);
			}
			if (old?.kind === 'u' && old.indexComment !== null) {
				await client.query(`comment on index ${qualify(created.indexSchema!, created.indexName!)} is ${pg.escapeLiteral(old.indexComment)}`);
			}
		} else if (op.kind === 'renameConstraint' || op.kind === 'validateConstraint') {
			if (op.kind === 'validateConstraint' && (!['c', 'f'].includes(old!.kind) || !old!.enforced)) {
				throw new Error('Only enforced CHECK or foreign key constraints can be validated here');
			}
			if (op.kind === 'validateConstraint') await client.query("select pg_catalog.set_config('search_path', $1, true)", [searchPath]);
			await client.query(`alter table ${table} ${op.kind === 'renameConstraint'
				? `rename constraint ${ident(old!.name)} to ${ident(op.name)}` : `validate constraint ${ident(old!.name)}`}`);
			await trusted();
			const constraint = (await client.query<{ name: string; kind: string; table: string; validated: boolean }>(`
				select conname as name, contype as kind, conrelid::text as table, convalidated as validated
				from pg_constraint where oid = $1::oid`, [old!.oid])).rows[0];
			if (!constraint || constraint.name !== (op.kind === 'renameConstraint' ? op.name : old!.name)
				|| constraint.table !== current.oid || constraint.kind !== old!.kind
				|| (op.kind === 'validateConstraint' && !constraint.validated)) {
				throw new Error('Constraint changed; reopen the schema editor before applying');
			}
		}
	}
	// Self-reference snapshots may legitimately change through this batch's type/index DDL.
	// Capture their final index identities now, then fence late independent index renames too.
	for (const reference of references.values()) {
		if (reference.spec.reference.oid === current.oid) reference.indexes = await indexVersion(current.oid);
	}
	return async () => {
		for (const { reference, identity } of relatedTables.values()) {
			if (JSON.stringify(await relationIdentity(reference)) !== identity) {
				throw new Error('Related table or namespace changed; reopen the schema editor');
			}
		}
		for (const reference of references.values()) {
			const ref = reference.spec.reference;
			const relation = (await client.query(`select c.oid::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
				where n.nspname = $1 and c.relname = $2`, [ref.schema, ref.table])).rows[0];
			if (relation?.oid !== ref.oid || await namespaceVersion(ref.schema) !== reference.namespace
				|| await indexVersion(ref.oid) !== reference.indexes
				|| (ref.oid !== current.oid
					&& (await definition(client, { ...target, schema: ref.schema, table: ref.table }, current.oid)).version !== reference.version)) {
				throw new Error('Referenced table, namespace or index changed; reopen the schema editor');
			}
			const constraint = (await client.query(`select confrelid::text as oid, confkey as columns, conindid::text as index
				from pg_constraint where oid = $1::oid and conrelid = $2::oid`, [reference.createdOid, current.oid])).rows[0];
			if (constraint?.oid !== ref.oid || JSON.stringify(constraint.columns) !== JSON.stringify(reference.attnums)) {
				throw new Error('Foreign key changed; reopen the schema editor');
			}
			await eligible(reference, constraint.index);
		}
	};
}

export async function changeSchema(pool: pg.Pool, args: SchemaChangeArgs): Promise<void> {
	const validated = schemaChangeSchema['~standard'].validate(args);
	if ('issues' in validated) throw new Error(validated.issues[0].message);
	args = validated.value;
	await transaction(pool, async (client, searchPath) => {
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
		const sourceBefore = op.kind === 'duplicateTable' ? await sourceCatalogVersion(client, args) : null;
		let current: SchemaDefinition | undefined;
		if (op.kind !== 'createTable') {
			// ONLY avoids locking descendants before we reject inherited/partitioned tables.
			await client.query(`lock table only ${table} in ${op.kind === 'duplicateTable' ? 'access share' : 'access exclusive'} mode`);
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
		let createdOid: string | undefined;
		let checkReferences: (() => Promise<void>) | undefined;
		switch (op.kind) {
			case 'duplicateTable':
				createdOid = await duplicateTable(client, args, current!.oid, op.name, op.includeRows);
				if ((await definition(client, args)).version !== current!.version
					|| await sourceCatalogVersion(client, args) !== sourceBefore) {
					throw new Error('Source table or type catalog changed; reopen the schema editor before applying');
				}
				break;
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
			case 'createIndex': {
				for (const name of op.columns) {
					if (!current!.columns.some((column) => column.name === name)) throw new Error(`Unknown index column: ${name}`);
				}
				await client.query(`create ${op.unique ? 'unique ' : ''}index ${ident(op.name)} on ${table}
					using ${ident(op.method)} (${op.columns.map(ident).join(', ')})`);
				const created = await client.query<{ table: string }>(`
					select i.indrelid::text as table from pg_index i
					join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
					where n.nspname = $1 and c.relname = $2`, [args.schema, op.name]);
				if (created.rows[0]?.table !== current!.oid) throw new Error('Index or table changed; reopen the schema editor before applying');
				break;
			}
			case 'dropIndex': {
				const index = current!.indexes.find((index) => index.oid === op.indexOid);
				if (!index) throw new Error('Index no longer belongs to this table; reopen the schema editor');
				if (index.constraint) throw new Error(`Index belongs to constraint ${index.constraint}; manage the constraint instead`);
				if (index.replicaIdentity) throw new Error('Change the table replica identity before dropping this index');
				await client.query(`drop index ${qualify(args.schema, index.name)} restrict`);
				// Index renames need not lock the parent table. A reused name must not let us
				// commit the removal of a different index; roll the entire operation back.
				if ((await client.query('select oid from pg_class where oid = $1::oid', [index.oid])).rows.length) {
					throw new Error('Index changed; reopen the schema editor before applying');
				}
				break;
			}
			case 'addConstraint': case 'alterConstraint': case 'renameConstraint': case 'dropConstraint': case 'validateConstraint': {
				checkReferences = await applyConstraints(client, args, current!, [op], searchPath);
				break;
			}
			case 'alterColumn': {
				const old = current!.columns.find((column) => column.name === op.column);
				if (!old) throw new Error('Column does not exist');
				const next = op.changes;
				if (old.primaryKey && !next.primaryKey) throw new Error('An existing primary key cannot be replaced');
				if (!old.primaryKey && next.primaryKey && current!.primaryKey.length) throw new Error('An existing primary key cannot be replaced');
				checkReferences = await applyConstraints(client, args, current!, op.constraints ?? [], searchPath, async () => {
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
				}, next.typeOid !== null ? old.name : undefined);
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
				where n.nspname = $1 and c.relname = $2`, [args.schema, op.kind === 'renameTable' || op.kind === 'duplicateTable' ? op.name : args.table]);
			targetChanged = !after.rows[0] || (createdOid !== undefined ? after.rows[0].oid !== createdOid : (!!current && after.rows[0].oid !== current.oid))
				|| changedColumns.some((column) => column.typeOid !== null
					&& after.rows.find((row) => row.name === column.name)?.typeOid !== column.typeOid);
		}
		if (targetChanged || await catalogVersion() !== before) {
			throw new Error('Table, namespace or type catalog changed; reopen the schema editor before applying');
		}
		await checkReferences?.();
	});
	invalidateMetadata(pool);
}
