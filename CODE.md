# superbase — code map

Postgres table + SQL editor: SvelteKit 3 / Svelte 5 SPA (SSR off), SvelteKit remote functions,
shadcn-svelte, Tailwind v4, `pg` directly. One Node process; a pool per open database.

## Deployment modes and trust model

- **Local** (`DATABASE_URL` unset): browsers pick a URL; `server/connections.ts` keeps a pool
  per database. Bound to 127.0.0.1; `hooks.server.ts` rejects non-loopback Host headers
  (DNS rebinding). SvelteKit's origin check guards commands and form POSTs.
- **Locked** (`DATABASE_URL` set): pinned to that database; `connect` refuses.
  `HOST` other than loopback disables the Host check: auth is expected in front.
  `bin/superbase.js` (the published CLI and `bun run start`) marks requests as HTTP unless
  `ORIGIN` is set (adapter-node assumes HTTPS), tries ports 3000+ when none is given, and opens
  a browser. A positional postgres URL sets `DATABASE_URL`. The npm package ships `bin` and the
  built `build/` (no source maps); `pg` is its only runtime dependency, everything else is bundled.
  The `Dockerfile` builds with Bun and runs the same launcher on `node:24-alpine` as user `node`,
  with `HOST=0.0.0.0`; `ORIGIN` must match the public URL for commands to pass the origin check.

Whoever reaches the app can run arbitrary SQL with the configured role. So remote functions are
`'unchecked'` (no schema validation layer) and there is no DDL/SQL "hardening". SQL builders
still quote identifiers, bind values and whitelist interpolated keywords (sort direction, filter
operators) — for correctness, not as a security boundary.

## Connection lifecycle

`connections.ts` maps a key, `host:port/database · user · sslmode` (no password, from pg's own
URL parsing), to `{ info, pool, sql }`. `connect` (a POST: the only request with a password)
opens or reuses that key's pool after a test query and returns `info`; every other request
carries the key of the database its page shows, so it can only act on that one, and tabs on
different databases are independent. An unknown key (server restarted) asks to reload; the
route then reconnects the saved profile. Idle pools hold no clients, so pools are never closed.
Locked mode has one pinned connection and refuses other keys. SSL is a separate setting
(`connection-options.ts`); URLs may carry only `sslmode` (imported into the setting, then
stripped) because pg lets URL options override `ssl`. `prefer` retries once without TLS only
on pg's "server does not support SSL" error. `safeErrorMessage` redacts connection URLs.
Profiles (`connection-profiles.ts`) are a plain localStorage list; the active one is matched by
host/port/db/user. A successful connect fully loads the new database's route (other tabs keep
theirs). One-off URLs are never stored, so they cannot reconnect after a server restart.

## Routes and history

`/db/[db]/tables/[[schema]]/[[table]]`, `/db/[db]/sql`, `/db/[db]/database/[[section]]`; the
table view (filters, sort, page, FK reference) is in the hash (`view.ts`, e.g.
`#f.status=eq.pending&sort=placed_at.desc`), so filter values never reach the server.
- `[db]` is `connectionId` (FNV-1a) of the password-free target. `db/[db]/+layout.svelte` opens
  the app with the open database whose id matches (passing its key down), otherwise connects the
  saved profile with that id (one attempt), otherwise shows the connection manager; locked mode
  redirects to its database. `/` redirects to the last-used profile, else any open database.
- The layout keeps `EditorApp` and all three workspaces mounted; the empty pages only select one.
- `EditorApp` syncs both ways: URL → `editor.show(view)` (deferred while `navigationBlocked`, so
  Back during an edit applies once it ends) and editor state → `goto` (new history entry;
  canonicalizing a bare/unknown table replaces). `show` sets state synchronously, so the two
  settle without loops; the editor → URL effect must not track `page.url`.
- A schema without a table (`/tables/<schema>`) opens the schema's first table, or stays on an
  empty schema: `editor.schemas` comes from `listTables` (every usable schema except
  `__superbase`), not from the tables, so an empty schema can be active with no table open.
- Demo: `404.html` copies the app shell so GitHub Pages serves deep links.

