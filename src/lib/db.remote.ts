import { command, query } from '$app/server';
import * as connections from '#lib/server/connections.js';
import * as db from '#lib/server/db.js';
import { connectSchema, connectionSchema, deleteSchema, rowsSchema, saveSchema, switchSchema } from '#lib/validation.js';

export const connectionStatus = query(() => connections.connectionStatus());
export const connect = command(connectSchema, (args) => connections.connect(args));
export const disconnect = command(switchSchema, (args) => connections.disconnect(args));
export const useDefault = command(switchSchema, (args) => connections.useDefault(args));

// Pin one pool before any await. No operation can change databases halfway through.
export const database = query(connectionSchema, ({ connection }) => db.listTables(connections.activePool(connection)));
export const tableRows = query(rowsSchema, (args) => db.listRows(connections.activePool(args.connection), args));
export const saveTable = command(saveSchema, (args) => db.saveTable(connections.activePool(args.connection), args));
export const deleteRows = command(deleteSchema, (args) => db.deleteRows(connections.activePool(args.connection), args));
