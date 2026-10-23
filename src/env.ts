import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: {
		description: 'Postgres connection string, e.g. postgresql://user:pass@host:5432/db',
		// Optional at startup so the app can show a connection error screen instead of
		// failing to boot. The db module throws a readable error when it is empty.
		schema: (value) => value ?? ''
	}
});
