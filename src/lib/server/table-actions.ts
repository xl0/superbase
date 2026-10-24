import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SchemaExport } from '../schema.js';
import type { TableTarget } from '../types.js';
import { ident, qualify } from './db.js';

/** Shared by the semantic fingerprint and action snapshot; never includes sequence state. */
export const ownedSequencesSql = `coalesce((select jsonb_agg(jsonb_build_object(
	'oid', s.oid::text, 'schema', sn.nspname, 'name', s.relname,
	'column', a.attname, 'ownership', dep.deptype, 'persistence', s.relpersistence,
	'type', format_type(q.seqtypid, null), 'start', q.seqstart::text,
	'increment', q.seqincrement::text, 'min', q.seqmin::text, 'max', q.seqmax::text,
	'cache', q.seqcache::text, 'cycle', q.seqcycle, 'comment', obj_description(s.oid, 'pg_class'),
	'defaults', coalesce((select jsonb_agg(jsonb_build_object(
		'column', da.attname,
		'canonical', pg_get_expr(ad.adbin, ad.adrelid) = format('nextval(%L::regclass)', s.oid::regclass::text)
	) order by da.attnum)
	from pg_depend dd join pg_attrdef ad on dd.classid = 'pg_attrdef'::regclass and dd.objid = ad.oid
	join pg_attribute da on da.attrelid = ad.adrelid and da.attnum = ad.adnum
	where dd.refclassid = 'pg_class'::regclass and dd.refobjid = s.oid and ad.adrelid = c.oid), '[]'::jsonb),
	'otherDependencies', exists(select 1 from pg_depend dd
		where dd.refclassid = 'pg_class'::regclass and dd.refobjid = s.oid and (
			(dd.classid = 'pg_constraint'::regclass and dd.objid in (select oid from pg_constraint where conrelid = c.oid))
			or (dd.classid = 'pg_class'::regclass and dd.objid in (select indexrelid from pg_index where indrelid = c.oid))))
) order by s.oid)
from pg_depend dep join pg_class s on dep.classid = 'pg_class'::regclass and s.oid = dep.objid and s.relkind = 'S'
join pg_namespace sn on sn.oid = s.relnamespace join pg_sequence q on q.seqrelid = s.oid
join pg_attribute a on a.attrelid = dep.refobjid and a.attnum = dep.refobjsubid
where dep.refclassid = 'pg_class'::regclass and dep.refobjid = c.oid and dep.deptype in ('a', 'i')), '[]'::jsonb)`;

type OwnedSequence = {
	oid: string; schema: string; name: string; column: string; ownership: 'a' | 'i';
	persistence: string; type: string; start: string; increment: string; min: string;
	max: string; cache: string; cycle: boolean; comment: string | null;
	defaults: { column: string; canonical: boolean }[]; otherDependencies: boolean;
};
type ActionColumn = {
	name: string; type: string; dimensions: number; isArray: boolean;
	collation: string | null; nullable: boolean; expression: string | null;
	generated: string; identity: string; comment: string | null;
	sequenceCall: boolean; canonicalSequence: boolean;
};
type ActionMetadata = {
	oid: string; namespaceOid: string; schema: string; name: string; persistence: string;
	rls: boolean; forceRls: boolean; comment: string | null;
	columns: ActionColumn[]; sequences: OwnedSequence[];
	constraints: { name: string; kind: string; definition: string; comment: string | null; sequenceCall: boolean }[];
	indexes: { name: string; definition: string; valid: boolean; comment: string | null }[];
};

