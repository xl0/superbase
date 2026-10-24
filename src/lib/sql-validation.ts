import { object, schema, text } from './validation.js';
import { SQL_MAX_LENGTH, type SqlCancelArgs, type SqlRunArgs, type SqlTarget } from './sql.js';

function target(input: unknown, keys: string[]): SqlTarget {
	const value = object(input, keys);
	return { connection: text(value.connection, 100), session: text(value.session, 100) };
}
export const sqlTargetSchema = schema<SqlTarget>((input) => target(input, ['connection', 'session']));
export const sqlCancelSchema = schema<SqlCancelArgs>((input) => {
	const value = object(input, ['connection', 'session', 'run']);
	return { ...target(value, ['connection', 'session', 'run']), run: text(value.run, 100) };
});
export const sqlRunSchema = schema<SqlRunArgs>((input) => {
	const value = object(input, ['connection', 'session', 'run', 'sql']);
	const sql = text(value.sql, SQL_MAX_LENGTH);
	if (!sql.trim()) throw new Error('Enter SQL to run.');
	return { ...target(value, ['connection', 'session', 'run', 'sql']), run: text(value.run, 100), sql };
});