## Rows (`queries/db.ts`)

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
- Realtime (opt-in per table, `Table.realtime`): `ddl.realtimeSql` adds a statement-level
  `superbase_realtime` trigger calling `__superbase.notify_change()` (the tool-owned schema; dropping
  it with cascade removes every realtime trigger, as Database → Realtime offers), which `pg_notify`s channel
  `superbase` with schema/table/op only. `connections.subscribeChanges` keeps one LISTEN client per
  database while subscribed; `/events?connection=<key>` streams it as SSE. `EditorApp` opens one
  EventSource while any table has realtime and refetches the open table through `editor.poll`
  (coalesced); the 5 s poll then runs only every 30 s as a safety net. Not in the static demo.
  Self-check: after LISTEN the server notifies itself through the pool; no echo within 5 s (e.g. a
  transaction-mode pooler) marks the connection `realtimeUnavailable`, the stream sends an
  `unavailable` event and editors keep polling (`editor.realtimeIssue` explains why).
  Toggling (toolbar ⚡ via `editor.setRealtime`, or the Realtime page) applies at once, unpreviewed.
- "View as role" (`TableTarget.as`, `editor.viewAs`): row reads, writes and CSV export run in a
  transaction after `actAs` (`set local role` + `set_config(…, true)`); metadata and locks stay with
  the connection role. `RoleMenu` shows on RLS tables (`Table.rls`) or while a role is active.
- Views and materialized views (`Table.kind`) are listed and read-only. Plain views have no
  system columns: rows are read without xmin/tableoid/ctid, keyed by position, and ordered only
  by user sorts (no tiebreaker, so ORDER BY may be omitted).

## Schema editing

`lib/ddl.ts` is the pure SQL generator (create table, add/alter column, duplicate, constraint
clauses, literal escaping). Forms build a `SchemaChange { sql, select?, destructive? }`, show it
as a preview, and `executeDdl` runs it in one transaction (`lock_timeout` 3 s). PostgreSQL is
the validator. `queries/schema.ts` also lists approved column types (builtins, enums, domains,
arrays) and reads one table's columns/PK/indexes/constraints via `pg_get_*def`.
`SchemaEditor.svelte` is the sheet shell plus simple inline forms; `SchemaIndexes` and
`SchemaConstraints` are list + form children that bind their `change`. Editing a constraint is
drop + add. `tableDefinition` (⋮ → Definition, a read-only side panel that blocks nothing) rebuilds
a table's or view's DDL from `pg_get_*def` and the catalogs in a read-only transaction with
`search_path = pg_catalog`, so every user object comes out qualified; a test round-trips it. Duplicate uses `LIKE … INCLUDING ALL`, copies non-generated columns with
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

`SchemaDiagram` draws the loaded table metadata (no extra query) with Svelte Flow and lays it out
with dagre (left to right, referenced tables first). Cards have fixed header/row heights so the
layout knows node sizes; edges attach to per-column handles. Tables referenced from other schemas
appear faded. Nodes are `$derived` from the metadata and bound to Svelte Flow, so dragging works
until the next metadata reload re-lays out. Positions are not saved.

`queries/database.ts` lists all indexes (key columns/expressions, owning constraint), top
`pg_stat_statements` entries for the current database (PG 13+; missing extension or preload is
reported, not thrown), client sessions of the current database (`pg_stat_activity` minus the
asking backend, read in one statement with the server-wide connection count; blockers via
`pg_blocking_pids`; cancel/terminate are previewed `select
pg_cancel_backend|pg_terminate_backend(pid)`), extensions (`pg_available_extensions` + installed version/schema,
required schema and dependencies) and a curated set of settings (`CONFIG_SETTINGS`) with this
session's value plus database and current-role defaults from `pg_db_role_setting`.
Policies: `listPolicies` returns tables with RLS state, policies (`pg_policy`, roles resolved, `public`
for none) and non-owner grants (`aclexplode(relacl)`), the roles a policy can name, and whether
`current_user` bypasses RLS (superuser/BYPASSRLS; owners of unforced tables too). `TableAccess`
renders one table (RLS switches, policies, a role × SELECT/INSERT/UPDATE/DELETE grid) for both
`DatabasePolicies` and the table editor's `TableAccessPanel` (`SchemaEditMode` `access`).
`ddl.createPolicy` omits USING for insert and WITH CHECK for select/delete; editing a policy is drop
+ create in one transaction; `ddl.grantChanges` diffs the grid into grant/revoke, leaving other
privileges alone. Roles (`listRoles`, server-wide): `ddl.createRole`/`alterRole` (attributes only
when changed, membership as grant/revoke, rename last); the preview masks passwords.
Schemas (`listSchemas`, all non-system ones with table/function counts): create, rename/owner,
drop (cascade needs the typed name). Triggers (`listTriggers`, non-internal, events decoded from
`tgtype`) show their and their function's definition; enable/disable apply at once, drop previews.
Enums (`listEnums`, with columns using each) are edited in place by `ddl.enumChanges` (rename values,
append values, rename the type last; Postgres cannot remove values). `DatabaseIndexes`/`DatabaseEnums`/`DatabaseExtensions`/`DatabaseConfig` preview `drop index`, `create/alter/drop extension` and
`alter database|role … set|reset` SQL and run it through `executeDdl`. `search_path` values are
written as SQL lists; other values are quoted literals.

