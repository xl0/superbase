import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

import { constraintOperationSchema, schemaChangeSchema, schemaTargetSchema } from '../src/lib/schema-validation.js';
import type { ColumnDefault, ColumnSpec, ConstraintSpec, SchemaCatalog, SchemaColumn, SchemaDefinition, SchemaOperation, SchemaType } from '../src/lib/schema.js';
import { displayIdentifier } from '../src/lib/schema-forms.js';
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
const uniqueConstraint = (name: string, columns = ['v']): Extract<ConstraintSpec, { kind: 'unique' }> => ({
	kind: 'unique', name, columns, nullsNotDistinct: false, deferrable: false, initiallyDeferred: false
});
const checkConstraint = (name: string, expression = 'v > 0'): Extract<ConstraintSpec, { kind: 'check' }> => ({
	kind: 'check', name, expression, notValid: false, noInherit: false
});
const foreignKeyConstraint = (name: string, target: Pick<SchemaDefinition, 'schema' | 'table' | 'oid' | 'version'>,
	columns = ['v'], referencedColumns = ['id']): Extract<ConstraintSpec, { kind: 'foreignKey' }> => ({
	kind: 'foreignKey', name, columns, reference: { schema: target.schema, table: target.table, oid: target.oid, version: target.version, columns: referencedColumns },
	match: 'simple', onUpdate: 'no action', onDelete: 'no action', notValid: false, deferrable: false, initiallyDeferred: false
});

describe('structured schema validation', () => {
	test('FK and column batches have strict nested keys, dense arrays, captured targets and bounded operations', () => {
		const fk = foreignKeyConstraint('fk', { schema: 'public', table: 'parent', oid: '123', version: 'a'.repeat(64) });
		const add = { kind: 'addConstraint', constraint: fk } as const;
		expect(constraintOperationSchema['~standard'].validate(add)).toHaveProperty('value');
		for (const constraint of [
			{ ...fk, columns: [] }, { ...fk, columns: ['v', 'v'] }, { ...fk, columns: ['v', 'n'] },
			{ ...fk, columns: Array(1) }, { ...fk, columns: Object.assign(['v'], { [Symbol('extra')]: true }) },
			{ ...fk, columns: Object.setPrototypeOf(['v'], {}) },
			{ ...fk, onUpdate: 'CASCADE' }, { ...fk, onDelete: 'drop table' }, { ...fk, match: 'partial' },
			{ ...fk, deferrable: 'false' }, { ...fk, initiallyDeferred: true }, { ...fk, notValid: 1 },
			{ ...fk, reference: { ...fk.reference, oid: '0' } },
			{ ...fk, reference: { ...fk.reference, version: 'x'.repeat(64) } },
			{ ...fk, reference: { ...fk.reference, columns: ['id', 'id'] } },
			{ ...fk, reference: { ...fk.reference, table: 'é'.repeat(32) } },
			{ ...fk, reference: { ...fk.reference, [Symbol('extra')]: 1 } },
			{ ...fk, reference: Object.assign(Object.create({}), fk.reference) }
		]) expect(constraintOperationSchema['~standard'].validate({ ...add, constraint })).toHaveProperty('issues');
		const batch = { kind: 'alterColumn', column: 'v', changes: column('renamed', null), constraints: [add] };
		const args = { ...target('t'), expected: 'a'.repeat(64), operation: batch };
		expect(validate(args)).toHaveProperty('value');
		expect(validate({ ...args, operation: { ...batch, constraints: [] } })).toHaveProperty('value');
		for (const constraints of [
			Array(1), Object.assign([add], { [Symbol('extra')]: 1 }), Object.setPrototypeOf([add], {}),
			Array.from({ length: 21 }, () => add), [{ kind: 'renameConstraint', constraintOid: '1', name: 'new' }],
			[{ kind: 'validateConstraint', constraintOid: '1' }],
			[{ kind: 'dropConstraint', constraintOid: '1' }, { kind: 'alterConstraint', constraintOid: '1', constraint: fk }],
			undefined, null
		]) expect(validate({ ...args, operation: { ...batch, constraints } })).toHaveProperty('issues');
	});

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

	test('constraint intents strictly bound specs, flags, expressions and captured OIDs', () => {
		const expected = 'a'.repeat(64), unique = uniqueConstraint('u'), check = checkConstraint('c');
		for (const constraint of [
			unique, check, { ...unique, columns: Array.from({ length: 32 }, (_, i) => `c${i}`) },
			{ ...unique, deferrable: true, initiallyDeferred: true },
			{ ...check, expression: ' '.repeat(9996) + 'true', notValid: true, noInherit: true }
		]) {
			expect(validate(valid({ kind: 'addConstraint', constraint }, expected))).toHaveProperty('value');
			expect(validate(valid({ kind: 'alterConstraint', constraintOid: '123', constraint }, expected))).toHaveProperty('value');
		}
		for (const constraint of [
			{ ...unique, columns: [] }, { ...unique, columns: ['v', 'v'] },
			{ ...unique, columns: Array.from({ length: 33 }, (_, i) => `c${i}`) },
			{ ...unique, columns: Array(1) }, { ...unique, initiallyDeferred: true },
			{ ...unique, nullsNotDistinct: 'false' }, { ...unique, deferrable: 1 },
			{ ...unique, initiallyDeferred: null }, { ...unique, name: 'é'.repeat(32) },
			{ ...unique, include: ['x'] }, { ...unique, kind: 'foreignKey' },
			{ ...check, expression: '' }, { ...check, expression: ' \n\t' },
			{ ...check, expression: 'x'.repeat(10001) }, { ...check, expression: 'true\0' },
			{ ...check, expression: '\ud800' }, { ...check, notValid: 'false' },
			{ ...check, noInherit: 0 }, { ...check, sql: 'select 1' },
			{ kind: 'check', name: 'c', expression: 'true', notValid: false },
			Object.assign(Object.create({ kind: 'check' }), { name: 'c', expression: 'true', notValid: false, noInherit: false }),
			{ ...check, [Symbol('extra')]: true }
		]) expect(validate({ ...valid({ kind: 'addConstraint', constraint: check }, expected),
			operation: { kind: 'addConstraint', constraint } })).toHaveProperty('issues');
		for (const kind of ['alterConstraint', 'renameConstraint', 'dropConstraint', 'validateConstraint'] as const) {
			const operation = { kind, constraintOid: '123',
				...(kind === 'alterConstraint' ? { constraint: unique } : kind === 'renameConstraint' ? { name: '__proto__' } : {}) };
			const args = { ...target('t'), expected, operation };
			expect(validate(args)).toHaveProperty('value');
			for (const constraintOid of ['0', '-1', '1;select 1', '12345678901', 123, undefined]) {
				expect(validate({ ...args, operation: { ...operation, constraintOid } })).toHaveProperty('issues');
			}
			expect(validate({ ...args, expected: null })).toHaveProperty('issues');
			expect(validate({ ...args, operation: { ...operation, cascade: true } })).toHaveProperty('issues');
		}
	});
});

