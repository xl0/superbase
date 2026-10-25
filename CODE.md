# superbase — code map

Postgres table + SQL editor: SvelteKit 3 / Svelte 5 SPA (SSR off), SvelteKit remote functions,
shadcn-svelte, Tailwind v4, `pg` directly. One Node process, one database target.

## Deployment modes and trust model

- **Local** (`DATABASE_URL` unset): browsers pick a URL; `server/connections.ts` keeps one
  global pool. Bound to 127.0.0.1; `hooks.server.ts` rejects non-loopback Host headers
  (DNS rebinding). SvelteKit's origin check guards commands and form POSTs.
- **Locked** (`DATABASE_URL` set): pinned to that database; `connect` refuses.
  `HOST` other than loopback disables the Host check: auth is expected in front.
  `bin/superbase.js` (the published CLI and `bun run start`) marks requests as HTTP unless
  `ORIGIN` is set (adapter-node assumes HTTPS), tries ports 3000+ when none is given, and opens
  a browser. A positional postgres URL sets `DATABASE_URL`. The npm package ships `bin` and the
  built `build/` (no source maps); `pg` is its only runtime dependency, everything else is bundled.

Whoever reaches the app can run arbitrary SQL with the configured role. So remote functions are
`'unchecked'` (no schema validation layer) and there is no DDL/SQL "hardening". SQL builders
still quote identifiers, bind values and whitelist interpolated keywords (sort direction, filter
operators) — for correctness, not as a security boundary.

## Connection lifecycle

`connections.ts`: `current = { info, pool, sql }`. `info.id` is a random generation that
changes on every switch. Every remote call passes the generation it loaded; a mismatch throws
"Connection changed in another tab", so stale tabs never act on a new database.
Connect test-queries a candidate pool before replacing the old one. SSL is a separate setting
(`connection-options.ts`); URLs may carry only `sslmode` (imported into the setting, then
stripped) because pg lets URL options override `ssl`. `prefer` retries once without TLS only
on pg's "server does not support SSL" error. `safeErrorMessage` redacts connection URLs.
Profiles (`connection-profiles.ts`) are a plain localStorage list; the active one is matched by
host/port/db/user. A successful switch reloads the page. Switching to a saved profile records its
id; on load, an unconnected (non-locked) server is reconnected to it (`+page.svelte`).
One-off URLs are never stored.

## Rows (`server/db.ts`)

- `CellValue` is PostgreSQL text or NULL: per-query identity type parsers, never JS coercion.
- `loadMetadata` reads tables/columns/PK/FK/enum info; cached per pool for 30 s, refreshed by
  `listTables` and invalidated after DDL. Column `kind` is only a rendering hint.
- `rowSelection` builds the shared WHERE (exact FK filter, structured filters, picker search)
  and deterministic ORDER BY (`reference` = exact FK-navigation match, `filters` = user conditions)
  (user sorts NULLS LAST, then PK, tableoid, ctid). Grid pages use
  OFFSET/LIMIT+1 (`hasMore`); counts are catalog estimates.
- Writes run in one transaction with a ROW EXCLUSIVE lock and fresh metadata. Updates/deletes
  match PK + tableoid + xmin and require rowCount 1, so concurrent changes conflict and roll back.
  Inserts send sparse values: omitted = DEFAULT. Keyless tables are read-only.

## Schema editing

`lib/ddl.ts` is the pure SQL generator (create table, add/alter column, duplicate, constraint
clauses, literal escaping). Forms build a `SchemaChange { sql, select?, destructive? }`, show it
as a preview, and `executeDdl` runs it in one transaction (`lock_timeout` 3 s). PostgreSQL is
the validator. `server/schema.ts` also lists approved column types (builtins, enums, domains,
arrays) and reads one table's columns/PK/indexes/constraints via `pg_get_*def`.
`SchemaEditor.svelte` is the sheet shell plus simple inline forms; `SchemaIndexes` and
`SchemaConstraints` are list + form children that bind their `change`. Editing a constraint is
drop + add. Duplicate uses `LIKE … INCLUDING ALL`, copies non-generated columns with
`overriding system value`, and advances identity sequences.

## SQL console (`server/sql.ts`)

