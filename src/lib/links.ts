import { resolve } from '$app/paths';
import { connectionId, connectionTarget } from './connection-profiles.js';
import type { ConnectionInfo } from './types.js';
import { viewHash, type TableView } from './view.js';

/** URL id of an open database: stable across SSL modes and passwords (see connectionId). */
export const databaseId = (info: ConnectionInfo) => connectionId(connectionTarget(info));

/** `resolve` inserts params verbatim; names may contain `/`, `#`, `?` or `%`, and the router decodes them back. */
const segment = (name?: string) => name ? encodeURIComponent(name) : undefined;

export const tablesHref = (db: string, view?: TableView) =>
	resolve('/db/[db]/tables/[[schema]]/[[table]]', { db, schema: segment(view?.schema), table: segment(view?.table) })
	+ (view ? viewHash(view) : '');
export const sqlHref = (db: string) => resolve('/db/[db]/sql', { db });
export const databaseHref = (db: string, section?: string) => resolve('/db/[db]/database/[[section]]', { db, section });