/** OID-bound single catalog snapshot. Call only while the source relation is locked. */
export async function actionMetadata(client: pg.PoolClient, oid: string): Promise<ActionMetadata> {
	const result = await client.query<{ metadata: ActionMetadata }>(`
		with sequence_functions as (
			select ':funcid (' || string_agg(p.oid::text, '|') || ') ' as pattern from pg_proc p
			where p.pronamespace = 'pg_catalog'::regnamespace and p.proname in ('nextval', 'currval', 'setval')
		)
		select jsonb_build_object(
			'oid', c.oid::text, 'namespaceOid', n.oid::text, 'schema', n.nspname, 'name', c.relname,
			'persistence', c.relpersistence, 'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
			'comment', obj_description(c.oid, 'pg_class'), 'sequences', ${ownedSequencesSql},
			'columns', coalesce((select jsonb_agg(jsonb_build_object(
				'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
				'dimensions', a.attndims, 'isArray', t.typelem <> 0 and t.typtype <> 'd',
				'collation', case when co.oid is not null then quote_ident(cn.nspname) || '.' || quote_ident(co.collname) end,
				'nullable', not a.attnotnull, 'expression', pg_get_expr(d.adbin, d.adrelid),
				'sequenceCall', coalesce(d.adbin::text ~ sf.pattern, false),
				'canonicalSequence', exists(select 1 from pg_depend dd join pg_class s on s.oid = dd.refobjid and s.relkind = 'S'
					where dd.classid = 'pg_attrdef'::regclass and dd.objid = d.oid and dd.refclassid = 'pg_class'::regclass
					and pg_get_expr(d.adbin, d.adrelid) = format('nextval(%L::regclass)', s.oid::regclass::text)),
				'generated', a.attgenerated, 'identity', a.attidentity,
				'comment', col_description(c.oid, a.attnum)
			) order by a.attnum) from pg_attribute a
			join pg_type t on t.oid = a.atttypid
			left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			left join pg_collation co on co.oid = a.attcollation
			left join pg_namespace cn on cn.oid = co.collnamespace
			where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::jsonb),
			'constraints', coalesce((select jsonb_agg(jsonb_build_object(
				'name', con.conname, 'kind', con.contype, 'definition', pg_get_constraintdef(con.oid),
				'comment', obj_description(con.oid, 'pg_constraint'),
				'sequenceCall', coalesce(con.conbin::text ~ sf.pattern, false)
			) order by con.oid) from pg_constraint con
			where con.conrelid = c.oid and con.contype <> 'n'), '[]'::jsonb),
			'indexes', coalesce((select jsonb_agg(jsonb_build_object(
				'name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid),
				'valid', i.indisvalid and i.indisready, 'comment', obj_description(ic.oid, 'pg_class')
			) order by i.indexrelid) from pg_index i join pg_class ic on ic.oid = i.indexrelid
			where i.indrelid = c.oid and not exists(select 1 from pg_constraint con
				where con.conrelid = c.oid and con.conindid = i.indexrelid and con.contype in ('p', 'u', 'x'))), '[]'::jsonb)
		) as metadata from pg_class c join pg_namespace n on n.oid = c.relnamespace
		cross join sequence_functions sf where c.oid = $1::oid`, [oid]);
	if (!result.rows[0]) throw new Error('Source table no longer exists');
	return result.rows[0].metadata;
}

function sequenceOptions(sequence: OwnedSequence): string {
	return `as ${sequence.type} increment by ${sequence.increment} minvalue ${sequence.min} maxvalue ${sequence.max}`
		+ ` start with ${sequence.start} cache ${sequence.cache} ${sequence.cycle ? '' : 'no '}cycle`;
}

