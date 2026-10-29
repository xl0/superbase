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
  The `Dockerfile` builds with Bun and runs the same launcher on `node:24-alpine` as user `node`
  (runtime `node_modules` from `bun install --production --frozen-lockfile`),
  with `HOST=0.0.0.0`; `ORIGIN` must match the public URL for commands to pass the origin check.

Whoever reaches the app can run arbitrary SQL with the configured role. So remote functions are
`'unchecked'` (no schema validation layer) and there is no DDL/SQL "hardening". SQL builders
still quote identifiers, bind values and whitelist interpolated keywords (sort direction, filter
operators) — for correctness, not as a security boundary.

## Connection lifecycle

`connections.ts` maps a key, `host:port/database · user · sslmode` (no password, from pg's own
URL parsing), to `{ info, pool, sql }`. `connect` (a POST: the only request with a password)
reuses that key's pool only for the identical URL; otherwise it opens one, runs a test query and
replaces the old pool (closing its SQL sessions; realtime streams reconnect), so a wrong password
never "connects". It returns `info`; every other request
carries the key of the database its page shows, so it can only act on that one, and tabs on
different databases are independent. An unknown key (server restarted) asks to reload; the
route then reconnects the saved profile. Idle pools hold no clients, so pools are never closed.
Locked mode has one pinned connection and refuses other keys.
The URL is the whole setting and reaches pg as typed (its options override the pool's). The
server adds `uselibpqcompat=true` so `sslmode` keeps libpq's meaning (absent = `prefer`; pg alone
reads prefer/require as verify-full), and maps `channel_binding` to `enableChannelBinding`.
`prefer` retries once without TLS only on pg's "server does not support SSL" error (locked mode
probes once at startup and swaps in the plain pool). The connection form's SSL select and
channel binding checkbox only edit the URL's query. `safeErrorMessage` redacts connection URLs.
Profiles (`connection-profiles.ts`) are a plain localStorage list. A successful connect stores the
target the server resolved the profile's URL to (`target`, pg defaults for user/port/database
applied): it gives the profile's URL id and marks the active one. A successful connect fully loads the new database's route (other tabs keep
theirs). One-off URLs are never stored, so they cannot reconnect after a server restart.

## Routes and history

`/db/[db]/tables/[[schema]]/[[table]]`, `/db/[db]/sql`, `/db/[db]/database/[[section]]`; the
table view (filters, sort, page, FK reference) is in the hash (`view.ts`, e.g.
`#f.status=eq.pending&sort=placed_at.desc`), so they stay out of page requests (row reads still
send them, as remote query arguments). Filters with an unknown operator are dropped when parsed;
sorts, filters and references on columns the table lacks are dropped once metadata is known
(`editor.validView`), and that canonical URL replaces the bad one.
LIKE/ILIKE compare a column's text, and `json` columns (no operators) compare as text.
Schema and table names are URL-encoded path segments (`links.ts`): names may hold `/`, `#`, `%`.
- `[db]` is `connectionId` (FNV-1a) of the password-free target. `db/[db]/+layout.svelte` opens
  the app with the open database whose id matches (passing its key down), otherwise connects the
  saved profile with that id (one attempt), otherwise shows the connection manager; locked mode
  redirects to its database. `/` redirects to the last-used profile, else any open database.
- The layout keeps `EditorApp` mounted; the empty pages only select a workspace. Tables and SQL stay
  mounted while hidden; Database mounts while open.
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
- `loadMetadata` reads tables/columns/PK/FK/enum info, never cached on the server: every grid page
  and write reads that one table's, so they match the current columns even after DDL in the SQL
  console. Column `kind` is only a rendering hint.
- `rowSelection` builds the shared WHERE (exact FK filter, structured filters, picker search)
  and deterministic ORDER BY (`reference` = exact FK-navigation match, `filters` = user conditions)
  (user sorts NULLS LAST, then PK, tableoid, ctid). Grid pages use
  OFFSET/LIMIT+1 (`hasMore`); counts are catalog estimates.
- Writes run in one transaction with a ROW EXCLUSIVE lock and fresh metadata. Updates/deletes
  match PK + tableoid + xmin and require rowCount 1, so concurrent changes conflict and roll back.
  Inserts send sparse values: omitted = DEFAULT. Keyless tables are read-only.
