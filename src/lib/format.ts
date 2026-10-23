import type { Column } from './types';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Postgres renders timestamps as `2026-10-23 02:52:05.893+00`; keep them compact. */
export function formatTimestamp(raw: string): string {
	const value = raw.trim();
	// Show date + time down to seconds, dropping fractional seconds and the timezone for table display.
	return value.replace('T', ' ').replace(/(\.\d+)?\+00(:?00)?$/, '');
}

export function formatNumber(value: number): string {
	return value.toLocaleString('en-US');
}

export function displayValue(value: unknown, column: Column): string {
	if (value === null || value === undefined) return 'NULL';
	switch (column.kind) {
		case 'number':
			return typeof value === 'number' ? formatNumber(value) : String(value);
		case 'timestamp':
			return typeof value === 'string' ? formatTimestamp(value) : String(value);
		case 'json':
			return JSON.stringify(value);
		case 'array':
			return Array.isArray(value) ? `{${value.join(',')}}` : String(value);
		case 'boolean':
			return value ? 'true' : 'false';
		default:
			return String(value);
	}
}