/** No text substitution: only a whole, catalog-verified nextval expression is rebound. */
export async function duplicateTable(
	client: pg.PoolClient, target: TableTarget, oid: string, name: string, includeRows: boolean
): Promise<string> {
	const source = await actionMetadata(client, oid);
	const columns = source.columns.filter((column) => !column.generated);
	// pg_depend cannot bind dynamic regclass expressions. Inspect builtin function OIDs
	// in copied defaults/generated expressions and CHECKs, not user literals. Index
	// expressions/predicates cannot directly call these volatile builtin functions.
	if (source.sequences.length && (
		source.columns.some((column) => column.sequenceCall && !column.canonicalSequence)
		|| source.constraints.some((constraint) => constraint.kind === 'c' && constraint.sequenceCall)
	)) {
		throw new Error('Cannot duplicate a complex owned-sequence dependency; only direct nextval defaults are supported');
	}
	for (const sequence of source.sequences) {
		if (sequence.otherDependencies || sequence.defaults.some((item) => !item.canonical)) {
			throw new Error('Cannot duplicate a complex owned-sequence dependency; only direct nextval defaults are supported');
		}
	}
	if (source.indexes.some((index) => !index.valid)) throw new Error('Cannot duplicate an invalid or unfinished index faithfully');
	const destination = qualify(target.schema, name);
	const table = qualify(target.schema, target.table);
	await client.query(`create ${source.persistence === 'u' ? 'unlogged ' : ''}table ${destination} (like ${table} including all)`);
	const created = await client.query<{ oid: string }>(
		`select oid::text as oid from pg_class where relnamespace = $1::oid and relname = $2
			and xmin = pg_current_xact_id()::xid`,
		[source.namespaceOid, name]);
	if (!created.rows[0]) throw new Error('Destination namespace catalog changed during duplication');
	const newOid = created.rows[0].oid;
	const clone = await actionMetadata(client, newOid);
	for (const sequence of source.sequences) {
		let newSequence: string;
		if (sequence.ownership === 'i') {
			const identity = clone.sequences.find((item) => item.ownership === 'i' && item.column === sequence.column);
			if (!identity) throw new Error('Cloned identity sequence is missing');
			newSequence = qualify(identity.schema, identity.name);
			await client.query(`alter sequence ${newSequence} ${sequenceOptions(sequence)} restart with ${sequence.start}`);
			if (identity.persistence !== sequence.persistence) {
				await client.query(`alter sequence ${newSequence} set ${sequence.persistence === 'u' ? 'unlogged' : 'logged'}`);
			}
		} else {
			// Fixed ASCII length avoids truncation/collisions with hostile or 63-byte table names.
			newSequence = qualify(target.schema, `sb_seq_${randomUUID().replaceAll('-', '')}`);
			await client.query(`create ${sequence.persistence === 'u' ? 'unlogged ' : ''}sequence ${newSequence} ${sequenceOptions(sequence)}`);
			await client.query(`alter sequence ${newSequence} owned by ${destination}.${ident(sequence.column)}`);
		}
		for (const dependency of sequence.defaults) {
			await client.query(`alter table ${destination} alter column ${ident(dependency.column)} set default pg_catalog.nextval(${pg.escapeLiteral(newSequence)}::pg_catalog.regclass)`);
		}
		if (sequence.comment !== null) await client.query(`comment on sequence ${newSequence} is ${pg.escapeLiteral(sequence.comment)}`);
	}
	if (includeRows) {
		const names = columns.map((column) => ident(column.name)).join(', ');
		// An empty SELECT list preserves row multiplicity for zero/all-generated tables.
		// Typed values stay in PostgreSQL; generated columns are recomputed and RLS stays active.
		await client.query(`insert into ${destination}${names ? ` (${names})` : ''} overriding system value select ${names} from only ${table}`);
	}
	const populated = await actionMetadata(client, newOid);
	for (const sequence of populated.sequences) {
		const names = [...new Set([sequence.column, ...sequence.defaults.map((item) => item.column)])];
		// All arithmetic remains numeric/int8 in PostgreSQL, including negative increments and int8 extrema.
		const extrema = names.map((column) => `select ${ident(column)}::numeric as value from ${destination}`).join(' union all ');
		const next = await client.query<{ next: string; exhausted: boolean }>(`
			with bounds as (select min(value) as lo, max(value) as hi from (${extrema}) values_),
			candidate as (select case when $2::numeric > 0 then
				greatest($1::numeric, $1::numeric + (floor((hi - $1::numeric) / $2::numeric) + 1) * $2::numeric)
			else least($1::numeric, $1::numeric + (floor(($1::numeric - lo) / (-$2::numeric)) + 1) * $2::numeric) end as value from bounds)
			select value::text as next, value < $3::numeric or value > $4::numeric as exhausted from candidate`,
			[sequence.start, sequence.increment, sequence.min, sequence.max]);
		if (next.rows[0].exhausted) throw new Error('Copied values exhaust an owned sequence; cannot safely continue without collisions');
		await client.query('select pg_catalog.setval($1::oid::regclass, $2::bigint, false)', [sequence.oid, next.rows[0].next]);
	}
	if (source.comment !== null) await client.query(`comment on table ${destination} is ${pg.escapeLiteral(source.comment)}`);
	// Apply before commit: default grants must never expose RLS-protected copied rows.
	if (source.rls) await client.query(`alter table ${destination} enable row level security`);
	if (source.forceRls) await client.query(`alter table ${destination} force row level security`);
	if (JSON.stringify(await actionMetadata(client, oid)) !== JSON.stringify(source)) {
		throw new Error('Source catalog changed during duplication; reload its definition');
	}
	return newOid;
}

const exportWarnings = [
	'Structure only; this is not a full pg_dump or backup. No rows or live sequence values are included.',
	'Schemas, external types, functions, collations, operator classes, tablespaces, referenced tables and unowned sequences must already exist. External dependencies remain shared.',
	'Triggers, rules, RLS policies, security labels, grants and ownership are omitted; privileges follow PostgreSQL defaults.',
	'RLS ENABLE/FORCE flags are retained without policies: access is denied where RLS applies, possibly even for the owner.',
	'Typed-table bindings; table-level access methods, tablespaces and storage options; column storage/compression; replication/publication settings, clustering, statistics settings and extended statistics are omitted.',
	'NOT NULL is preserved, but NOT NULL constraint names, validation state and comments are omitted. Constraint-backed index comments and physical index settings not present in PostgreSQL deparsed definitions are omitted.'
];

