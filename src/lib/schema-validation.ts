import { INDEX_METHODS, REFERENTIAL_ACTIONS } from './schema.js';
import type { ColumnConstraintOperation, ColumnDefault, ColumnSpec, ConstraintOperation, ConstraintSpec, SchemaChangeArgs, SchemaOperation } from './schema.js';
import type { CsvExportArgs, TableTarget } from './types.js';
import { object, rowQuery, schema, target, text } from './validation.js';

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
	plainArray(value.typeModifiers);
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

function unique<T>(input: unknown, parse: (value: unknown) => T, key: (value: T) => string, max = 100): T[] {
	if (!Array.isArray(input) || input.length < 1 || input.length > max) {
		throw new Error(`Expected between 1 and ${max} columns`);
	}
	plainArray(input);
	const result = Array.from(input, parse);
	if (new Set(result.map(key)).size !== result.length) throw new Error('Duplicate column name');
	return result;
}

function plainArray(input: unknown[]): void {
	if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1
		|| !Array.from({ length: input.length }, (_, i) => Object.hasOwn(input, i)).every(Boolean)) {
		throw new Error('Expected a plain, dense array');
	}
}

function constraint(input: unknown): ConstraintSpec {
	const value = object(input);
	if (value.kind === 'foreignKey') {
		exact(value, ['kind', 'name', 'columns', 'reference', 'match', 'onUpdate', 'onDelete', 'notValid', 'deferrable', 'initiallyDeferred']);
		const reference = exact(value.reference, ['schema', 'table', 'oid', 'version', 'columns']);
		const oid = text(reference.oid, 10), version = text(reference.version, 64);
		if (!/^[1-9]\d*$/.test(oid) || !/^[a-f0-9]{64}$/.test(version)) throw new Error('Foreign keys require a captured target OID and fingerprint');
		const columns = unique(value.columns, name, (v) => v, 32);
		const referencedColumns = unique(reference.columns, name, (v) => v, 32);
		if (columns.length !== referencedColumns.length) throw new Error('Foreign key column counts must match');
		const onUpdate = REFERENTIAL_ACTIONS.find((action) => action === value.onUpdate);
		const onDelete = REFERENTIAL_ACTIONS.find((action) => action === value.onDelete);
		if (!onUpdate || !onDelete || (value.match !== 'simple' && value.match !== 'full')) throw new Error('Unsupported foreign key action or match');
		const deferrable = flag(value.deferrable), initiallyDeferred = flag(value.initiallyDeferred);
		if (initiallyDeferred && !deferrable) throw new Error('Initially deferred requires a deferrable constraint');
		return { kind: value.kind, name: name(value.name), columns,
			reference: { schema: name(reference.schema), table: name(reference.table), oid, version, columns: referencedColumns },
			match: value.match, onUpdate, onDelete, notValid: flag(value.notValid), deferrable, initiallyDeferred };
	}
	if (value.kind === 'unique') {
		exact(value, ['kind', 'name', 'columns', 'nullsNotDistinct', 'deferrable', 'initiallyDeferred']);
		const deferrable = flag(value.deferrable), initiallyDeferred = flag(value.initiallyDeferred);
		if (initiallyDeferred && !deferrable) throw new Error('Initially deferred requires a deferrable constraint');
		return { kind: value.kind, name: name(value.name), columns: unique(value.columns, name, (v) => v, 32),
			nullsNotDistinct: flag(value.nullsNotDistinct), deferrable, initiallyDeferred };
	}
	if (value.kind === 'check') {
		exact(value, ['kind', 'name', 'expression', 'notValid', 'noInherit']);
		const expression = text(value.expression, 10_000);
		if (!expression.trim() || !expression.isWellFormed()) throw new Error('CHECK requires a valid Unicode expression');
		return { kind: value.kind, name: name(value.name), expression,
			notValid: flag(value.notValid), noInherit: flag(value.noInherit) };
	}
	throw new Error('Unsupported constraint kind');
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
		case 'duplicateTable':
			exact(value, ['kind', 'name', 'includeRows']);
			return { kind: value.kind, name: name(value.name), includeRows: flag(value.includeRows) };
		case 'dropTable':
			exact(value, ['kind']);
			return { kind: value.kind };
		case 'addColumn':
			exact(value, ['kind', 'column']);
			return { kind: value.kind, column: column(value.column, true) };
		case 'alterColumn': {
			const batched = Object.hasOwn(value, 'constraints');
			exact(value, ['kind', 'column', 'changes', ...(batched ? ['constraints'] : [])]);
			let constraints: ColumnConstraintOperation[] | undefined;
			if (batched) {
				if (!Array.isArray(value.constraints) || value.constraints.length > 20) throw new Error('At most 20 column constraint operations');
				plainArray(value.constraints);
				constraints = Array.from(value.constraints, (input) => {
					const op = constraintOperation(input);
					if (op.kind === 'renameConstraint' || op.kind === 'validateConstraint') throw new Error('Column constraints only support add, alter and drop');
					return op;
				});
				const oids = constraints.flatMap((op) => 'constraintOid' in op ? [op.constraintOid] : []);
				if (new Set(oids).size !== oids.length) throw new Error('Duplicate constraint OID');
			}
			return { kind: value.kind, column: name(value.column), changes: column(value.changes, false),
				...(constraints ? { constraints } : {}) };
		}
		case 'dropColumn':
			exact(value, ['kind', 'column']);
			return { kind: value.kind, column: name(value.column) };
		case 'addPrimaryKey':
			exact(value, ['kind', 'columns']);
			return { kind: value.kind, columns: unique(value.columns, name, (v) => v) };
		case 'createIndex': {
			exact(value, ['kind', 'name', 'method', 'unique', 'columns']);
			const method = INDEX_METHODS.find((method) => method === value.method);
			if (!method) throw new Error('Unsupported index method');
			return { kind: value.kind, name: name(value.name), method, unique: flag(value.unique),
				columns: unique(value.columns, name, (v) => v, 32) };
		}
		case 'addConstraint': case 'alterConstraint': case 'renameConstraint': case 'dropConstraint': case 'validateConstraint':
			return constraintOperation(value);
		case 'dropIndex': {
			exact(value, ['kind', 'indexOid']);
			const indexOid = text(value.indexOid, 10);
			if (!/^[1-9]\d*$/.test(indexOid)) throw new Error('Invalid index OID');
			return { kind: value.kind, indexOid };
		}
		default: throw new Error('Invalid schema operation');
	}
}

