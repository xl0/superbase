import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import * as ddl from '../src/lib/ddl.js';
import { executeDdl, getSchemaDefinition, listSchemaCatalog } from '../src/lib/server/schema.js';
import { listTables } from '../src/lib/server/db.js';
import type { SchemaType } from '../src/lib/schema.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `sb_ddl_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
let pool: pg.Pool;
let types: SchemaType[];
const oid = (name: string) => types.find((type) => type.schema === 'pg_catalog' && type.name === name)!.oid;
const column = (name: string, type: string, rest: Partial<ddl.ColumnSpec> = {}): ddl.ColumnSpec =>
	({ name, typeOid: oid(type), typeModifiers: '', nullable: true, default: { kind: 'none' }, comment: '', primaryKey: false, ...rest });

(url ? describe : describe.skip)('generated DDL round-trips through PostgreSQL', () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: url, max: 2 });
		await pool.query(`create schema ${ddl.ident(schema)}`);
		types = (await listSchemaCatalog(pool)).types;
	});
	afterAll(async () => {
		await pool.query(`drop schema ${ddl.ident(schema)} cascade`);
		await pool.end();
	});

	test('create, alter, constrain, index and duplicate a table', async () => {
		const table = ddl.qualify(schema, 'odd "table"');
		await executeDdl(pool, ddl.createTable(schema, 'odd "table"', [
			column('id', 'int8', { default: { kind: 'identity' }, primaryKey: true, nullable: false }),
			column('label', 'varchar', { typeModifiers: '20', default: { kind: 'literal', value: `it's \\ "quoted"` }, comment: 'A label' }),
			column('created', 'timestamptz', { default: { kind: 'expression', sql: 'now()' }, nullable: false }),
			{ ...column('tags', 'text'), typeOid: types.find((type) => type.oid === oid('text'))!.arrayOid }
		], types));
		await pool.query(`insert into ${table} (label) values (default), ('b')`);
		let definition = await getSchemaDefinition(pool, { connection: 'test', schema, table: 'odd "table"' });
		expect(definition.primaryKey).toEqual(['id']);
		expect(definition.columns.map((column) => column.type)).toEqual(['bigint', 'character varying(20)', 'timestamp with time zone', 'text[]']);
		expect((await pool.query(`select label from ${table} order by id`)).rows[0].label).toBe(`it's \\ "quoted"`);

		const label = { ...definition.columns[1], primaryKey: false };
		await executeDdl(pool, ddl.alterColumn(table, label, {
			name: 'title', typeOid: oid('text'), typeModifiers: '', nullable: false, default: { kind: 'none' }, comment: '', primaryKey: false
		}, types));
		await executeDdl(pool, [
			`alter table ${table} add constraint title_key ${ddl.constraintSql({ kind: 'unique', name: 'title_key', columns: ['title'] })};`,
			`alter table ${table} add constraint short ${ddl.constraintSql({ kind: 'check', name: 'short', expression: 'length(title) < 100' })};`,
			`create table ${ddl.qualify(schema, 'child')} (parent bigint);`,
			`alter table ${ddl.qualify(schema, 'child')} add constraint parent_fkey ${ddl.constraintSql({ kind: 'foreignKey', name: 'parent_fkey', columns: ['parent'],
				reference: { schema, table: 'odd "table"', columns: ['id'] }, onUpdate: 'no action', onDelete: 'cascade' })};`
		].join('\n'));
		definition = await getSchemaDefinition(pool, { connection: 'test', schema, table: 'odd "table"' });
		const title = definition.columns.find((column) => column.name === 'title')!;
		expect([title.type, title.nullable, title.defaultValue, title.comment]).toEqual(['text', false, null, null]);
		expect(definition.constraints.map((constraint) => [constraint.name, constraint.kind])).toEqual([['short', 'c'], ['title_key', 'u']]);
		const child = await getSchemaDefinition(pool, { connection: 'test', schema, table: 'child' });
		expect(child.constraints[0].foreignKey).toMatchObject({ table: 'odd "table"', columns: ['id'], onDelete: 'cascade' });

		// Failed scripts roll back entirely.
		await expect(executeDdl(pool, `alter table ${table} add column extra int; alter table ${table} add column extra int;`)).rejects.toThrow();
		expect((await getSchemaDefinition(pool, { connection: 'test', schema, table: 'odd "table"' })).columns.some((column) => column.name === 'extra')).toBe(false);

		const source = (await listTables(pool)).tables.find((table) => table.schema === schema && table.name === 'odd "table"')!;
		await executeDdl(pool, ddl.duplicateTable(source, 'copy', true));
		const copy = ddl.qualify(schema, 'copy');
		await pool.query(`insert into ${copy} (title) values ('c')`);
		expect((await pool.query(`select id::text, title from ${copy} order by id`)).rows.map((row) => row.id)).toEqual(['1', '2', '3']);
	});
});
