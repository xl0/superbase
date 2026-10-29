import type pg from 'pg';

import type {
	Column, ColumnKind, DeleteArgs, Row, RowIdentity, RowQuery, RowsArgs, RowsPage,
	SaveArgs, Table, Values, ViewAs
} from '../types.js';
import { FILTER_OPERATORS, writable } from '../types.js';
import { ident, qualify, REALTIME_SCHEMA } from '../ddl.js';

/** Per-query parser: every value stays PostgreSQL's exact text output (numeric, JSON, arrays…). */
export const textTypes = { getTypeParser: () => (value: string) => value };

const NUMBER_TYPES = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid']);
const TIMESTAMP_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval']);

function kindOf(typeName: string, typeKind: string, category: string): ColumnKind {
	if (typeKind === 'e') return 'enum';
	if (category === 'A') return 'array';
	if (typeName === 'bool') return 'boolean';
	if (typeName === 'json' || typeName === 'jsonb') return 'json';
	if (typeName === 'uuid') return 'uuid';
	if (NUMBER_TYPES.has(typeName)) return 'number';
	if (TIMESTAMP_TYPES.has(typeName)) return 'timestamp';
	return 'text';
}

type TableRow = { id: string; schema: string; name: string; kind: string; rls: boolean; realtime: boolean; row_count: number };
type ColumnRow = {
	table_id: string;
	name: string;
	type_name: string;
	type_kind: string;
	type_category: string;
	element_name: string | null;
	element_kind: string | null;
	element_category: string | null;
	exact_type: string;
	not_null: boolean;
	generated: boolean;
	identity: string;
	default_value: string | null;
	comment: string | null;
	enum_values: string[] | null;
	is_primary_key: boolean;
};
type ForeignKeyRow = {
	table_id: string;
	column_name: string;
	target_schema: string;
	target_table: string;
	target_column: string;
	source_columns: string[];
	target_columns: string[];
};

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_toast')`;

