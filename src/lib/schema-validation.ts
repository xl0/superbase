import type { ColumnDefault, ColumnSpec, SchemaChangeArgs, SchemaOperation } from './schema.js';
import type { TableTarget } from './types.js';
import { object, schema, target, text } from './validation.js';

function exact(input: unknown, keys: string[]): Record<string, unknown> {
	const value = object(input, keys);
	if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
		throw new Error('Expected exactly: ' + keys.join(', '));
	}
	return value;
}

function name(input: unknown): string {
	const value = text(input, 63);
	if (new TextEncoder().encode(value).length > 63 || !value.isWellFormed()) {
		throw new Error('Identifiers must be valid Unicode and at most 63 UTF-8 bytes');
	}
	return value;
}

function schemaTarget(value: Record<string, unknown>): TableTarget {
	const result = { ...target(value), schema: name(value.schema), table: name(value.table) };
	if (result.schema.startsWith('pg_') || result.schema === 'information_schema') {
		throw new Error('System schemas cannot be edited');
	}
	return result;
}

function flag(input: unknown): boolean {
	if (typeof input !== 'boolean') throw new Error('Expected a boolean');
	return input;
}

function columnDefault(input: unknown): ColumnDefault {
	const value = object(input);
	if (value.kind === 'literal') {
		exact(value, ['kind', 'value']);
		return { kind: 'literal', value: text(value.value, 10_000, true) };
	}
	exact(value, ['kind']);
	switch (value.kind) {
		case 'keep': case 'none': case 'now': case 'today': case 'currentTime': case 'uuid': case 'identity':
			return { kind: value.kind };
		default: throw new Error('Invalid column default');
	}
}

function column(input: unknown, fresh: boolean): ColumnSpec {
	const value = exact(input, ['name', 'typeOid', 'typeModifiers', 'nullable', 'default', 'comment', 'primaryKey']);
	const typeOid = value.typeOid === null ? null : text(value.typeOid, 10);
	if (typeOid !== null && !/^[1-9]\d*$/.test(typeOid)) throw new Error('Invalid type OID');
	if (!Array.isArray(value.typeModifiers) || value.typeModifiers.length > 2
		|| !Array.from(value.typeModifiers).every(Number.isSafeInteger)) {
		throw new Error('Type options require at most two whole, safe integer values');
	}
	if (typeOid === null && value.typeModifiers.length) throw new Error('Keeping the existing type requires empty type options');
	const result: ColumnSpec = {
		name: name(value.name), typeOid, typeModifiers: [...value.typeModifiers], nullable: flag(value.nullable),
		default: columnDefault(value.default), comment: text(value.comment, 10_000, true),
		primaryKey: flag(value.primaryKey)
	};
	if (fresh && (typeOid === null || result.default.kind === 'keep')) {
		throw new Error('New columns require a type and an explicit default choice');
	}
	if (result.default.kind === 'identity' && (!fresh || result.nullable)) {
		throw new Error('Identity is only available for new, nonnullable integer columns');
	}
	return result;
}

function unique<T>(input: unknown, parse: (value: unknown) => T, key: (value: T) => string): T[] {
	if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
		throw new Error('Expected between 1 and 100 columns');
	}
	const result = Array.from(input, parse);
	if (new Set(result.map(key)).size !== result.length) throw new Error('Duplicate column name');
	return result;
}

function operation(input: unknown): SchemaOperation {
	const value = object(input);
	switch (value.kind) {
		case 'createTable':
			exact(value, ['kind', 'columns']);
			return { kind: value.kind, columns: unique(value.columns, (v) => column(v, true), (v) => v.name) };
		case 'renameTable':
			exact(value, ['kind', 'name']);
			return { kind: value.kind, name: name(value.name) };
		case 'dropTable':
			exact(value, ['kind']);
			return { kind: value.kind };
		case 'addColumn':
			exact(value, ['kind', 'column']);
			return { kind: value.kind, column: column(value.column, true) };
		case 'alterColumn':
			exact(value, ['kind', 'column', 'changes']);
			return { kind: value.kind, column: name(value.column), changes: column(value.changes, false) };
		case 'dropColumn':
			exact(value, ['kind', 'column']);
			return { kind: value.kind, column: name(value.column) };
		case 'addPrimaryKey':
			exact(value, ['kind', 'columns']);
			return { kind: value.kind, columns: unique(value.columns, name, (v) => v) };
		default: throw new Error('Invalid schema operation');
	}
}

export const schemaTargetSchema = schema<TableTarget>((input) =>
	schemaTarget(exact(input, ['connection', 'schema', 'table']))
);

export const schemaChangeSchema = schema<SchemaChangeArgs>((input) => {
	const value = exact(input, ['connection', 'schema', 'table', 'expected', 'operation']);
	const op = operation(value.operation);
	const expected = value.expected === null ? null : text(value.expected, 64);
	if (op.kind === 'createTable' ? expected !== null : expected === null || !/^[a-f0-9]{64}$/.test(expected)) {
		throw new Error('Existing tables require a schema fingerprint; new tables require expected: null');
	}
	return { ...schemaTarget(value), expected, operation: op };
});
