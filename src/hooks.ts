import type { Transport } from '@sveltejs/kit/hooks';

/** Devalue rejects __proto__ object keys. Carry these column records as entries instead. */
export const transport: Transport = {
	ColumnRecord: {
		encode: (value) => value !== null && typeof value === 'object' &&
			[Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
			Object.hasOwn(value, '__proto__') && Object.entries(value),
		decode: (entries: unknown) => {
			if (!Array.isArray(entries) || entries.some((entry) =>
				!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) {
				throw new Error('Invalid column record transport');
			}
			// Define own data properties, never assign through Object.prototype's setter.
			return Object.fromEntries(entries);
		}
	}
};
