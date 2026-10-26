import { describe, expect, test } from 'bun:test';
import { error } from '@sveltejs/kit';
import { message } from '../src/lib/utils.js';
import { displayValue, fromTSV, toTSV } from '../src/lib/format.js';
import { arrayJSON, arrayLiteral } from '../src/lib/arrays.js';
import { parseViewHash, viewHash } from '../src/lib/view.js';
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

describe('arrays as JSON', () => {
	const array = (element: Column['kind']): Column => ({ ...column, type: 'array', kind: 'array', element });
	test('round-trips PostgreSQL array output through JSON without losing spelling', () => {
		const cases: [Column['kind'], string, string][] = [
			['text', '{"a\\"b","c\\\\d",NULL,"NULL","","x y",plain}', '["a\\"b","c\\\\d",null,"NULL","","x y","plain"]'],
			['number', '{{1.10,9007199254740993},{NaN,-2e+5}}', '[[1.10,9007199254740993],["NaN",-2e+5]]'],
			['boolean', '{t,f,NULL}', '[true,false,null]'],
			['json', '{"{\\"a\\": 1.0}","[1, 2]",NULL}', '[{"a": 1.0},[1, 2],null]']
		];
		for (const [element, literal, json] of cases) {
			expect(arrayJSON(literal, array(element))).toBe(json);
			expect(arrayJSON(arrayLiteral(json, element), array(element))).toBe(json);
		}
		expect(arrayLiteral('["a\\"b", "c\\\\d", null, 1.10, true]', 'text')).toBe('{"a\\"b","c\\\\d",NULL,1.10,true}');
	});
	test('keeps literals without a JSON form and rejects non-arrays', () => {
		expect(arrayJSON('[0:1]={1,2}', array('number'))).toBeNull();
		expect(arrayJSON('{1,2}', { ...array('number'), element: undefined })).toBeNull();
		for (const json of ['', '{"a": 1}', '[1,', '[1] 2']) expect(() => arrayLiteral(json, 'number')).toThrow();
	});
});

test('view hash round-trips filters, sort, page and FK references', () => {
	const view = {
		filters: [
			{ column: 'a.b', operator: 'eq' as const, value: 'x.y & z=1 #ü +' },
			{ column: 'status', operator: 'isNull' as const, value: '' },
			{ column: 'status', operator: 'like' as const, value: '%.%' }
		],
		sort: [{ column: 'placed.at', direction: 'desc' as const }, { column: 'id', direction: 'asc' as const }],
		page: 2, reference: { 'customer id': '38' }
	};
	expect(parseViewHash(viewHash({ schema: 's', table: 't', ...view }))).toEqual(view);
	expect(viewHash({ schema: 's', table: 't', filters: [], sort: [], page: 0, reference: null })).toBe('');
	expect(parseViewHash('')).toEqual({ filters: [], sort: [], page: 0, reference: null });
});