function constraintOperation(input: unknown): ConstraintOperation {
	const value = object(input);
	if (value.kind === 'addConstraint') {
		exact(value, ['kind', 'constraint']);
		return { kind: value.kind, constraint: constraint(value.constraint) };
	}
	if (value.kind === 'alterConstraint' || value.kind === 'renameConstraint' || value.kind === 'dropConstraint' || value.kind === 'validateConstraint') {
		exact(value, ['kind', 'constraintOid', ...(value.kind === 'alterConstraint' ? ['constraint'] : value.kind === 'renameConstraint' ? ['name'] : [])]);
		const constraintOid = text(value.constraintOid, 10);
		if (!/^[1-9]\d*$/.test(constraintOid)) throw new Error('Invalid constraint OID');
		if (value.kind === 'alterConstraint') return { kind: value.kind, constraintOid, constraint: constraint(value.constraint) };
		if (value.kind === 'renameConstraint') return { kind: value.kind, constraintOid, name: name(value.name) };
		return { kind: value.kind, constraintOid };
	}
	throw new Error('Invalid constraint operation');
}

export const constraintOperationSchema = schema<ConstraintOperation>(constraintOperation);

export const schemaTargetSchema = schema<TableTarget>((input) =>
	schemaTarget(exact(input, ['connection', 'schema', 'table']))
);

export const csvExportSchema = schema<CsvExportArgs>((input) => {
	const value = object(input, ['connection', 'schema', 'table', 'query', 'columns']);
	let columns: string[] | undefined;
	if (Object.hasOwn(value, 'columns')) {
		if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > 1600) {
			throw new Error('Select between 1 and 1600 columns');
		}
		columns = Array.from(value.columns, name);
		if (new Set(columns).size !== columns.length) throw new Error('Duplicate export column');
	}
	return {
		...schemaTarget(value),
		...(columns ? { columns } : {}),
		...(Object.hasOwn(value, 'query') ? {
			query: rowQuery(object(value.query, ['sort', 'search', 'filter', 'filters']))
		} : {})
	};
});

export const schemaChangeSchema = schema<SchemaChangeArgs>((input) => {
	const value = exact(input, ['connection', 'schema', 'table', 'expected', 'operation']);
	const op = operation(value.operation);
	const expected = value.expected === null ? null : text(value.expected, 64);
	if (op.kind === 'createTable' ? expected !== null : expected === null || !/^[a-f0-9]{64}$/.test(expected)) {
		throw new Error('Existing tables require a schema fingerprint; new tables require expected: null');
	}
	return { ...schemaTarget(value), expected, operation: op };
});
