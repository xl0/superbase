import type { ConstraintSpec, SchemaConstraint } from './schema.js';

/** Joined UI labels must distinguish a.b/c from a/b.c and one comma-containing key from two keys. */
export const displayIdentifier = (name: string) => /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;

/** Target fingerprints load asynchronously; refreshing metadata alone is not a user edit. */
export const schemaDraftSnapshot = (value: unknown) => JSON.stringify(value, (key, value) => key === 'version' ? undefined : value);

export function constraintSpec(constraint: SchemaConstraint): ConstraintSpec {
	if (constraint.kind === 'u') return {
		kind: 'unique', name: constraint.name, columns: [...constraint.columns], nullsNotDistinct: constraint.nullsNotDistinct,
		deferrable: constraint.deferrable, initiallyDeferred: constraint.initiallyDeferred
	};
	if (constraint.kind === 'f') {
		const reference = constraint.foreignKey!;
		if (reference.match === 'partial') throw new Error('MATCH PARTIAL requires SQL');
		return { kind: 'foreignKey', name: constraint.name, columns: [...constraint.columns],
			reference: { schema: reference.schema, table: reference.table, oid: reference.tableOid, version: '', columns: [...reference.columns] },
			match: reference.match, onUpdate: reference.onUpdate, onDelete: reference.onDelete,
			notValid: !constraint.validated, deferrable: constraint.deferrable, initiallyDeferred: constraint.initiallyDeferred };
	}
	return { kind: 'check', name: constraint.name, expression: constraint.expression ?? '', notValid: !constraint.validated, noInherit: constraint.noInherit };
}
