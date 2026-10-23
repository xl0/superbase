import { describe, expect, test } from 'bun:test';
import { error } from '@sveltejs/kit';
import { parse, stringify } from 'devalue';
import { transport } from '../src/hooks.js';
import { message } from '../src/lib/utils.js';
import { displayValue, fromTSV, toTSV } from '../src/lib/format.js';
import { connectSchema, deleteSchema, rowsSchema, saveSchema } from '../src/lib/validation.js';
import type { Column } from '../src/lib/types.js';

const column: Column = { name: 'value', type: 'numeric', kind: 'number', primaryKey: false, generated: false, identity: null, defaultValue: null, nullable: true };

describe('lossless display and clipboard', () => {
	test('preserves exact PostgreSQL text and distinguishes NULL/default/empty', () => {
		for (const value of ['9007199254740993', '0.0001234', '1.234567890123456789', 'NaN', '', '__NULL__']) expect(displayValue(value, column)).toBe(value);
		expect(displayValue(null, column)).toBe('NULL');
		expect(displayValue(undefined, column)).toBe('DEFAULT');
	});
	test('round-trips quotes, tabs, newlines, carriage returns, sentinels and raw JSON/arrays', () => {
		const rows = [[null, undefined, '', '\\N', '\\D', 'a\tb', 'line1\r\nline2'], ['"quoted"', '__NULL__', '{"big":9007199254740993}', '{"a,b",NULL,""}', '9007199254740993']];
		expect(fromTSV(toTSV(rows))).toEqual(rows);
	});
	test('accepts external TSV and quoted multiline fields, rejects malformed quotes atomically', () => {
		expect(fromTSV('a\tb\r\nc\t\r\n')).toEqual([['a', 'b'], ['c', '']]);
		expect(fromTSV('"line1\nline2"\tTRUE')).toEqual([['line1\nline2', 'TRUE']]);
		expect(() => fromTSV('"unclosed')).toThrow('Unclosed');
		expect(() => fromTSV('"ok"bad')).toThrow('Unexpected');
	});
});

test('remote command errors show the message, not a serialized HTTP error', () => {
	try { error(409, 'Row changed'); } catch (value) { expect(message(value)).toBe('Row changed'); }
	expect(message({ message: 'Connection expired' })).toBe('Connection expired');
});

test('remote transport round-trips prototype-like column names without prototype mutation', () => {
	const values = Object.fromEntries([['__proto__', 'literal'], ['constructor', '9007199254740993'], ['empty', '']]);
	const identity = { pk: Object.fromEntries([['__proto__', 'key']]), version: '1', relation: '42' };
	const encoders = Object.fromEntries(Object.entries(transport).map(([name, codec]) => [name, codec.encode]));
	const decoders = Object.fromEntries(Object.entries(transport).map(([name, codec]) => [name, codec.decode]));
	const data = { rows: [{ values, identity }], updates: [{ identity, changes: values }], inserts: [values], filter: values };
	const result = parse(stringify(data, encoders), decoders);
	expect(result).toEqual(data);
	expect(Object.hasOwn(result.rows[0].values, '__proto__')).toBe(true);
	expect(Object.getPrototypeOf(result.rows[0].values)).toBe(Object.prototype);
	const hostile = transport.ColumnRecord.decode([['__proto__', { polluted: true }]]);
	expect(Object.hasOwn(hostile, '__proto__')).toBe(true);
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	for (const value of [null, {}, [['key']], [[{}, 'value']]]) {
		expect(() => transport.ColumnRecord.decode(value)).toThrow('Invalid column record');
	}
});

describe('remote validation', () => {
	const target = { connection: 'generation', schema: 'public', table: 'users' };
	const identity = { pk: { id: '9007199254740993' }, version: '123', relation: '456' };
	test('optional row filters preserve exact values and reject malformed payloads', () => {
		const input = { ...target, page: 0, pageSize: 100, sort: null, search: '' };
		expect(rowsSchema['~standard'].validate(input)).toEqual({ value: input });
		const filter = JSON.parse('{"__proto__":"literal","id":"9007199254740993","nullable":null,"empty":""}');
		const result = rowsSchema['~standard'].validate({ ...input, filter });
		expect(result).toEqual({ value: { ...input, filter } });
		if ('value' in result) expect(Object.hasOwn(result.value.filter!, '__proto__')).toBe(true);
		expect(rowsSchema['~standard'].validate({ ...input, filter: {} })).toEqual({ value: { ...input, filter: {} } });
		for (const filter of [undefined, null, [], 'id = 1', { id: 42 }, { id: true }, { id: {} }, { id: 'a\0b' }]) {
			expect(rowsSchema['~standard'].validate({ ...input, filter })).toHaveProperty('issues');
		}
	});
	test('rejects malformed, oversized and non-text mutation inputs', () => {
		for (const input of [null, {}, { ...target, updates: [], inserts: [{ id: 42 }] }, { ...target, updates: [], inserts: Array(501).fill({}) }]) {
			expect(saveSchema['~standard'].validate(input)).toHaveProperty('issues');
		}
		expect(deleteSchema['~standard'].validate({ ...target, identities: [{ ...identity, pk: {} }] })).toHaveProperty('issues');
		expect(rowsSchema['~standard'].validate({ ...target, page: Infinity, pageSize: 500, sort: null, search: '' })).toHaveProperty('issues');
		expect(connectSchema['~standard'].validate({ url: {}, expected: null })).toHaveProperty('issues');
	});
	test('preserves arbitrary column names and valid text payloads without coercion', () => {
		const input = { ...target, updates: [{ identity, changes: JSON.parse('{"__proto__":"literal","doc":"[1,2]","nullable":null}') }], inserts: [{}] };
		const result = saveSchema['~standard'].validate(input);
		expect(result).toHaveProperty('value');
		if ('value' in result) {
			expect(result.value).toEqual(input);
			expect(Object.hasOwn(result.value.updates[0].changes, '__proto__')).toBe(true);
		}
	});
});
