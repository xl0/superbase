import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

import { schemaChangeSchema, schemaTargetSchema } from '../src/lib/schema-validation.js';
import type { ColumnDefault, ColumnSpec, SchemaCatalog, SchemaColumn, SchemaOperation, SchemaType } from '../src/lib/schema.js';
import { columnOptionsError, defaultOptions, elementType, typeOptionsError } from '../src/lib/schema-options.js';
import { changeSchema, exportSchema, getSchemaDefinition, listSchemaCatalog } from '../src/lib/server/schema.js';
import { ident, listRows, listTables, qualify } from '../src/lib/server/db.js';

const namespace = `sb_ddl_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
const target = (table: string) => ({ connection: 'test', schema: namespace, table });
const column = (name: string, typeOid: string | null, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
	name, typeOid, typeModifiers: [], nullable: true, default: { kind: typeOid === null ? 'keep' : 'none' },
	comment: '', primaryKey: false, ...extra
});
const valid = (operation: SchemaOperation, expected: string | null = null) => ({ ...target('table'), expected, operation });
const validate = (input: unknown) => schemaChangeSchema['~standard'].validate(input);

describe('structured schema validation', () => {
	test('strict own keys, bounded UTF-8 names, safe namespace and structured defaults', () => {
		const create = valid({ kind: 'createTable', columns: [column('__proto__', '25')] });
		expect(validate(create)).toHaveProperty('value');
		for (const invalid of [
			{ ...create, extra: true }, { ...create, expected: 'a'.repeat(64) },
			{ ...create, schema: 'pg_temp' }, { ...create, schema: 'information_schema' },
			{ ...create, table: 'é'.repeat(32) }, { ...create, table: 'a\0b' },
			{ ...create, table: '\ud800' },
			{ ...create, operation: { kind: 'dropTable', sql: 'select 1' } },
			{ ...create, operation: Object.assign(Object.create({ kind: 'dropTable' }), {}) },
			{ ...create, operation: { kind: 'createTable', columns: [column('x', null)] } },
			{ ...create, operation: { kind: 'createTable', columns: [column('x', '25', { default: { kind: 'keep' } })] } },
			{ ...create, operation: { kind: 'createTable', columns: [column('x', '25'), column('x', '25')] } },
			{ ...create, operation: { kind: 'createTable', columns: Array.from({ length: 101 }, (_, i) => column(`${i}`, '25')) } },
			{ ...create, operation: { kind: 'createTable', columns: [column('x', '25', { default: { kind: 'literal', value: 'x'.repeat(10001) } })] } },
			valid({ kind: 'dropTable' }),
			valid({ kind: 'addPrimaryKey', columns: ['x', 'x'] }, 'a'.repeat(64)),
			valid({ kind: 'alterColumn', column: 'x', changes: column('x', null, { nullable: false, default: { kind: 'identity' } }) }, 'a'.repeat(64))
		]) expect(validate(invalid)).toHaveProperty('issues');
		expect(schemaTargetSchema['~standard'].validate({ ...target('x'), extra: true })).toHaveProperty('issues');
		expect(validate({ ...create, [Symbol('extra')]: 1 })).toHaveProperty('issues');
	});

	test('modifier payloads require safe numbers, exact keys and an explicit type', () => {
		const spec = column('x', '1700');
		for (const typeModifiers of [undefined, null, '4', ['4'], [NaN], [Infinity], [1.5], [Number.MAX_SAFE_INTEGER + 1], [1, 2, 3], Array(1)]) {
			expect(validate(valid({ kind: 'createTable', columns: [{ ...spec, typeModifiers } as ColumnSpec] }))).toHaveProperty('issues');
		}
		const { typeModifiers: _, ...missing } = spec;
		expect(validate(valid({ kind: 'createTable', columns: [missing as ColumnSpec] }))).toHaveProperty('issues');
		expect(validate(valid({ kind: 'alterColumn', column: 'x', changes: column('x', null, { typeModifiers: [4] }) }, 'a'.repeat(64)))).toHaveProperty('issues');
		expect(validate(valid({ kind: 'createTable', columns: [column('x', '1700', { typeModifiers: [5, -2] })] }))).toHaveProperty('value');
	});

	test('index intents require bounded unique columns, fixed methods and captured identities', () => {
		const create = { kind: 'createIndex', name: 'idx', method: 'btree', unique: false, columns: ['__proto__', 'id'] } as const;
		const args = { ...target('t'), expected: 'a'.repeat(64), operation: create };
		expect(validate(args)).toHaveProperty('value');
		for (const operation of [
			{ ...create, method: 'btree); drop table x; --' }, { ...create, unique: 'false' },
			{ ...create, name: 'é'.repeat(32) }, { ...create, columns: [] },
			{ ...create, columns: ['id', 'id'] }, { ...create, columns: Array.from({ length: 33 }, (_, i) => `c${i}`) },
			{ ...create, columns: ['id'], where: 'true' }, { ...create, concurrently: true },
			{ kind: 'dropIndex', indexOid: '0' }, { kind: 'dropIndex', indexOid: '1;select 1' },
			{ kind: 'dropIndex', indexOid: '123', cascade: true }
		]) expect(validate({ ...args, operation })).toHaveProperty('issues');
		expect(validate({ ...args, expected: null })).toHaveProperty('issues');
		expect(validate({ ...args, operation: { kind: 'dropIndex', indexOid: '123' } })).toHaveProperty('value');
	});

	test('duplication requires an exact boolean, bounded destination and source fingerprint', () => {
		const op = { kind: 'duplicateTable', name: 'copy', includeRows: false } as const;
		expect(validate(valid(op, 'a'.repeat(64)))).toHaveProperty('value');
		for (const operation of [
			{ ...op, includeRows: 'false' }, { ...op, name: 'é'.repeat(32) },
			{ ...op, name: '' }, { kind: op.kind, name: op.name }, { ...op, sql: 'select 1' }
		]) expect(validate({ ...valid(op, 'a'.repeat(64)), operation })).toHaveProperty('issues');
		expect(validate(valid(op))).toHaveProperty('issues');
	});
});

describe('shared contextual schema options', () => {
	const types: SchemaType[] = ['numeric', 'varchar', 'bpchar', 'bit', 'varbit', 'time', 'timetz', 'timestamp', 'timestamptz', 'date', 'uuid', 'text', 'int2', 'int4', 'int8', 'jsonb'].map((name, i) => ({
		oid: String(i + 1), schema: 'pg_catalog', name, label: name, kind: 'base', elementOid: null, arrayOid: null, enumValues: []
	}));
	const numeric = types[0];
	const array: SchemaType = { ...numeric, oid: '100', name: '_numeric', kind: 'array', elementOid: numeric.oid };
	const domain: SchemaType = { ...numeric, oid: '101', schema: 'custom', name: 'numbers', kind: 'domain' };
	types.push(array, domain);
	const type = (name: string) => types.find((item) => item.name === name)!;

	test('scalar/array modifier bounds reject coercion and domains remain opaque', () => {
		for (const [name, accepted, rejected] of [
			['numeric', [[1], [1000, -1000], [1, 1000]], [[0], [1001], [5, -1001], [5, 1001]]],
			['varchar', [[1], [10485760]], [[0], [10485761], [1, 2]]],
			['bpchar', [[2]], [[-1]]],
			['bit', [[1], [83886080]], [[0], [83886081]]],
			['varbit', [[2]], [[2, 3]]],
			['time', [[0], [6]], [[-1], [7], [1, 2]]],
			['timetz', [[3]], [[7]]],
			['timestamp', [[6]], [[7]]],
			['timestamptz', [[0]], [[7]]]
		] as [string, number[][], number[][]][]) {
			for (const modifiers of accepted) expect(typeOptionsError(type(name), modifiers, types)).toBeNull();
			for (const modifiers of rejected) expect(typeOptionsError(type(name), modifiers, types)).not.toBeNull();
		}
		expect(typeOptionsError(array, [5, -2], types)).toBeNull();
		expect(elementType(array, types)).toBe(numeric);
		expect(elementType(domain, types)).toBe(domain);
		for (const item of [domain, type('jsonb'), undefined]) {
			expect(typeOptionsError(item, [], types)).toBeNull();
			expect(typeOptionsError(item, [2], types)).not.toBeNull();
		}
		for (const modifiers of [[NaN], [Infinity], [1.5], [1, 2, 3], Array(1)]) {
			expect(typeOptionsError(numeric, modifiers, types)).not.toBeNull();
		}
	});

	test('default presets use scalar builtin types, new-column identity and unknown-type preservation', () => {
		for (const [name, preset] of [
			['time', 'currentTime'], ['timetz', 'currentTime'], ['date', 'today'],
			['timestamp', 'now'], ['timestamptz', 'now'], ['uuid', 'uuid'],
			['text', 'uuid'], ['varchar', 'uuid'], ['bpchar', 'uuid'],
			['int2', 'identity'], ['int4', 'identity'], ['int8', 'identity']
		]) {
			expect(defaultOptions(type(name), true).map((option) => option.kind)).toEqual(['none', 'literal', preset]);
		}
		expect(defaultOptions(type('text'), true).at(-1)?.label).toBe('Generate UUID as text');
		for (const item of [array, domain, undefined, { ...type('date'), kind: 'enum' as const }, { ...type('date'), schema: 'custom' }]) {
			expect(defaultOptions(item, false).map((option) => option.kind)).toEqual(['keep', 'none', 'literal']);
		}
		const old: SchemaColumn = {
			name: 'x', type: 'unknown', typeOid: '999', typeModifiers: null, nullable: true,
			defaultValue: 'custom()', generated: false, identity: null, comment: null, primaryKey: false
		};
		for (const kind of ['keep', 'none', 'literal'] as const) {
			expect(columnOptionsError(column('x', null, { default: kind === 'literal' ? { kind, value: '' } : { kind } }), types, old)).toBeNull();
		}
		expect(columnOptionsError(column('x', null, { default: { kind: 'now' } }), types, old)).not.toBeNull();
		expect(columnOptionsError(column('x', null, { typeModifiers: [4] }), types, old)).not.toBeNull();
		expect(columnOptionsError(column('x', '999'), types, old)).toContain('approved');
		expect(columnOptionsError(column('x', type('int4').oid, { default: { kind: 'identity' } }), types)).toContain('nonnullable');
		expect(columnOptionsError(column('x', type('int4').oid, { nullable: false, default: { kind: 'identity' } }), types)).toBeNull();
		expect(columnOptionsError(column('x', type('int4').oid, { nullable: false, default: { kind: 'identity' } }), types, old)).not.toBeNull();
	});
});

// Never use DATABASE_URL, user seed schemas, or browser fixtures.
const url = process.env.TEST_DATABASE_URL;
let pool: pg.Pool;
let created = false;
let catalog: SchemaCatalog;
const tableSql = (table: string) => qualify(namespace, table);
const typeOid = (name: string, schema = 'pg_catalog') => {
	const type = catalog.types.find((type) => type.schema === schema && type.name === name);
	if (!type) throw new Error(`Missing catalog type ${schema}.${name}`);
	return type.oid;
};
// Interleave real DDL from another connection at a deterministic query boundary.
function interleaved(run: (sql: string) => Promise<void>): pg.Pool {
	return { connect: async () => {
		const client = await pool.connect();
		return {
			release: () => client.release(),
			query: async (sql: string, values?: unknown[]) => {
				// A role's default isolation must not freeze the optimistic catalog checks.
				if (sql.startsWith('begin')) await client.query("set default_transaction_isolation = 'repeatable read'");
				const result = await client.query(sql, values);
				if (sql === 'commit' || sql === 'rollback') await client.query('reset default_transaction_isolation');
				await run(sql);
				return result;
			}
		};
	} } as unknown as pg.Pool;
}
const definition = (table: string) => getSchemaDefinition(pool, target(table));
const change = async (table: string, operation: SchemaOperation) => changeSchema(pool, {
	...target(table), operation,
	expected: operation.kind === 'createTable' ? null : (await definition(table)).version
});

(url ? describe : describe.skip)('transactional PostgreSQL schema editing', () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: url, max: 4 });
		await pool.query(`create schema ${ident(namespace)}`);
		created = true;
		catalog = await listSchemaCatalog(pool);
	});

	afterAll(async () => {
		if (!pool) return;
		try {
			if (created) await pool.query(`drop schema ${ident(namespace)} cascade`);
		} finally {
			await pool.end();
		}
	});

	test('includes empty namespaces, builtins and enum/domain arrays, rejects arbitrary type OIDs', async () => {
		expect(catalog.schemas).toContain(namespace);
		expect(catalog.schemas).not.toContain('pg_catalog');
		await pool.query(`create type ${tableSql('mood')} as enum ('one', 'two'); create domain ${tableSql('positive')} as int check (value > 0)`);
		catalog = await listSchemaCatalog(pool);
		for (const name of ['mood', '_mood', 'positive', '_positive']) expect(typeOid(name, namespace)).toMatch(/^\d+$/);
		expect(catalog.types.find((type) => type.oid === typeOid('mood', namespace))).toMatchObject({
			kind: 'enum', elementOid: null, arrayOid: typeOid('_mood', namespace), enumValues: ['one', 'two']
		});
		expect(catalog.types.find((type) => type.oid === typeOid('_mood', namespace))).toMatchObject({
			kind: 'array', elementOid: typeOid('mood', namespace), enumValues: []
		});
		await change('typed', { kind: 'createTable', columns: [
			column('enum', typeOid('mood', namespace)), column('domain', typeOid('positive', namespace)),
			column('array', typeOid('_mood', namespace)), column('numbers', typeOid('_int8'))
		] });
		await pool.query(`insert into ${tableSql('typed')} values ('one', 1, '{one,two}', '{1,2}')`);
		await expect(pool.query(`insert into ${tableSql('typed')} ("domain") values (-1)`)).rejects.toThrow();
		const oid = (await pool.query(`select reltype::text as oid from pg_class where oid = $1::regclass`, [tableSql('typed')])).rows[0].oid;
		await expect(change('bad_type', { kind: 'createTable', columns: [column('x', oid)] })).rejects.toThrow('approved');
	});

	test('safe modifiers round-trip scalar and array types, including negative numeric scales', async () => {
		const specs: [string, string, number[]][] = [
			['n', 'numeric', [12, 4]], ['rounded', 'numeric', [5, -2]], ['fraction', 'numeric', [2, 4]],
			['v', 'varchar', [12]], ['c', 'bpchar', [3]], ['b', 'bit', [4]], ['vb', 'varbit', [7]],
			['ts', 'timestamp', [0]], ['tz', 'timestamptz', [6]], ['t', 'time', [2]], ['tt', 'timetz', [3]],
			['na', '_numeric', [8, -1]], ['va', '_varchar', [6]], ['ta', '_timestamptz', [1]],
			['ba', '_bit', [3]]
		];
		await change('modifiers', { kind: 'createTable', columns: specs.map(([name, type, typeModifiers]) => column(name, typeOid(type), { typeModifiers })) });
		let def = await definition('modifiers');
		for (const [name, type, modifiers] of specs) {
			expect(def.columns.find((item) => item.name === name)).toMatchObject({ typeOid: typeOid(type), typeModifiers: modifiers });
		}
		await pool.query(`insert into ${tableSql('modifiers')} (n, rounded, fraction, na, va) values (1.23456, 1234, 0.00123, '{123,456}', '{abc,def}')`);
		expect((await pool.query(`select n::text, rounded::text, fraction::text, na::text from ${tableSql('modifiers')}`)).rows[0])
			.toEqual({ n: '1.2346', rounded: '1200', fraction: '0.0012', na: '{120,460}' });
		await change('modifiers', { kind: 'alterColumn', column: 'va', changes: column('va', typeOid('_varchar'), { typeModifiers: [2], default: { kind: 'keep' } }) });
		expect((await pool.query(`select va::text from ${tableSql('modifiers')}`)).rows[0].va).toBe('{ab,de}');
		await change('modifiers', { kind: 'alterColumn', column: 'n', changes: column('n', typeOid('numeric'), { typeModifiers: [8, 2], default: { kind: 'keep' } }) });
		expect((await pool.query(`select n::text from ${tableSql('modifiers')}`)).rows[0].n).toBe('1.23');
		def = await definition('modifiers');
		await expect(change('modifiers', { kind: 'alterColumn', column: 'rounded', changes: column('changed', typeOid('numeric'), { typeModifiers: [1, 0], comment: 'rollback' }) })).rejects.toThrow('overflow');
		expect((await definition('modifiers')).version).toBe(def.version);
		for (const [type, modifiers] of [['numeric', [0]], ['varchar', [1, 2]], ['time', [7]], ['_numeric', [2, 1001]], ['text', [3]]] as [string, number[]][]) {
			await expect(change('modifiers', { kind: 'addColumn', column: column('invalid', typeOid(type), { typeModifiers: modifiers }) })).rejects.toThrow();
		}
		expect((await definition('modifiers')).version).toBe(def.version);
	});

	test('contextual defaults handle dates, both time zones, UUID text and literal-only arrays/domains', async () => {
		await pool.query(`create domain ${tableSql('number_list')} as numeric(6,2)[];
			create type ${tableSql('default_mood')} as enum ('one', 'two')`);
		catalog = await listSchemaCatalog(pool);
		const domain = catalog.types.find((type) => type.oid === typeOid('number_list', namespace))!;
		expect(domain).toMatchObject({ kind: 'domain', elementOid: null, arrayOid: typeOid('_number_list', namespace) });
		expect(elementType(domain, catalog.types)).toBe(domain);
		await change('defaults', { kind: 'createTable', columns: [
			column('d', typeOid('date'), { default: { kind: 'today' } }),
			column('t', typeOid('time'), { typeModifiers: [2], default: { kind: 'currentTime' } }),
			column('tz', typeOid('timetz'), { default: { kind: 'currentTime' } }),
			column('u', typeOid('text'), { default: { kind: 'uuid' } }),
			column('uv', typeOid('varchar'), { typeModifiers: [36], default: { kind: 'uuid' } }),
			column('uc', typeOid('bpchar'), { typeModifiers: [36], default: { kind: 'uuid' } }),
			column('empty', typeOid('text'), { default: { kind: 'literal', value: '' } }),
			column('yes', typeOid('bool'), { default: { kind: 'literal', value: 'true' } }),
			column('json', typeOid('jsonb'), { default: { kind: 'literal', value: '{}' } }),
			column('array', typeOid('_numeric'), { typeModifiers: [4, 1], default: { kind: 'literal', value: '{}' } }),
			column('domain', domain.oid, { default: { kind: 'literal', value: '{1.23}' } }),
			column('domains', typeOid('_number_list', namespace)),
			column('enum', typeOid('default_mood', namespace), { default: { kind: 'literal', value: 'two' } })
		] });
		const row = (await pool.query(`insert into ${tableSql('defaults')} default values returning *,
			d = CURRENT_DATE as date_ok, t = LOCALTIME(2) as time_ok, tz = CURRENT_TIME as zone_ok`)).rows[0];
		expect([row.date_ok, row.time_ok, row.zone_ok]).toEqual([true, true, true]);
		for (const name of ['u', 'uv', 'uc']) expect(row[name]).toMatch(/^[a-f\d-]{36}$/);
		expect(row.empty).toBe('');
		expect(row.yes).toBe(true);
		expect(row.json).toEqual({});
		expect(row.array).toEqual([]);
		expect(row.enum).toBe('two');
		const def = await definition('defaults');
		expect(def.columns.find((item) => item.name === 'u')?.defaultValue).toContain('::text');
		expect(def.columns.find((item) => item.name === 'domain')?.typeModifiers).toEqual([]);
		for (const [oid, kind] of [
			[typeOid('_timestamptz'), 'now'], [typeOid('_date'), 'today'], [typeOid('_time'), 'currentTime'],
			[typeOid('_uuid'), 'uuid'], [domain.oid, 'uuid'], [typeOid('text'), 'now'],
			[typeOid('date'), 'now'], [typeOid('default_mood', namespace), 'uuid']
		] as [string, ColumnDefault['kind']][]) {
			await expect(change('defaults', { kind: 'addColumn', column: column('bad', oid, { default: { kind } as ColumnDefault }) })).rejects.toThrow('not available');
		}
		await expect(change('defaults', { kind: 'addColumn', column: column('bad', domain.oid, { typeModifiers: [3] }) })).rejects.toThrow('does not support');
		await expect(change('defaults', { kind: 'addColumn', column: column('bad', typeOid('_number_list', namespace), { typeModifiers: [3] }) })).rejects.toThrow('does not support');
		await expect(change('defaults', { kind: 'alterColumn', column: 'enum', changes: column('bad', null, { default: { kind: 'literal', value: 'missing' } }) })).rejects.toThrow('enum');
		await expect(change('defaults', { kind: 'alterColumn', column: 'd', changes: column('d', typeOid('_date'), { default: { kind: 'today' } }) })).rejects.toThrow('not available');
		expect((await definition('defaults')).version).toBe(def.version);
		await change('defaults', { kind: 'alterColumn', column: 't', changes: column('t', null, { default: { kind: 'currentTime' } }) });
		expect((await definition('defaults')).columns.find((item) => item.name === 't')?.typeModifiers).toEqual([2]);
	});

	test('UUID text presets require enough room for explicit and preserved character lengths', async () => {
		for (const name of ['varchar', 'bpchar']) {
			const table = `uuid_length_${name}`, oid = typeOid(name);
			const uuid = { kind: 'uuid' } as const;
			await expect(change(table, { kind: 'createTable', columns: [
				column('v', oid, { typeModifiers: [35], default: uuid })
			] })).rejects.toThrow('at least 36');
			await change(table, { kind: 'createTable', columns: [
				column('v', oid, { typeModifiers: [35] }),
				column('unbounded', oid, { default: uuid })
			] });
			const before = await definition(table);
			const old = before.columns[0];
			for (const type of [null, oid]) {
				const spec = column('v', type, { typeModifiers: type === null ? [] : [35], default: uuid });
				expect(columnOptionsError(spec, catalog.types, old)).toContain('at least 36');
				await expect(change(table, { kind: 'alterColumn', column: 'v', changes: spec })).rejects.toThrow('at least 36');
			}
			expect((await definition(table)).version).toBe(before.version);
			await change(table, { kind: 'alterColumn', column: 'v', changes: column('v', oid, { typeModifiers: [36], default: uuid }) });
			await change(table, { kind: 'alterColumn', column: 'v', changes: column('v', null, { default: uuid }) });
			const row = (await pool.query(`insert into ${tableSql(table)} default values returning *`)).rows[0];
			expect(row.v).toHaveLength(36);
			expect(row.unbounded).toHaveLength(36);
		}
	});

	test('unmodified qualified bpchar and bit remain unbounded, unlike their bare SQL labels', async () => {
		await change('unbounded_types', { kind: 'createTable', columns: [
			column('c', typeOid('bpchar')), column('b', typeOid('bit')),
			column('ca', typeOid('_bpchar')), column('ba', typeOid('_bit'))
		] });
		const def = await definition('unbounded_types');
		expect(def.columns.map((item) => item.typeModifiers)).toEqual([[], [], [], []]);
		expect(def.columns.map((item) => item.type)).toEqual(['bpchar', '"bit"', 'bpchar[]', '"bit"[]']);
		await pool.query(`insert into ${tableSql('unbounded_types')} values ('abc', B'101', '{abc,defgh}', '{101,10101}')`);
		const row = (await pool.query(`select c::text, b::text, ca::text, ba::text from ${tableSql('unbounded_types')}`)).rows[0];
		expect(row).toEqual({ c: 'abc', b: '101', ca: '{abc,defgh}', ba: '{101,10101}' });
	});

	test('unsupported and unapproved existing types preserve exact modifiers and allow literal defaults', async () => {
		await pool.query(`create table ${tableSql('unsupported')} (i interval day to second(2), p point default '(1,2)')`);
		const before = await definition('unsupported');
		expect(before.columns[0].typeModifiers).toBeNull();
		await change('unsupported', { kind: 'alterColumn', column: 'i', changes: column('i', null, { comment: 'preserved' }) });
		await change('unsupported', { kind: 'alterColumn', column: 'p', changes: column('p', null, { default: { kind: 'literal', value: '(3,4)' } }) });
		const after = await definition('unsupported');
		expect(after.columns[0].type).toBe(before.columns[0].type);
		expect(after.columns[0].typeModifiers).toBeNull();
		expect((await pool.query(`insert into ${tableSql('unsupported')} default values returning p::text`)).rows[0].p).toBe('(3,4)');
	});

	test('quotes arbitrary names and exact literals/comments; identity, uuid and now presets work', async () => {
		const table = 'odd"; DROP TABLE nope;--';
		const name = '__proto__';
		const literal = "\\' ; DROP SCHEMA public CASCADE; --\n9007199254740993";
		await change(table, { kind: 'createTable', columns: [
			column('id', typeOid('int8'), { nullable: false, primaryKey: true, default: { kind: 'identity' } }),
			column(name, typeOid('text'), { default: { kind: 'literal', value: literal }, comment: literal }),
			column('uuid', typeOid('uuid'), { default: { kind: 'uuid' } }),
			column('now', typeOid('timestamptz'), { default: { kind: 'now' } }),
			column('exact', typeOid('numeric'), { default: { kind: 'literal', value: '9007199254740993.0000000000001' } })
		] });
		const result = (await pool.query(`insert into ${tableSql(table)} default values returning *`)).rows[0];
		expect(result[name]).toBe(literal);
		expect(result.exact).toBe('9007199254740993.0000000000001');
		expect(result.uuid).toMatch(/^[a-f\d-]{36}$/);
		expect(result.now).toBeInstanceOf(Date);
		const def = await definition(table);
		expect(def.columns.find((c) => c.name === name)?.comment).toBe(literal);
		expect(def.columns[0].identity).toBe('by-default');
		await change(table, { kind: 'renameTable', name: 'renamed";--' });
		await change('renamed";--', { kind: 'dropTable' });
	});

	test('preserves exact typmods and custom expressions with search-path-independent fingerprints', async () => {
		await pool.query(`create function ${tableSql('custom_default')}() returns numeric language sql immutable as 'select 12.34';
			create table ${tableSql('preserve')} (n numeric(20,4) default ${tableSql('custom_default')}(), id integer generated always as identity,
			 g numeric generated always as (n * 2) stored)`);
		const before = await definition('preserve');
		const other = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace},public`, max: 1 });
		try {
			expect((await getSchemaDefinition(other, target('preserve'))).version).toBe(before.version);
		} finally { await other.end(); }
		await change('preserve', { kind: 'alterColumn', column: 'n', changes: column('renamed', null, { comment: 'kept' }) });
		const after = await definition('preserve');
		expect(after.columns[0].type).toBe('numeric(20,4)');
		expect(after.columns[0].defaultValue).toBe(before.columns[0].defaultValue);
		expect(after.columns[1].identity).toBe('always');
		expect(after.columns[2].generated).toBe(true);
		expect((await pool.query(`insert into ${tableSql('preserve')} default values returning renamed::text, g::text`)).rows[0])
			.toEqual({ renamed: '12.3400', g: '24.6800' });
		await change('preserve', { kind: 'alterColumn', column: 'g', changes: column('g2', null, { comment: 'generated kept' }) });
	});

	test('explicit native casts, default replacement ordering, and all-or-nothing rollback', async () => {
		await pool.query(`create table ${tableSql('casts')} (value text default 'bad'); insert into ${tableSql('casts')} values ('42')`);
		await expect(change('casts', { kind: 'alterColumn', column: 'value', changes: column('value', typeOid('int4'), { default: { kind: 'keep' } }) })).rejects.toThrow();
		await change('casts', { kind: 'alterColumn', column: 'value', changes: column('number', typeOid('int4'), { default: { kind: 'literal', value: '7' } }) });
		expect((await pool.query(`select number from ${tableSql('casts')}`)).rows[0].number).toBe(42);
		expect((await pool.query(`insert into ${tableSql('casts')} default values returning number`)).rows[0].number).toBe(7);
		await change('casts', { kind: 'alterColumn', column: 'number', changes: column('number', typeOid('text'), { default: { kind: 'literal', value: 'not a number' } }) });
		await pool.query(`insert into ${tableSql('casts')} default values`);
		const before = await definition('casts');
		await expect(change('casts', { kind: 'alterColumn', column: 'number', changes: column('renamed', typeOid('int4'), { comment: 'should rollback' }) })).rejects.toThrow('invalid input syntax');
		expect((await definition('casts')).version).toBe(before.version);
		await expect(change('casts', { kind: 'addColumn', column: column('required', typeOid('text'), { nullable: false }) })).rejects.toThrow();
		expect((await definition('casts')).version).toBe(before.version);
		await change('casts', { kind: 'alterColumn', column: 'number', changes: column('number', null, { default: { kind: 'none' } }) });
		expect((await definition('casts')).columns[0].defaultValue).toBeNull();
	});

	test('guards generated/identity edits and identity presets', async () => {
		await pool.query(`create table ${tableSql('generated')} (id int generated always as identity, n int, g int generated always as (n*2) stored)`);
		const before = await definition('generated');
		for (const [name, changes] of [
			['g', column('g', typeOid('int8'), { default: { kind: 'keep' } })],
			['g', column('g', null, { default: { kind: 'none' } })],
			['id', column('id', null, { default: { kind: 'literal', value: '7' } })]
		] as const) await expect(change('generated', { kind: 'alterColumn', column: name, changes })).rejects.toThrow();
		await expect(change('generated', { kind: 'addColumn', column: column('invalid', typeOid('text'), { nullable: false, default: { kind: 'identity' } }) })).rejects.toThrow('integer');
		expect((await definition('generated')).version).toBe(before.version);
		await change('generated', { kind: 'alterColumn', column: 'id', changes: column('newid', typeOid('int8'), { nullable: false, default: { kind: 'keep' } }) });
		expect((await definition('generated')).columns[0].identity).toBe('always');
	});

	test('supports ordered composite PKs, singleton keyless PKs, and never replaces existing keys', async () => {
		await change('pk', { kind: 'createTable', columns: [column('b', typeOid('int4'), { primaryKey: true }), column('a', typeOid('int4'), { primaryKey: true }), column('other', typeOid('int4'))] });
		expect((await definition('pk')).primaryKey).toEqual(['b', 'a']);
		await expect(change('pk', { kind: 'alterColumn', column: 'a', changes: column('a', null) })).rejects.toThrow('primary key');
		await expect(change('pk', { kind: 'alterColumn', column: 'other', changes: column('other', null, { primaryKey: true }) })).rejects.toThrow('primary key');
		await expect(change('pk', { kind: 'addColumn', column: column('extra', typeOid('int4'), { primaryKey: true }) })).rejects.toThrow('primary key');
		await pool.query(`create table ${tableSql('keyless')} (a int, b int); insert into ${tableSql('keyless')} values (1,2)`);
		await change('keyless', { kind: 'addPrimaryKey', columns: ['b', 'a'] });
		expect((await definition('keyless')).primaryKey).toEqual(['b', 'a']);
		await expect(change('keyless', { kind: 'addPrimaryKey', columns: ['a'] })).rejects.toThrow('primary key');
		await pool.query(`create table ${tableSql('singleton')} (a int); create table ${tableSql('added_pk')} (a text)`);
		await change('singleton', { kind: 'alterColumn', column: 'a', changes: column('key', null, { primaryKey: true }) });
		await change('added_pk', { kind: 'addColumn', column: column('key', typeOid('int4'), { primaryKey: true }) });
		expect((await definition('singleton')).primaryKey).toEqual(['key']);
		expect((await definition('added_pk')).primaryKey).toEqual(['key']);
		await pool.query(`create table ${tableSql('included_pk')} (a int, b int, primary key (a) include (b))`);
		expect((await definition('included_pk')).primaryKey).toEqual(['a']);
		expect((await definition('included_pk')).columns[1].primaryKey).toBe(false);
	});

	test('inspects native indexes and creates/drops ordered plain-column indexes with native rollback', async () => {
		await pool.query(`create table ${tableSql('index_tools')} (
			id int primary key, "__proto__" text, value int unique, payload jsonb);
			insert into ${tableSql('index_tools')} values (1, 'same', 1, '{}'), (2, 'same', 2, '{}');
			create index ${ident('index_expression')} on ${tableSql('index_tools')} (lower("__proto__")) where value > 0;
			comment on index ${tableSql('index_expression')} is 'Expression/partial example'`);
		await expect(pool.query(`create unique index concurrently ${ident('index_invalid')}
			on ${tableSql('index_tools')} ("__proto__")`)).rejects.toMatchObject({ code: '23505' });
		let def = await definition('index_tools');
		expect(def.indexes.find((index) => index.primary)).toMatchObject({ unique: true, constraint: 'index_tools_pkey' });
		expect(def.indexes.find((index) => index.name === 'index_tools_value_key')?.constraint).toBe('index_tools_value_key');
		expect(def.indexes.find((index) => index.name === 'index_invalid')?.valid).toBe(false);
		const expression = def.indexes.find((index) => index.name === 'index_expression')!;
		expect(expression.definition).toContain('lower(');
		expect(expression.definition).toContain('WHERE');
		expect(expression.comment).toBe('Expression/partial example');
		const name = 'idx";--';
		await change('index_tools', { kind: 'createIndex', name, method: 'btree', unique: false, columns: ['value', '__proto__'] });
		def = await definition('index_tools');
		const built = def.indexes.find((index) => index.name === name)!;
		expect(built).toMatchObject({ method: 'btree', unique: false, valid: true, ready: true, constraint: null });
		expect((await pool.query(`select a.attname from pg_index i
			cross join lateral unnest(i.indkey) with ordinality k(num, position)
			join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.num
			where i.indexrelid = $1::oid order by k.position`, [built.oid])).rows.map((row) => row.attname)).toEqual(['value', '__proto__']);
		await change('index_tools', { kind: 'createIndex', name: 'index_gin', method: 'gin', unique: false, columns: ['payload'] });
		const before = await definition('index_tools');
		for (const [method, unique, columns, code] of [
			['btree', true, ['__proto__'], '23505'], ['gin', true, ['payload'], '0A000'],
			['hash', false, ['value', '__proto__'], '0A000']
		] as const) {
			await expect(change('index_tools', { kind: 'createIndex', name: 'index_failed', method, unique, columns: [...columns] })).rejects.toMatchObject({ code });
			expect((await definition('index_tools')).version).toBe(before.version);
		}
		await expect(change('index_tools', { kind: 'createIndex', name: 'index_missing', method: 'btree', unique: false, columns: ['missing'] })).rejects.toThrow('Unknown index column');
		await expect(change('index_tools', { kind: 'createIndex', name, method: 'btree', unique: false, columns: ['value'] })).rejects.toThrow('already exists');
		await change('index_tools', { kind: 'dropIndex', indexOid: built.oid });
		await change('index_tools', { kind: 'dropIndex', indexOid: before.indexes.find((index) => index.name === 'index_invalid')!.oid });
		expect((await definition('index_tools')).indexes.some((index) => index.oid === built.oid)).toBe(false);
		expect((await pool.query(`select count(*)::int as n from ${tableSql('index_tools')}`)).rows[0].n).toBe(2);
	});

	test('protects constraint/replica identity indexes and lets RESTRICT reject self-FK dependencies', async () => {
		await pool.query(`create table ${tableSql('index_guards')} (id int not null, parent int, u int unique);
			create unique index ${ident('index_self')} on ${tableSql('index_guards')} (id);
			alter table ${tableSql('index_guards')} add foreign key (parent) references ${tableSql('index_guards')} (id);
			create unique index ${ident('index_replica')} on ${tableSql('index_guards')} (id);
			alter table ${tableSql('index_guards')} replica identity using index ${ident('index_replica')}`);
		const before = await definition('index_guards');
		const self = before.indexes.find((index) => index.name === 'index_self')!;
		expect(self.constraint).toBeNull();
		await expect(change('index_guards', { kind: 'dropIndex', indexOid: self.oid })).rejects.toMatchObject({ code: '2BP01' });
		await expect(change('index_guards', { kind: 'dropIndex', indexOid: before.indexes.find((index) => index.constraint)!.oid })).rejects.toThrow('constraint');
		await expect(change('index_guards', { kind: 'dropIndex', indexOid: before.indexes.find((index) => index.replicaIdentity)!.oid })).rejects.toThrow('replica identity');
		const other = (await definition('index_tools')).indexes[0];
		await expect(change('index_guards', { kind: 'dropIndex', indexOid: other.oid })).rejects.toThrow('belongs');
		await pool.query(`alter index ${tableSql('index_self')} rename to index_self_renamed`);
		await expect(changeSchema(pool, { ...target('index_guards'), expected: before.version,
			operation: { kind: 'dropIndex', indexOid: self.oid } })).rejects.toThrow('schema changed');
	});

	test('a renamed index cannot redirect DROP to another table index with its former name', async () => {
		await pool.query(`create table ${tableSql('index_race_a')} (id int);
			create table ${tableSql('index_race_b')} (id int);
			create index index_race_selected on ${tableSql('index_race_a')} (id);
			create index index_race_other on ${tableSql('index_race_b')} (id)`);
		const before = await definition('index_race_a');
		const other = (await definition('index_race_b')).indexes[0];
		const racer = await pool.connect();
		let changed = false;
		try {
			await racer.query("set lock_timeout = '1s'");
			const wrapped = interleaved(async (sql) => {
				if (changed || !sql.includes('with approved as')) return;
				changed = true;
				await racer.query(`alter index ${tableSql('index_race_selected')} rename to index_race_moved;
					alter index ${tableSql('index_race_other')} rename to index_race_selected`);
			});
			await expect(changeSchema(wrapped, { ...target('index_race_a'), expected: before.version,
				operation: { kind: 'dropIndex', indexOid: before.indexes[0].oid } })).rejects.toThrow('Index changed');
			expect(changed).toBe(true);
			expect((await definition('index_race_a')).indexes[0]).toMatchObject({ oid: before.indexes[0].oid, name: 'index_race_moved' });
			expect((await definition('index_race_b')).indexes[0]).toMatchObject({ oid: other.oid, name: 'index_race_selected' });
		} finally { await racer.query('reset lock_timeout'); racer.release(); }
	});

	test('index operations reject namespace retargeting and unauthorized writes', async () => {
		const original = `${namespace}_index`, moved = `${namespace}_imoved`;
		for (const kind of ['createIndex', 'dropIndex'] as const) {
			try {
				await pool.query(`create schema ${ident(original)}; create table ${qualify(original, 't')} (v int);
					create index idx on ${qualify(original, 't')} (v)`);
				const args = { connection: 'test', schema: original, table: 't' };
				const before = await getSchemaDefinition(pool, args);
				let changed = false;
				const wrapped = interleaved(async (sql) => {
					if (changed || !sql.includes('with approved as')) return;
					changed = true;
					await pool.query(`alter schema ${ident(original)} rename to ${ident(moved)};
						create schema ${ident(original)}; create table ${qualify(original, 't')} (v int);
						create index idx on ${qualify(original, 't')} (v)`);
				});
				const operation: SchemaOperation = kind === 'createIndex'
					? { kind, name: 'new_idx', method: 'btree', unique: false, columns: ['v'] }
					: { kind, indexOid: before.indexes[0].oid };
				await expect(changeSchema(wrapped, { ...args, expected: before.version, operation })).rejects.toThrow('changed');
				for (const schema of [original, moved]) expect((await getSchemaDefinition(pool, { ...args, schema })).indexes.map((index) => index.name)).toEqual(['idx']);
			} finally { await pool.query(`drop schema if exists ${ident(original)} cascade; drop schema if exists ${ident(moved)} cascade`); }
		}
		const role = `${namespace}_idxreader`;
		let restricted: pg.Pool | undefined;
		try {
			await pool.query(`create role ${ident(role)}; grant usage on schema ${ident(namespace)} to ${ident(role)};
				grant select on ${tableSql('index_tools')} to ${ident(role)}`);
			restricted = new pg.Pool({ connectionString: url, options: `-c role=${role}`, max: 1 });
			const before = await getSchemaDefinition(restricted, target('index_tools'));
			expect(before.indexes.length).toBeGreaterThan(0);
			for (const operation of [
				{ kind: 'createIndex', name: 'forbidden', method: 'btree', unique: false, columns: ['id'] },
				{ kind: 'dropIndex', indexOid: before.indexes.find((index) => index.name === 'index_gin')!.oid }
			] satisfies SchemaOperation[]) {
				await expect(changeSchema(restricted, { ...target('index_tools'), expected: before.version, operation })).rejects.toMatchObject({ code: '42501' });
			}
			expect((await definition('index_tools')).version).toBe(before.version);
		} finally {
			await restricted?.end();
			await pool.query(`drop owned by ${ident(role)}; drop role ${ident(role)}`);
		}
	});

	test('RESTRICT blocks external dependencies; dropping a column may remove its own indexes', async () => {
		await pool.query(`create table ${tableSql('dep')} (id int primary key, n int unique);
			create table ${tableSql('ref')} (id int references ${tableSql('dep')}(id))`);
		await expect(change('dep', { kind: 'dropTable' })).rejects.toThrow('depend');
		await expect(change('dep', { kind: 'dropColumn', column: 'id' })).rejects.toThrow('depend');
		await change('dep', { kind: 'dropColumn', column: 'n' });
		expect((await definition('dep')).columns.map((c) => c.name)).toEqual(['id']);
		await change('ref', { kind: 'dropTable' });
		await change('dep', { kind: 'dropColumn', column: 'id' });
		expect((await definition('dep')).primaryKey).toEqual([]);
		await change('dep', { kind: 'dropTable' });
	});

	test('rejects inheritance and partition DDL for parents and children', async () => {
		await pool.query(`create table ${tableSql('parent')} (id int); create table ${tableSql('child')} () inherits (${tableSql('parent')});
			create table ${tableSql('parts')} (id int) partition by list (id);
			create table ${tableSql('part')} partition of ${tableSql('parts')} for values in (1);
			create view ${tableSql('view')} as select 1 as n`);
		for (const table of ['parent', 'child', 'parts', 'part', 'view']) {
			expect((await definition(table)).editable).toBe(false);
			await expect(change(table, { kind: 'dropTable' })).rejects.toThrow();
		}
	});

	test('fingerprints ignore data/statistics but detect defaults, comments, constraints, indexes and replacement OIDs', async () => {
		await pool.query(`create table ${tableSql('stale')} (id int, value text)`);
		const first = await definition('stale');
		await pool.query(`insert into ${tableSql('stale')} values (1, 'x'); analyze ${tableSql('stale')}`);
		expect((await definition('stale')).version).toBe(first.version);
		for (const sql of [
			`alter table ${tableSql('stale')} alter column id set default 1`,
			`comment on column ${tableSql('stale')}.value is 'updated'`,
			`alter table ${tableSql('stale')} add check (id > 0)`,
			`create index on ${tableSql('stale')} (value)`
		]) {
			const before = await definition('stale');
			await pool.query(sql);
			expect((await definition('stale')).version).not.toBe(before.version);
			await expect(changeSchema(pool, { ...target('stale'), expected: before.version, operation: { kind: 'dropTable' } })).rejects.toThrow('schema changed');
		}
		await pool.query(`create table ${tableSql('replacement')} (id int)`);
		const before = await definition('replacement');
		await pool.query(`drop table ${tableSql('replacement')}; create table ${tableSql('replacement')} (id int)`);
		expect((await definition('replacement')).oid).not.toBe(before.oid);
		await expect(changeSchema(pool, { ...target('replacement'), expected: before.version, operation: { kind: 'dropTable' } })).rejects.toThrow('schema changed');
	});

	test('rolls back type-name replacements during create, add and alter without changing data', async () => {
		for (const kind of ['createTable', 'addColumn', 'alterColumn'] as const) {
			const table = `type_race_${kind}`, type = `domain_${kind}`;
			await pool.query(`create domain ${tableSql(type)} as text`);
			const oid = (await pool.query('select $1::regtype::oid::text as oid', [tableSql(type)])).rows[0].oid;
			if (kind !== 'createTable') await pool.query(`create table ${tableSql(table)} (v text); insert into ${tableSql(table)} values ('0042')`);
			const before = kind === 'createTable' ? null : await definition(table);
			let changed = false;
			const wrapped = interleaved(async (sql) => {
				if (changed || !sql.includes('with approved as')) return;
				changed = true;
				await pool.query(`alter domain ${tableSql(type)} rename to ${ident(`${type}_old`)}; create domain ${tableSql(type)} as integer`);
			});
			const spec = column('v', oid, { default: { kind: kind === 'alterColumn' ? 'keep' : 'none' } });
			const operation: SchemaOperation = kind === 'createTable' ? { kind, columns: [spec] }
				: kind === 'addColumn' ? { kind, column: { ...spec, name: 'added' } } : { kind, column: 'v', changes: spec };
			await expect(changeSchema(wrapped, { ...target(table), expected: before?.version ?? null, operation })).rejects.toThrow('catalog changed');
			expect(changed).toBe(true);
			if (before) {
				expect((await definition(table)).version).toBe(before.version);
				expect((await pool.query(`select v from ${tableSql(table)}`)).rows).toEqual([{ v: '0042' }]);
			} else expect((await pool.query('select to_regclass($1) as table', [tableSql(table)])).rows[0].table).toBeNull();
		}
	});

	test('array element names and rename-back are fenced even when the selected array OID is unchanged', async () => {
		for (const restore of [false, true]) {
			const name = `array_element_${restore}`, table = `array_race_${restore}`;
			await pool.query(`create type ${tableSql(name)} as enum ('one')`);
			const types = await listSchemaCatalog(pool);
			const type = types.types.find((item) => item.schema === namespace && item.name === name)!;
			let changed = false, restored = false;
			const wrapped = interleaved(async (sql) => {
				if (!changed && sql.includes('with approved as')) {
					changed = true;
					await pool.query(`alter type ${tableSql(name)} rename to ${ident(`${name}_old`)};
						create type ${tableSql(name)} as enum ('one')`);
				} else if (restore && !restored && sql.startsWith('comment on column')) {
					restored = true;
					await pool.query(`alter type ${tableSql(name)} rename to ${ident(`${name}_other`)};
						alter type ${tableSql(`${name}_old`)} rename to ${ident(name)}`);
				}
			});
			await expect(changeSchema(wrapped, { ...target(table), expected: null, operation: {
				kind: 'createTable', columns: [column('v', type.arrayOid, { comment: 'race boundary' })]
			} })).rejects.toThrow('catalog changed');
			expect(changed).toBe(true);
			expect(restored).toBe(restore);
			expect((await pool.query('select to_regclass($1) as table', [tableSql(table)])).rows[0].table).toBeNull();
		}
	});

	test('namespace replacement and rename-back cannot retarget committed DDL', async () => {
		const original = `${namespace}_race`, moved = `${namespace}_moved`, other = `${namespace}_other`;
		for (const kind of ['dropTable', 'createTable', 'alterColumn'] as const) {
			try {
				await pool.query(`create schema ${ident(original)}; create table ${qualify(original, 't')} (v text); insert into ${qualify(original, 't')} values ('original')`);
				const args = { connection: 'test', schema: original, table: kind === 'createTable' ? 'new' : 't' };
				const expected = kind === 'createTable' ? null : (await getSchemaDefinition(pool, args)).version;
				let changed = false, restored = false;
				const wrapped = interleaved(async (sql) => {
					if (!changed && sql.includes('with approved as')) {
						changed = true;
						await pool.query(`alter schema ${ident(original)} rename to ${ident(moved)};
							create schema ${ident(original)}; create table ${qualify(original, 't')} (v text);
							insert into ${qualify(original, 't')} values ('replacement')`);
					} else if (kind === 'alterColumn' && !restored && sql.startsWith('comment on column')) {
						restored = true;
						await pool.query(`alter schema ${ident(original)} rename to ${ident(other)}; alter schema ${ident(moved)} rename to ${ident(original)}`);
					}
				});
				const operation: SchemaOperation = kind === 'dropTable' ? { kind }
					: kind === 'createTable' ? { kind, columns: [column('v', typeOid('text'))] }
					: { kind, column: 'v', changes: column('v', null, { comment: 'must not commit' }) };
				await expect(changeSchema(wrapped, { ...args, expected, operation })).rejects.toThrow('catalog changed');
				expect(changed).toBe(true);
				expect(restored).toBe(kind === 'alterColumn');
				for (const [schema, value] of [[restored ? original : moved, 'original'], [restored ? other : original, 'replacement']]) {
					expect((await pool.query(`select v from ${qualify(schema, 't')}`)).rows).toEqual([{ v: value }]);
					expect((await getSchemaDefinition(pool, { ...args, schema, table: 't' })).columns[0].comment).toBeNull();
				}
				if (kind === 'createTable') expect((await pool.query('select to_regclass($1) as table', [qualify(original, 'new')])).rows[0].table).toBeNull();
			} finally {
				for (const schema of [original, moved, other]) await pool.query(`drop schema if exists ${ident(schema)} cascade`);
			}
		}
	});

	test('reloads metadata under the exclusive lock and fails after a short lock timeout', async () => {
		await pool.query(`create table ${tableSql('locked')} (id int)`);
		const before = await definition('locked');
		const blocker = await pool.connect();
		try {
			await blocker.query(`begin; lock table ${tableSql('locked')} in access exclusive mode`);
			const start = Date.now();
			await expect(changeSchema(pool, { ...target('locked'), expected: before.version, operation: { kind: 'dropTable' } })).rejects.toMatchObject({ code: '55P03' });
			expect(Date.now() - start).toBeGreaterThanOrEqual(2800);
			expect(Date.now() - start).toBeLessThan(6000);
			await blocker.query(`alter table ${tableSql('locked')} add column later text`);
			const pending = changeSchema(pool, { ...target('locked'), expected: before.version, operation: { kind: 'dropTable' } })
				.then(() => null, (error: Error) => error);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await blocker.query('commit');
			expect((await pending)?.message).toContain('schema changed');
			expect((await definition('locked')).columns.map((c) => c.name)).toEqual(['id', 'later']);
		} finally {
			await blocker.query('rollback');
			blocker.release();
		}
	}, 10_000);

	test('invalidates the existing row metadata cache after committed DDL and validates direct callers', async () => {
		await pool.query(`create table ${tableSql('cache')} (id int primary key); insert into ${tableSql('cache')} values (1)`);
		await listTables(pool);
		await change('cache', { kind: 'addColumn', column: column('new', typeOid('text'), { default: { kind: 'literal', value: 'fresh' } }) });
		const result = await listRows(pool, { ...target('cache'), page: 0, pageSize: 10, sort: [{ column: 'new', direction: 'asc' }], search: '' });
		expect(result.rows[0].values.new).toBe('fresh');
		await expect(changeSchema(pool, { ...target('cache'), expected: null, operation: { kind: 'dropTable' } })).rejects.toThrow('fingerprint');
		await expect(getSchemaDefinition(pool, { ...target('cache'), schema: 'pg_catalog' })).rejects.toThrow('System');
	});

	test('duplicates exact structure and rows with independent serial/identity sequences, including shared defaults', async () => {
		const source = 'clone_source', copy = 'clone";\n--copy';
		await pool.query(`create table ${tableSql(source)} (
			id bigserial primary key, second bigint,
			identity_id bigint generated always as identity (start 100 increment 7 cache 3),
			amount numeric(40,15) default 9007199254740993.000000000000001,
			payload json default '{"n":9007199254740993,"n":1}',
			g numeric generated always as (amount * 2) stored,
			label text collate "C" default 'exact' check (amount > 0));
			alter sequence ${tableSql(`${source}_id_seq`)} start 10 increment 3 cache 2;
			alter table ${tableSql(source)} alter column second set default nextval(${pg.escapeLiteral(tableSql(`${source}_id_seq`))}::regclass);
			create index on ${tableSql(source)} (label);
			comment on table ${tableSql(source)} is 'table comment';
			comment on column ${tableSql(source)}.amount is 'column comment';
			insert into ${tableSql(source)} (id, second, identity_id) overriding system value values
				(9007199254740993, 9007199254740994, 121), (20, 23, 114)`);
		const serial = tableSql(`${source}_id_seq`), identity = tableSql(`${source}_identity_id_seq`);
		const state = async (name: string) => (await pool.query(`select last_value::text, is_called from ${name}`)).rows;
		const beforeSerial = await state(serial), beforeIdentity = await state(identity);
		const fingerprint = (await definition(source)).version;
		await change(source, { kind: 'duplicateTable', name: copy, includeRows: true });
		expect((await definition(source)).version).toBe(fingerprint);
		expect(await state(serial)).toEqual(beforeSerial);
		expect(await state(identity)).toEqual(beforeIdentity);
		const copied = await pool.query(`select id::text, second::text, identity_id::text, amount::text, payload::text, g::text from ${tableSql(copy)} order by id`);
		const original = await pool.query(`select id::text, second::text, identity_id::text, amount::text, payload::text, g::text from ${tableSql(source)} order by id`);
		expect(copied.rows).toEqual(original.rows);
		const next = (await pool.query(`insert into ${tableSql(copy)} default values returning id::text, second::text, identity_id::text`)).rows[0];
		expect(next).toEqual({ id: '9007199254740997', second: '9007199254741000', identity_id: '128' });
		const sequenceNames = (await pool.query(`select pg_get_serial_sequence($1, 'id') as serial, pg_get_serial_sequence($1, 'identity_id') as identity`, [tableSql(copy)])).rows[0];
		expect(sequenceNames.serial).not.toBe(serial);
		expect(sequenceNames.identity).not.toBe(identity);
		expect((await definition(copy)).columns.find((item) => item.name === 'amount')?.comment).toBe('column comment');
		expect((await pool.query('select obj_description($1::regclass) as comment', [tableSql(copy)])).rows[0].comment).toBe('table comment');
		await change(source, { kind: 'duplicateTable', name: 'clone_empty', includeRows: false });
		expect((await pool.query(`select count(*)::int as n from ${tableSql('clone_empty')}`)).rows[0].n).toBe(0);
		expect((await pool.query(`insert into ${tableSql('clone_empty')} default values returning id::text, second::text, identity_id::text`)).rows[0])
			.toEqual({ id: '10', second: '13', identity_id: '100' });
		await expect(change(source, { kind: 'duplicateTable', name: copy, includeRows: false })).rejects.toThrow('already exists');
	});

	test('negative sequence increments, exhaustion and unsupported owned dependencies never alter source state', async () => {
		await pool.query(`create table ${tableSql('descending')} (id bigint generated always as identity
			(start -10 increment -3 minvalue -100 maxvalue -1));
			insert into ${tableSql('descending')} overriding system value values (-20), (-30)`);
		await change('descending', { kind: 'duplicateTable', name: 'descending_copy', includeRows: true });
		expect((await pool.query(`insert into ${tableSql('descending_copy')} default values returning id::text`)).rows[0].id).toBe('-31');
		await pool.query(`create table ${tableSql('exhausted')} (id bigint generated by default as identity (maxvalue 10 cycle));
			insert into ${tableSql('exhausted')} values (10);
			create table ${tableSql('complex_sequence')} (id serial, extra bigint);
			alter table ${tableSql('complex_sequence')} alter column extra set default nextval(${pg.escapeLiteral(tableSql('complex_sequence_id_seq'))}::regclass) + 1`);
		for (const [source, error] of [['exhausted', 'exhaust'], ['complex_sequence', 'complex owned-sequence']]) {
			const seq = (await pool.query("select pg_get_serial_sequence($1, 'id') as name", [tableSql(source)])).rows[0].name;
			const before = (await pool.query(`select last_value::text, is_called from ${seq}`)).rows;
			await expect(change(source, { kind: 'duplicateTable', name: `${source}_copy`, includeRows: true })).rejects.toThrow(error);
			expect((await pool.query('select to_regclass($1) as name', [tableSql(`${source}_copy`)])).rows[0].name).toBeNull();
			expect((await pool.query(`select last_value::text, is_called from ${seq}`)).rows).toEqual(before);
		}
		await pool.query(`create sequence ${tableSql('external_seq')};
			create table ${tableSql('external_sequence')} (id bigint default nextval(${pg.escapeLiteral(tableSql('external_seq'))}::regclass))`);
		await change('external_sequence', { kind: 'duplicateTable', name: 'external_sequence_copy', includeRows: false });
		expect((await definition('external_sequence_copy')).columns[0].defaultValue).toBe((await definition('external_sequence')).columns[0].defaultValue);
		await pool.query(`create table ${tableSql('dynamic_sequence')} (id serial, second bigint, literal text default 'nextval(');
			alter table ${tableSql('dynamic_sequence')} alter column second set default
				nextval((${pg.escapeLiteral(tableSql('dynamic_sequence_id_seq'))}::text)::regclass)`);
		await expect(change('dynamic_sequence', { kind: 'duplicateTable', name: 'dynamic_sequence_copy', includeRows: false })).rejects.toThrow('complex owned-sequence');
		await pool.query(`alter table ${tableSql('dynamic_sequence')} alter column second drop default`);
		await change('dynamic_sequence', { kind: 'duplicateTable', name: 'dynamic_sequence_copy', includeRows: false });
		await pool.query(`create table ${tableSql('wide_identity')} (id integer generated always as identity);
			alter sequence ${tableSql('wide_identity_id_seq')} as bigint maxvalue 9223372036854775807;
			alter sequence ${tableSql('wide_identity_id_seq')} set unlogged`);
		await change('wide_identity', { kind: 'duplicateTable', name: 'wide_identity_copy', includeRows: false });
		const exported = await exportSchema(pool, target('wide_identity'));
		await pool.query(`drop table ${tableSql('wide_identity')}`);
		await pool.query(exported.sql);
		for (const table of ['wide_identity', 'wide_identity_copy']) {
			const sequence = (await pool.query("select pg_get_serial_sequence($1, 'id') as name", [tableSql(table)])).rows[0].name;
			expect((await pool.query(`select q.seqtypid::regtype::text as type, q.seqmax::text as max, c.relpersistence as persistence
				from pg_sequence q join pg_class c on c.oid = q.seqrelid where q.seqrelid = $1::regclass`, [sequence])).rows[0])
				.toEqual({ type: 'bigint', max: '9223372036854775807', persistence: 'u' });
		}
	});

	test('zero/all-generated tables duplicate structure or rows and round-trip SQL', async () => {
		await pool.query(`create table ${tableSql('zero_clone')} ();
			create table ${tableSql('generated_only')} (x int generated always as (7) stored)`);
		for (const table of ['zero_clone', 'generated_only']) {
			await pool.query(`insert into ${tableSql(table)} overriding system value select from generate_series(1, 3)`);
			await change(table, { kind: 'duplicateTable', name: `${table}_copy`, includeRows: false });
			expect((await pool.query(`select count(*)::int as n from ${tableSql(`${table}_copy`)}`)).rows[0].n).toBe(0);
			await change(table, { kind: 'duplicateTable', name: `${table}_rows`, includeRows: true });
			expect((await pool.query(`select count(*)::int as n from ${tableSql(`${table}_rows`)}`)).rows[0].n).toBe(3);
			if (table === 'generated_only') {
				expect((await pool.query(`select x from ${tableSql(`${table}_rows`)}`)).rows).toEqual([{ x: 7 }, { x: 7 }, { x: 7 }]);
			}
			const before = await definition(table);
			const exported = await exportSchema(pool, target(table));
			await pool.query(`drop table ${tableSql(table)}`);
			await pool.query(exported.sql);
			expect((await definition(table)).columns).toEqual(before.columns);
			expect((await pool.query(`select count(*)::int as n from ${tableSql(table)}`)).rows[0].n).toBe(0);
			await pool.query(`insert into ${tableSql(table)} default values`);
			expect((await pool.query(`select * from ${tableSql(table)}`)).rows).toEqual(table === 'zero_clone' ? [{}] : [{ x: 7 }]);
		}
	});

	test('dynamic sequence calls in copied CHECKs reject before DDL without advancing source sequences', async () => {
		const table = 'check_sequence', sequence = tableSql(`${table}_id_seq`);
		await pool.query(`create table ${tableSql(table)} (id serial);
			insert into ${tableSql(table)} (id) values (42);
			alter table ${tableSql(table)} add constraint dynamic_sequence_check
				check (nextval((${pg.escapeLiteral(sequence)}::text)::regclass) > 0)`);
		const before = (await pool.query(`select last_value::text, is_called from ${sequence}`)).rows;
		expect(before).toEqual([{ last_value: '1', is_called: true }]);
		let attemptedCreate = false;
		const wrapped = interleaved(async (sql) => { if (sql.startsWith('create table')) attemptedCreate = true; });
		for (const includeRows of [false, true]) {
			const name = `${table}_${includeRows}`;
			await expect(changeSchema(wrapped, { ...target(table), expected: (await definition(table)).version,
				operation: { kind: 'duplicateTable', name, includeRows } })).rejects.toThrow('complex owned-sequence');
			expect(attemptedCreate).toBe(false);
			expect((await pool.query('select to_regclass($1) as name', [tableSql(name)])).rows[0].name).toBeNull();
			expect((await pool.query(`select last_value::text, is_called from ${sequence}`)).rows).toEqual(before);
		}
	});

	test('sequence options/ownership and RLS affect fingerprints, live sequence/data changes do not', async () => {
		await pool.query(`create table ${tableSql('sequence_fingerprint')} (id serial)`);
		let before = await definition('sequence_fingerprint');
		await pool.query(`insert into ${tableSql('sequence_fingerprint')} default values`);
		expect((await definition('sequence_fingerprint')).version).toBe(before.version);
		for (const sql of [
			`alter sequence ${tableSql('sequence_fingerprint_id_seq')} increment 2`,
			`alter table ${tableSql('sequence_fingerprint')} enable row level security`,
			`alter table ${tableSql('sequence_fingerprint')} force row level security`,
			`alter sequence ${tableSql('sequence_fingerprint_id_seq')} owned by none`
		]) {
			await pool.query(sql);
			const after = await definition('sequence_fingerprint');
			expect(after.version).not.toBe(before.version);
			await expect(changeSchema(pool, { ...target('sequence_fingerprint'), expected: before.version,
				operation: { kind: 'duplicateTable', name: 'stale_clone', includeRows: false } })).rejects.toThrow('schema changed');
			before = after;
		}
	});

	test('SELECT-only source access respects RLS and retains flags before default-granted copies become visible', async () => {
		const role = `${namespace}_reader`;
		await pool.query(`create role ${ident(role)}; grant usage, create on schema ${ident(namespace)} to ${ident(role)}`);
		const restricted = { connect: async () => {
			const client = await pool.connect();
			await client.query(`set role ${ident(role)}`);
			return {
				query: async (sql: string, values?: unknown[]) => {
					const result = await client.query(sql, values);
					if (sql === 'commit' || sql === 'rollback') await client.query('reset role');
					return result;
				},
				release: () => client.release()
			};
		} } as unknown as pg.Pool;
		try {
			await pool.query(`create table ${tableSql('rls_source')} (id serial);
				insert into ${tableSql('rls_source')} values (1), (2);
				grant select on ${tableSql('rls_source')} to ${ident(role)};
				alter table ${tableSql('rls_source')} enable row level security;
				alter table ${tableSql('rls_source')} force row level security;
				create policy visible on ${tableSql('rls_source')} for select to ${ident(role)} using (id = 1);
				alter default privileges for role ${ident(role)} in schema ${ident(namespace)} grant select on tables to public`);
			const before = await getSchemaDefinition(restricted, target('rls_source'));
			await changeSchema(restricted, { ...target('rls_source'), expected: before.version,
				operation: { kind: 'duplicateTable', name: 'rls_copy', includeRows: true } });
			expect((await pool.query(`select * from ${tableSql('rls_copy')}`)).rows).toEqual([{ id: 1 }]);
			expect((await pool.query('select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass', [tableSql('rls_copy')])).rows[0])
				.toEqual({ relrowsecurity: true, relforcerowsecurity: true });
			const client = await pool.connect();
			try {
				await client.query(`set role ${ident(role)}`);
				expect((await client.query(`select * from ${tableSql('rls_copy')}`)).rows).toEqual([]);
			} finally { await client.query('reset role'); client.release(); }
			expect((await exportSchema(restricted, target('rls_source'))).sql).toContain('FORCE ROW LEVEL SECURITY');
		} finally {
			await pool.query(`drop owned by ${ident(role)}; drop role ${ident(role)}`);
		}
	});

	test('standalone SQL round-trips hostile names, exact types/defaults, sequences, constraints, indexes, comments and RLS', async () => {
		const table = 'export";\n--table', columnName = 'a";\n--col', typeName = 'export_type';
		const comment = "quote'\\\nCOMMIT; DROP SCHEMA public CASCADE; --";
		await pool.query(`create type ${tableSql(typeName)} as enum ('one', 'two');
			create table ${tableSql('export_reference')} (id int primary key);
			create table ${tableSql(table)} (
				id bigserial primary key, iid bigint generated always as identity (start 20 increment 4 minvalue 2 maxvalue 200 cache 5 cycle),
				${ident(columnName)} numeric(40,15) default 9007199254740993.000000000000001 not null,
				j json default '{"n":9007199254740993,"n":1}', label text collate "C" default 'one',
				g numeric generated always as (${ident(columnName)} * 2) stored,
				e ${tableSql(typeName)} default 'two', a numeric(5,2)[][], interval_value interval day to second(2),
				ref int references ${tableSql('export_reference')}(id), unique(label), check (${ident(columnName)} > 0));
			alter sequence ${tableSql('export";\n--table_id_seq')} start 11 increment 3 cache 2;
			create index ${ident('export";\n--index')} on ${tableSql(table)} (lower(label)) where ref is not null;
			comment on table ${tableSql(table)} is ${pg.escapeLiteral(comment)};
			comment on column ${tableSql(table)}.${ident(columnName)} is ${pg.escapeLiteral(comment)};
			alter table ${tableSql(table)} enable row level security;
			alter table ${tableSql(table)} force row level security`);
		const before = await definition(table);
		const semantic = async () => ({
			constraints: (await pool.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
				where conrelid = $1::regclass and contype <> 'n' order by conname`, [tableSql(table)])).rows,
			indexes: (await pool.query(`select pg_get_indexdef(indexrelid) as def from pg_index where indrelid = $1::regclass order by def`, [tableSql(table)])).rows,
			columns: (await pool.query(`select attname, attndims, attcollation::regcollation::text from pg_attribute
				where attrelid = $1::regclass and attnum > 0 order by attnum`, [tableSql(table)])).rows,
			sequences: (await pool.query(`select a.attname, q.seqtypid::regtype::text, q.seqstart::text, q.seqincrement::text,
				q.seqmin::text, q.seqmax::text, q.seqcache::text, q.seqcycle, d.deptype
				from pg_depend d join pg_sequence q on q.seqrelid = d.objid
				join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
				where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass
				and d.refobjid = $1::regclass and d.deptype in ('a', 'i') order by a.attname`, [tableSql(table)])).rows
		});
		const original = await semantic();
		const exported = await exportSchema(pool, target(table));
		expect(exported.sql).not.toContain('LIKE ');
		expect(exported.warnings.join(' ')).toContain('not a full pg_dump');
		expect(exported.warnings.join(' ')).toContain('policies');
		for (const warning of exported.warnings) expect(exported.sql).toContain(`-- ${warning}\n`);
		await pool.query(`drop table ${tableSql(table)}`);
		await pool.query(exported.sql);
		expect((await definition(table)).columns).toEqual(before.columns);
		expect(await semantic()).toEqual(original);
		const row = (await pool.query(`insert into ${tableSql(table)} default values returning id::text, iid::text,
			${ident(columnName)}::text as n, j::text, g::text, e::text`)).rows[0];
		expect(row).toEqual({ id: '11', iid: '20', n: '9007199254740993.000000000000001',
			j: '{"n":9007199254740993,"n":1}', g: '18014398509481986.000000000000002', e: 'two' });
		expect((await pool.query('select obj_description($1::regclass) as comment', [tableSql(table)])).rows[0].comment).toBe(comment);
	});

	test('SQL export restores standalone unique indexes before self-referencing foreign keys, retaining comments', async () => {
		const table = 'export_self_reference', index = 'export_self_unique', foreignKey = 'self_fk';
		const comment = "quoted' comment\n--still a comment";
		await pool.query(`create table ${tableSql(table)} (id int not null, parent_id int, check (id > 0));
			create unique index ${ident(index)} on ${tableSql(table)} (id);
			alter table ${tableSql(table)} add constraint ${ident(foreignKey)}
				foreign key (parent_id) references ${tableSql(table)} (id) deferrable initially deferred;
			comment on index ${tableSql(index)} is ${pg.escapeLiteral(comment)};
			comment on constraint ${ident(foreignKey)} on ${tableSql(table)} is ${pg.escapeLiteral(comment)}`);
		const constraints = async () => (await pool.query(`select conname, contype, pg_get_constraintdef(oid) as definition,
			obj_description(oid, 'pg_constraint') as comment from pg_constraint
			where conrelid = $1::regclass and contype <> 'n' order by conname`, [tableSql(table)])).rows;
		const before = await constraints();
		const exported = await exportSchema(pool, target(table));
		await pool.query(`drop table ${tableSql(table)}`);
		await pool.query(exported.sql);
		expect(await constraints()).toEqual(before);
		expect((await pool.query('select obj_description($1::regclass) as comment', [tableSql(index)])).rows[0].comment).toBe(comment);
		await pool.query(`insert into ${tableSql(table)} values (1, null), (2, 1)`);
		await expect(pool.query(`insert into ${tableSql(table)} values (3, 999)`)).rejects.toMatchObject({ code: '23503' });
	});

	test('read/clone actions reject source type/namespace races and changed sequence options', async () => {
		await pool.query(`create domain ${tableSql('clone_race_type')} as text;
			create table ${tableSql('clone_race')} (id serial, value ${tableSql('clone_race_type')})`);
		let changed = false;
		const wrapped = interleaved(async (sql) => {
			if (changed || !sql.startsWith('create table')) return;
			changed = true;
			await pool.query(`alter sequence ${tableSql('clone_race_id_seq')} increment 5`);
		});
		await expect(changeSchema(wrapped, { ...target('clone_race'), expected: (await definition('clone_race')).version,
			operation: { kind: 'duplicateTable', name: 'clone_race_failed', includeRows: false } })).rejects.toThrow('changed');
		expect(changed).toBe(true);
		expect((await pool.query('select to_regclass($1) as name', [tableSql('clone_race_failed')])).rows[0].name).toBeNull();
		changed = false;
		const exportRace = interleaved(async (sql) => {
			if (changed || !sql.includes("'namespaceOid'")) return;
			changed = true;
			await pool.query(`alter domain ${tableSql('clone_race_type')} rename to clone_race_type_old;
				alter domain ${tableSql('clone_race_type_old')} rename to clone_race_type`);
		});
		await expect(exportSchema(exportRace, target('clone_race'))).rejects.toThrow('catalog changed');
		expect(changed).toBe(true);
		for (const table of ['parent', 'parts', 'view']) await expect(exportSchema(pool, target(table))).rejects.toThrow('standalone');
	});

	test('clone/export namespace rename-and-reuse fences prevent replacement retargeting', async () => {
		const original = `${namespace}_action`, moved = `${namespace}_amoved`;
		for (const action of ['duplicate', 'export']) {
			try {
				await pool.query(`create schema ${ident(original)};
					create table ${qualify(original, 'source')} (id serial);
					insert into ${qualify(original, 'source')} default values`);
				const args = { connection: 'test', schema: original, table: 'source' };
				const before = await getSchemaDefinition(pool, args);
				let changed = false;
				const wrapped = interleaved(async (sql) => {
					if (changed || !(action === 'duplicate' ? sql.includes('with approved as') : sql.startsWith('lock table'))) return;
					changed = true;
					await pool.query(`alter schema ${ident(original)} rename to ${ident(moved)};
						create schema ${ident(original)};
						create table ${qualify(original, 'source')} (id serial);
						insert into ${qualify(original, 'source')} values (100)`);
				});
				if (action === 'duplicate') {
					await expect(changeSchema(wrapped, { ...args, expected: before.version,
						operation: { kind: 'duplicateTable', name: 'copy', includeRows: true } })).rejects.toThrow('catalog changed');
				} else await expect(exportSchema(wrapped, args)).rejects.toThrow('changed');
				expect(changed).toBe(true);
				for (const schema of [original, moved]) {
					expect((await pool.query('select to_regclass($1) as name', [qualify(schema, 'copy')])).rows[0].name).toBeNull();
					expect((await pool.query(`select last_value::text, is_called from ${qualify(schema, 'source_id_seq')}`)).rows[0])
						.toEqual({ last_value: '1', is_called: schema === moved });
				}
			} finally {
				await pool.query(`drop schema if exists ${ident(original)} cascade; drop schema if exists ${ident(moved)} cascade`);
			}
		}
	});
});
