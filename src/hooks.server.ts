import type { HandleServerError } from '@sveltejs/kit/hooks';

// The client is a local database tool: surface the actual error (connection refused,
// permission denied, constraint violation) instead of a generic "Internal Error".
export const handleError: HandleServerError = ({ error }) => {
	const message =
		error instanceof Error ? error.message : typeof error === 'string' ? error : 'Internal Error';
	return { message };
};
