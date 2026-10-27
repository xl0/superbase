import { jsonLanguage } from '@codemirror/lang-json';
import type { Column, ColumnKind } from './types.js';

/**
 * Array values stay PostgreSQL text but are shown and edited as JSON, like Supabase.
 * Only plain `{…}` literals of comma-delimited element types (`Column.element` set) convert;
 * explicit bounds (`[0:1]={…}`) and box[] keep their literal.
 */
type Item = string | null | Item[];

/** PostgreSQL's array output: quoted items use backslash escapes, NULL is unquoted. */
function parseArray(text: string): Item[] | null {
	let i = 0;
	const list = (): Item[] | null => {
		const items: Item[] = [];
		if (text[++i] === '}') { i++; return items; }
		while (i < text.length) {
			if (text[i] === '{') {
				const inner = list();
				if (!inner) return null;
				items.push(inner);
			} else if (text[i] === '"') {
				let value = '';
				for (i++; i < text.length && text[i] !== '"'; i++) value += text[i] === '\\' ? text[++i] : text[i];
				i++;
				items.push(value);
			} else {
				const start = i;
				while (i < text.length && text[i] !== ',' && text[i] !== '}') i++;
				const raw = text.slice(start, i);
				items.push(raw === 'NULL' ? null : raw);
			}
			if (text[i] === '}') { i++; return items; }
			if (text[i++] !== ',') return null;
		}
		return null;
	};
	if (text[0] !== '{') return null;
	const items = list();
	return items && i === text.length ? items : null;
}

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function itemJSON(item: Item, element: ColumnKind): string {
	if (item === null) return 'null';
	if (Array.isArray(item)) return `[${item.map((inner) => itemJSON(inner, element)).join(',')}]`;
	// Element text is used verbatim where it already is valid JSON, so numbers keep their spelling.
	if (element === 'number' && JSON_NUMBER.test(item)) return item;
	if (element === 'boolean') return item === 't' || item === 'true' ? 'true' : 'false';
	if (element === 'json') return item;
	return JSON.stringify(item);
}

/** Compact JSON for an array value, or null when it has no JSON form. */
export function arrayJSON(value: string, column: Column): string | null {
	const items = column.element ? parseArray(value) : null;
	return items && itemJSON(items, column.element!);
}

/** Clipboard text: arrays copy as the JSON shown in the grid. */
export const arrayCopyText = (value: string, column: Column) => arrayJSON(value, column) ?? value;

/** Pasted text for an array column: a JSON array converts; a literal (`{…}`, `[0:1]={…}`) passes as is. */
export function arrayPasteValue(text: string, column: Column): string {
	return column.element && text.trimStart().startsWith('[') && !/^\s*\[-?\d+:-?\d+\]/.test(text) ? arrayLiteral(text, column.element) : text;
}

const quote = (text: string) => `"${text.replace(/["\\]/g, '\\$&')}"`;

/** JSON array → PostgreSQL array literal. Numbers keep their spelling; PostgreSQL validates the elements. */
export function arrayLiteral(source: string, element: ColumnKind): string {
	const tree = jsonLanguage.parser.parse(source);
	let invalid = false;
	tree.iterate({ enter: (node) => { if (node.type.isError) invalid = true; } });
	const top = tree.topNode.firstChild;
	if (invalid || top?.name !== 'Array') throw new Error('Enter a JSON array, e.g. ["a", "b"] or [1, 2].');
	// Nested arrays are dimensions, except in json/jsonb arrays where every element is a document.
	const convert = (node: NonNullable<typeof top>, nested: boolean): string => {
		if (node.name === 'Null') return 'NULL';
		if (node.name === 'Array' && !(nested && element === 'json')) {
			const items: string[] = [];
			for (let child = node.firstChild; child; child = child.nextSibling) {
				if (child.name !== '[' && child.name !== ']' && child.name !== ',') items.push(convert(child, true));
			}
			return `{${items.join(',')}}`;
		}
		const text = source.slice(node.from, node.to);
		if (element !== 'json' && node.name === 'String') return quote(JSON.parse(text));
		return node.name === 'Number' || node.name === 'True' || node.name === 'False' ? text : quote(text);
	};
	return convert(top, false);
}
