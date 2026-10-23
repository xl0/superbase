import { describe, expect, test } from 'bun:test';
import { EditorState, StateEffect, Transaction } from '@codemirror/state';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { jsonValue, prettyJSON, setJSONValue } from '../src/lib/json.js';
import type { CellValue } from '../src/lib/types.js';

function buffer(value: CellValue | undefined, language: 'text' | 'json' = 'json') {
	const documentText = (value: CellValue | undefined) => language === 'json' ? prettyJSON(value ?? '') : value ?? '';
	let state = EditorState.create({
		doc: documentText(value),
		extensions: [EditorState.lineSeparator.of('\n'), history(), jsonValue.init(() => value)]
	});
	return {
		get state() { return state; },
		dispatch(transaction: Transaction) { state = transaction.state; },
		edit(text: string) {
			state = state.update({
				changes: { from: 0, to: state.doc.length, insert: text },
				annotations: isolateHistory.of('full')
			}).state;
		},
		set(value: CellValue | undefined) {
			const doc = documentText(value);
			state = state.update({
				changes: doc === state.doc.toString() ? undefined : { from: 0, to: state.doc.length, insert: doc },
				effects: setJSONValue.of({ value }),
				annotations: isolateHistory.of('full')
			}).state;
		}
	};
}

describe('JSON buffer semantic history', () => {
	test('undo/redo distinguish initial SQL NULL, DEFAULT and explicit empty text', () => {
		for (const original of [null, undefined, '']) {
			const editor = buffer(original);
			expect(editor.state.doc.toString()).toBe('');
			expect(editor.state.field(jsonValue)).toBe(original);
			expect(undo(editor)).toBe(false);
			editor.edit('{"x":1}');
			expect(editor.state.field(jsonValue)).toBe('{"x":1}');
			expect(undo(editor)).toBe(true);
			expect(editor.state.doc.toString()).toBe('');
			expect(editor.state.field(jsonValue)).toBe(original);
			expect(redo(editor)).toBe(true);
			expect(editor.state.field(jsonValue)).toBe('{"x":1}');
		}
	});

	test('user-deleted empty documents remain text, including intermediate undo/redo', () => {
		for (const original of [null, undefined]) {
			const editor = buffer(original);
			editor.edit('1');
			editor.edit('');
			expect(editor.state.field(jsonValue)).toBe('');
			editor.edit('2');
			for (const expected of ['', '1', original]) {
				expect(undo(editor)).toBe(true);
				expect(editor.state.field(jsonValue)).toBe(expected);
			}
			for (const expected of ['1', '', '2']) {
				expect(redo(editor)).toBe(true);
				expect(editor.state.field(jsonValue)).toBe(expected);
			}
		}
	});

	test('undo grouped keystrokes restores the oldest semantic value', () => {
		const editor = buffer(null);
		for (const text of ['{', '"x"', ':1}']) editor.dispatch(editor.state.update({
			changes: { from: editor.state.doc.length, insert: text },
			annotations: [Transaction.userEvent.of('input.type'), Transaction.time.of(100)]
		}));
		expect(editor.state.doc.toString()).toBe('{"x":1}');
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBeNull();
		expect(editor.state.doc.toString()).toBe('');
		expect(undo(editor)).toBe(false);
		expect(redo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe('{"x":1}');
	});

	test('DEFAULT effects survive CodeMirror history position mapping', () => {
		const editor = buffer(undefined);
		const effects = StateEffect.mapEffects(
			[setJSONValue.of({ value: undefined })], editor.state.changes({ from: 0, insert: '1' })
		);
		expect(effects).toHaveLength(1);
		expect(effects[0].value).toEqual({ value: undefined });
	});

	test('reconfiguration preserves history and undo restores exact unformatted original text', () => {
		const original = ' \n{"x":9007199254740993,"x":1E+009} ';
		const editor = buffer(original);
		expect(editor.state.field(jsonValue)).toBe(original);
		expect(editor.state.doc.toString()).toBe(prettyJSON(original));
		editor.edit('null');
		editor.dispatch(editor.state.update({
			selection: { anchor: 2 },
			effects: StateEffect.reconfigure.of([history(), jsonValue])
		}));
		expect(editor.state.selection.main.head).toBe(2);
		expect(editor.state.field(jsonValue)).toBe('null');
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe(original);
		expect(editor.state.doc.toString()).toBe(prettyJSON(original));
		expect(redo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe('null');
	});

	test('external NULL/DEFAULT/empty changes are distinct undoable semantic operations', () => {
		const editor = buffer(null);
		for (const value of [undefined, '', null]) {
			editor.set(value);
			expect(editor.state.doc.toString()).toBe('');
			expect(editor.state.field(jsonValue)).toBe(value);
		}
		for (const value of ['', undefined, null]) {
			expect(undo(editor)).toBe(true);
			expect(editor.state.field(jsonValue)).toBe(value);
		}
		for (const value of [undefined, '', null]) {
			expect(redo(editor)).toBe(true);
			expect(editor.state.field(jsonValue)).toBe(value);
		}
		editor.set(undefined);
		editor.edit('{"x":1}');
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBeUndefined();
		expect(editor.state.doc.toString()).toBe('');
	});

	test('external text updates keep exact spelling and form their own undo boundary', () => {
		const original = '{"x":1}';
		const external = ' {"big":9007199254740993} ';
		const editor = buffer(original);
		editor.edit('[]');
		editor.set(null);
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe('[]');
		expect(editor.state.doc.toString()).toBe('[]');
		editor.set(external);
		expect(editor.state.doc.toString()).toBe(prettyJSON(external));
		expect(editor.state.field(jsonValue)).toBe(external);
		editor.set(null);
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe(external);
		expect(editor.state.doc.toString()).toBe(prettyJSON(external));
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe('[]');
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe(original);
	});
});

describe('plain-text buffer', () => {
	test('JSON-looking text and mixed line endings survive input and undo verbatim', () => {
		for (const original of [' \t{ "n": 9007199254740993 }\r\n', 'first\r\nsecond\rthird\nfourth\t ']) {
			const editor = buffer(original, 'text');
			expect(editor.state.doc.toString()).toBe(original);
			editor.dispatch(editor.state.update({ changes: { from: 0, insert: 'X' } }));
			expect(editor.state.field(jsonValue)).toBe(`X${original}`);
			expect(undo(editor)).toBe(true);
			expect(editor.state.doc.toString()).toBe(original);
			expect(editor.state.field(jsonValue)).toBe(original);
			expect(redo(editor)).toBe(true);
			expect(editor.state.field(jsonValue)).toBe(`X${original}`);
			editor.set(original);
			expect(editor.state.doc.toString()).toBe(original);
		}
	});

	test('plain text retains NULL, DEFAULT and empty semantics through undo', () => {
		for (const original of [null, undefined, '']) {
			const editor = buffer(original, 'text');
			editor.edit('hello');
			expect(undo(editor)).toBe(true);
			expect(editor.state.field(jsonValue)).toBe(original);
		}
		const editor = buffer(null, 'text');
		editor.set('');
		editor.set(undefined);
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBe('');
		expect(undo(editor)).toBe(true);
		expect(editor.state.field(jsonValue)).toBeNull();
	});
});

describe('lossless JSON formatting', () => {
	test('preserves large integers, signed zero, decimal precision and exponent spelling', () => {
		const numbers = ['9007199254740993', '-999999999999999999999999999999999999', '-0', '1.230000', '0.000000000000000000001', '1e400', '1E+009', '-2.3400e-010'];
		expect(prettyJSON(`[${numbers.join(',')}]`)).toBe(`[\n  ${numbers.join(',\n  ')}\n]`);
	});

	test('preserves escaped keys and string lexemes without decoding or re-escaping', () => {
		const key = String.raw`"\u006b\"\\"`;
		const value = String.raw`"\u0041\ud83d\ude00\uD800\/\\\"\b\f\n\r\t"`;
		expect(prettyJSON(`{${key}:${value},"literal":"é 😀"}`)).toBe(`{\n  ${key}: ${value},\n  "literal": "é 😀"\n}`);
	});

	test('retains duplicate keys, order and prototype-like names', () => {
		expect(prettyJSON('{"z":1,"a":2,"z":3,"__proto__":{"constructor":null}}')).toBe(
			'{\n  "z": 1,\n  "a": 2,\n  "z": 3,\n  "__proto__": {\n    "constructor": null\n  }\n}'
		);
	});

	test('indents nested arrays/objects and keeps empty containers compact', () => {
		const source = ' \r\n { "items" : [ { "v": [true,false,null] }, {}, [] ], "empty":{} }\t';
		const expected = '{\n  "items": [\n    {\n      "v": [\n        true,\n        false,\n        null\n      ]\n    },\n    {},\n    []\n  ],\n  "empty": {}\n}';
		expect(prettyJSON(source)).toBe(expected);
		expect(prettyJSON(expected)).toBe(expected);
	});

	test('handles top-level scalars and JSON null without coercion', () => {
		for (const scalar of ['null', 'true', 'false', '9007199254740993', '-0.00E+10', '""', '"a : { b, [ c ] }"', '{}', '[]']) {
			expect(prettyJSON(` \t${scalar}\r\n`)).toBe(scalar);
		}
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

	test('treats HTML/script-looking strings as literal data', () => {
		const payload = String.raw`"</script><img src=x onerror=alert(1)>&\u003cscript\u003e"`;
		expect(prettyJSON(`{"html":${payload}}`)).toBe(`{\n  "html": ${payload}\n}`);
	});
});
