import { describe, expect, test } from 'bun:test';
import { prettyJSON } from '../src/lib/json.js';

describe('lossless JSON formatting', () => {
	test('preserves large integers, signed zero, decimal precision and exponent spelling', () => {
		const numbers = ['9007199254740993', '-999999999999999999999999999999999999', '-0', '1.230000', '0.000000000000000000001', '1e400', '1E+009', '-2.3400e-010'];
		expect(prettyJSON(`[${numbers.join(',')}]`)).toBe(`[\n  ${numbers.join(',\n  ')}\n]`);
	});

	test('retains duplicate keys, order and prototype-like names', () => {
		expect(prettyJSON('{"z":1,"a":2,"z":3,"__proto__":{"constructor":null}}')).toBe(
			'{\n  "z": 1,\n  "a": 2,\n  "z": 3,\n  "__proto__": {\n    "constructor": null\n  }\n}'
		);
	});

	test('leaves malformed, incomplete and empty documents exactly unchanged', () => {
		for (const source of [
			'', ' \r\n\t', '{', '[1,', '{"a":', '{"a":1,}', '[1,]', '{a:1}', '{"a" 1}',
			'01', '+1', '1.', '.1', '1e', 'NaN', 'Infinity', 'undefined', 'true false', '{}[]',
			'/* comment */ {}', '{"a":1 // comment\n}', ' \t{"a":1} trailing\r\n',
			String.raw`{"a":"\q"}`, String.raw`{"a":"\uZZZZ"}`, '"unterminated',
			'"raw\nnewline"', '"raw\t tab"', '{"x":\u0000}', '\uFEFF{}'
		]) expect(prettyJSON(source)).toBe(source);
	});

});