- Realtime (opt-in per table, `Table.realtime`): `ddl.realtimeSql` adds a statement-level
  `superbase_realtime` trigger calling `__superbase.notify_change()` (created once, by whichever role
  comes first, with USAGE for all, so other roles can attach it; the tool-owned schema; dropping
  it with cascade, e.g. from Database → Schemas, removes every realtime trigger), which `pg_notify`s channel
  `superbase` with schema/table/op only. `connections.subscribeChanges` keeps one LISTEN client per
  database while subscribed; `/events?connection=<key>` streams it as SSE. `EditorApp` opens one
  EventSource while any table has realtime and refetches the open table through `editor.poll`
  (a poll asked for mid-poll runs again after it, so bursts coalesce and none is lost); the 5 s poll then runs only every 30 s as a safety net. Not in the static demo.
  Self-check: after LISTEN the server notifies itself through the pool; no echo within 5 s of the
  committed ping (a busy pool only delays sending it; e.g. a
  transaction-mode pooler) marks the connection `realtimeUnavailable`, the stream sends an
  `unavailable` event and editors keep polling (`editor.realtimeIssue` explains why).
  Toggling (toolbar ⚡, `editor.setRealtime`) applies at once, unpreviewed; the table list marks
  realtime tables with ⚡. Database → Triggers hides `superbase_realtime`.
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
the validator. Type changes are destructive; toggling Array converts `x` ↔ `{x}` (array → value
first checks every array has one element). Names over 63 bytes are refused (Postgres would truncate
them). `queries/schema.ts` also lists approved column types (builtins, enums, domains,
arrays) and reads one table's columns/PK/indexes/constraints via `pg_get_*def`.
`SchemaEditor.svelte` is the sheet shell plus simple inline forms; `SchemaIndexes` and
`SchemaConstraints` are list + form children that bind their `change`; constraints are the table's
own (`conislocal`) UNIQUE/CHECK/FK/EXCLUDE, not inherited copies. Editing a constraint edits
its `pg_get_constraintdef` text, so clauses the add form lacks survive: a changed definition is drop
+ add, a new name alone a rename. `tableDefinition` (⋮ → Definition, a read-only side panel that blocks nothing) rebuilds
a table's or view's DDL from `pg_get_*def` and the catalogs in a read-only transaction with
`search_path = pg_catalog`, so every user object comes out qualified; a test round-trips it. Duplicate reads the
table's definition fresh, uses `LIKE … INCLUDING ALL`, copies non-generated columns with
`overriding system value`, and moves identity sequences past the copied values (only when rows
were copied, so an empty copy keeps the original start). The copy is a plain table: an inheritance
parent copies only its own rows, a partitioned one all partitions' rows.

## SQL console (`server/sql.ts`)

