import pg from 'pg';

import type {
	Column, ColumnKind, DeleteArgs, Row, RowIdentity, RowsArgs, RowsPage,
	SaveArgs, ServerInfo, Table, Values
} from '../types.js';
import { tableKey, writable } from '../types.js';

function ident(name: string): string {
	if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
		throw new Error('Invalid identifier');
	}
	return `"${name.replaceAll('"', '""')}"`;
}

function qualify(schema: string, table: string): string {
	return `${ident(schema)}.${ident(table)}`;
}

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

type TableRow = { id: string; schema: string; name: string; row_count: number };
type ColumnRow = {
	table_id: string;
	name: string;
	type_name: string;
	type_kind: string;
	type_category: string;
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

async function loadMetadata(
	db: pg.Pool | pg.PoolClient,
	filter?: { schema: string; table: string }
): Promise<Table[]> {
	const params = filter ? [filter.schema, filter.table] : [];
	const scope = filter ? 'and n.nspname = $1 and c.relname = $2' : '';
	const visible = `c.relkind in ('r', 'p')
		and n.nspname not in ${SYSTEM_SCHEMAS}
		and n.nspname !~ '^pg_(toast_)?temp_' ${scope}`;
	const tables = await db.query<TableRow>(
			`select c.oid::text as id, n.nspname as schema, c.relname as name,
			        greatest(c.reltuples, 0) as row_count
			 from pg_class c
			 join pg_namespace n on n.oid = c.relnamespace
			 where ${visible}
			 order by n.nspname, c.relname`, params
		);
	const columns = await db.query<ColumnRow>(
			`select a.attrelid::text as table_id, a.attname as name,
			        t.typname as type_name, t.typtype as type_kind, t.typcategory as type_category,
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
		columns: columnsByTable.get(table.id) ?? [],
		rowCount: Math.max(0, Math.round(Number(table.row_count)))
	}));
}

// Refresh explicitly on listTables, or at most every 30 seconds on reads.
// Replacing the whole map also discards dropped tables instead of accumulating stale entries.
const metadata = new WeakMap<pg.Pool, { expires: number; tables: Promise<Map<string, Table>> }>();

async function cachedTables(pool: pg.Pool, refresh = false): Promise<Map<string, Table>> {
	let cached = metadata.get(pool);
	if (refresh || !cached || cached.expires <= Date.now()) {
		cached = {
			expires: Date.now() + 30_000,
			tables: loadMetadata(pool).then((tables) => new Map(tables.map((table) => [tableKey(table.schema, table.name), table])))
		};
		metadata.set(pool, cached);
	}
	try {
		return await cached.tables;
	} catch (error) {
		if (metadata.get(pool) === cached) metadata.delete(pool);
		throw error;
	}
}

function primaryKey(table: Table): string[] {
	return table.columns.filter((column) => column.primaryKey).map((column) => column.name);
}

export async function listTables(pool: pg.Pool): Promise<{ tables: Table[]; server: ServerInfo }> {
	const [tables, info] = await Promise.all([
		cachedTables(pool, true),
		pool.query<ServerInfo>(
			`select version() as version, current_database() as database,
			        current_user as "user", inet_server_addr()::text as host,
			        inet_server_port() as port`
		)
	]);
	const server = info.rows[0];
	return {
		tables: [...tables.values()],
		server: { ...server, version: /^PostgreSQL (\S+)/.exec(server.version)?.[1] ?? server.version }
	};
}

export async function listRows(pool: pg.Pool, args: RowsArgs): Promise<RowsPage> {
	const table = (await cachedTables(pool)).get(tableKey(args.schema, args.table));
	if (!table) throw new Error(`Table ${args.schema}.${args.table} not found; refresh metadata`);
	if (!Number.isSafeInteger(args.page) || args.page < 0 ||
		!Number.isSafeInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 500 ||
		!Number.isSafeInteger(args.page * args.pageSize)) throw new Error('Invalid pagination');
	if (args.sort && (!table.columns.some((column) => column.name === args.sort!.column) ||
		!['asc', 'desc'].includes(args.sort.direction))) throw new Error('Invalid sort');
	const pkColumns = primaryKey(table);
	const search = table.columns.length ? args.search.trim() : '';
	const values: (string | number)[] = search ? [`%${search}%`] : [];
	const clauses = search
		? [`(${table.columns.map((column) => `t.${ident(column.name)}::text ilike $1`).join(' or ')})`]
		: [];
	for (const [name, value] of Object.entries(args.filter ?? {})) {
		if (!table.columns.some((column) => column.name === name)) throw new Error(`Unknown column: ${name}`);
		if (value !== null && typeof value !== 'string') throw new Error(`Expected PostgreSQL text or null for ${name}`);
		if (value === null) clauses.push(`t.${ident(name)} is null`);
		else {
			values.push(value);
			clauses.push(`t.${ident(name)} = $${values.length}`);
		}
	}
	const filter = clauses.length ? `where ${clauses.join(' and ')}` : '';
	const order = args.sort ? [`t.${ident(args.sort.column)} ${args.sort.direction} nulls last`] : [];
	for (const column of pkColumns) {
		if (column !== args.sort?.column) order.push(`t.${ident(column)} asc`);
	}
	// Inheritance can repeat primary keys across relations. Keyless tables use physical order only.
	order.push('t.tableoid asc', 't.ctid asc');
	const selected = table.columns.map((column) => `t.${ident(column.name)}`);
	selected.push('t.xmin', 't.tableoid', 't.ctid');
	const result = await pool.query<(string | null)[]>({
		text: `select ${selected.join(', ')} from ${qualify(args.schema, args.table)} t
			${filter} order by ${order.join(', ')} limit $${values.length + 1} offset $${values.length + 2}`,
		values: [...values, args.pageSize + 1, args.page * args.pageSize],
		rowMode: 'array',
		// Per-query parsing preserves PostgreSQL's text output even for JSON, numeric and arrays.
		types: { getTypeParser: () => (value: string) => value }
	});
	const rows: Row[] = result.rows.slice(0, args.pageSize).map((cells) => {
		const values: Values = Object.fromEntries(table.columns.map((column, i) => [column.name, cells[i]]));
		const [version, relation, ctid] = cells.slice(table.columns.length) as string[];
		const pk = Object.fromEntries(pkColumns.map((name) => [name, values[name] as string]));
		return {
			// Display key for this physical row version, not a durable logical identifier:
			// updates/rewrites can change ctid; xmin distinguishes reused tuple slots.
			// Mutations use identity only, never this key or ctid.
			key: JSON.stringify([relation, ctid, version]),
			values,
			identity: pkColumns.length ? { pk, version, relation } : null
		};
	});
	return { rows, hasMore: result.rows.length > args.pageSize };
}

function entriesForWrite(table: Table, values: Values): [string, string | null][] {
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid row values');
	const columns = new Map(table.columns.map((column) => [column.name, column]));
	const entries = Object.entries(values);
	for (const [name, value] of entries) {
		const column = columns.get(name);
		if (!column) throw new Error(`Unknown column: ${name}`);
		if (!writable(column)) throw new Error(`Column is not writable: ${name}`);
		if (value !== null && typeof value !== 'string') throw new Error(`Expected PostgreSQL text or null for ${name}`);
	}
	return entries;
}

function identityWhere(identity: RowIdentity, pkColumns: string[], values: (string | null)[]): string {
	if (!identity || !identity.pk || typeof identity.pk !== 'object' || Array.isArray(identity.pk) ||
		Object.keys(identity.pk).length !== pkColumns.length ||
		pkColumns.some((name) => !Object.hasOwn(identity.pk, name) || typeof identity.pk[name] !== 'string') ||
		typeof identity.version !== 'string' || !/^\d+$/.test(identity.version) ||
		typeof identity.relation !== 'string' || !/^\d+$/.test(identity.relation)) {
		throw new Error('Invalid row identity; reload the table');
	}
	const clauses = pkColumns.map((name) => {
		values.push(identity.pk[name]);
		return `${ident(name)} = $${values.length}`;
	});
	values.push(identity.relation, identity.version);
	clauses.push(`tableoid = $${values.length - 1}::oid`, `xmin = $${values.length}::xid`);
	return clauses.join(' and ');
}

async function mutate<T>(
	pool: pg.Pool,
	args: { schema: string; table: string },
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
		const result = await operation(client, table, target, pk);
		await client.query('commit');
		return result;
	} catch (error) {
		await client.query('rollback');
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
			if (result.rowCount !== 1) throw new Error('Row conflict: row changed or was deleted. Pending changes were kept; revert them and refresh before editing again.');
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
