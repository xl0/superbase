import { FILTER_OPERATORS, type FilterOperator, type RowFilter, type Sort, type Values } from './types.js';

/** What the table editor shows. Schema and table live in the route; the rest in the URL hash. */
export interface TableView {
	schema: string;
	table: string;
	filters: RowFilter[];
	sort: Sort[];
	/** Zero-based; the URL shows it one-based. */
	page: number;
	/** Exact match from following a foreign key; values are never NULL. */
	reference: Values | null;
}

/** `#f.status=eq.pending&sort=placed_at.desc&page=2&ref.id=38`; repeated keys keep order. */
export function viewHash(view: TableView): string {
	const params = new URLSearchParams();
	for (const filter of view.filters) params.append(`f.${filter.column}`, `${filter.operator}.${filter.value}`);
	for (const rule of view.sort) params.append('sort', `${rule.column}.${rule.direction}`);
	for (const [column, value] of Object.entries(view.reference ?? {})) params.append(`ref.${column}`, value ?? '');
	if (view.page) params.set('page', String(view.page + 1));
	const text = params.toString();
	return text ? `#${text}` : '';
}

/** Inverse of viewHash. Filters with an unknown operator (a hand-edited or stale link) are dropped. */
export function parseViewHash(hash: string): Omit<TableView, 'schema' | 'table'> {
	const params = new URLSearchParams(hash.replace(/^#/, ''));
	const filters: RowFilter[] = [];
	const sort: Sort[] = [];
	const reference: Values = {};
	for (const [key, value] of params) {
		if (key.startsWith('f.')) {
			const [operator, ...rest] = value.split('.');
			if (Object.hasOwn(FILTER_OPERATORS, operator)) filters.push({ column: key.slice(2), operator: operator as FilterOperator, value: rest.join('.') });
		} else if (key === 'sort') {
			// A hand-edited rule may omit the direction (ascending).
			const [, column, direction] = value.match(/^(.*)\.(asc|desc)$/) ?? [, value, 'asc'];
			sort.push({ column, direction: direction as Sort['direction'] });
		} else if (key.startsWith('ref.')) reference[key.slice(4)] = value;
	}
	const page = Math.max(0, (Number.parseInt(params.get('page') ?? '', 10) || 1) - 1);
	return { filters, sort, page, reference: Object.keys(reference).length ? reference : null };
}