Up to 16 dedicated `pg.Client`s per connection, keyed by random session id; never reconnected.
A buffer is sent unchanged via the simple protocol. A `row` listener (no callback) stops pg from
accumulating rows; previews keep ≤1,000 rows per result and ~10M chars total. Per-statement
results come from pg's internal `query._results`; transaction status is read after
ReadyForQuery. Cancel opens a second client and `pg_cancel_backend`, guarded by a run counter.
Sessions expire after 15 idle minutes; a pagehide `sendBeacon` to `/sql/close` releases them.
`SqlState` (client) persists the draft and its linked snippet id per database, and the snippet
library (`superbase.sql-snippets`, shared by databases/tabs; writes re-read first) in localStorage.
`SqlLibrary.svelte` lists favourites, snippets and `sql-examples.ts` (Apache-2.0 attributed).
Opening anything only loads text; replacing modified text asks first. Autocomplete (a
toolbar checkbox) also offers schema/table/column names from the loaded metadata.

## Database workspace

`server/database.ts` lists all indexes (key columns/expressions, owning constraint), top
`pg_stat_statements` entries for the current database (PG 13+; missing extension or preload is
reported, not thrown), extensions (`pg_available_extensions` + installed version/schema,
required schema and dependencies) and a curated set of settings (`CONFIG_SETTINGS`) with this
session's value plus database and current-role defaults from `pg_db_role_setting`.
`DatabaseIndexes`/`DatabaseExtensions`/`DatabaseConfig` preview `drop index`, `create/alter/drop extension` and
`alter database|role … set|reset` SQL and run it through `executeDdl`. `search_path` values are
written as SQL lists; other values are quoted literals.

## CSV export

`/export` takes one form-POSTed JSON `CsvExportArgs` into a hidden iframe so the browser streams
the attachment; an error response loads in the frame and is shown as a toast. `server/export.ts`
declares a read-only cursor (same `rowSelection` as the grid when a query is given) and streams
256-row batches; cancel/abort destroys the leased client.

## Browser state and UI

- `state/editor.svelte.ts` (`EditorState`, module singleton): active table, query, rows, row
  selections (captured identities, across pages), busy/editing flags. A request counter discards
  out-of-order reads; a live generation discards polls begun before a mutation. A failed read
  after an acknowledged write is reported as a read error, never retried as a write.
  `navigationBlocked` (busy/editing/inserting/schemaEditing) gates navigation and reloads.
- `utils.fresh()` refreshes a remote query: queries are cached per argument and polling reuses
  identical arguments.
- `DataGrid` is a custom CSS-grid spreadsheet (fixed 35 px rows, no virtualization) with
  positional focus/range; edits capture the row, never an index. `CellEditor` holds one
  text/NULL/DEFAULT buffer in a popover or `ResizableSheet`; only Apply saves.
- `TextEditor` wraps CodeMirror (text/JSON/SQL). The parent owns the NULL/DEFAULT/text value;
  the editor reports document edits only, so opening and applying unchanged never rewrites a
  value. `json.ts` pretty-prints JSON from parser tokens (no number decoding, keys kept).
- `PanelResizer` / `ResizableSheet` provide pointer+keyboard resizing for the sidebar and sheets.
- Theme: dark charcoal palette in `app.css`, shared by shadcn components and the grid.

## Development

```sh
bun install --frozen-lockfile
bun run dev                 # 127.0.0.1:5173 (loads .env)
bun run check
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55433/postgres bun run test
bun run test:production     # builds, then checks the real launcher (CSRF, Host guard)
docker run -d --name sb-dev-db -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55433:5432 postgres:18.3-alpine \
  -c shared_preload_libraries=pg_stat_statements   # enables the Performance tab
```

DB tests create and drop their own schema and need an explicit `TEST_DATABASE_URL`.
Tests are deliberately few: exact values, conflicts, editor race guards, DDL round-trip,
SQL sessions, CSV and the production HTTP boundary.

## Layout

- `src/lib/types.ts`, `schema.ts`, `sql.ts` — shared contracts; `ddl.ts` — DDL generation.
- `src/lib/db.remote.ts` — remote functions; `src/lib/server/` — connections, rows, schema, SQL, CSV.
- `src/lib/state/` — editor and SQL workspace state; `src/lib/components/` — UI (`ui/` is generated shadcn).
- `src/routes/export`, `src/routes/sql/close` — non-remote endpoints.

Not supported: views, OR filters, saved SQL history, enum/schema management, replacing an
existing primary key.
