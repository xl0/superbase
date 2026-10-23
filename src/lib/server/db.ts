import pg from 'pg';

import { DATABASE_URL } from '$app/env/private';
import type { Column, ColumnKind, Row, ServerInfo, Sort, Table } from '#lib/types.js';

const { Pool, types } = pg;

// Keep the values the grid expects: int8 as a number when safe, timestamps and
// dates as strings, everything else as node-postgres parses it.
types.setTypeParser(20, (value) => {
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : value;
});
types.setTypeParser(1082, (value) => value); // date
types.setTypeParser(1114, (value) => value); // timestamp
types.setTypeParser(1184, (value) => value); // timestamptz
types.setTypeParser(1186, (value) => value); // interval

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
	if (pool) return pool;
	const connectionString = DATABASE_URL;
	if (!connectionString) {
		throw new Error('DATABASE_URL is not set. Add it to .env and restart the server.');
	}
	pool = new Pool({
		connectionString,
		max: 5,
		application_name: 'superbase',
		statement_timeout: 30_000
	});
	pool.on('error', (error) => console.error('[pg] idle client error', error));
	return pool;
}

async function select<T extends pg.QueryResultRow>(
	text: string,
	values: unknown[] = []
): Promise<T[]> {
	const result = await getPool().query<T>(text, values);
	return result.rows;
}

function ident(name: string): string {
	if (typeof name !== 'string' || name.length === 0) throw new Error('Invalid identifier');
	return `"${name.replaceAll('"', '""')}"`;
}

function qualify(schema: string, table: string): string {
	return `${ident(schema)}.${ident(table)}`;
}

const NUMBER_TYPES = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid']);
const TIMESTAMP_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval']);

function kindOf(typeName: string, typeKind: string): ColumnKind {
	if (typeKind === 'e') return 'enum';
	if (typeName.startsWith('_')) return 'array';
	if (typeName === 'bool') return 'boolean';
	if (typeName === 'json' || typeName === 'jsonb') return 'json';
	if (typeName === 'uuid') return 'uuid';
	if (NUMBER_TYPES.has(typeName)) return 'number';
	if (TIMESTAMP_TYPES.has(typeName)) return 'timestamp';
	return 'text';
}

function displayType(typeName: string): string {
	return typeName.startsWith('_') ? `${typeName.slice(1)}[]` : typeName;
}

type TableRow = { id: number; schema: string; name: string; row_count: number | string };
type ColumnRow = {
	table_id: number;
	name: string;
	type_name: string;
	type_kind: string;
	not_null: boolean;
	default_value: string | null;
	comment: string | null;
	enum_values: string[] | null;
	is_primary_key: boolean;
};
type ForeignKeyRow = {
	table_id: number;
	column_name: string;
	target_schema: string;
	target_table: string;
	target_column: string;
};

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_toast')`;

