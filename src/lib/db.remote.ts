import { command, query } from '$app/server';

import type { DeleteArgs, RowsArgs, SaveArgs } from '#lib/server/db.js';
import * as db from '#lib/server/db.js';

export const database = query(() => db.listTables());

export const tableRows = query('unchecked', (args: RowsArgs) => db.listRows(args));

export const saveTable = command('unchecked', (args: SaveArgs) => db.saveTable(args));

export const deleteRows = command('unchecked', (args: DeleteArgs) => db.deleteRows(args));

export const executeSql = command('unchecked', (sql: string) => db.runSql(sql));