export async function loadMetadata(
	db: pg.Pool | pg.PoolClient,
	filter?: { schema: string; table: string }
): Promise<Table[]> {
	const params = filter ? [filter.schema, filter.table] : [];
	const scope = filter ? 'and n.nspname = $1 and c.relname = $2' : '';
	const visible = `c.relkind in ('r', 'p', 'v', 'm')
		and n.nspname not in ${SYSTEM_SCHEMAS}
		and n.nspname !~ '^pg_(toast_)?temp_' ${scope}`;
	const tables = await db.query<TableRow>(
			`select c.oid::text as id, n.nspname as schema, c.relname as name, c.relkind as kind, c.relrowsecurity as rls,
			        exists (select from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'superbase_realtime') as realtime,
			        c.reltuples as row_count
			 from pg_class c
			 join pg_namespace n on n.oid = c.relnamespace
			 where ${visible}
			 order by n.nspname, c.relname`, params
		);
	const columns = await db.query<ColumnRow>(
			`select a.attrelid::text as table_id, a.attname as name,
			        t.typname as type_name, t.typtype as type_kind, t.typcategory as type_category,
			        et.typname as element_name, et.typtype as element_kind, et.typcategory as element_category,
			        format_type(a.atttypid, a.atttypmod) as exact_type,
			        a.attnotnull as not_null, a.attgenerated <> '' as generated,
			        a.attidentity as identity,
			        pg_get_expr(d.adbin, d.adrelid) as default_value,
			        col_description(a.attrelid, a.attnum) as comment,
			        (select json_agg(e.enumlabel order by e.enumsortorder)
			           from pg_enum e where e.enumtypid = t.oid) as enum_values,
			        exists (select 1 from pg_index i
			          where i.indrelid = a.attrelid and i.indisprimary
			            and a.attnum = any((i.indkey::smallint[])[0:i.indnkeyatts - 1])) as is_primary_key
			 from pg_attribute a
			 join pg_class c on c.oid = a.attrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 join pg_type t on t.oid = a.atttypid
			 left join pg_type et on et.oid = t.typelem and t.typcategory = 'A' and et.typdelim = ','
			 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			 where a.attnum > 0 and not a.attisdropped and ${visible}
			 order by a.attrelid, a.attnum`, params
		);
	const foreignKeys = await db.query<ForeignKeyRow>(
			`select con.conrelid::text as table_id, a.attname as column_name,
			        fn.nspname as target_schema, fc.relname as target_table,
			        fa.attname as target_column,
			        array_agg(a.attname::text) over fk as source_columns,
			        array_agg(fa.attname::text) over fk as target_columns
			 from pg_constraint con
			 join pg_class c on c.oid = con.conrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 cross join lateral unnest(con.conkey, con.confkey) with ordinality as k(src, tgt, pos)
			 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.src
			 join pg_class fc on fc.oid = con.confrelid
			 join pg_namespace fn on fn.oid = fc.relnamespace
			 join pg_attribute fa on fa.attrelid = con.confrelid and fa.attnum = k.tgt
			 where con.contype = 'f' and ${visible}
			 window fk as (partition by con.oid order by k.pos rows between unbounded preceding and unbounded following)
			 order by con.conname, con.oid, k.pos`, params
		);

	const fkByColumn = new Map<string, ForeignKeyRow>();
	// One FK per column: choose the first constraint by name/OID until multi-FK browsing is needed.
	for (const fk of foreignKeys.rows) {
		const key = JSON.stringify([fk.table_id, fk.column_name]);
		if (!fkByColumn.has(key)) fkByColumn.set(key, fk);
	}
	const columnsByTable = new Map<string, Column[]>();
	for (const row of columns.rows) {
		const fk = fkByColumn.get(JSON.stringify([row.table_id, row.name]));
		const column: Column = {
			name: row.name,
			type: row.exact_type,
			kind: kindOf(row.type_name, row.type_kind, row.type_category),
			// json[]/jsonb[] keep the literal: a nested JSON array could be a dimension or a document.
			element: row.element_name && row.element_name !== 'json' && row.element_name !== 'jsonb'
				? kindOf(row.element_name, row.element_kind!, row.element_category!) : undefined,
			nullable: !row.not_null,
			primaryKey: row.is_primary_key,
			generated: row.generated,
			identity: row.identity === 'a' ? 'always' : row.identity === 'd' ? 'by-default' : null,
			enumValues: row.enum_values ?? undefined,
			defaultValue: row.default_value,
			comment: row.comment,
			foreignKey: fk ? {
				schema: fk.target_schema, table: fk.target_table, column: fk.target_column,
				columns: fk.source_columns, referencedColumns: fk.target_columns
			} : undefined
		};
		const list = columnsByTable.get(row.table_id) ?? [];
		list.push(column);
		columnsByTable.set(row.table_id, list);
	}
	return tables.rows.map((table) => ({
		schema: table.schema,
		name: table.name,
		kind: table.kind === 'v' ? 'view' : table.kind === 'm' ? 'materialized view' : 'table',
		rls: table.rls,
		realtime: table.realtime,
		columns: columnsByTable.get(table.id) ?? [],
		// Views have no statistics; -1 hides the estimate.
		rowCount: table.kind === 'v' ? -1 : Math.round(Number(table.row_count))
	}));
}

function primaryKey(table: Table): string[] {
	return table.columns.filter((column) => column.primaryKey).map((column) => column.name);
}

/**
 * Tables plus what "view as role" needs: the connection role, whether it bypasses RLS, other roles.
 * `schemas`: every non-system schema the role can use (empty ones too), except superbase's own.
 */
export async function listTables(pool: pg.Pool): Promise<{ tables: Table[]; schemas: string[]; version: string; role: string; bypass: boolean; roles: string[] }> {
	const [tables, info] = await Promise.all([
		loadMetadata(pool),
		pool.query<{ schemas: string[]; version: string; role: string; bypass: boolean; roles: string[] }>(`
			select array(select nspname::text from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', '${REALTIME_SCHEMA}')
			             and has_schema_privilege(oid, 'USAGE')) as schemas,
			       current_setting('server_version') as version, current_user as role,
			       (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypass,
			       array(select rolname::text from pg_roles where rolname !~ '^pg_' order by rolname) as roles`)
	]);
	const { schemas, ...rest } = info.rows[0];
	return { tables, schemas: [...new Set([...schemas, ...tables.map((table) => table.schema)])].sort(), ...rest };
}

