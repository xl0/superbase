import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

import { schemaChangeSchema, schemaTargetSchema } from '../src/lib/schema-validation.js';
import type { ColumnDefault, ColumnSpec, SchemaCatalog, SchemaColumn, SchemaOperation, SchemaType } from '../src/lib/schema.js';
import { columnOptionsError, defaultOptions, elementType, typeOptionsError } from '../src/lib/schema-options.js';
import { changeSchema, getSchemaDefinition, listSchemaCatalog } from '../src/lib/server/schema.js';
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
});