describe('shared contextual schema options', () => {
	test('joined constraint labels distinguish dotted targets and comma-containing keys', () => {
		expect(['a.b', 'c'].map(displayIdentifier).join('.')).toBe('"a.b".c');
		expect(['a', 'b.c'].map(displayIdentifier).join('.')).toBe('a."b.c"');
		expect(['a, b'].map(displayIdentifier).join(', ')).toBe('"a, b"');
		expect(['a', 'b'].map(displayIdentifier).join(', ')).toBe('a, b');
		expect(displayIdentifier('A"B')).toBe('"A""B"');
	});

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
function interleaved(run: (sql: string) => Promise<void>, source: pg.Pool = pool): pg.Pool {
	return { connect: async () => {
		const client = await source.connect();
		return {
			release: () => client.release(),
			query: async (sql: string | pg.Query, values?: unknown[]) => {
				if (typeof sql !== 'string') return client.query(sql);
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

	test('FK metadata exposes owned ordered tuples and eligible key-only indexes, including INCLUDE and PK', async () => {
		await pool.query(`create table ${tableSql('fk_keys')} (id int, a int, b int, n int,
				primary key (id) include (n),
				constraint fk_keys_deferred unique (n) deferrable,
				constraint fk_keys_include unique (a, b) include (n));
			create unique index fk_partial on ${tableSql('fk_keys')} (n) where n > 0;
			create unique index fk_expression on ${tableSql('fk_keys')} ((a + b));
			create unique index fk_duplicate on ${tableSql('fk_keys')} (id, id);
			create table ${tableSql('fk_metadata')} (v int, w int, z int,
				constraint fk_metadata_ref foreign key (v, w) references ${tableSql('fk_keys')} (b, a)
					match full on update cascade on delete set null (v))`);
		const keys = await definition('fk_keys');
		expect(keys.primaryKey).toEqual(['id']);
		expect(keys.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true);
		expect(keys.columns.find((column) => column.name === 'n')?.primaryKey).toBe(false);
		expect(keys.indexes.find((index) => index.primary)).toMatchObject({ columns: ['id'], referenceable: true });
		expect(keys.indexes.find((index) => index.name === 'fk_keys_include')).toMatchObject({ columns: ['a', 'b'], referenceable: true });
		expect(keys.constraints.find((constraint) => constraint.name === 'fk_keys_include')).toMatchObject({ columns: ['a', 'b'], replaceable: false });
		for (const name of ['fk_keys_deferred', 'fk_partial', 'fk_expression', 'fk_duplicate']) {
			expect(keys.indexes.find((index) => index.name === name)?.referenceable).toBe(false);
		}
		expect(keys.constraints.every((constraint) => constraint.kind === 'u')).toBe(true);
		const fk = (await definition('fk_metadata')).constraints[0];
		expect(fk).toMatchObject({ kind: 'f', columns: ['v', 'w'], indexOid: null, indexComment: null,
			replaceable: false, foreignKey: { schema: namespace, table: 'fk_keys', tableOid: keys.oid,
				columns: ['b', 'a'], match: 'full', onUpdate: 'cascade', onDelete: 'set null' } });
		await expect(change('fk_metadata', { kind: 'alterConstraint', constraintOid: fk.oid,
			constraint: foreignKeyConstraint('fk_metadata_ref', keys, ['v', 'w'], ['b', 'a']) })).rejects.toThrow('Use SQL');
		await change('fk_metadata', { kind: 'renameConstraint', constraintOid: fk.oid, name: 'advanced_renamed' });
		await change('fk_metadata', { kind: 'dropConstraint', constraintOid: fk.oid });
		for (const columns of [['n'], ['a'], ['a', 'b', 'n']]) {
			await expect(change('fk_metadata', { kind: 'addConstraint',
				constraint: foreignKeyConstraint('bad_key', await definition('fk_keys'), ['v', 'w', 'z'].slice(0, columns.length), columns) }))
				.rejects.toThrow('eligible unique key');
		}
		await change('fk_metadata', { kind: 'addConstraint',
			constraint: foreignKeyConstraint('include_keys_only', await definition('fk_keys'), ['v', 'w'], ['a', 'b']) });
		expect((await definition('fk_metadata')).constraints[0].columns).toEqual(['v', 'w']);
	});

	test('native composite FK actions, deferral, NOT VALID and replacement preserve only FK comments', async () => {
		await pool.query(`create table ${tableSql('fk_parent')} (a int, b int, constraint fk_parent_key unique (a, b));
			create table ${tableSql('fk_child')} (v int, w int);
			insert into ${tableSql('fk_parent')} values (1, 2);
			insert into ${tableSql('fk_child')} values (8, 9);
			comment on index ${tableSql('fk_parent_key')} is 'referenced index untouched'`);
		let spec = { ...foreignKeyConstraint('fk_child_ref', await definition('fk_parent'), ['v', 'w'], ['b', 'a']),
			match: 'full' as const, onUpdate: 'cascade' as const, onDelete: 'set null' as const,
			deferrable: true, initiallyDeferred: true, notValid: true };
		await change('fk_child', { kind: 'addConstraint', constraint: spec });
		let fk = (await definition('fk_child')).constraints[0];
		expect(fk).toMatchObject({ kind: 'f', validated: false, deferrable: true, initiallyDeferred: true,
			replaceable: true, indexOid: null, indexComment: null });
		await expect(change('fk_child', { kind: 'validateConstraint', constraintOid: fk.oid })).rejects.toMatchObject({ code: '23503' });
		await expect(pool.query(`insert into ${tableSql('fk_child')} values (1, null)`)).rejects.toMatchObject({ code: '23503' });
		await pool.query(`delete from ${tableSql('fk_child')}; insert into ${tableSql('fk_child')} values (2, 1);
			update ${tableSql('fk_parent')} set a = 3;
			comment on constraint fk_child_ref on ${tableSql('fk_child')} is 'keep FK comment'`);
		expect((await pool.query(`select * from ${tableSql('fk_child')}`)).rows).toEqual([{ v: 2, w: 3 }]);
		await change('fk_child', { kind: 'validateConstraint', constraintOid: fk.oid });
		const client = await pool.connect();
		try {
			await client.query('begin');
			await client.query(`insert into ${tableSql('fk_child')} values (20, 10)`);
			await client.query(`insert into ${tableSql('fk_parent')} values (10, 20)`);
			await client.query('commit');
		} finally { await client.query('rollback'); client.release(); }
		spec = { ...spec, reference: foreignKeyConstraint('unused', await definition('fk_parent'), ['v', 'w'], ['b', 'a']).reference, notValid: false };
		await change('fk_child', { kind: 'alterConstraint', constraintOid: fk.oid, constraint: spec });
		fk = (await definition('fk_child')).constraints[0];
		expect(fk).toMatchObject({ validated: true, comment: 'keep FK comment', indexComment: null });
		expect((await definition('fk_parent')).indexes[0].comment).toBe('referenced index untouched');
		await pool.query(`delete from ${tableSql('fk_parent')}`);
		expect((await pool.query(`select * from ${tableSql('fk_child')}`)).rows).toEqual([{ v: null, w: null }, { v: null, w: null }]);
		await change('fk_child', { kind: 'renameConstraint', constraintOid: fk.oid, name: 'fk_renamed' });
		await change('fk_child', { kind: 'dropConstraint', constraintOid: fk.oid });
		expect((await definition('fk_parent')).indexes[0].comment).toBe('referenced index untouched');
	});

	test('advanced FK enforcement and temporal options stay inspectable but cannot be replaced', async () => {
		const version = Number((await pool.query('show server_version_num')).rows[0].server_version_num);
		if (version < 180000) return;
		await pool.query(`create table ${tableSql('fk_advanced_parent')} (id int primary key);
			create table ${tableSql('fk_advanced_child')} (v int,
				constraint fk_unenforced foreign key (v) references ${tableSql('fk_advanced_parent')} (id) not enforced);
			create table ${tableSql('fk_period_parent')} (bucket int4range, span daterange, unique (bucket, span without overlaps));
			create table ${tableSql('fk_period_child')} (bucket int4range, span daterange,
				constraint fk_period foreign key (bucket, period span) references ${tableSql('fk_period_parent')} (bucket, period span))`);
		const temporal = await definition('fk_period_parent');
		expect(temporal.indexes[0].referenceable).toBe(false);
		for (const table of ['fk_advanced_child', 'fk_period_child']) {
			const fk = (await definition(table)).constraints[0];
			expect(fk).toMatchObject({ kind: 'f', replaceable: false, indexOid: null, indexComment: null });
			if (table === 'fk_advanced_child') {
				expect(fk.enforced).toBe(false);
				await expect(change(table, { kind: 'validateConstraint', constraintOid: fk.oid })).rejects.toThrow('enforced');
			}
			const ref = await definition(table === 'fk_advanced_child' ? 'fk_advanced_parent' : 'fk_period_parent');
			await expect(change(table, { kind: 'alterConstraint', constraintOid: fk.oid,
				constraint: foreignKeyConstraint(fk.name, ref, fk.columns, fk.foreignKey!.columns) })).rejects.toThrow('Use SQL');
			await change(table, { kind: 'renameConstraint', constraintOid: fk.oid, name: `${fk.name}_renamed` });
			await change(table, { kind: 'dropConstraint', constraintOid: fk.oid });
		}
	});

	test('FK fingerprints cover RI trigger modes, exact native names and comments on both relations', async () => {
		await pool.query(`create table ${tableSql('fk_trigger_parent')} (id int primary key);
			create table ${tableSql('fk_trigger_child')} (v int constraint fk_trigger_ref references ${tableSql('fk_trigger_parent')} (id))`);
		const before = await definition('fk_trigger_child'), parentBefore = await definition('fk_trigger_parent');
		const fk = before.constraints[0];
		expect(fk.replaceable).toBe(true);
		const triggers = (await pool.query<{ oid: string; name: string; table: string; function: string }>(`
			select t.oid::text, t.tgname as name, c.relname as table, p.proname as function
			from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
			where t.tgconstraint = $1::oid order by t.oid`, [fk.oid])).rows;
		expect(triggers).toHaveLength(4);
		for (const trigger of triggers) {
			const prefix = ['RI_FKey_check_ins', 'RI_FKey_check_upd'].includes(trigger.function) ? 'c' : 'a';
			expect(trigger.name).toBe(`RI_ConstraintTrigger_${prefix}_${trigger.oid}`);
			for (const customization of ['always', 'replica', 'disabled', 'name', 'comment']) {
				const renamed = `RI_ConstraintTrigger_${prefix}_${trigger.oid}0`;
				await pool.query(customization === 'name'
					? `alter trigger ${ident(trigger.name)} on ${tableSql(trigger.table)} rename to ${ident(renamed)}`
					: customization === 'comment'
						? `comment on trigger ${ident(trigger.name)} on ${tableSql(trigger.table)} is 'preserve RI comment'`
						: `alter table ${tableSql(trigger.table)} ${customization === 'disabled' ? 'disable' : `enable ${customization}`} trigger ${ident(trigger.name)}`);
				const customized = await definition('fk_trigger_child'), parentCustomized = await definition('fk_trigger_parent');
				expect(customized.version).not.toBe(before.version);
				expect(parentCustomized.version).not.toBe(parentBefore.version);
				expect(customized.constraints[0].replaceable).toBe(false);
				await expect(change('fk_trigger_child', { kind: 'alterConstraint', constraintOid: fk.oid,
					constraint: foreignKeyConstraint(fk.name, parentCustomized) })).rejects.toThrow('Use SQL');
				expect((await definition('fk_trigger_child')).version).toBe(customized.version);
				if (customization === 'always' && trigger.function === 'RI_FKey_check_ins') {
					const client = await pool.connect();
					try {
						await client.query('begin; set local session_replication_role = replica');
						await expect(client.query(`insert into ${tableSql('fk_trigger_child')} values (999)`)).rejects.toMatchObject({ code: '23503' });
					} finally { await client.query('rollback'); client.release(); }
				}
				await pool.query(customization === 'name'
					? `alter trigger ${ident(renamed)} on ${tableSql(trigger.table)} rename to ${ident(trigger.name)}`
					: customization === 'comment'
						? `comment on trigger ${ident(trigger.name)} on ${tableSql(trigger.table)} is null`
						: `alter table ${tableSql(trigger.table)} enable trigger ${ident(trigger.name)}`);
				expect((await definition('fk_trigger_child')).version).toBe(before.version);
			}
		}
		const action = triggers.find((trigger) => trigger.table === 'fk_trigger_parent')!;
		await pool.query(`comment on trigger ${ident(action.name)} on ${tableSql(action.table)} is 'keep through rename'`);
		await change('fk_trigger_child', { kind: 'renameConstraint', constraintOid: fk.oid, name: 'fk_trigger_renamed' });
		expect((await pool.query(`select obj_description($1::oid, 'pg_trigger') as comment`, [action.oid])).rows[0].comment).toBe('keep through rename');
		await change('fk_trigger_child', { kind: 'dropConstraint', constraintOid: fk.oid });
		expect((await pool.query('select oid from pg_trigger where tgconstraint = $1::oid', [fk.oid])).rows).toEqual([]);
	});

	test('retargeting an existing partitioned FK stays SQL-only and preserves child RI trigger customizations', async () => {
		await pool.query(`create table ${tableSql('fk_old_partitioned')} (id int primary key) partition by range (id);
			create table ${tableSql('fk_old_partition')} partition of ${tableSql('fk_old_partitioned')} for values from (0) to (10);
			create table ${tableSql('fk_old_partition_source')} (v int references ${tableSql('fk_old_partitioned')} (id));
			create table ${tableSql('fk_old_partition_new')} (id int primary key)`);
		const initial = await definition('fk_old_partition_source');
		const parent = initial.constraints.find((constraint) => constraint.foreignKey?.table === 'fk_old_partitioned')!;
		expect(parent.replaceable).toBe(false);
		const trigger = (await pool.query(`select t.oid::text, t.tgname as name from pg_trigger t
			join pg_constraint con on con.oid = t.tgconstraint where con.conparentid = $1::oid order by t.oid limit 1`, [parent.oid])).rows[0];
		await pool.query(`comment on trigger ${ident(trigger.name)} on ${tableSql('fk_old_partition')} is 'preserve partition trigger'`);
		const before = await definition('fk_old_partition_source');
		await expect(change('fk_old_partition_source', { kind: 'alterColumn', column: 'v',
			changes: column('v', typeOid('int8')), constraints: [] })).rejects.toThrow('Use SQL to change this FK key type');
		await expect(change('fk_old_partition_source', { kind: 'alterConstraint', constraintOid: parent.oid,
			constraint: foreignKeyConstraint(parent.name, await definition('fk_old_partition_new')) })).rejects.toThrow('Use SQL');
		expect((await definition('fk_old_partition_source')).version).toBe(before.version);
		await change('fk_old_partition_source', { kind: 'renameConstraint', constraintOid: parent.oid, name: 'partition_ref_renamed' });
		expect((await pool.query(`select obj_description($1::oid, 'pg_trigger') as comment`, [trigger.oid])).rows[0].comment).toBe('preserve partition trigger');
		await change('fk_old_partition_source', { kind: 'dropConstraint', constraintOid: parent.oid });
		expect((await definition('fk_old_partition_source')).constraints).toEqual([]);
		await pool.query(`create table ${tableSql('fk_cast_partition_source')} (v int references ${tableSql('fk_old_partition_new')} (id))
				partition by range (v);
			create table ${tableSql('fk_cast_partition_leaf')} partition of ${tableSql('fk_cast_partition_source')} for values from (0) to (10)`);
		const referenced = await definition('fk_old_partition_new');
		await expect(change('fk_old_partition_new', { kind: 'alterColumn', column: 'id',
			changes: column('id', typeOid('int8'), { nullable: false, primaryKey: true }) }))
			.rejects.toThrow('Use SQL to change this FK key type');
		expect((await definition('fk_old_partition_new')).version).toBe(referenced.version);
	});

	test('FK key casts cannot implicitly discard RI customizations, but unrelated edits and explicit drops remain native', async () => {
		for (const customization of ['mode', 'comment', 'name'] as const) {
			const parent = `fk_cast_parent_${customization}`, child = `fk_cast_child_${customization}`;
			await pool.query(`create table ${tableSql(parent)} (id int primary key, other int);
				create table ${tableSql(child)} (v int references ${tableSql(parent)} (id), other int)`);
			const fk = (await definition(child)).constraints[0];
			const trigger = (await pool.query(`select t.oid::text, t.tgname as name, c.relname as table
				from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgconstraint = $1::oid
					and t.tgrelid = $2::regclass order by t.oid limit 1`, [fk.oid, tableSql(customization === 'comment' ? parent : child)])).rows[0];
			await pool.query(customization === 'mode'
				? `alter table ${tableSql(trigger.table)} enable always trigger ${ident(trigger.name)}`
				: customization === 'comment'
					? `comment on trigger ${ident(trigger.name)} on ${tableSql(trigger.table)} is 'keep through column edits'`
					: `alter trigger ${ident(trigger.name)} on ${tableSql(trigger.table)} rename to custom_ri_trigger`);
			const triggerState = async () => (await pool.query(`select oid::text, tgname, tgenabled, obj_description(oid, 'pg_trigger') as comment
				from pg_trigger where tgconstraint = $1::oid order by oid`, [fk.oid])).rows;
			const triggersBefore = await triggerState();
			const childBefore = await definition(child), parentBefore = await definition(parent);
			for (const [table, op] of [
				[child, { kind: 'alterColumn', column: 'v', changes: column('v', typeOid('int8')) }],
				[child, { kind: 'alterColumn', column: 'v', changes: column('v', typeOid('int4')), constraints: [] }],
				[parent, { kind: 'alterColumn', column: 'id', changes: column('id', typeOid('int8'), { primaryKey: true, nullable: false }),
					constraints: [{ kind: 'addConstraint', constraint: checkConstraint('must_not_create', 'id > 0') }] }]
			] satisfies [string, SchemaOperation][]) {
				await expect(change(table, op)).rejects.toThrow('Use SQL to change this FK key type');
				expect((await definition(child)).version).toBe(childBefore.version);
				expect((await definition(parent)).version).toBe(parentBefore.version);
			}
			for (const table of [child, parent]) {
				const before = await definition(table);
				let relatedLock = false;
				const wrapped = interleaved(async (sql) => {
					if (sql === `lock table only ${tableSql(table === child ? parent : child)} in access exclusive mode`) relatedLock = true;
				});
				await changeSchema(wrapped, { ...target(table), expected: before.version,
					operation: { kind: 'alterColumn', column: 'other', changes: column('other', typeOid('int8')), constraints: [] } });
				expect(relatedLock).toBe(false);
				expect((await definition(table)).columns.find((column) => column.name === 'other')?.type).toBe('bigint');
				expect(await triggerState()).toEqual(triggersBefore);
			}
			await change(child, { kind: 'alterColumn', column: 'v', changes: column('renamed', null, { nullable: false }) });
			expect(await triggerState()).toEqual(triggersBefore);
			await change(child, { kind: 'alterColumn', column: 'renamed', changes: column('final', typeOid('int8'), { nullable: false }),
				constraints: [{ kind: 'dropConstraint', constraintOid: fk.oid }] });
			expect((await definition(child)).constraints).toEqual([]);
			expect(await triggerState()).toEqual([]);
		}
	});

	test('column Apply drops old CHECK before type changes, creates against new types and renames last atomically', async () => {
		await pool.query(`create table ${tableSql('column_constraints')} (v text constraint column_old_check check (length(v) > 0),
				n int constraint column_n_key unique);
			insert into ${tableSql('column_constraints')} values ('12', 1);
			comment on constraint column_old_check on ${tableSql('column_constraints')} is 'preserved check';
			comment on index ${tableSql('column_n_key')} is 'preserved index'`);
		const before = await definition('column_constraints');
		const check = before.constraints.find((constraint) => constraint.kind === 'c')!;
		const unique = before.constraints.find((constraint) => constraint.kind === 'u')!;
		await change('column_constraints', { kind: 'alterColumn', column: 'v', changes: column('renamed', typeOid('int4')),
			constraints: [
				{ kind: 'alterConstraint', constraintOid: check.oid, constraint: checkConstraint('column_new_check', 'v > 0') },
				{ kind: 'alterConstraint', constraintOid: unique.oid, constraint: uniqueConstraint('column_n_key', ['n']) },
				{ kind: 'addConstraint', constraint: uniqueConstraint('column_v_key', ['v']) }
			] });
		const after = await definition('column_constraints');
		expect(after.columns[0]).toMatchObject({ name: 'renamed', type: 'integer' });
		expect(after.constraints.find((constraint) => constraint.kind === 'c')).toMatchObject({
			expression: '(renamed > 0)', columns: ['renamed'], comment: 'preserved check'
		});
		expect(after.constraints.find((constraint) => constraint.name === 'column_n_key')?.indexComment).toBe('preserved index');
		expect((await pool.query(`select * from ${tableSql('column_constraints')}`)).rows).toEqual([{ renamed: 12, n: 1 }]);
		const op: SchemaOperation = { kind: 'alterColumn', column: 'renamed',
			changes: column('failed_rename', typeOid('int8'), { comment: 'must roll back' }),
			constraints: [
				{ kind: 'dropConstraint', constraintOid: after.constraints.find((constraint) => constraint.kind === 'c')!.oid },
				{ kind: 'addConstraint', constraint: checkConstraint('final_failure', 'renamed < 0') }
			] };
		await expect(change('column_constraints', op)).rejects.toMatchObject({ code: '23514' });
		expect((await definition('column_constraints')).version).toBe(after.version);
	});

	test('self FK batches use the original captured version and names through type and final column rename', async () => {
		await pool.query(`create table ${tableSql('fk_self')} (v int primary key, parent int);
			insert into ${tableSql('fk_self')} values (1, 1)`);
		const before = await definition('fk_self');
		const racer = await pool.connect();
		let locked = false;
		try {
			await racer.query("set lock_timeout = '100ms'");
			const wrapped = interleaved(async (sql) => {
				if (locked || !sql.startsWith(`alter index ${tableSql('fk_self_pkey')} set tablespace`)) return;
				locked = true;
				await expect(racer.query(`alter index ${tableSql('fk_self_pkey')} rename to raced_self_key`))
					.rejects.toMatchObject({ code: '55P03' });
			});
			await changeSchema(wrapped, { ...target('fk_self'), expected: before.version, operation: {
				kind: 'alterColumn', column: 'v', changes: column('id', typeOid('int8'), { primaryKey: true, nullable: false }),
				constraints: [{ kind: 'addConstraint', constraint: foreignKeyConstraint('self_ref', before, ['parent'], ['v']) },
					{ kind: 'addConstraint', constraint: checkConstraint('self_check', 'v > 0') }] } });
			expect(locked).toBe(true);
		} finally { await racer.query('reset lock_timeout'); racer.release(); }
		const after = await definition('fk_self');
		expect(after.constraints.find((constraint) => constraint.kind === 'f')?.foreignKey?.columns).toEqual(['id']);
		await expect(pool.query(`insert into ${tableSql('fk_self')} values (2, 99)`)).rejects.toMatchObject({ code: '23503' });
		await expect(change('fk_self', { kind: 'alterColumn', column: 'parent', changes: column('not_saved', null),
			constraints: [{ kind: 'addConstraint', constraint: foreignKeyConstraint('stale_self', before, ['parent'], ['v']) }] }))
			.rejects.toThrow('Referenced table schema changed');
		expect((await definition('fk_self')).version).toBe(after.version);
	});

	test('FK native errors, stale references and dependency drops roll back the entire column batch', async () => {
		await pool.query(`create table ${tableSql('fk_atomic_parent')} (id int unique);
			create table ${tableSql('fk_atomic_child')} (v int constraint fk_atomic_check check (v > 0));
			insert into ${tableSql('fk_atomic_child')} values (7)`);
		let parent = await definition('fk_atomic_parent');
		const before = await definition('fk_atomic_child');
		const op: SchemaOperation = { kind: 'alterColumn', column: 'v', changes: column('unsaved', typeOid('int8')),
			constraints: [
				{ kind: 'dropConstraint', constraintOid: before.constraints[0].oid },
				{ kind: 'addConstraint', constraint: checkConstraint('intermediate', 'v < 100') },
				{ kind: 'addConstraint', constraint: foreignKeyConstraint('final_fk', parent) }
			] };
		await expect(change('fk_atomic_child', op)).rejects.toMatchObject({ code: '23503' });
		expect((await definition('fk_atomic_child')).version).toBe(before.version);
		await pool.query(`comment on table ${tableSql('fk_atomic_parent')} is 'stale'`);
		await expect(change('fk_atomic_child', op)).rejects.toThrow('Referenced table schema changed');
		expect((await definition('fk_atomic_child')).version).toBe(before.version);
		parent = await definition('fk_atomic_parent');
		await pool.query(`insert into ${tableSql('fk_atomic_parent')} values (7)`);
		await change('fk_atomic_child', { kind: 'addConstraint', constraint: foreignKeyConstraint('dependent_fk', parent) });
		parent = await definition('fk_atomic_parent');
		await expect(change('fk_atomic_parent', { kind: 'alterColumn', column: 'id', changes: column('not_saved', null),
			constraints: [{ kind: 'dropConstraint', constraintOid: parent.constraints[0].oid }] })).rejects.toMatchObject({ code: '2BP01' });
		expect((await definition('fk_atomic_parent')).version).toBe(parent.version);
		await expect(change('fk_atomic_child', { kind: 'dropConstraint', constraintOid: parent.constraints[0].oid })).rejects.toThrow('no longer belongs');
		await pool.query(`create table ${tableSql('fk_incompatible')} (v text);
			create table ${tableSql('fk_partition_target')} (id int primary key) partition by range (id)`);
		const incompatible = await definition('fk_incompatible');
		await expect(change('fk_incompatible', { kind: 'alterColumn', column: 'v', changes: column('unsaved', typeOid('date')),
			constraints: [{ kind: 'addConstraint', constraint: foreignKeyConstraint('bad_types', parent) }] }))
			.rejects.toMatchObject({ code: '42804' });
		expect((await definition('fk_incompatible')).version).toBe(incompatible.version);
		await expect(change('fk_incompatible', { kind: 'alterColumn', column: 'v', changes: column('unsaved', null),
			constraints: [{ kind: 'addConstraint', constraint: foreignKeyConstraint('bad_target', await definition('fk_partition_target')) }] }))
			.rejects.toThrow('ordinary standalone');
		expect((await definition('fk_incompatible')).version).toBe(incompatible.version);
	});

	test('self FK and UNIQUE replacements respect dependency order and never treat the referenced index as FK-owned', async () => {
		await pool.query(`create table ${tableSql('fk_self_replace')} (v int not null constraint self_replace_key unique, parent int,
				constraint self_replace_ref foreign key (parent) references ${tableSql('fk_self_replace')} (v));
			insert into ${tableSql('fk_self_replace')} values (1, 1);
			comment on index ${tableSql('self_replace_key')} is 'key comment';
			comment on constraint self_replace_ref on ${tableSql('fk_self_replace')} is 'FK comment'`);
		const before = await definition('fk_self_replace');
		const key = before.constraints.find((constraint) => constraint.kind === 'u')!;
		const fk = before.constraints.find((constraint) => constraint.kind === 'f')!;
		await change('fk_self_replace', { kind: 'alterColumn', column: 'v', changes: column('id', typeOid('int8'), { nullable: false }),
			constraints: [
				{ kind: 'alterConstraint', constraintOid: key.oid, constraint: uniqueConstraint(key.name, ['v']) },
				{ kind: 'alterConstraint', constraintOid: fk.oid, constraint: foreignKeyConstraint(fk.name, before, ['parent'], ['v']) }
			] });
		let after = await definition('fk_self_replace');
		expect(after.constraints.find((constraint) => constraint.kind === 'u')).toMatchObject({ columns: ['id'], indexComment: 'key comment' });
		expect(after.constraints.find((constraint) => constraint.kind === 'f')).toMatchObject({ comment: 'FK comment', indexComment: null,
			foreignKey: { columns: ['id'] } });
		await pool.query(`alter table ${tableSql('fk_self_replace')} replica identity using index self_replace_key`);
		after = await definition('fk_self_replace');
		await change('fk_self_replace', { kind: 'dropConstraint', constraintOid: after.constraints.find((constraint) => constraint.kind === 'f')!.oid });
		expect((await definition('fk_self_replace')).indexes[0]).toMatchObject({ replicaIdentity: true, comment: 'key comment' });
	});

	test('cross-schema FKs retain native REFERENCES permissions and all referential actions', async () => {
		const schema = `${namespace}_fk`, role = `${namespace}_fkowner`;
		let owner: pg.Pool | undefined;
		try {
			await pool.query(`create schema ${ident(schema)};
				create role ${ident(role)};
				grant usage on schema ${ident(schema)}, ${ident(namespace)} to ${ident(role)};
				create table ${qualify(schema, 'parent')} (id int primary key);
				create table ${tableSql('fk_permission')} (v int default 1);
				alter table ${tableSql('fk_permission')} owner to ${ident(role)};
				insert into ${qualify(schema, 'parent')} values (1), (2)`);
			owner = new pg.Pool({ connectionString: url, options: `-c role=${role}`, max: 1 });
			const refTarget = { connection: 'test', schema, table: 'parent' };
			let ref = await getSchemaDefinition(owner, refTarget);
			let source = await getSchemaDefinition(owner, target('fk_permission'));
			await expect(changeSchema(owner, { ...target('fk_permission'), expected: source.version,
				operation: { kind: 'addConstraint', constraint: foreignKeyConstraint('permission_ref', ref) } }))
				.rejects.toMatchObject({ code: '42501' });
			await pool.query(`grant references (id) on ${qualify(schema, 'parent')} to ${ident(role)}`);
			for (const action of ['no action', 'restrict', 'cascade', 'set null', 'set default'] as const) {
				ref = await getSchemaDefinition(owner, refTarget);
				source = await getSchemaDefinition(owner, target('fk_permission'));
				await changeSchema(owner, { ...target('fk_permission'), expected: source.version,
					operation: { kind: 'addConstraint', constraint: { ...foreignKeyConstraint('permission_ref', ref),
						onUpdate: action, onDelete: action } } });
				let fk = (await getSchemaDefinition(owner, target('fk_permission'))).constraints[0];
				expect(fk.foreignKey).toMatchObject({ schema, onUpdate: action, onDelete: action });
				if (action === 'no action') {
					source = await getSchemaDefinition(owner, target('fk_permission'));
					ref = await getSchemaDefinition(owner, refTarget);
					const replacement: SchemaOperation = { kind: 'alterConstraint', constraintOid: fk.oid,
						constraint: foreignKeyConstraint(fk.name, ref) };
					await expect(changeSchema(owner, { ...target('fk_permission'), expected: source.version, operation: replacement }))
						.rejects.toMatchObject({ code: '42501' });
					const keyCast: SchemaOperation = { kind: 'alterColumn', column: 'v',
						changes: column('v', typeOid('int4'), { default: { kind: 'keep' } }), constraints: [] };
					await expect(changeSchema(owner, { ...target('fk_permission'), expected: source.version, operation: keyCast }))
						.rejects.toMatchObject({ code: '42501' });
					expect((await getSchemaDefinition(owner, target('fk_permission'))).version).toBe(source.version);
					await pool.query(`grant all privileges on ${qualify(schema, 'parent')} to ${ident(role)}`);
					await changeSchema(owner, { ...target('fk_permission'), expected: source.version, operation: replacement });
					const replaced = (await getSchemaDefinition(owner, target('fk_permission'))).constraints[0];
					expect(replaced.oid).not.toBe(fk.oid);
					source = await getSchemaDefinition(owner, target('fk_permission'));
					await changeSchema(owner, { ...target('fk_permission'), expected: source.version, operation: keyCast });
					fk = (await getSchemaDefinition(owner, target('fk_permission'))).constraints[0];
					await pool.query(`revoke all privileges on ${qualify(schema, 'parent')} from ${ident(role)};
						grant references (id) on ${qualify(schema, 'parent')} to ${ident(role)}`);
					source = await getSchemaDefinition(owner, target('fk_permission'));
					await changeSchema(owner, { ...target('fk_permission'), expected: source.version,
						operation: { kind: 'renameConstraint', constraintOid: fk.oid, name: 'permission_renamed' } });
				}
				await owner.query(`insert into ${tableSql('fk_permission')} values (2)`);
				if (action === 'no action' || action === 'restrict') {
					await expect(pool.query(`delete from ${qualify(schema, 'parent')} where id = 2`))
						.rejects.toMatchObject({ code: action === 'restrict' ? '23001' : '23503' });
				} else {
					await pool.query(`delete from ${qualify(schema, 'parent')} where id = 2`);
					expect((await owner.query(`select v from ${tableSql('fk_permission')}`)).rows)
						.toEqual(action === 'cascade' ? [] : [{ v: action === 'set null' ? null : 1 }]);
					await pool.query(`insert into ${qualify(schema, 'parent')} values (2)`);
				}
				await owner.query(`delete from ${tableSql('fk_permission')}`);
				source = await getSchemaDefinition(owner, target('fk_permission'));
				await changeSchema(owner, { ...target('fk_permission'), expected: source.version,
					operation: { kind: 'dropConstraint', constraintOid: fk.oid } });
			}
		} finally {
			await owner?.end();
			await pool.query(`drop owned by ${ident(role)}; drop role ${ident(role)}; drop schema ${ident(schema)} cascade`);
		}
	});

	test('referenced parse locks survive Close/Sync and precede all column-batch mutations', async () => {
		await pool.query(`create table ${tableSql('fk_lock_parent')} (id int primary key);
			create table ${tableSql('fk_lock_child')} (v int constraint fk_lock_check check (v > 0))`);
		const ref = await definition('fk_lock_parent'), before = await definition('fk_lock_child');
		const racer = await pool.connect();
		let checked = false;
		try {
			await racer.query("set lock_timeout = '100ms'");
			const wrapped = interleaved(async (sql) => {
				if (checked || !sql.startsWith(`alter table ${tableSql('fk_lock_child')} drop constraint`)) return;
				checked = true;
				expect((await racer.query(`select mode from pg_locks where relation = $1::oid and granted
					and mode = 'AccessShareLock'`, [ref.oid])).rows.length).toBeGreaterThan(0);
				await expect(racer.query(`alter table ${tableSql('fk_lock_parent')} add column blocked int`))
					.rejects.toMatchObject({ code: '55P03' });
			});
			await changeSchema(wrapped, { ...target('fk_lock_child'), expected: before.version,
				operation: { kind: 'alterColumn', column: 'v', changes: column('renamed', null),
					constraints: [
						{ kind: 'dropConstraint', constraintOid: before.constraints[0].oid },
						{ kind: 'addConstraint', constraint: foreignKeyConstraint('locked_ref', ref) }
					] } });
			expect(checked).toBe(true);
			expect((await definition('fk_lock_child')).constraints[0].columns).toEqual(['renamed']);
		} finally { await racer.query('reset lock_timeout'); racer.release(); }
	});

	test('FK retargeting catches old-target trigger changes before locking and blocks them through replacement', async () => {
		for (const boundary of ['before', 'locked'] as const) {
			for (const customization of ['comment', 'mode'] as const) {
				const suffix = `${boundary}_${customization}`;
				const oldTable = `fk_old_${suffix}`, newTable = `fk_new_${suffix}`, child = `fk_source_${suffix}`;
				await pool.query(`create table ${tableSql(oldTable)} (id int primary key);
					create table ${tableSql(newTable)} (id int primary key);
					create table ${tableSql(child)} (v int references ${tableSql(oldTable)} (id));
					insert into ${tableSql(oldTable)} values (1); insert into ${tableSql(newTable)} values (1);
					insert into ${tableSql(child)} values (1)`);
				const before = await definition(child), ref = await definition(newTable);
				const fk = before.constraints[0];
				const trigger = (await pool.query(`select tgname as name, oid::text from pg_trigger
					where tgconstraint = $1::oid and tgrelid = $2::regclass order by oid limit 1`, [fk.oid, tableSql(oldTable)])).rows[0];
				const mutation = customization === 'comment'
					? `comment on trigger ${ident(trigger.name)} on ${tableSql(oldTable)} is 'concurrent RI comment'`
					: `alter table ${tableSql(oldTable)} enable always trigger ${ident(trigger.name)}`;
				const racer = await pool.connect();
				let changed = false, mutated = false;
				try {
					await racer.query("set lock_timeout = '100ms'");
					const wrapped = interleaved(async (sql) => {
						if (sql.startsWith(`alter table ${tableSql(child)}`)) mutated = true;
						if (changed || !(boundary === 'before' ? sql.includes('n.xmin::text as version')
							: sql === `lock table only ${tableSql(oldTable)} in access exclusive mode`)) return;
						changed = true;
						if (boundary === 'before') await racer.query(mutation);
						else {
							await expect(racer.query(mutation)).rejects.toMatchObject({ code: '55P03' });
							await expect(racer.query(`alter trigger ${ident(trigger.name)} on ${tableSql(oldTable)} rename to raced_trigger`))
								.rejects.toMatchObject({ code: '55P03' });
						}
					});
					const applying = changeSchema(wrapped, { ...target(child), expected: before.version, operation: {
						kind: 'alterColumn', column: 'v', changes: column('renamed', typeOid('int8')),
						constraints: [{ kind: 'alterConstraint', constraintOid: fk.oid, constraint: foreignKeyConstraint(fk.name, ref) }]
					} });
					if (boundary === 'before') {
						await expect(applying).rejects.toThrow('Constraint changed');
						expect(mutated).toBe(false);
						const after = await definition(child);
						expect(after.columns).toEqual(before.columns);
						expect(after.constraints[0]).toMatchObject({ oid: fk.oid, replaceable: false });
						expect((await pool.query(`select tgenabled, obj_description(oid, 'pg_trigger') as comment
							from pg_trigger where oid = $1::oid`, [trigger.oid])).rows[0])
							.toEqual({ tgenabled: customization === 'mode' ? 'A' : 'O', comment: customization === 'comment' ? 'concurrent RI comment' : null });
					} else {
						await applying;
						expect((await definition(child)).constraints[0]).toMatchObject({ foreignKey: { table: newTable }, replaceable: true });
						expect((await pool.query(`select * from ${tableSql(child)}`)).rows).toEqual([{ renamed: '1' }]);
						expect((await pool.query('select oid from pg_trigger where tgconstraint = $1::oid', [fk.oid])).rows).toEqual([]);
					}
					expect(changed).toBe(true);
				} finally { await racer.query('reset lock_timeout'); racer.release(); }
			}
		}
	});

	test('implicit incoming and outgoing FK rebuilds fence trigger races before native column DDL', async () => {
		for (const side of ['source', 'referenced'] as const) {
			for (const boundary of ['before', 'locked'] as const) {
				const parent = `fk_cast_lock_parent_${side}_${boundary}`, child = `fk_cast_lock_child_${side}_${boundary}`;
				await pool.query(`create table ${tableSql(parent)} (id int primary key);
					create table ${tableSql(child)} (v int references ${tableSql(parent)} (id));
					insert into ${tableSql(parent)} values (1); insert into ${tableSql(child)} values (1)`);
				const table = side === 'source' ? child : parent, other = side === 'source' ? parent : child;
				const before = await definition(table), fk = (await definition(child)).constraints[0];
				const trigger = (await pool.query(`select oid::text, tgname as name from pg_trigger
					where tgconstraint = $1::oid and tgrelid = $2::regclass order by oid limit 1`, [fk.oid, tableSql(other)])).rows[0];
				const comment = `comment on trigger ${ident(trigger.name)} on ${tableSql(other)} is 'raced cast comment'`;
				const mode = `alter table ${tableSql(other)} enable always trigger ${ident(trigger.name)}`;
				const racer = await pool.connect();
				let checked = false, mutated = false;
				try {
					await racer.query("set lock_timeout = '100ms'");
					const wrapped = interleaved(async (sql) => {
						if (sql.startsWith(`alter table ${tableSql(table)}`)) mutated = true;
						if (checked || !(boundary === 'before' ? sql.includes('n.xmin::text as version')
							: sql === `lock table only ${tableSql(other)} in access exclusive mode`)) return;
						checked = true;
						if (boundary === 'before') await racer.query(side === 'source' ? comment : mode);
						else {
							await expect(racer.query(comment)).rejects.toMatchObject({ code: '55P03' });
							await expect(racer.query(mode)).rejects.toMatchObject({ code: '55P03' });
						}
					});
					const name = side === 'source' ? 'v' : 'id';
					const applying = changeSchema(wrapped, { ...target(table), expected: before.version, operation: {
						kind: 'alterColumn', column: name,
						changes: column(name, typeOid('int8'), { nullable: side === 'source', primaryKey: side === 'referenced' }),
						constraints: [{ kind: 'addConstraint', constraint: checkConstraint('after_cast_check', `${name} > 0`) }]
					} });
					if (boundary === 'before') {
						await expect(applying).rejects.toThrow('Constraint changed');
						expect(mutated).toBe(false);
						expect((await definition(table)).columns).toEqual(before.columns);
						expect((await definition(child)).constraints.find((constraint) => constraint.kind === 'f')!.oid).toBe(fk.oid);
						expect((await pool.query(`select tgenabled, obj_description(oid, 'pg_trigger') as comment
							from pg_trigger where oid = $1::oid`, [trigger.oid])).rows[0])
							.toEqual({ tgenabled: side === 'referenced' ? 'A' : 'O', comment: side === 'source' ? 'raced cast comment' : null });
					} else {
						await applying;
						expect((await definition(table)).columns.find((column) => column.name === name)?.type).toBe('bigint');
						expect((await definition(table)).constraints.some((constraint) => constraint.name === 'after_cast_check')).toBe(true);
						expect((await definition(child)).constraints.find((constraint) => constraint.kind === 'f')?.replaceable).toBe(true);
					}
					expect(checked).toBe(true);
				} finally { await racer.query('reset lock_timeout'); racer.release(); }
			}
		}
	});

	test('all old FK targets are locked and rechecked before any batch replacement', async () => {
		await pool.query(`create table ${tableSql('fk_batch_old_a')} (id int primary key);
			create table ${tableSql('fk_batch_old_b')} (id int primary key);
			create table ${tableSql('fk_batch_new')} (id int primary key);
			create table ${tableSql('fk_batch_source')} (v int references ${tableSql('fk_batch_old_a')} (id),
				w int references ${tableSql('fk_batch_old_b')} (id))`);
		const before = await definition('fk_batch_source'), ref = await definition('fk_batch_new');
		const second = before.constraints.find((constraint) => constraint.columns[0] === 'w')!;
		const trigger = (await pool.query(`select tgname as name from pg_trigger
			where tgconstraint = $1::oid and tgrelid = $2::regclass order by oid limit 1`,
		[second.oid, tableSql('fk_batch_old_b')])).rows[0];
		let locks = 0, changed = false, mutated = false;
		const wrapped = interleaved(async (sql) => {
			if (sql.startsWith(`alter table ${tableSql('fk_batch_source')}`)) mutated = true;
			if (sql.startsWith(`lock table only "${namespace}"."fk_batch_old_`)) locks++;
			if (!changed && locks === 1 && sql.includes('n.xmin::text as version')) {
				changed = true;
				await pool.query(`comment on trigger ${ident(trigger.name)} on ${tableSql('fk_batch_old_b')} is 'second target changed'`);
			}
		});
		await expect(changeSchema(wrapped, { ...target('fk_batch_source'), expected: before.version,
			operation: { kind: 'alterColumn', column: 'v', changes: column('unsaved', typeOid('int8')),
				constraints: before.constraints.map((constraint) => ({
					kind: 'alterConstraint' as const, constraintOid: constraint.oid,
					constraint: foreignKeyConstraint(constraint.name, ref, constraint.columns)
				})) } })).rejects.toThrow('Constraint changed');
		expect(locks).toBe(2);
		expect(changed).toBe(true);
		expect(mutated).toBe(false);
		const after = await definition('fk_batch_source');
		expect(after.columns).toEqual(before.columns);
		expect(after.constraints.map((constraint) => constraint.oid)).toEqual(before.constraints.map((constraint) => constraint.oid));
	});

	test('old FK target namespace reuse and ABA cannot redirect a replacement lock or commit', async () => {
		const original = `${namespace}_oldfk`, moved = `${namespace}_oldmoved`;
		for (const boundary of ['identity', 'drop'] as const) {
			for (const restore of [false, true]) {
				const child = `fk_old_namespace_${boundary}_${restore}`, newTable = `${child}_new`;
				try {
					await pool.query(`create schema ${ident(original)}; create table ${qualify(original, 'p')} (id int primary key);
						create table ${tableSql(newTable)} (id int primary key);
						create table ${tableSql(child)} (v int references ${qualify(original, 'p')} (id))`);
					const before = await definition(child), ref = await definition(newTable), fk = before.constraints[0];
					let changed = false;
					const wrapped = interleaved(async (sql) => {
						if (changed || !(boundary === 'identity' ? sql.includes('n.xmin::text as version')
							: sql.startsWith(`alter table ${tableSql(child)} drop constraint`))) return;
						changed = true;
						await pool.query(`alter schema ${ident(original)} rename to ${ident(moved)};
							${restore ? `alter schema ${ident(moved)} rename to ${ident(original)}`
								: `create schema ${ident(original)}; create table ${qualify(original, 'p')} (id int primary key)`}`);
					});
					await expect(changeSchema(wrapped, { ...target(child), expected: before.version,
						operation: { kind: 'alterConstraint', constraintOid: fk.oid, constraint: foreignKeyConstraint(fk.name, ref) } }))
						.rejects.toThrow('changed');
					expect(changed).toBe(true);
					const after = await definition(child);
					expect(after.constraints[0]).toMatchObject({ oid: fk.oid,
						foreignKey: { tableOid: fk.foreignKey!.tableOid, schema: restore ? original : moved } });
					expect(after.columns).toEqual(before.columns);
				} finally {
					await pool.query(`drop schema if exists ${ident(original)} cascade; drop schema if exists ${ident(moved)} cascade`);
				}
			}
		}
	});

	test('target fences allow this source’s native FK rebuilds but reject another source’s concurrent FK', async () => {
		await pool.query(`create table ${tableSql('fk_incoming_parent')} (id int primary key);
			create table ${tableSql('fk_incoming_source')} (v int references ${tableSql('fk_incoming_parent')} (id), w int);
			create table ${tableSql('fk_incoming_other')} (v int)`);
		let ref = await definition('fk_incoming_parent');
		await change('fk_incoming_source', { kind: 'alterColumn', column: 'v', changes: column('renamed', typeOid('int8')),
			constraints: [{ kind: 'addConstraint', constraint: foreignKeyConstraint('incoming_second', ref, ['w']) }] });
		const after = await definition('fk_incoming_source');
		expect(after.constraints.map((constraint) => constraint.columns)).toEqual([['renamed'], ['w']]);
		ref = await definition('fk_incoming_parent');
		let changed = false;
		const wrapped = interleaved(async (sql) => {
			if (changed || !sql.includes('n.xmin::text as version')) return;
			changed = true;
			await pool.query(`alter table ${tableSql('fk_incoming_other')} add foreign key (v) references ${tableSql('fk_incoming_parent')} (id)`);
		});
		await expect(changeSchema(wrapped, { ...target('fk_incoming_source'), expected: after.version,
			operation: { kind: 'alterColumn', column: 'w', changes: column('unsaved', typeOid('int8')),
				constraints: [{ kind: 'addConstraint', constraint: foreignKeyConstraint('incoming_third', ref, ['w']) }] } }))
			.rejects.toThrow('changed');
		expect(changed).toBe(true);
		expect((await definition('fk_incoming_source')).version).toBe(after.version);
		expect((await definition('fk_incoming_other')).constraints).toHaveLength(1);
	});

	test('FK target namespace and index name-reuse races roll back all column edits before and after native ADD', async () => {
		const schema = `${namespace}_fkrace`, moved = `${namespace}_fkmoved`;
		for (const race of ['namespace', 'index', 'namespaceRestore', 'indexRestore'] as const) {
			for (const boundary of ['column', 'added'] as const) {
				const child = `fk_race_${race}_${boundary}`;
				try {
					await pool.query(`create schema ${ident(schema)};
						create table ${qualify(schema, 'parent')} (id int unique);
						create table ${qualify(schema, 'decoy')} (id int);
						create index decoy_index on ${qualify(schema, 'decoy')} (id);
						create table ${tableSql(child)} (v int)`);
					const ref = await getSchemaDefinition(pool, { connection: 'test', schema, table: 'parent' });
					const before = await definition(child);
					let changed = false;
					const wrapped = interleaved(async (sql) => {
						if (changed || !sql.startsWith(`alter table ${tableSql(child)} ${boundary === 'column' ? 'alter column' : 'add constraint'}`)) return;
						changed = true;
						if (race === 'namespaceRestore') {
							await pool.query(`alter schema ${ident(schema)} rename to ${ident(moved)};
								alter schema ${ident(moved)} rename to ${ident(schema)}`);
						} else if (race === 'indexRestore') {
							await pool.query(`alter index ${qualify(schema, 'parent_id_key')} rename to moved_key;
								alter index ${qualify(schema, 'moved_key')} rename to parent_id_key`);
						} else if (race === 'namespace') {
							await pool.query(`alter schema ${ident(schema)} rename to ${ident(moved)};
								create schema ${ident(schema)}; create table ${qualify(schema, 'parent')} (id int primary key)`);
						} else {
							await pool.query(`alter index ${qualify(schema, 'parent_id_key')} rename to moved_key;
								alter index ${qualify(schema, 'decoy_index')} rename to parent_id_key`);
						}
					});
					await expect(changeSchema(wrapped, { ...target(child), expected: before.version,
						operation: { kind: 'alterColumn', column: 'v', changes: column('unsaved', typeOid('int8')),
							constraints: [{ kind: 'addConstraint', constraint: foreignKeyConstraint('raced_ref', ref) }] } }))
						.rejects.toThrow('changed');
					expect(changed).toBe(true);
					expect((await definition(child)).version).toBe(before.version);
					expect((await pool.query('select oid from pg_constraint where conrelid = $1::oid', [before.oid])).rows).toEqual([]);
				} finally {
					await pool.query(`drop schema if exists ${ident(schema)} cascade; drop schema if exists ${ident(moved)} cascade`);
				}
			}
		}
	});

	test('all selected UNIQUE backing indexes lock before a column batch drops or mutates anything', async () => {
		await pool.query(`create table ${tableSql('batch_index_locks')} (v int constraint batch_v_key unique,
			n int constraint batch_n_key unique); insert into ${tableSql('batch_index_locks')} values (1, 2)`);
		const before = await definition('batch_index_locks');
		let reads = 0, mutated = false;
		const wrapped = interleaved(async (sql) => {
			if (sql.startsWith(`alter table ${tableSql('batch_index_locks')}`)) mutated = true;
			if (!sql.includes('as "defaultTablespace"') || ++reads !== 2) return;
			await pool.query(`comment on index ${tableSql('batch_n_key')} is 'concurrent'`);
		});
		await expect(changeSchema(wrapped, { ...target('batch_index_locks'), expected: before.version,
			operation: { kind: 'alterColumn', column: 'v', changes: column('unsaved', typeOid('int8')),
				constraints: before.constraints.map((constraint) => ({ kind: 'alterConstraint' as const,
					constraintOid: constraint.oid, constraint: uniqueConstraint(constraint.name, constraint.columns) })) } }))
			.rejects.toThrow('Constraint changed');
		expect(reads).toBe(2);
		expect(mutated).toBe(false);
		const after = await definition('batch_index_locks');
		expect(after.columns).toEqual(before.columns);
		expect(after.constraints.map((constraint) => constraint.oid)).toEqual(before.constraints.map((constraint) => constraint.oid));
		// A clean second batch proves both locks are acquired before original-fingerprint
		// checks, not one lock after an earlier replacement has already changed the source.
		await change('batch_index_locks', { kind: 'alterColumn', column: 'v', changes: column('renamed', typeOid('int8')),
			constraints: after.constraints.map((constraint) => ({ kind: 'alterConstraint' as const,
				constraintOid: constraint.oid, constraint: uniqueConstraint(constraint.name, constraint.columns) })) });
		expect((await definition('batch_index_locks')).constraints.map((constraint) => constraint.columns)).toEqual([['renamed'], ['n']]);
	});

	test('UNIQUE round-trips ordered varchar keys, native deferral/NULL semantics and atomic replacements with comments', async () => {
		const table = 'constraint_unique', name = 'unique";\n--key';
		await pool.query(`create table ${tableSql(table)} (id int primary key, v varchar(20), n int);
			insert into ${tableSql(table)} values (1, 'one', 1), (2, 'two', 1), (3, null, 1), (4, null, 1)`);
		await change(table, { kind: 'addConstraint', constraint: uniqueConstraint(name, ['v', 'n']) });
		await pool.query(`comment on constraint ${ident(name)} on ${tableSql(table)} is 'constraint ''comment';
			comment on index ${tableSql(name)} is 'backing index comment'`);
		const before = await definition(table), original = before.constraints[0];
		expect(before.constraints).toHaveLength(1); // PK is not an editable UNIQUE.
		expect(original).toMatchObject({
			name, kind: 'u', columns: ['v', 'n'], expression: null, validated: true, enforced: true,
			deferrable: false, initiallyDeferred: false, nullsNotDistinct: false, noInherit: true,
			comment: "constraint 'comment", indexComment: 'backing index comment', replaceable: true
		});
		expect(original.definition).toBe('UNIQUE (v, n)');
		const replacement = { ...uniqueConstraint('unique_replaced', ['v', 'n']),
			nullsNotDistinct: true, deferrable: true, initiallyDeferred: true };
		await expect(change(table, { kind: 'alterConstraint', constraintOid: original.oid, constraint: replacement }))
			.rejects.toMatchObject({ code: '23505' });
		expect(await definition(table)).toEqual(before);
		await expect(change(table, { kind: 'addConstraint', constraint: uniqueConstraint('missing_key', ['missing']) })).rejects.toThrow('Unknown constraint column');
		await expect(change(table, { kind: 'alterConstraint', constraintOid: original.oid, constraint: checkConstraint(name) })).rejects.toThrow('Use SQL');
		await expect(change(table, { kind: 'validateConstraint', constraintOid: original.oid })).rejects.toThrow('CHECK');
		await pool.query(`delete from ${tableSql(table)} where id = 4`);
		await change(table, { kind: 'alterConstraint', constraintOid: original.oid, constraint: replacement });
		const replaced = (await definition(table)).constraints[0];
		expect(replaced).toMatchObject({
			name: replacement.name, columns: ['v', 'n'], nullsNotDistinct: true, deferrable: true,
			initiallyDeferred: true, comment: original.comment, indexComment: original.indexComment, replaceable: true
		});
		expect(replaced.oid).not.toBe(original.oid);
		expect(replaced.indexOid).not.toBe(original.indexOid);
		expect((await pool.query('select oid from pg_constraint where oid = $1::oid', [original.oid])).rows).toEqual([]);
		await expect(pool.query(`insert into ${tableSql(table)} values (5, null, 1)`)).rejects.toMatchObject({ code: '23505' });
		const client = await pool.connect();
		try {
			await client.query('begin');
			await client.query(`update ${tableSql(table)} set v = 'two' where id = 1`);
			await client.query(`update ${tableSql(table)} set v = 'one' where id = 2`);
			await client.query('commit'); // An immediate constraint would reject the first UPDATE.
		} finally { await client.query('rollback'); client.release(); }
		await change(table, { kind: 'renameConstraint', constraintOid: replaced.oid, name });
		const renamed = (await definition(table)).constraints[0];
		expect(renamed).toMatchObject({ oid: replaced.oid, name, indexOid: replaced.indexOid, comment: original.comment, indexComment: original.indexComment });
		expect((await definition(table)).indexes.find((index) => index.oid === replaced.indexOid)?.name).toBe(name);
		await change(table, { kind: 'dropConstraint', constraintOid: renamed.oid });
		expect((await definition(table)).constraints).toEqual([]);
		expect((await definition(table)).indexes.some((index) => index.oid === renamed.indexOid)).toBe(false);
	});

	test('CHECK NOT VALID enforces new writes, permits NULL and validates or replaces atomically', async () => {
		const table = 'constraint_check';
		await pool.query(`create table ${tableSql(table)} (v int);
			insert into ${tableSql(table)} values (-1), (null), (2)`);
		await change(table, { kind: 'addConstraint', constraint: { ...checkConstraint('positive'), notValid: true, noInherit: true } });
		await pool.query(`comment on constraint positive on ${tableSql(table)} is 'keep check comment'`);
		const before = await definition(table), check = before.constraints[0];
		expect(check).toMatchObject({
			name: 'positive', kind: 'c', expression: '(v > 0)', columns: ['v'], validated: false,
			enforced: true, noInherit: true, deferrable: false, initiallyDeferred: false,
			nullsNotDistinct: false, indexOid: null, indexComment: null, replaceable: true,
			comment: 'keep check comment', definition: 'CHECK ((v > 0)) NO INHERIT NOT VALID'
		});
		await expect(pool.query(`insert into ${tableSql(table)} values (-2)`)).rejects.toMatchObject({ code: '23514' });
		await pool.query(`insert into ${tableSql(table)} values (null)`);
		await expect(change(table, { kind: 'validateConstraint', constraintOid: check.oid })).rejects.toMatchObject({ code: '23514' });
		await expect(change(table, { kind: 'alterConstraint', constraintOid: check.oid, constraint: checkConstraint('stricter', 'v > 10') }))
			.rejects.toMatchObject({ code: '23514' });
		expect(await definition(table)).toEqual(before);
		await pool.query(`delete from ${tableSql(table)} where v < 0`);
		await change(table, { kind: 'validateConstraint', constraintOid: check.oid });
		expect((await definition(table)).constraints[0]).toMatchObject({ oid: check.oid, validated: true, noInherit: true });
		await change(table, { kind: 'alterConstraint', constraintOid: check.oid, constraint: checkConstraint('nonnegative', 'v >= 0') });
		const replaced = (await definition(table)).constraints[0];
		expect(replaced).toMatchObject({ name: 'nonnegative', expression: '(v >= 0)', validated: true, noInherit: false, comment: check.comment });
		expect(replaced.oid).not.toBe(check.oid);
		await change(table, { kind: 'renameConstraint', constraintOid: replaced.oid, name: '__proto__' });
		expect((await definition(table)).constraints[0]).toMatchObject({ oid: replaced.oid, name: '__proto__' });
		await change(table, { kind: 'dropConstraint', constraintOid: replaced.oid });
		await pool.query(`insert into ${tableSql(table)} values (-3)`);
	});

	test('CHECK parsing rejects extra DDL and native errors without planning, executing or leaking prepared statements', async () => {
		const table = 'constraint_parser';
		await pool.query(`create table ${tableSql(table)} (v int, victim text);
			insert into ${tableSql(table)} values (1, 'untouched');
			create sequence ${tableSql('check_calls')};
			create function ${tableSql('check_tick')}() returns boolean language plpgsql immutable as $$
			begin perform nextval('${tableSql('check_calls')}'::regclass); return true; end $$`);
		// One physical connection makes recovery and prepared-statement leakage observable.
		const single = new pg.Pool({ connectionString: url, max: 1 });
		try {
			const before = await getSchemaDefinition(single, target(table));
			const prepared = (await single.query('select name, statement from pg_prepared_statements order by name')).rows;
			for (const expression of [
				'true), drop column victim --',
				`true); update ${tableSql(table)} set victim = 'changed'; --`,
				`true); drop table ${tableSql(table)}; --`,
				// Valid SELECT grammar, but not a CHECK expression; the actual DDL must reject it.
				'true) union select 1 where (true',
				'v', "'not-an-integer'::int > 0", 'v >', '(select true)'
			]) {
				await expect(changeSchema(single, { ...target(table), expected: before.version,
					operation: { kind: 'addConstraint', constraint: checkConstraint('unsafe', expression) } })).rejects.toThrow();
				expect(await getSchemaDefinition(single, target(table))).toEqual(before);
				expect((await single.query(`select * from ${tableSql(table)}`)).rows).toEqual([{ v: 1, victim: 'untouched' }]);
				expect((await single.query('select name, statement from pg_prepared_statements order by name')).rows).toEqual(prepared);
			}
			const expression = `${tableSql('check_tick')}() and v > 0
				and '); drop table x; --' = $tag$); drop table x; --$tag$
				/* ), ADD COLUMN injected int */ -- closing wrapper must survive this comment`;
			await changeSchema(single, { ...target(table), expected: before.version,
				operation: { kind: 'addConstraint', constraint: { ...checkConstraint('safe', expression), notValid: true } } });
			// IMMUTABLE zero-argument functions would run during planning, even on no rows.
			expect((await single.query(`select is_called from ${tableSql('check_calls')}`)).rows[0].is_called).toBe(false);
			const added = await getSchemaDefinition(single, target(table));
			await changeSchema(single, { ...target(table), expected: added.version,
				operation: { kind: 'validateConstraint', constraintOid: added.constraints[0].oid } });
			expect((await single.query(`select is_called from ${tableSql('check_calls')}`)).rows[0].is_called).toBe(true);
			expect((await single.query('select name, statement from pg_prepared_statements order by name')).rows).toEqual(prepared);
			expect(single.idleCount).toBe(1);
		} finally { await single.end(); }
	});

	test('CHECK parsing and native DDL retain the original search path for custom functions and operators', async () => {
		const table = 'constraint_operators';
		await pool.query(`create function ${tableSql('check_case_equal')}(text, text) returns boolean
			language sql immutable as 'select pg_catalog.lower($1) operator(pg_catalog.=) pg_catalog.lower($2)';
			create operator ${ident(namespace)}.= (
				function = ${tableSql('check_case_equal')}, leftarg = text, rightarg = text);
			create table ${tableSql('pg_constraint')} (not_a_catalog int);
			create function ${tableSql('check_local')}(int) returns boolean language plpgsql volatile as $$
			begin
				create temporary table if not exists pg_constraint (not_a_catalog int);
				perform pg_catalog.set_config('search_path', '${namespace},pg_catalog', true);
				perform pg_catalog.set_config('standard_conforming_strings', 'off', true);
				return $1 > 0;
			end $$;
			create table ${tableSql(table)} (v int, label text);
			insert into ${tableSql(table)} values (1, 'alice')`);
		const custom = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace},pg_catalog`, max: 1 });
		try {
			const before = await getSchemaDefinition(custom, target(table));
			await changeSchema(custom, { ...target(table), expected: before.version,
				operation: { kind: 'addConstraint', constraint: checkConstraint('custom_semantics', "check_local(v) and label = 'ALICE'") } });
			const added = await getSchemaDefinition(custom, target(table));
			expect(added.constraints[0].expression).toContain(`OPERATOR(${namespace}.=)`);
			expect(added.constraints[0].expression).toContain(`${namespace}.check_local(v)`);
			await custom.query(`insert into ${tableSql(table)} values (2, 'AlIcE')`);
			await expect(custom.query(`insert into ${tableSql(table)} values (3, 'bob')`)).rejects.toMatchObject({ code: '23514' });
			await expect(changeSchema(custom, { ...target(table), expected: added.version,
				operation: { kind: 'alterConstraint', constraintOid: added.constraints[0].oid,
					constraint: checkConstraint('custom_bad', "check_local(v) and label = 'BOB'") } })).rejects.toMatchObject({ code: '23514' });
			expect(await getSchemaDefinition(custom, target(table))).toEqual(added);
			expect((await custom.query('show search_path')).rows[0].search_path).toBe(`${namespace},pg_catalog`);
		} finally { await custom.end(); }
	});

	test('constraint guards preserve advanced options, FK/replica dependencies, captured ownership and permissions', async () => {
		const table = 'constraint_guards';
		await pool.query(`create table ${tableSql(table)} (
				id int primary key, v int not null, label varchar(20), n int, k int, r int not null,
				constraint guard_fk unique (v),
				constraint guard_include unique (label) include (id),
				constraint guard_storage unique (n) with (fillfactor = 70),
				constraint guard_cluster unique (k),
				constraint guard_replica unique (r));
			alter table ${tableSql(table)} cluster on guard_cluster;
			alter table ${tableSql(table)} replica identity using index guard_replica;
			create table ${tableSql('constraint_references')} (v int references ${tableSql(table)} (v), other int unique)`);
		const before = await definition(table);
		expect(before.constraints).toHaveLength(5); // Neither PK nor incoming FK is owned UNIQUE/CHECK.
		for (const name of ['guard_include', 'guard_storage', 'guard_cluster']) {
			const constraint = (await definition(table)).constraints.find((item) => item.name === name)!;
			expect(constraint.replaceable).toBe(false);
			await expect(change(table, { kind: 'alterConstraint', constraintOid: constraint.oid,
				constraint: uniqueConstraint(name, [constraint.columns[0]]) })).rejects.toThrow('Use SQL');
			await change(table, { kind: 'renameConstraint', constraintOid: constraint.oid, name: `${name}_renamed` });
			await change(table, { kind: 'dropConstraint', constraintOid: constraint.oid });
		}
		const replica = before.constraints.find((item) => item.name === 'guard_replica')!;
		expect(replica.replaceable).toBe(false);
		await expect(change(table, { kind: 'dropConstraint', constraintOid: replica.oid })).rejects.toThrow('replica identity');
		await expect(change(table, { kind: 'alterConstraint', constraintOid: replica.oid,
			constraint: uniqueConstraint(replica.name, ['r']) })).rejects.toThrow();
		await change(table, { kind: 'renameConstraint', constraintOid: replica.oid, name: 'guard_replica_renamed' });
		const fk = before.constraints.find((item) => item.name === 'guard_fk')!;
		const guarded = await definition(table);
		for (const operation of [
			{ kind: 'dropConstraint', constraintOid: fk.oid },
			{ kind: 'alterConstraint', constraintOid: fk.oid, constraint: uniqueConstraint(fk.name) }
		] satisfies SchemaOperation[]) await expect(change(table, operation)).rejects.toMatchObject({ code: '2BP01' });
		expect(await definition(table)).toEqual(guarded);
		const foreignOid = (await definition('constraint_references')).constraints[0].oid;
		for (const kind of ['alterConstraint', 'renameConstraint', 'dropConstraint', 'validateConstraint'] as const) {
			const operation: SchemaOperation = kind === 'alterConstraint'
				? { kind, constraintOid: foreignOid, constraint: uniqueConstraint('foreign') }
				: kind === 'renameConstraint' ? { kind, constraintOid: foreignOid, name: 'foreign' }
					: { kind, constraintOid: foreignOid };
			await expect(change(table, operation)).rejects.toThrow('belongs');
		}
		await pool.query(`comment on constraint guard_fk on ${tableSql(table)} is 'changed'`);
		await expect(changeSchema(pool, { ...target(table), expected: guarded.version,
			operation: { kind: 'dropConstraint', constraintOid: fk.oid } })).rejects.toThrow('schema changed');

		// PostgreSQL 18 added NOT ENFORCED; introspection on older versions still works.
		if (Number((await pool.query('show server_version_num')).rows[0].server_version_num) >= 180000) {
			await pool.query(`alter table ${tableSql(table)} add constraint unenforced check (n > 0) not enforced`);
			const unchecked = (await definition(table)).constraints.find((item) => item.name === 'unenforced')!;
			expect(unchecked).toMatchObject({ kind: 'c', enforced: false, replaceable: false });
			await expect(change(table, { kind: 'alterConstraint', constraintOid: unchecked.oid,
				constraint: checkConstraint('unenforced', 'n > 0') })).rejects.toThrow('Use SQL');
			await expect(change(table, { kind: 'validateConstraint', constraintOid: unchecked.oid })).rejects.toThrow('enforced CHECK');
			await change(table, { kind: 'renameConstraint', constraintOid: unchecked.oid, name: 'unenforced_renamed' });
			await change(table, { kind: 'dropConstraint', constraintOid: unchecked.oid });
		}
		const role = `${namespace}_conreader`;
		let restricted: pg.Pool | undefined;
		try {
			await pool.query(`create role ${ident(role)}; grant usage on schema ${ident(namespace)} to ${ident(role)};
				grant select on ${tableSql(table)} to ${ident(role)}`);
			restricted = new pg.Pool({ connectionString: url, options: `-c role=${role}`, max: 1 });
			const snapshot = await getSchemaDefinition(restricted, target(table));
			expect(snapshot.constraints.length).toBeGreaterThan(0);
			for (const operation of [
				{ kind: 'addConstraint', constraint: checkConstraint('forbidden') },
				{ kind: 'alterConstraint', constraintOid: fk.oid, constraint: uniqueConstraint('forbidden') },
				{ kind: 'renameConstraint', constraintOid: fk.oid, name: 'forbidden' },
				{ kind: 'dropConstraint', constraintOid: fk.oid },
				{ kind: 'validateConstraint', constraintOid: fk.oid }
			] satisfies SchemaOperation[]) {
				await expect(changeSchema(restricted, { ...target(table), expected: snapshot.version, operation }))
					.rejects.toMatchObject({ code: '42501' });
			}
			expect(await definition(table)).toEqual(snapshot);
		} finally {
			await restricted?.end();
			await pool.query(`drop owned by ${ident(role)}; drop role ${ident(role)}`);
		}
	});

	test('backing-index rename/name reuse cannot retarget constraint drop, replacement or rename', async () => {
		for (const kind of ['dropConstraint', 'alterConstraint', 'renameConstraint'] as const) {
			const table = `constraint_race_${kind}`;
			const selected = `${kind}_selected`, other = `${kind}_other`, moved = `${kind}_moved`;
			await pool.query(`create table ${tableSql(table)} (v int, n int,
				constraint ${ident(selected)} unique (v), constraint ${ident(other)} unique (n))`);
			const before = await definition(table);
			const original = before.constraints.find((item) => item.name === selected)!;
			const victim = before.constraints.find((item) => item.name === other)!;
			const racer = await pool.connect();
			let changed = false;
			try {
				await racer.query("set lock_timeout = '1s'");
				const wrapped = interleaved(async (sql) => {
					if (changed || !sql.includes('with approved as')) return;
					changed = true;
					await racer.query(`alter index ${tableSql(selected)} rename to ${ident(moved)};
						alter index ${tableSql(other)} rename to ${ident(selected)}`);
				});
				const operation: SchemaOperation = kind === 'alterConstraint'
					? { kind, constraintOid: original.oid, constraint: uniqueConstraint(selected) }
					: kind === 'renameConstraint' ? { kind, constraintOid: original.oid, name: `${kind}_new` }
						: { kind, constraintOid: original.oid };
				await expect(changeSchema(wrapped, { ...target(table), expected: before.version, operation })).rejects.toThrow('Constraint changed');
				expect(changed).toBe(true);
				const after = await definition(table);
				expect(after.constraints).toHaveLength(2);
				expect(after.constraints.find((item) => item.oid === original.oid)).toMatchObject({
					name: moved, indexOid: original.indexOid, columns: ['v']
				});
				expect(after.constraints.find((item) => item.oid === victim.oid)).toMatchObject({
					name: selected, indexOid: victim.indexOid, columns: ['n']
				});
			} finally { await racer.query('reset lock_timeout'); racer.release(); }
		}
	});

	test('UNIQUE replacement rejects independent index option/comment changes before acquiring its index lock', async () => {
		for (const boundary of ['snapshot', 'indexRead'] as const) {
			for (const edit of ['options', 'comment'] as const) {
				const table = `constraint_race_${boundary}_${edit}`, name = `${table}_key`;
				await pool.query(`create table ${tableSql(table)} (v int constraint ${ident(name)} unique);
					insert into ${tableSql(table)} values (1);
					comment on index ${tableSql(name)} is 'original comment'`);
				const before = await definition(table), original = before.constraints[0];
				const stamp = (await pool.query('select xmin::text from pg_class where oid = $1::oid', [original.indexOid])).rows[0].xmin;
				const racer = await pool.connect();
				let changed = false, dropped = false;
				try {
					await racer.query("set lock_timeout = '1s'");
					const wrapped = interleaved(async (sql) => {
						if (sql.startsWith(`alter table ${tableSql(table)} drop constraint`)) dropped = true;
						if (changed || !(boundary === 'snapshot' ? sql.includes('with approved as') : sql.includes('as "defaultTablespace"'))) return;
						changed = true;
						await racer.query(edit === 'options'
							? `alter index ${tableSql(name)} set (fillfactor = 70)`
							: `comment on index ${tableSql(name)} is 'concurrent comment'`);
						const nextStamp = (await racer.query('select xmin::text from pg_class where oid = $1::oid', [original.indexOid])).rows[0].xmin;
						// COMMENT changes pg_description, not the index's pg_class xmin.
						expect(nextStamp === stamp).toBe(edit === 'comment');
					});
					await expect(changeSchema(wrapped, { ...target(table), expected: before.version,
						operation: { kind: 'alterConstraint', constraintOid: original.oid,
							constraint: { ...uniqueConstraint(name), nullsNotDistinct: true } } })).rejects.toThrow('Constraint changed');
					expect(changed).toBe(true);
					expect(dropped).toBe(false);
					const after = await definition(table);
					expect(after.constraints).toHaveLength(1);
					expect(after.constraints[0]).toMatchObject({
						oid: original.oid, indexOid: original.indexOid, nullsNotDistinct: false,
						indexComment: edit === 'comment' ? 'concurrent comment' : 'original comment',
						replaceable: edit === 'comment'
					});
					expect((await pool.query('select reloptions from pg_class where oid = $1::oid', [original.indexOid])).rows[0].reloptions)
						.toEqual(edit === 'options' ? ['fillfactor=70'] : null);
					expect((await pool.query(`select * from ${tableSql(table)}`)).rows).toEqual([{ v: 1 }]);
				} finally { await racer.query('reset lock_timeout'); racer.release(); }
			}
		}
	});

	test('ordinary-owner UNIQUE replacement holds an unchanged index lock against comments/options until rebuilding', async () => {
		const table = 'constraint_index_lock', name = 'constraint_index_lock_key', role = `${namespace}_conowner`;
		let owner: pg.Pool | undefined;
		const racer = await pool.connect();
		try {
			await pool.query(`create role ${ident(role)};
				grant usage, create on schema ${ident(namespace)} to ${ident(role)};
				create table ${tableSql(table)} (v int constraint ${ident(name)} unique);
				insert into ${tableSql(table)} values (1);
				comment on constraint ${ident(name)} on ${tableSql(table)} is 'constraint comment';
				comment on index ${tableSql(name)} is 'index comment';
				alter table ${tableSql(table)} owner to ${ident(role)}`);
			owner = new pg.Pool({ connectionString: url, options: `-c role=${role}`, max: 1 });
			expect((await owner.query(`select has_tablespace_privilege(dattablespace, 'CREATE') as allowed
				from pg_database where datname = current_database()`)).rows[0].allowed).toBe(false);
			// A different builtin default needs no filesystem fixture. Ordinary indexes
			// cannot use pg_global; replacement must explicitly retain the database default.
			await owner.query("set default_tablespace = 'pg_global'");
			const before = await getSchemaDefinition(owner, target(table)), original = before.constraints[0];
			const storage = (await racer.query('select xmin::text, relfilenode, reltablespace from pg_class where oid = $1::oid', [original.indexOid])).rows[0];
			let locked = false;
			await racer.query("set lock_timeout = '100ms'");
			const wrapped = interleaved(async (sql) => {
				if (locked || !sql.startsWith(`alter index ${tableSql(name)} set tablespace `)) return;
				locked = true;
				expect((await racer.query('select xmin::text, relfilenode, reltablespace from pg_class where oid = $1::oid', [original.indexOid])).rows[0])
					.toEqual(storage);
				for (const concurrent of [
					`comment on index ${tableSql(name)} is 'blocked comment'`,
					`alter index ${tableSql(name)} set (fillfactor = 70)`
				]) await expect(racer.query(concurrent)).rejects.toMatchObject({ code: '55P03' });
			}, owner);
			await changeSchema(wrapped, { ...target(table), expected: before.version,
				operation: { kind: 'alterConstraint', constraintOid: original.oid,
					constraint: { ...uniqueConstraint(name), nullsNotDistinct: true } } });
			expect(locked).toBe(true);
			const after = await getSchemaDefinition(owner, target(table)), replacement = after.constraints[0];
			expect(replacement).toMatchObject({
				nullsNotDistinct: true, replaceable: true, comment: 'constraint comment', indexComment: 'index comment'
			});
			expect(replacement.oid).not.toBe(original.oid);
			expect(replacement.indexOid).not.toBe(original.indexOid);
			expect((await racer.query('select reloptions, reltablespace from pg_class where oid = $1::oid', [replacement.indexOid])).rows)
				.toEqual([{ reloptions: null, reltablespace: storage.reltablespace }]);
			expect((await racer.query('select oid from pg_class where oid = $1::oid', [original.indexOid])).rows).toEqual([]);
			expect((await racer.query(`select * from ${tableSql(table)}`)).rows).toEqual([{ v: 1 }]);
		} finally {
			await owner?.end();
			await racer.query('reset lock_timeout');
			racer.release();
			await pool.query(`drop owned by ${ident(role)}; drop role ${ident(role)}`);
		}
	});

	test('all constraint operations roll back when a namespace rename retargets the table name', async () => {
		const original = `${namespace}_con`, moved = `${namespace}_cmoved`;
		for (const kind of ['addConstraint', 'alterConstraint', 'renameConstraint', 'dropConstraint', 'validateConstraint'] as const) {
			try {
				await pool.query(`create schema ${ident(original)}; create table ${qualify(original, 't')} (v int);
					alter table ${qualify(original, 't')} add constraint c check (v > 0) not valid`);
				const args = { connection: 'test', schema: original, table: 't' };
				const before = await getSchemaDefinition(pool, args);
				let changed = false;
				const wrapped = interleaved(async (sql) => {
					if (changed || !sql.includes('with approved as')) return;
					changed = true;
					await pool.query(`alter schema ${ident(original)} rename to ${ident(moved)};
						create schema ${ident(original)}; create table ${qualify(original, 't')} (v int);
						alter table ${qualify(original, 't')} add constraint c check (v > 0) not valid`);
				});
				const operation: SchemaOperation = kind === 'addConstraint'
					? { kind, constraint: uniqueConstraint('new_constraint') }
					: kind === 'alterConstraint' ? { kind, constraintOid: before.constraints[0].oid, constraint: checkConstraint('c', 'v >= 0') }
						: kind === 'renameConstraint' ? { kind, constraintOid: before.constraints[0].oid, name: 'renamed' }
							: { kind, constraintOid: before.constraints[0].oid };
				await expect(changeSchema(wrapped, { ...args, expected: before.version, operation })).rejects.toThrow('changed');
				expect(changed).toBe(true);
				for (const schema of [original, moved]) {
					const after = await getSchemaDefinition(pool, { ...args, schema });
					expect(after.constraints).toHaveLength(1);
					expect(after.constraints[0]).toMatchObject({ name: 'c', kind: 'c', expression: '(v > 0)', validated: false });
					expect(after.indexes).toEqual([]);
					if (schema === moved) expect(after.constraints[0].oid).toBe(before.constraints[0].oid);
				}
			} finally { await pool.query(`drop schema if exists ${ident(original)} cascade; drop schema if exists ${ident(moved)} cascade`); }
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