## CSV export

`/export` takes one form-POSTed JSON `CsvExportArgs` into a hidden iframe so the browser streams
the attachment; an error response loads in the frame and is shown as a toast. `queries/export.ts`
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
- `arrays.ts`: array cells are displayed and edited as JSON (like Supabase) while values stay
  literals. Element text that is valid JSON (numbers, json elements) is used verbatim, so nothing
  is decoded; JSON goes back to a literal via the Lezer JSON tree on apply (`InsertRow` holds
  JSON until Save). `Column.element` is set only for comma-delimited element types; bounds
  (`[0:1]={…}`) and box[] keep the literal editor. Grid copy writes JSON; paste converts a JSON
  array and passes literals through. CSV export stays literal.
- `sql-highlight.ts` renders read-only SQL (Activity hover, Performance) with the editor's parser;
  `.sql-code` in `app.css` holds the colors.
- `TextEditor` wraps CodeMirror (text/JSON/SQL). The parent owns the NULL/DEFAULT/text value;
  the editor reports document edits only, so opening and applying unchanged never rewrites a
  value. `json.ts` pretty-prints JSON from parser tokens (no number decoding, keys kept).
- `EditorApp` switches three workspaces from the left rail (Tables, SQL, Database; hidden ones
  stay mounted). Each is a `Workspace`: a resizable side panel (one width shared by all) and a
  main area. Database sections (schema, indexes, performance, extensions, configuration) are
  side panel items.
- `PanelResizer` / `ResizableSheet` provide pointer+keyboard resizing for side panels and sheets.
- `ui/` popover, dialog and sheet contents default `preventOverflowTextSelection` to false: bits-ui
  otherwise sets `user-select` on `<body>` per click, restyling every grid cell (~145 ms at 500 rows).
- Theme: dark charcoal palette in `app.css`, shared by shadcn components and the grid.

## Demo build

`bun run build:demo` (`vite --mode demo`, `dev:demo` for development) is a static site with
PostgreSQL in the tab (PGlite, seeded from `demo/seed.sql`, in memory). Vite aliases
`#lib/db.remote.js` to `demo/db.svelte.ts`, which runs the `queries/` modules against a
pg-shaped pool and returns minimal `RemoteQuery` look-alikes. That is why `queries/` lives
outside `server/` (SvelteKit keeps `/server/` out of client bundles) and imports only pg types.
- Exact text: PGlite applies per-query parsers/serializers by oid only, so the pool maps every
  `pg_type` oid to identity; parameterless queries use the simple protocol, like pg.
- One session: a promise queue serializes pool calls and holds it for a client lease; release
  rolls back a leftover transaction. SQL console runs roll back an open transaction and say so;
  cancel is unavailable (queries block the tab).
- A few small contrib extensions are bundled, including preloaded pg_stat_statements.
- Remaining `import.meta.env.MODE === 'demo'` branches: CSV export builds a Blob, no
  `/sql/close` beacon, a header badge, and the connection picker (shown, not locked) answers
  Connect/Save with a pointer to the repo. The normal build drops them, PGlite included.
- `BASE_PATH` sets the subpath; `.github/workflows/demo.yml` publishes to GitHub Pages on every
  push to master (or on demand).

## Releases

`bun run release [patch|minor|major|x.y.z]` (from `pi-lovely-codex`): checks branch, origin,
npm and the changelog, runs `bun run verify`, rolls `CHANGELOG.md` [Unreleased] and bumps the
version, pauses for review, then commits, tags and pushes. The tag runs `release.yml`: verify,
`npm stage publish` with provenance (approved by the script with a 2FA code), Docker images for
amd64/arm64 to GHCR and Docker Hub, and a GitHub Release from the changelog section.

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
- `src/lib/db.remote.ts` — remote functions; `src/lib/server/` — connections, SQL sessions.
- `src/lib/queries/` — rows, schema, database workspace, CSV (any pg-shaped pool); `src/lib/demo/` — demo build.
- `src/lib/state/` — editor and SQL workspace state; `src/lib/components/` — UI (`ui/` is generated shadcn).
- `src/routes/db/[db]` — app routes; `src/routes/export`, `src/routes/sql/close` — non-remote endpoints.
- `src/lib/view.ts` (URL hash encoding), `src/lib/links.ts` (route builders).

Not supported: editing views, OR filters, saved SQL history, schema management, replacing an
existing primary key.
