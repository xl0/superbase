import { command, query } from '$app/server';
import * as connections from '#lib/server/connections.js';
import * as db from '#lib/queries/db.js';
import * as schemaDb from '#lib/queries/schema.js';
import * as databaseDb from '#lib/queries/database.js';
import type { ConnectionOptions } from '#lib/connection-options.js';
import type { DeleteArgs, RowsArgs, SaveArgs, TableTarget } from '#lib/types.js';
import type { SqlRunArgs, SqlTarget } from '#lib/sql.js';

// Arguments are not schema-validated: whoever can call these can also run arbitrary SQL below.
// SQL builders quote identifiers, bind values and whitelist the keywords they interpolate.
type Target = { connection: string };
type Expected = { expected: string | null };

export const connectionStatus = query(() => connections.connectionStatus());
export const connect = command('unchecked', (args: ConnectionOptions & Expected) => connections.connect(args));

// Resolve one pool before any await: no operation can change databases halfway through.
export const database = query('unchecked', ({ connection }: Target) => db.listTables(connections.activePool(connection)));
export const tableRows = query('unchecked', (args: RowsArgs) => db.listRows(connections.activePool(args.connection), args));
export const saveTable = command('unchecked', (args: SaveArgs) => db.saveTable(connections.activePool(args.connection), args));
export const deleteRows = command('unchecked', (args: DeleteArgs) => db.deleteRows(connections.activePool(args.connection), args));
export const schemaCatalog = query('unchecked', ({ connection }: Target) => schemaDb.listSchemaCatalog(connections.activePool(connection)));
export const schemaDefinition = query('unchecked', (args: TableTarget) => schemaDb.getSchemaDefinition(connections.activePool(args.connection), args));
export const indexes = query('unchecked', ({ connection }: Target) => databaseDb.listIndexes(connections.activePool(connection)));
export const queryStats = query('unchecked', ({ connection }: Target) => databaseDb.queryStats(connections.activePool(connection)));
export const extensions = query('unchecked', ({ connection }: Target) => databaseDb.listExtensions(connections.activePool(connection)));
export const settings = query('unchecked', ({ connection }: Target) => databaseDb.listSettings(connections.activePool(connection)));
export const changeSchema = command('unchecked', ({ connection, sql }: Target & { sql: string }) => schemaDb.executeDdl(connections.activePool(connection), sql));

// Console SQL runs on dedicated per-tab sessions, never on table-editor pool clients.
export const openSql = command('unchecked', ({ connection }: Target) => connections.activeSql(connection).open());
export const runSql = command('unchecked', (args: SqlRunArgs) => connections.activeSql(args.connection).run(args));
export const cancelSql = command('unchecked', (args: SqlTarget) => connections.activeSql(args.connection).cancel(args.session));
export const closeSql = command('unchecked', ({ connection, session }: SqlTarget) => connections.activeSql(connection).close(session));
