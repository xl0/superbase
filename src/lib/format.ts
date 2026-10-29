import type { CellValue, Column } from './types.js';
import { arrayJSON } from './arrays.js';

/** Date/time columns, which accept 'now'; not their arrays (`timestamp with time zone[]`). */
export const isTemporal = (column: Column) => column.kind !== 'array' && /^(date|timestamp|time)(?:\(|\s|$)/.test(column.type);
/** Fixed choices for boolean ('t'/'f' as PostgreSQL prints them) and enum columns. */
export const valueOptions = (column: Column) => column.kind === 'boolean' ? ['t', 'f'] : column.enumValues ?? [];
export const optionLabel = (column: Column, option: string) =>
	column.kind === 'boolean' ? option === 't' ? 'true' : 'false' : option || '(empty string)';
/** Spells out values that look alike in an input: NULL, DEFAULT and empty text. */
export const valueState = (value: CellValue | undefined) =>
	value === null ? 'SQL NULL' : value === undefined ? 'DEFAULT' : value === '' ? 'Empty text' : '';

export function displayValue(value: CellValue | undefined, column: Column): string {
	if (value === undefined) return 'DEFAULT';
	if (value === null) return 'NULL';
	if (column.kind === 'boolean') return value === 't' || value === 'true' ? 'TRUE' : 'FALSE';
	if (column.kind === 'array') return arrayJSON(value, column) ?? value;
	return value;
}

/** Quoted TSV. Unquoted \N = SQL NULL, \D = DEFAULT; literal markers are quoted. */
export function toTSV(rows: (CellValue | undefined)[][]): string {
	return rows.map((row) => row.map((value) => {
		if (value === null) return '\\N';
		if (value === undefined) return '\\D';
		return !value || /[\t\r\n"]/.test(value) || value === '\\N' || value === '\\D'
			? `"${value.replaceAll('"', '""')}"` : value;
	}).join('\t')).join('\n');
}

/**
 * Inverse of toTSV, lenient for raw text: a field counts as quoted only if its closing quote ends the field and its
 * content needed quoting (as toTSV and spreadsheets quote). Anything else, e.g. `"key": 1` or `"abc"`, pastes as is.
 */
export function fromTSV(text: string): (CellValue | undefined)[][] {
	const rows: (CellValue | undefined)[][] = [];
	let row: (CellValue | undefined)[] = [];
	const separator = (i: number) => i >= text.length || text[i] === '\t' || text[i] === '\r' || text[i] === '\n';
	let i = 0;
	for (;;) {
		let value: CellValue | undefined;
		let quoted: string | null = null;
		if (text[i] === '"') {
			let j = i + 1;
			let content = '';
			for (; j < text.length; j++) {
				if (text[j] !== '"') content += text[j];
				else if (text[j + 1] === '"') { content += '"'; j++; }
				else break;
			}
			if (j < text.length && separator(j + 1) && (!content || content === '\\N' || content === '\\D' || /[\t\r\n"]/.test(content))) {
				quoted = content;
				i = j + 1;
			}
		}
		if (quoted !== null) value = quoted;
		else {
			let end = i;
			while (!separator(end)) end++;
			const raw = text.slice(i, end);
			value = raw === '\\N' ? null : raw === '\\D' ? undefined : raw;
			i = end;
		}
		row.push(value);
		if (i >= text.length) { rows.push(row); break; }
		if (text[i++] === '\t') continue;
		if (text[i - 1] === '\r' && text[i] === '\n') i++;
		rows.push(row);
		row = [];
		if (i >= text.length) break;
	}
	return rows;
}