Up to 16 dedicated `pg.Client`s per connection, keyed by random session id; never reconnected.
A buffer is sent unchanged via the simple protocol. A `row` listener (no callback) stops pg from
accumulating rows; previews keep ≤1,000 rows per result and ~10M chars total. Per-statement
results come from pg's internal `query._results`; transaction status is read after
ReadyForQuery. Cancel opens a second client and `pg_cancel_backend`, guarded by a run counter.
No statement or idle-in-transaction timeouts beyond the database's own.
Sessions (and any open transaction) expire after 15 idle minutes; a pagehide `sendBeacon` to `/sql/close` releases them.
`SqlState` (client) persists the draft and its linked snippet id per database, and the snippet
library (`superbase.sql-snippets`, shared by databases/tabs; writes re-read first) in localStorage.
`SqlLibrary.svelte` lists favourites, snippets and `sql-examples.ts` (Apache-2.0 attributed).
Opening anything only loads text; replacing modified text asks first. A run that ends idle after
DDL or COMMIT reloads the metadata (table list, autocomplete). Autocomplete (a
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
session's value plus database, current-role and role-in-database defaults from `pg_db_role_setting`.
Policies: `listPolicies` returns tables with RLS state, policies (`pg_policy`, roles resolved, `public`
for none) and non-owner grants (`aclexplode(relacl)`, grouped with their grantors: a revoke removes only one
grantor's grant, so the grid marks privileges also granted by roles other than the owner). The roles a
policy can name and whether `current_user` bypasses RLS come from `editor` (`listTables`). `TableAccess`
renders one table (RLS switches, policies, a role × SELECT/INSERT/UPDATE/DELETE grid) for both
`DatabasePolicies` and the table editor's `TableAccessPanel` (`SchemaEditMode` `access`).
`ddl.createPolicy` omits USING for insert and WITH CHECK for select/delete. The form has no
`public` checkbox: no roles means PUBLIC, because Postgres ignores named roles listed beside it
(with only a warning). Editing a policy is drop
+ create in one transaction; `ddl.grantChanges` diffs the grid into grant/revoke, leaving other
privileges alone. Roles (`listRoles`, server-wide): `ddl.createRole`/`alterRole` (alter names only changed
attributes: PG16+ rejects naming BYPASSRLS/CREATEDB without holding them; membership as
grant/revoke, a PG16+ revoke once per grantor (`granted by`), rename last); the preview masks passwords.
Schemas (`listSchemas`, all non-system ones with table/function counts): create, rename/owner,
drop (cascade needs the typed name). Triggers (`listTriggers`, non-internal, no partition clones, events decoded from
`tgtype`) show their and their function's definition, and can be dropped. Indexes skip partitions'
copies of a partitioned index (`relispartition`).
Enums (`listEnums`, with columns using each, also via domains, inherited copies once) are edited in place by `ddl.enumChanges` (rename values,
append values, rename the type last; Postgres cannot remove values). Config writes
`alter database|role [in database] … set|reset`: `search_path` values as SQL lists, others as quoted literals.

Every change on these pages goes through `SqlDialog`: form fields as children, the SQL preview,
Apply runs it via `changeSchema` (`executeDdl`, one transaction; fields are disabled meanwhile),
closes, then `onapplied` reloads. A failed rollback never replaces the statement's own error.
An empty `sql` means nothing to apply. `SchemaFilter` is the shared schema picker + search box.

## CSV export

`/export` takes one form-POSTed JSON `CsvExportArgs` into a hidden iframe so the browser streams
the attachment (one toolbar button, `CsvExport`, captures the grid's query and lets the user pick
columns); an error response loads in the frame and is shown as a toast. `queries/export.ts`
declares a read-only cursor with the grid's `rowSelection` and the chosen columns, and streams
256-row batches; cancel/abort destroys the leased client.

## Browser state and UI

- `state/editor.svelte.ts` (`EditorState`, module singleton): active table, query, rows, row
  selections (captured identities, across pages), busy/editing flags. A request counter discards
  out-of-order reads; a live generation discards polls begun before a mutation. A failed read
  after an acknowledged write is reported as a read error, never retried as a write.
  `navigationBlocked` (busy/editing/inserting/schemaEditing) gates navigation and reloads.
  Metadata reloads (Refresh, Database-page changes) count separately, so a navigation started
  meanwhile doesn't discard them, and keep the view (page, filters, rows on screen) while the
  table exists; schema changes reset it. ⚡ only flips the table's flag after its DDL.
- `utils.fresh()` refreshes a remote query: queries are cached per argument and polling reuses
  identical arguments.
- `DataGrid` is a custom CSS-grid spreadsheet (fixed 35 px rows, no virtualization) with
  positional focus/range; edits capture the row, never an index. `CellEditor` holds one
  text/NULL/DEFAULT buffer in a popover or `ResizableSheet`; only Apply saves.
- `arrays.ts`: array cells are displayed and edited as JSON (like Supabase) while values stay
  literals. Element text that is valid JSON (numbers) is used verbatim, so nothing
  is decoded; JSON goes back to a literal via the Lezer JSON tree on apply (`InsertRow` holds
  JSON until Save). `Column.element` is set only for comma-delimited element types; bounds
  (`[0:1]={…}`), box[] and json[]/jsonb[] keep the literal editor (a nested JSON array there could be a
  dimension or a document). Grid copy writes JSON; paste converts a JSON
  array and passes literals through. CSV export stays literal.
- Clipboard TSV (`format.ts`): a field counts as quoted only when its closing quote ends it and
  its content needed quoting, so raw text starting with `"` pastes unchanged.
- `sql-highlight.ts` renders read-only SQL (Activity hover, Performance) with the editor's parser;
  `.sql-code` in `app.css` holds the colors.
- `TextEditor` wraps CodeMirror (text/JSON/SQL). The parent owns the NULL/DEFAULT/text value;
  the editor reports document edits only, so opening and applying unchanged never rewrites a
  value. `json.ts` pretty-prints JSON from parser tokens (no number decoding, keys kept);
  `json` (not `jsonb`) cells open verbatim, since that type keeps the text's whitespace.
- `EditorApp` switches three workspaces from the left rail (Tables, SQL, Database). Each is a
  `Workspace`: a resizable side panel (one width shared by all) and a main area. Database sections
  are side panel items.
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

`dev/seed.sql` seeds a dev database; its `edge` schema holds awkward names, partitions,
inheritance, an exclusion constraint, json vs jsonb and forced-but-disabled RLS.
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

Not supported: editing views, OR filters, saved SQL history, replacing an existing primary key,
enabling/disabling triggers (SQL editor).