/** Act as `as.role` for the rest of the transaction, with its session settings (RLS testing). */
export async function actAs(client: pg.PoolClient, as: ViewAs | undefined): Promise<void> {
	if (!as) return;
	await client.query(`set local role ${ident(as.role)}`);
	for (const [name, value] of Object.entries(as.settings)) await client.query('select set_config($1, $2, true)', [name, value]);
}

/** Parameterized WHERE and deterministic ORDER BY shared by grid pages and CSV exports. */
export function rowSelection(table: Table, args: RowQuery) {
	const column = (name: string) => {
		if (!table.columns.some((column) => column.name === name)) throw new Error(`Unknown column: ${name}`);
		return `t.${ident(name)}`;
	};
	const search = table.columns.length ? args.search?.trim() ?? '' : '';
	const values: (string | number)[] = search ? [`%${search}%`] : [];
	const clauses = search ? [`(${table.columns.map((c) => `${column(c.name)}::text ilike $1`).join(' or ')})`] : [];
	for (const [name, value] of Object.entries(args.reference ?? {})) {
		if (value === null) clauses.push(`${column(name)} is null`);
		else clauses.push(`${column(name)} = $${values.push(value)}`);
	}
	for (const { column: name, operator, value } of args.filters ?? []) {
		if (!Object.hasOwn(FILTER_OPERATORS, operator)) throw new Error(`Unknown filter operator: ${operator}`);
		const { sql, needsValue } = FILTER_OPERATORS[operator];
		clauses.push(`${column(name)} ${sql}${needsValue ? ` $${values.push(value)}` : ''}`);
	}
	const order = args.sort.map(({ column: name, direction }) => `${column(name)} ${direction === 'desc' ? 'desc' : 'asc'} nulls last`);
	for (const name of primaryKey(table)) {
		if (!args.sort.some((rule) => rule.column === name)) order.push(`${column(name)} asc`);
	}
	// Inheritance can repeat primary keys across relations. Keyless tables use physical order only;
	// plain views have neither, so without a user sort their order is the view's own (may be empty).
	if (table.kind !== 'view') order.push('t.tableoid asc', 't.ctid asc');
	return { where: clauses.length ? `where ${clauses.join(' and ')}` : '', order: order.join(', '), values };
}

