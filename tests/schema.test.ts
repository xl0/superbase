import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import * as ddl from '../src/lib/ddl.js';
import { executeDdl, getSchemaDefinition, listSchemaCatalog } from '../src/lib/queries/schema.js';
import { listTables } from '../src/lib/queries/db.js';
import { listPolicies, listRoles } from '../src/lib/queries/database.js';
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

	test('policies round-trip: commands drop clauses they cannot have, roles and RLS state read back', async () => {
		const table = ddl.qualify(schema, 'secured');
		await executeDdl(pool, `create table ${table} (id int primary key, owner text); alter table ${table} enable row level security;`);
		const role = (await pool.query('select current_user as role')).rows[0].role as string;
		await executeDdl(pool, [
			ddl.createPolicy(table, { name: 'read "own"', command: 'select', permissive: true, roles: [role], using: `owner = current_user`, check: 'ignored' }),
			ddl.createPolicy(table, { name: 'add', command: 'insert', permissive: false, roles: [], using: 'ignored', check: 'owner is not null' })
		].join('\n'));
		const secured = (await listPolicies(pool)).tables.find((entry) => entry.schema === schema && entry.table === 'secured')!;
		expect(secured).toMatchObject({ enabled: true, forced: false, owner: role });
		expect(secured.policies).toEqual([
			{ name: 'add', command: 'insert', permissive: false, roles: ['public'], using: null, check: '(owner IS NOT NULL)' },
			{ name: 'read "own"', command: 'select', permissive: true, roles: [role], using: '(owner = CURRENT_USER)', check: null }
		]);
	});

	test('roles and table privileges round-trip through their builders', async () => {
		const name = `sb_role_${process.pid}`;
		const table = ddl.qualify(schema, 'granted');
		await executeDdl(pool, `create table ${table} (id int primary key);`);
		await executeDdl(pool, ddl.createRole({ name, login: false, password: '', bypass: true, createdb: false, memberOf: [] }));
		try {
			expect((await listRoles(pool)).find((role) => role.name === name)).toMatchObject({ login: false, bypass: true, memberOf: [] });
			await executeDdl(pool, ddl.grantChanges(table, {}, { [name]: ['SELECT', 'UPDATE'], public: ['SELECT'] }));
			const grants = async () => (await listPolicies(pool)).tables.find((entry) => entry.schema === schema && entry.table === 'granted')!.grants
				.map((grant) => `${grant.role}:${grant.privilege}`).sort();
			expect(await grants()).toEqual(['public:SELECT', `${name}:SELECT`, `${name}:UPDATE`]);
			await executeDdl(pool, ddl.grantChanges(table, { [name]: ['SELECT', 'UPDATE'], public: ['SELECT'] }, { [name]: ['SELECT', 'DELETE'] }));
			expect(await grants()).toEqual([`${name}:DELETE`, `${name}:SELECT`]);
			const old = { name, login: false, bypass: true, createdb: false, memberOf: [] };
			expect(ddl.alterRole(old, { ...old, password: '' })).toBe('');
			await executeDdl(pool, ddl.alterRole(old, { ...old, name: `${name}_x`, bypass: false, password: '' }));
			expect((await listRoles(pool)).find((role) => role.name === `${name}_x`)).toMatchObject({ bypass: false });
		} finally {
			await pool.query(`drop table ${table}; drop role if exists ${name}; drop role if exists ${name}_x`);
		}
	});
});