async function loadMetadata(filter?: { schema: string; table: string }): Promise<Table[]> {
	const params = filter ? [filter.schema, filter.table] : [];
	const scope = filter ? 'and n.nspname = $1 and c.relname = $2' : '';

	const [tables, columns, foreignKeys] = await Promise.all([
		select<TableRow>(
			`select c.oid::int8 as id, n.nspname as schema, c.relname as name,
			        greatest(coalesce(pg_stat_get_live_tuples(c.oid), 0)::int8, 0) as row_count
			 from pg_class c
			 join pg_namespace n on n.oid = c.relnamespace
			 where c.relkind in ('r', 'p')
			   and n.nspname not in ${SYSTEM_SCHEMAS}
			   and n.nspname not like 'pg_temp_%'
			   and n.nspname not like 'pg_toast_temp_%'
			   ${scope}
			 order by n.nspname, c.relname`,
			params
		),
		select<ColumnRow>(
			`select a.attrelid::int8 as table_id,
			        a.attname as name,
			        t.typname as type_name,
			        t.typtype as type_kind,
			        a.attnotnull as not_null,
			        pg_get_expr(d.adbin, d.adrelid) as default_value,
			        col_description(a.attrelid, a.attnum) as comment,
			        (select json_agg(e.enumlabel order by e.enumsortorder)
			           from pg_enum e where e.enumtypid = t.oid) as enum_values,
			        exists (
			          select 1 from pg_index i
			          where i.indrelid = a.attrelid
			            and i.indisprimary
			            and a.attnum = any(i.indkey)
			        ) as is_primary_key
			 from pg_attribute a
			 join pg_class c on c.oid = a.attrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 join pg_type t on t.oid = a.atttypid
			 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			 where a.attnum > 0
			   and not a.attisdropped
			   and c.relkind in ('r', 'p')
			   and n.nspname not in ${SYSTEM_SCHEMAS}
			   ${scope}
			 order by a.attrelid, a.attnum`,
			params
		),
		select<ForeignKeyRow>(
			`select con.conrelid::int8 as table_id,
			        a.attname as column_name,
			        fn.nspname as target_schema,
			        fc.relname as target_table,
			        fa.attname as target_column
			 from pg_constraint con
			 join pg_class c on c.oid = con.conrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 cross join lateral unnest(con.conkey, con.confkey) with ordinality as k(src, tgt, ord)
			 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.src
			 join pg_class fc on fc.oid = con.confrelid
			 join pg_namespace fn on fn.oid = fc.relnamespace
			 join pg_attribute fa on fa.attrelid = con.confrelid and fa.attnum = k.tgt
			 where con.contype = 'f'
			   and n.nspname not in ${SYSTEM_SCHEMAS}
			   ${scope}`,
			params
		)
	]);

	const fkByColumn = new Map<string, ForeignKeyRow>();
	for (const foreignKey of foreignKeys) {
		fkByColumn.set(`${foreignKey.table_id}.${foreignKey.column_name}`, foreignKey);
	}

	const columnsByTable = new Map<number, Column[]>();
	for (const row of columns) {
		const foreignKey = fkByColumn.get(`${row.table_id}.${row.name}`);
		const column: Column = {
			name: row.name,
			type: displayType(row.type_name),
			kind: kindOf(row.type_name, row.type_kind),
			nullable: !row.not_null,
			primaryKey: row.is_primary_key,
			enumValues: row.enum_values ?? undefined,
			defaultValue: row.default_value,
			comment: row.comment,
			foreignKey: foreignKey
				? {
						schema: foreignKey.target_schema,
						table: foreignKey.target_table,
						column: foreignKey.target_column
					}
				: undefined
		};
		const list = columnsByTable.get(row.table_id) ?? [];
		list.push(column);
		columnsByTable.set(row.table_id, list);
	}

	return tables.map((table) => ({
		schema: table.schema,
		name: table.name,
		columns: columnsByTable.get(table.id) ?? [],
		rowCount: Number(table.row_count) || 0
	}));
}

export type RowsArgs = {
	schema: string;
	table: string;
	page: number;
	pageSize: number;
	sort: Sort | null;
	search: string;
};

export type SaveArgs = {
	schema: string;
	table: string;
	updates: { pk: Record<string, unknown>; changes: Record<string, unknown> }[];
	inserts: Record<string, unknown>[];
};

export type DeleteArgs = {
	schema: string;
	table: string;
	pks: Record<string, unknown>[];
};

export type RowsPage = { rows: Row[]; total: number };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function getTable(schema: string, table: string): Promise<Table> {
	const [found] = await loadMetadata({ schema, table });
	if (!found) throw new Error(`Table ${schema}.${table} not found`);
	return found;
}

function primaryKey(columns: Column[]): string[] {
	return columns.filter((column) => column.primaryKey).map((column) => column.name);
}

function rowKey(row: Record<string, unknown>, pkColumns: string[]): { key: string; pk: Record<string, unknown> } {
	if (pkColumns.length > 0) {
		const pk = Object.fromEntries(pkColumns.map((column) => [column, row[column]]));
		return { key: JSON.stringify(pk), pk };
	}
	const ctid = row.__ctid;
	delete row.__ctid;
	if (typeof ctid !== 'string') throw new Error('Row has neither a primary key nor a ctid');
	return { key: `ctid:${ctid}`, pk: { __ctid: ctid } };
}

export async function listTables(): Promise<{ tables: Table[]; server: ServerInfo }> {
	const tables = await loadMetadata();
	const [info] = await select<{
		version: string;
		database: string;
		user: string;
		host: string | null;
		port: number | null;
	}>(
		`select version() as version,
		        current_database() as database,
		        current_user as "user",
		        inet_server_addr()::text as host,
		        inet_server_port() as port`
	);

	const vm = /^PostgreSQL (\S+)/.exec(info?.version ?? '');
	return {
		tables,
		server: {
			version: vm?.[1] ?? 'unknown',
			database: info?.database ?? '',
			user: info?.user ?? '',
			host: info?.host ?? null,
			port: info?.port ?? null
		}
	};
}

