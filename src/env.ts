import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: {
		description: 'Optional trusted default Postgres URL; browsers can choose a separate connection.',
		// Missing configuration is a normal disconnected state, not a startup error.
		schema: (value) => value ?? ''
	}
});
