import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: {
		description: 'Pins the app to this Postgres URL and hides connection switching. Unset: browsers choose.',
		schema: (value) => value ?? ''
	}
});
