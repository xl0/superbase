import type { DeleteArgs, FilterOperator, RowIdentity, RowsArgs, SaveArgs, Sort, TableTarget, Values } from './types.js';
import { FILTER_OPERATORS, MAX_FILTERS, MAX_SORTS } from './types.js';

/** Small Standard Schema adapter for the remote boundary; no validation dependency needed. */
function schema<T>(parse: (input: unknown) => T): {
	'~standard': {
		version: 1;
		vendor: string;
		types?: { input: T; output: T };
		validate(input: unknown): { value: T } | { issues: { message: string }[] };
	};
} {
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'superbase',
			validate(input: unknown) {
				try {
					return { value: parse(input) };
				} catch (error) {
					return { issues: [{ message: error instanceof Error ? error.message : 'Invalid request' }] };
				}
			}
		}
	};
}

function object(input: unknown, keys?: string[]): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Expected an object');
	const value = input as Record<string, unknown>;
	if (keys && Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unexpected field');
	return value;
}

function text(input: unknown, max = 1024, empty = false): string {
	if (typeof input !== 'string' || (!empty && !input) || input.length > max || input.includes('\0')) {
		throw new Error('Invalid text value');
	}
	return input;
}

function integer(input: unknown, min: number, max: number): number {
	if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) {
		throw new Error('Number is outside the allowed range');
	}
	return input;
}

function list<T>(input: unknown, parse: (value: unknown) => T): T[] {
	if (!Array.isArray(input) || input.length > 500) throw new Error('At most 500 rows per operation');
	return input.map(parse);
}

function values(input: unknown): Values {
	const entries = Object.entries(object(input));
	if (entries.length > 1600) throw new Error('Too many columns');
	return Object.fromEntries(entries.map(([key, value]) => [text(key), value === null ? null : text(value, 1_000_000, true)]));
}

function identity(input: unknown): RowIdentity {
	const value = object(input, ['pk', 'version', 'relation']);
	const pk = values(value.pk);
	if (!Object.keys(pk).length || Object.values(pk).some((value) => value === null)) {
		throw new Error('A complete primary key is required');
	}
	const version = text(value.version, 10);
	const relation = text(value.relation, 10);
	if (!/^\d+$/.test(version) || !/^\d+$/.test(relation)) throw new Error('Invalid row version');
	return { pk: pk as Record<string, string>, version, relation };
}

function target(value: Record<string, unknown>): TableTarget {
	return { connection: text(value.connection, 100), schema: text(value.schema), table: text(value.table) };
}

export const connectionSchema = schema((input) => {
	const value = object(input, ['connection']);
	return { connection: text(value.connection, 100) };
});

export const connectSchema = schema((input) => {
	const value = object(input, ['url', 'expected']);
	return { url: text(value.url, 8192), expected: value.expected === null ? null : text(value.expected, 100) };
});

export const switchSchema = schema((input) => {
	const value = object(input, ['expected']);
	return { expected: value.expected === null ? null : text(value.expected, 100) };
});

export const rowsSchema = schema<RowsArgs>((input) => {
	const value = object(input, ['connection', 'schema', 'table', 'page', 'pageSize', 'sort', 'search', 'filter', 'filters']);
	if (!Array.isArray(value.sort) || value.sort.length > MAX_SORTS) throw new Error(`Expected at most ${MAX_SORTS} sort rules`);
	const columns = new Set<string>();
	const sort = Array.from(value.sort, (input): Sort => {
		const rule = object(input, ['column', 'direction']);
		if (Reflect.ownKeys(rule).length !== 2 || !Object.hasOwn(rule, 'column') || !Object.hasOwn(rule, 'direction')) {
			throw new Error('Expected column and direction');
		}
		if (rule.direction !== 'asc' && rule.direction !== 'desc') throw new Error('Invalid sort direction');
		const column = text(rule.column);
		if (columns.has(column)) throw new Error(`Duplicate sort column: ${column}`);
		columns.add(column);
		return { column, direction: rule.direction };
	});
	let filters;
	if (Object.hasOwn(value, 'filters')) {
		if (!Array.isArray(value.filters) || value.filters.length > MAX_FILTERS) {
			throw new Error(`Expected at most ${MAX_FILTERS} filters`);
		}
		filters = Array.from(value.filters, (input) => {
			const filter = object(input, ['column', 'operator', 'value']);
			if (Reflect.ownKeys(filter).length !== 3 ||
				!['column', 'operator', 'value'].every((key) => Object.hasOwn(filter, key))) {
				throw new Error('Expected column, operator and value');
			}
			if (typeof filter.operator !== 'string' || !Object.hasOwn(FILTER_OPERATORS, filter.operator)) {
				throw new Error('Invalid filter operator');
			}
			const operator = filter.operator as FilterOperator;
			const raw = text(filter.value, 10_000, true);
			if (!FILTER_OPERATORS[operator].needsValue && raw !== '') {
				throw new Error('Null checks require an empty value');
			}
			return { column: text(filter.column), operator, value: raw };
		});
	}
	return {
		...target(value), page: integer(value.page, 0, 1_000_000), pageSize: integer(value.pageSize, 1, 500),
		search: text(value.search, 1024, true),
		...(Object.hasOwn(value, 'filter') ? { filter: values(value.filter) } : {}),
		...(filters ? { filters } : {}),
		sort
	};
});

export const saveSchema = schema<SaveArgs>((input) => {
	const value = object(input, ['connection', 'schema', 'table', 'updates', 'inserts']);
	const updates = list(value.updates, (input) => {
		const update = object(input, ['identity', 'changes']);
		return { identity: identity(update.identity), changes: values(update.changes) };
	});
	const inserts = list(value.inserts, values);
	if (updates.length + inserts.length > 500) throw new Error('At most 500 rows per save');
	return { ...target(value), updates, inserts };
});

export const deleteSchema = schema<DeleteArgs>((input) => {
	const value = object(input, ['connection', 'schema', 'table', 'identities']);
	return { ...target(value), identities: list(value.identities, identity) };
});