export function schemaSql(source: ActionMetadata): SchemaExport {
	if (source.indexes.some((index) => !index.valid)) throw new Error('Cannot export an invalid or unfinished index faithfully');
	const table = qualify(source.schema, source.name);
	// These comments contain only fixed application text, never catalog names or comments.
	const statements = exportWarnings.map((warning) => `-- ${warning}`);
	statements.push('BEGIN;', 'SET LOCAL search_path = pg_catalog;', 'SET LOCAL standard_conforming_strings = on;');
	for (const sequence of source.sequences.filter((item) => item.ownership === 'a')) {
		statements.push(`CREATE ${sequence.persistence === 'u' ? 'UNLOGGED ' : ''}SEQUENCE ${qualify(sequence.schema, sequence.name)} ${sequenceOptions(sequence)};`);
	}
	const columns = source.columns.map((column) => {
		let sql = `${ident(column.name)} ${column.type}`;
		if (column.isArray && column.dimensions > 1) sql += '[]'.repeat(column.dimensions - 1);
		if (column.collation) sql += ` COLLATE ${column.collation}`;
		if (column.identity) {
			const sequence = source.sequences.find((item) => item.ownership === 'i' && item.column === column.name);
			if (!sequence) throw new Error('Identity sequence is missing');
			sql += ` GENERATED ${column.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY (SEQUENCE NAME ${qualify(sequence.schema, sequence.name)})`;
		} else if (column.generated) {
			if (!['s', 'v'].includes(column.generated) || column.expression === null) throw new Error('Unsupported generated column kind');
			sql += ` GENERATED ALWAYS AS (${column.expression}) ${column.generated === 's' ? 'STORED' : 'VIRTUAL'}`;
		} else if (column.expression !== null) sql += ` DEFAULT ${column.expression}`;
		if (!column.nullable) sql += ' NOT NULL';
		return sql;
	});
	statements.push(`CREATE ${source.persistence === 'u' ? 'UNLOGGED ' : ''}TABLE ${table} (\n${columns.map((column) => `  ${column}`).join(',\n')}\n);`);
	for (const sequence of source.sequences) {
		const name = qualify(sequence.schema, sequence.name);
		if (sequence.ownership === 'a') statements.push(`ALTER SEQUENCE ${name} OWNED BY ${table}.${ident(sequence.column)};`);
		else {
			statements.push(`ALTER SEQUENCE ${name} ${sequenceOptions(sequence)} RESTART WITH ${sequence.start};`);
			if (sequence.persistence !== source.persistence) {
				statements.push(`ALTER SEQUENCE ${name} SET ${sequence.persistence === 'u' ? 'UNLOGGED' : 'LOGGED'};`);
			}
		}
		if (sequence.comment !== null) statements.push(`COMMENT ON SEQUENCE ${name} IS ${pg.escapeLiteral(sequence.comment)};`);
	}
	const addConstraint = (constraint: ActionMetadata['constraints'][number]) => {
		statements.push(`ALTER TABLE ONLY ${table} ADD CONSTRAINT ${ident(constraint.name)} ${constraint.definition};`);
		if (constraint.comment !== null) statements.push(`COMMENT ON CONSTRAINT ${ident(constraint.name)} ON ${table} IS ${pg.escapeLiteral(constraint.comment)};`);
	};
	for (const constraint of source.constraints) if (constraint.kind !== 'f') addConstraint(constraint);
	for (const index of source.indexes) {
		statements.push(`${index.definition};`);
		if (index.comment !== null) statements.push(`COMMENT ON INDEX ${qualify(source.schema, index.name)} IS ${pg.escapeLiteral(index.comment)};`);
	}
	// A self-referencing FK can depend on a standalone unique index, not just a constraint.
	for (const constraint of source.constraints) if (constraint.kind === 'f') addConstraint(constraint);
	if (source.comment !== null) statements.push(`COMMENT ON TABLE ${table} IS ${pg.escapeLiteral(source.comment)};`);
	for (const column of source.columns) {
		if (column.comment !== null) statements.push(`COMMENT ON COLUMN ${table}.${ident(column.name)} IS ${pg.escapeLiteral(column.comment)};`);
	}
	if (source.rls) statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
	if (source.forceRls) statements.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
	statements.push('COMMIT;');
	return { sql: statements.join('\n') + '\n', warnings: [...exportWarnings] };
}