export async function listRows(args: RowsArgs): Promise<RowsPage> {
	const table = await getTable(args.schema, args.table);
	const columns = table.columns;
	if (columns.length === 0) throw new Error('Table has no columns');

	const pageSize = Math.min(Math.max(Math.trunc(args.pageSize) || 100, 1), 1000);
	const page = Math.max(0, Math.trunc(args.page) || 0);
	const offset = page * pageSize;

	const search = args.search.trim();
	const searchValues = search ? [`%${search}%`] : [];
	const filter = search
		? `where (${columns.map((column) => `t.${ident(column.name)}::text ilike $1`).join(' or ')})`
		: '';

	const pkColumns = primaryKey(columns);
	const tiebreak = pkColumns.length
		? pkColumns.map((column) => `t.${ident(column)}`).join(', ')
		: 't.ctid';
	const sortColumn =
		args.sort && columns.some((column) => column.name === args.sort!.column)
			? args.sort.column
			: null;
	const sort = sortColumn
		? `order by t.${ident(sortColumn)} ${args.sort!.direction === 'desc' ? 'desc' : 'asc'} nulls last` +
			(pkColumns.includes(sortColumn) ? '' : `, ${tiebreak} asc`)
		: `order by ${tiebreak} asc`;

	const [count, rows] = await Promise.all([
		select<{ count: number }>(
			`select count(*)::int8 as count from ${qualify(args.schema, args.table)} t ${filter}`,
			searchValues
		),
		select<Record<string, unknown>>(
			`select t.*, t.ctid::text as __ctid
			 from ${qualify(args.schema, args.table)} t
			 ${filter}
			 ${sort}
			 limit $${searchValues.length + 1} offset $${searchValues.length + 2}`,
			[...searchValues, pageSize, offset]
		)
	]);

	const keyed = rows.map((row) => {
		const { key, pk } = rowKey(row, pkColumns);
		return { ...row, __key: key, __pk: pk } as Row;
	});

	return { rows: keyed, total: Number(count[0]?.count ?? 0) };
}

function whereFromPk(
	pk: Record<string, unknown>,
	pkColumns: string[],
	values: unknown[]
): string {
	if (typeof pk.__ctid === 'string') {
		values.push(pk.__ctid);
		return `ctid = $${values.length}::tid`;
	}
	if (pkColumns.length === 0) throw new Error('Cannot identify a row without a primary key');
	return pkColumns
		.map((column) => {
			if (!(column in pk)) throw new Error(`Missing primary key value for ${column}`);
			values.push(pk[column]);
			return `${ident(column)} = $${values.length}`;
		})
		.join(' and ');
}

export async function saveTable(args: SaveArgs): Promise<{ updated: number; inserted: number }> {
	const table = await getTable(args.schema, args.table);
	const pkColumns = primaryKey(table.columns);
	const columnNames = new Set(table.columns.map((column) => column.name));
	const target = qualify(args.schema, args.table);

	const client = await getPool().connect();
	let updated = 0;
	let inserted = 0;
	try {
		await client.query('begin');

		for (const update of args.updates) {
			const entries = Object.entries(update.changes).filter(([name]) => columnNames.has(name));
			if (entries.length === 0) continue;
			const values: unknown[] = [];
			const assignments = entries.map(([name, value]) => {
				values.push(value);
				return `${ident(name)} = $${values.length}`;
			});
			const where = whereFromPk(update.pk, pkColumns, values);
			await client.query(`update ${target} set ${assignments.join(', ')} where ${where}`, values);
			updated += 1;
		}

		for (const insert of args.inserts) {
			const entries = Object.entries(insert).filter(
				([name]) => columnNames.has(name) && !name.startsWith('__')
			);
			if (entries.length === 0) {
				await client.query(`insert into ${target} default values`);
			} else {
				const values = entries.map(([, value]) => value);
				const names = entries.map(([name]) => ident(name)).join(', ');
				const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
				await client.query(`insert into ${target} (${names}) values (${placeholders})`, values);
			}
			inserted += 1;
		}

		await client.query('commit');
	} catch (error) {
		await client.query('rollback').catch(() => {});
		throw new Error(errorMessage(error));
	} finally {
		client.release();
	}

	return { updated, inserted };
}

export async function deleteRows(args: DeleteArgs): Promise<{ deleted: number }> {
	const table = await getTable(args.schema, args.table);
	const pkColumns = primaryKey(table.columns);
	const target = qualify(args.schema, args.table);

	const client = await getPool().connect();
	let deleted = 0;
	try {
		await client.query('begin');
		for (const pk of args.pks) {
			const values: unknown[] = [];
			const where = whereFromPk(pk, pkColumns, values);
			await client.query(`delete from ${target} where ${where}`, values);
			deleted += 1;
		}
		await client.query('commit');
	} catch (error) {
		await client.query('rollback').catch(() => {});
		throw new Error(errorMessage(error));
	} finally {
		client.release();
	}

	return { deleted };
}

/** Runs one or more statements and returns the last result set with rows. */
export async function runSql(sql: string): Promise<Record<string, unknown>[]> {
	const result = await getPool().query(sql);
	if (Array.isArray(result)) {
		const last = [...result].reverse().find((entry) => entry.rows.length > 0);
		return last?.rows ?? [];
	}
	return result.rows;
}

export type { Column, Row, ServerInfo, Sort, Table };