export async function listRows(pool: pg.Pool, args: RowsArgs): Promise<RowsPage> {
	// Metadata is read with every page (one table's: cheap), so reads always match the current columns.
	const [table] = await loadMetadata(pool, args);
	if (!table) throw new Error(`Table ${args.schema}.${args.table} not found; refresh the table list`);
	const pkColumns = primaryKey(table);
	const { where, order, values } = rowSelection(table, args);
	const selected = table.columns.map((column) => `t.${ident(column.name)}`);
	const physical = table.kind !== 'view';
	if (physical) selected.push('t.xmin', 't.tableoid', 't.ctid');
	const read = (db: pg.Pool | pg.PoolClient) => db.query<(string | null)[]>({
		text: `select ${selected.join(', ')} from ${qualify(args.schema, args.table)} t
			${where} ${order ? `order by ${order}` : ''} limit $${values.length + 1} offset $${values.length + 2}`,
		values: [...values, args.pageSize + 1, args.page * args.pageSize],
		rowMode: 'array',
		types: textTypes
	});
	let result;
	if (!args.as) result = await read(pool);
	else {
		const client = await pool.connect();
		try {
			await client.query('begin read only');
			await actAs(client, args.as);
			result = await read(client);
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
	}
	const rows: Row[] = result.rows.slice(0, args.pageSize).map((cells, i) => {
		const values: Values = Object.fromEntries(table.columns.map((column, i) => [column.name, cells[i]]));
		const [version, relation, ctid] = cells.slice(table.columns.length) as string[];
		const pk = Object.fromEntries(pkColumns.map((name) => [name, values[name] as string]));
		return {
			// Display key for this physical row version, not a durable logical identifier:
			// updates/rewrites can change ctid; xmin distinguishes reused tuple slots.
			// Mutations use identity only, never this key or ctid. View rows (read-only) use their position.
			key: physical ? JSON.stringify([relation, ctid, version]) : JSON.stringify(['row', args.page * args.pageSize + i]),
			values,
			identity: pkColumns.length ? { pk, version, relation } : null
		};
	});
	return { rows, hasMore: result.rows.length > args.pageSize };
}

function entriesForWrite(table: Table, values: Values): [string, string | null][] {
	const entries = Object.entries(values);
	for (const [name] of entries) {
		const column = table.columns.find((column) => column.name === name);
		if (!column) throw new Error(`Unknown column: ${name}`);
		if (!writable(column)) throw new Error(`Column is not writable: ${name}`);
	}
	return entries;
}

/** Match the loaded row version exactly: primary key, physical table (inheritance) and xmin. */
function identityWhere(identity: RowIdentity, pkColumns: string[], values: (string | null)[]): string {
	const clauses = pkColumns.map((name) => `${ident(name)} = $${values.push(identity.pk[name])}`);
	clauses.push(`tableoid = $${values.push(identity.relation)}::oid`, `xmin = $${values.push(identity.version)}::xid`);
	return clauses.join(' and ');
}

async function mutate<T>(
	pool: pg.Pool,
	args: { schema: string; table: string; as?: ViewAs },
	operation: (client: pg.PoolClient, table: Table, target: string, pk: string[]) => Promise<T>
): Promise<T> {
	const target = qualify(args.schema, args.table);
	const client = await pool.connect();
	try {
		await client.query('begin');
		// Hold off column/key DDL before reading metadata, without serializing ordinary writes.
		// Concurrent partition membership changes still have to pass the row identity check.
		await client.query(`lock table ${target} in row exclusive mode`);
		const [table] = await loadMetadata(client, args);
		if (!table) throw new Error(`Table ${args.schema}.${args.table} not found`);
		const pk = primaryKey(table);
		if (!pk.length) throw new Error('Tables without a primary key are read-only');
		await actAs(client, args.as);
		const result = await operation(client, table, target, pk);
		await client.query('commit');
		return result;
	} catch (error) {
		await client.query('rollback').catch(() => {}); // Report the write's error, not a failed rollback's.
		throw error;
	} finally {
		client.release();
	}
}

export async function saveTable(pool: pg.Pool, args: SaveArgs): Promise<{ updated: number; inserted: number }> {
	return mutate(pool, args, async (client, table, target, pk) => {
		let updated = 0;
		let inserted = 0;
		for (const update of args.updates) {
			const entries = entriesForWrite(table, update.changes);
			if (!entries.length) throw new Error('Update has no changes');
			const values = entries.map(([, value]) => value);
			const assignments = entries.map(([name], i) => `${ident(name)} = $${i + 1}`);
			const where = identityWhere(update.identity, pk, values);
			const result = await client.query(`update ${target} set ${assignments.join(', ')} where ${where}`, values);
			if (result.rowCount !== 1) throw new Error('Row conflict: row changed or was deleted. Your input was kept; cancel and refresh before editing again.');
			updated++;
		}
		for (const insert of args.inserts) {
			const entries = entriesForWrite(table, insert);
			const names = entries.map(([name]) => ident(name));
			const values = entries.map(([, value]) => value);
			const placeholders = values.map((_, i) => `$${i + 1}`);
			const result = await client.query(
				`insert into ${target} ${entries.length ? `(${names.join(', ')}) values (${placeholders.join(', ')})` : 'default values'}`,
				values
			);
			if (result.rowCount !== 1) throw new Error('Insert did not create exactly one row');
			inserted++;
		}
		return { updated, inserted };
	});
}

export async function deleteRows(pool: pg.Pool, args: DeleteArgs): Promise<{ deleted: number }> {
	return mutate(pool, args, async (client, _table, target, pk) => {
		let deleted = 0;
		for (const identity of args.identities) {
			const values: string[] = [];
			const where = identityWhere(identity, pk, values);
			const result = await client.query(`delete from ${target} where ${where}`, values);
			if (result.rowCount !== 1) throw new Error('Row conflict: row changed or was deleted. Nothing was deleted; refresh and reselect the rows.');
			deleted++;
		}
		return { deleted };
	});
}
