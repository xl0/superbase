import type { ColumnDefault, ColumnSpec, SchemaColumn, SchemaType } from './schema.js';

export const DEFAULT_LABELS: Record<ColumnDefault['kind'], string> = {
	keep: 'Keep existing default', none: 'No default', literal: 'Literal value',
	now: 'Current timestamp', today: 'Current date', currentTime: 'Current time',
	uuid: 'Generate UUID', identity: 'Identity (by default)'
};

/** Resolve only real arrays, never domains (including domains over arrays). */
export function elementType(type: SchemaType | undefined, types: SchemaType[]): SchemaType | undefined {
	return type?.kind === 'array' ? types.find((item) => item.oid === type.elementOid) : type;
}

export function typeOptionsError(type: SchemaType | undefined, modifiers: number[], types: SchemaType[]): string | null {
	if (!Array.isArray(modifiers) || modifiers.length > 2 || !Array.from(modifiers).every(Number.isSafeInteger)) {
		return 'Type options require at most two whole, safe integer values';
	}
	if (!modifiers.length) return null;
	const base = elementType(type, types);
	if (base?.kind !== 'base' || base.schema !== 'pg_catalog') return 'This type does not support editable type options';
	const [first, second] = modifiers;
	switch (base.name) {
		case 'numeric':
			if (first < 1 || first > 1000) return 'Numeric precision must be between 1 and 1000';
			if (modifiers.length === 2 && (second < -1000 || second > 1000)) return 'Numeric scale must be between -1000 and 1000';
			return null;
		case 'varchar': case 'bpchar':
			return modifiers.length !== 1 || first < 1 || first > 10_485_760
				? 'Character length must be one integer between 1 and 10485760' : null;
		case 'bit': case 'varbit':
			return modifiers.length !== 1 || first < 1 || first > 83_886_080
				? 'Bit length must be one integer between 1 and 83886080' : null;
		case 'timestamp': case 'timestamptz': case 'time': case 'timetz':
			return modifiers.length !== 1 || first < 0 || first > 6
				? 'Fractional precision must be one integer between 0 and 6' : null;
		default: return 'This type does not support editable type options';
	}
}

export function defaultOptions(type: SchemaType | undefined, fresh: boolean): { kind: ColumnDefault['kind']; label: string }[] {
	const kinds: ColumnDefault['kind'][] = fresh ? ['none', 'literal'] : ['keep', 'none', 'literal'];
	if (type?.kind === 'base' && type.schema === 'pg_catalog') {
		switch (type.name) {
			case 'timestamp': case 'timestamptz': kinds.push('now'); break;
			case 'date': kinds.push('today'); break;
			case 'time': case 'timetz': kinds.push('currentTime'); break;
			case 'uuid': case 'text': case 'varchar': case 'bpchar': kinds.push('uuid'); break;
			case 'int2': case 'int4': case 'int8': if (fresh) kinds.push('identity'); break;
		}
	}
	return kinds.map((kind) => ({ kind, label: kind === 'uuid' && type?.name !== 'uuid' ? 'Generate UUID as text' : DEFAULT_LABELS[kind] }));
}

export function columnOptionsError(column: ColumnSpec, types: SchemaType[], existing?: SchemaColumn): string | null {
	if (column.typeOid === null && !existing) return 'New columns require a type';
	if (column.typeOid === null && (!Array.isArray(column.typeModifiers) || column.typeModifiers.length)) {
		return 'Keeping the existing type requires empty type options';
	}
	const type = types.find((item) => item.oid === (column.typeOid ?? existing?.typeOid));
	if (column.typeOid !== null) {
		if (!type) return 'Type is not an approved catalog type; reload the type catalog';
		const error = typeOptionsError(type, column.typeModifiers, types);
		if (error) return error;
	}
	if (existing?.generated && (column.typeOid !== null || column.default.kind !== 'keep')) {
		return 'Generated columns must keep their existing type and expression';
	}
	if (existing?.identity && column.default.kind !== 'keep') return 'Existing identity columns must keep their default';
	if (column.default.kind === 'identity' && (existing || column.nullable || !defaultOptions(type, true).some((option) => option.kind === 'identity'))) {
		return 'Identity is only available for new, nonnullable built-in integer columns';
	}
	if (!defaultOptions(type, !existing).some((option) => option.kind === column.default.kind)) {
		return `${DEFAULT_LABELS[column.default.kind]} is not available for this type`;
	}
	const modifiers = column.typeOid === null ? existing?.typeModifiers : column.typeModifiers;
	if (column.default.kind === 'uuid' && type?.schema === 'pg_catalog'
		&& ['varchar', 'bpchar'].includes(type.name) && modifiers?.length && modifiers[0] < 36) {
		return 'Generate UUID as text requires a character length of at least 36 (or no length limit)';
	}
	return null;
}
