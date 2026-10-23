import type { CellValue, Column } from './types.js';

/** Counts only. Database numeric cells must not pass through Number or locale rounding. */
export function formatNumber(value: number): string {
	return value.toLocaleString('en-US');
}

export function displayValue(value: CellValue | undefined, column: Column): string {
	if (value === undefined) return 'DEFAULT';
	if (value === null) return 'NULL';
	if (column.kind === 'boolean') return value === 't' || value === 'true' ? 'TRUE' : 'FALSE';
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

export function fromTSV(text: string): (CellValue | undefined)[][] {
	const rows: (CellValue | undefined)[][] = [];
	let row: (CellValue | undefined)[] = [];
	let field = '';
	let quoted = false;
	let inQuotes = false;
	let closed = false;
	const finish = () => {
		row.push(!quoted && field === '\\N' ? null : !quoted && field === '\\D' ? undefined : field);
		field = ''; quoted = false; closed = false;
	};
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inQuotes) {
			if (char !== '"') field += char;
			else if (text[i + 1] === '"') { field += '"'; i++; }
			else { inQuotes = false; closed = true; }
		} else if (char === '\t' || char === '\r' || char === '\n') {
			finish();
			if (char !== '\t') {
				rows.push(row); row = [];
				if (char === '\r' && text[i + 1] === '\n') i++;
			}
		} else if (char === '"' && !field && !closed) {
			quoted = true; inQuotes = true;
		} else {
			if (closed) throw new Error('Unexpected text after a quoted clipboard value');
			field += char;
		}
	}
	if (inQuotes) throw new Error('Unclosed quote in clipboard data');
	if (field || quoted || row.length || !rows.length) { finish(); rows.push(row); }
	return rows;
}
