# superbase — code map

A local-only Postgres table editor: SvelteKit 3 / Svelte 5 SPA, shadcn-svelte, Tailwind v4,
and direct `pg`. No Supabase services, ORM, or public API. One Node process owns sessions.

## Runtime and boundaries

`+layout.ts` disables SSR. `+page.svelte` loads `connectionStatus()` before mounting either
onboarding or `EditorApp`. The latter initializes the module-level `EditorState` and renders
the sidebar, toolbar, grid/definition tab, and pagination. Connection changes reload the page
after confirming unsaved work; generation checks protect other tabs that did not reload.

`lib/db.remote.ts` validates structured intents using the Standard Schema adapters in
`lib/validation.ts`. It resolves a generation-checked pool exactly once, before calling
`lib/server/db.ts`. Database functions receive their pool explicitly, never consult cookies,
and never generate SQL on the client. Identifiers are quoted and values bound as parameters.
The unused arbitrary-SQL endpoint has been removed.

`hooks.server.ts` requires both a loopback socket peer and a localhost/loopback Host header.
It rejects proxy address/host/port header configuration and initializes the browser's session
before remote queries (queries cannot set cookies themselves). Database errors remain useful
but known passwords and connection URLs are redacted. Client errors use `utils.message` to
handle SvelteKit's HttpError body as well as ordinary Errors/query error bodies.

`server.mjs` is the production entrypoint. It binds 127.0.0.1 and overwrites an internal
protocol header with HTTP before invoking adapter-node's handler. Otherwise adapter-node
assumes HTTPS and rejects local HTTP commands. No client forwarding header is trusted and
SvelteKit's origin/CSRF validation remains enabled. `bun run start` loads optional `.env`.

## Data contracts

`lib/types.ts` is shared by the browser, validation, and SQL modules:

- `CellValue` is PostgreSQL text or SQL NULL. A per-query identity parser preserves exact
  numeric, JSON, array, timestamp, and other type output. Metadata queries use normal pg
  parsers; no process-global type parser mutations.
- `Row` is `{ key, values, identity, draft? }`. User columns never share a namespace with
  application fields. `Object.fromEntries`/computed keys and own-property checks preserve
  even names such as `__proto__`, `constructor`, and `__key`.
- `RowIdentity` captures primary-key text values, physical table OID, and xmin version.
  Writes require all three and exactly one affected row; otherwise the transaction rolls
  back. Physical table OIDs scope inherited/partitioned rows. Keyless tables refuse writes.
- Display keys encode tableoid/ctid/xmin and identify one loaded row version, not an enduring
  logical row. Pending mutations retain their own identity even after that version disappears.
- Draft `values` are sparse: omission is DEFAULT, `null` is explicit SQL NULL, `''` is empty
  text. Identity/generated column metadata controls writability on both client and server.
- `Column.kind` is only a rendering hint, not a serialization or validation rule. The server
  binds input text unchanged and PostgreSQL validates/coerces it to the actual column type.
- Table keys encode `[schema, table]` tuples; dotted identifier names cannot collide.

## SQL and metadata

`lib/server/db.ts` exports `listTables(pool)`, `listRows(pool,args)`, `saveTable(pool,args)`
and `deleteRows(pool,args)`.

Catalog introspection includes exact formatted types, PK columns (excluding INCLUDE columns),
enums, FKs, defaults, identity and generated columns. FK metadata preserves ordered source
and target tuples per constraint; a column in multiple FKs exposes the first by name/OID.
A WeakMap caches metadata per pool for 30 seconds; `listTables` explicitly refreshes it.
Each mutation acquires a transaction-local ROW EXCLUSIVE table lock before reading fresh metadata, preventing column/key DDL races.
Unknown/non-writable columns are rejected, never silently discarded.

Saves and deletions are transactional. Updates/deletes match PK + tableoid + xmin and check
rowCount; inserts also require one created row. Conflict handling is deliberately explicit:
no automatic retry, silent overwrite, or automatic merging of concurrent changes.

Pages use OFFSET/LIMIT with a complete PK tie-break and physical relation/tuple ordering.
Fetching one extra row gives `hasMore`; there is no mandatory exact COUNT. `rowCount` is a
catalog estimate. Search is debounced on the client but still uses text-cast ILIKE across
columns, so broad searches can scan large tables. Optional exact filters bind native typed
equality (or IS NULL), enabling indexed reference navigation rather than approximate text
search. Filter identifiers are checked against metadata. Refresh reloads metadata and rows.

## Connection lifecycle

`lib/server/connections.ts` maintains a bounded in-memory registry. Each browser has an
HttpOnly SameSite=Strict bearer cookie; its connection has an independent public generation.
An absent cookie may initialize the optional trusted `DATABASE_URL` default. An unknown or
expired cookie initializes an expired/disconnected session, never an environment fallback.
Malformed environment configuration appears in onboarding rather than preventing connection.

Connect tests a candidate pool before replacing the current one, checks expected generation
and session revision before and after the await, and retires old/pending clients. Failed
connects preserve the previous connection. Disconnect retains an explicit disconnected
session; `useDefault` is a separate command. Every access checks the two-hour idle TTL;
a periodic sweep releases idle sessions. Limits: 32 sessions, 8 pending connection attempts,
5 clients per pool, 10-second connect and 30-second query/statement timeouts.

Browser URLs are parsed into explicit pg settings, not passed through as driver options.
Only postgres/postgresql URLs and sslmode=require/verify-full/disable are accepted. Default
and require encrypt without certificate verification; verify-full opts into verification.
Disable explicitly selects plaintext; there is no automatic downgrade. The verification
checkbox reads/writes sslmode in the URL, keeping one source of truth, and is disabled for
plaintext URLs. Certificate file options, ambiguous settings, and environment-password
inheritance are rejected. Environment URLs are trusted and retain pg's parsing behavior.

## Browser state and grid

`EditorState` stores the active query separately from pending edits/drafts/selections per
table. Each edit owns the original values and row identity; selected rows retain identities
across pages. Sort fetches retain the displayed rows and their page offset, with a spinner
and editing disabled; other fetches clear stale rows immediately. A request counter discards
out-of-order responses. Reference arrows navigate with a complete exact-key filter;
selecting a table or Show all rows removes it. Multi-cell reference edits validate the whole
tuple against the captured row before applying any value.
Mutations capture an immutable batch and target, block user changes
until completion, and clear only acknowledged work. Failure preserves pending edits.
Changing connection generations cannot carry pending edits into another database.

Live mode is opt-in and scoped to the current result page. EditorApp invokes `poll()` every
five seconds and on visibility changes, gated by document visibility, data view and connection
modal state. Polls never overlap or invalidate foreground reads. Foreground request and live
mode generations reject obsolete responses, including reads begun before a mutation.
Unchanged results keep the existing row array. Changes update an idle view, or set a notice
when drafts, edits, an open editor, row selections or cell/range focus need preserving.
Live errors are separate from foreground errors and never clear rows. DataGrid reports cell
selection independently of its edit buffer. Polling does not refresh schema metadata in the UI.

`DataGrid.svelte` keeps positional focus/range and a captured row/column/anchor for its editor,
never a mutable array index as an edit target. Replacing rows cancels positional selection
and editing. Bounds and full paste rectangles are validated before local mutation. Native
child controls own their keyboard events; the grid exposes active-cell focus through ARIA.

`CellEditor.svelte` owns one exact text/NULL/DEFAULT buffer shared between a shadcn Popover
and a resizable Sheet. Apply stages changes, Escape cancels;
compact outside-click also applies. A transparent overlay consumes that click so sorting or
navigation cannot run before dismissal applies the buffer. Opening an editor cancels any
queued toolbar search for the same reason. Expansion preserves the buffer and text selection.
Set to options depend on nullability, type and draft status. Temporal Now uses PostgreSQL's
`now` literal rather than JS date conversion; PostgreSQL resolves it when the batch is saved.
Read-only cells can still be inspected and expanded. Sheets do not blur the underlying table;
regular confirmation and connection dialogs keep their backdrop. Applicable Set to actions
sit at the footer's right: one action is a button, multiple actions a DropdownMenu.
Select handles enum/boolean choices; Escape dismisses the innermost menu first.

`JsonEditor.svelte` uses CodeMirror for JSON/JSONB, retaining EditorState across expansion
so history and selection survive remounts. Initial pretty-printing and external buffer changes
do not emit edits. A history field tracks the semantic buffer value alongside the document:
undo/redo preserves SQL NULL, DEFAULT, explicit empty text and original literal spelling.
Set-to actions are independently undoable, even when the visible document stays empty.
`json.ts` formats parser tokens without decoding numbers, strings or duplicate keys.
Incomplete JSON stays editable. Rendering uses CodeMirror text nodes, never injected HTML.

`ReferencePicker.svelte` queries 25 target records per page with debounced search and
superseded-response cancellation. It fills all source columns atomically, not just the clicked
cell. NULL-containing target tuples cannot be selected as references. The same resizable
panel hosts the picker; a raw-value editor remains available.

The grid uses fixed 35px rows/header and 100/250/500-row pages, without virtualization.
Widths use runed PersistedState keyed by connection/table. Resizing works with pointer or
keyboard. shadcn provides buttons, checkboxes and textareas; the cell layout stays custom.
`format.ts` keeps display text lossless and implements quoted TSV, including NULL/default
markers. Opening and closing a cell without input does not coerce its original value.

The shell uses generated shadcn-svelte buttons, inputs, labels, dialogs, selects and badges.
TableDefinition and ReferencePicker use shadcn Table; the picker's outer scroll container
owns scrolling so the table header remains sticky. The spreadsheet remains custom.
Dialogs provide focus containment/restoration. Connection URLs are masked with optional
reveal; all-table discard confirmation and beforeunload guards protect local work. The dark
neutral/emerald palette in `app.css` is shared by shadcn and the grid.

## Development and verification

Use Bun for the pinned dependency lockfile and Node 24+ for the launcher and native
TypeScript test runner. Production runs through `server.mjs`, not `node build`.

```sh
bun install --frozen-lockfile
bun run dev                 # http://127.0.0.1:5173, loopback only
bun run check
bun run test                # tests not requiring a live database
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55433/postgres bun run test
bun run test:production     # builds and tests the real HTTP server
```

For an isolated development database:

```sh
docker run -d --name superbase-db -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:55433:5432 postgres:18.3-alpine
docker exec -i superbase-db psql -U postgres < dev/seed.sql
```

Copy `.env.example` to `.env` and adjust `DATABASE_URL` for an optional default connection.
The application can also start without any environment URL and connect through onboarding.
Integration tests require explicit `TEST_DATABASE_URL`, create a unique schema and remove it
afterward. They never fall back to the application's database URL. Use a disposable database.
Browser QA likewise uses isolated browser sessions and disposable databases.

`bun run check` typechecks application code. `bun run test` exercises actual compiled runes
state with mocked remote I/O, connection lifecycle with mocked sockets/request context, and
value/schema regressions, lossless JSON formatting and semantic CodeMirror history.
With explicit `TEST_DATABASE_URL`, real PostgreSQL tests cover
precision, defaults, arbitrary names, inheritance/partitions, conflicts and transaction rollback.
`bun run test:production` builds and checks actual same-origin HTTP commands and Host/CSRF
rejection through the production launcher.

## Source layout and limits

- `src/lib/types.ts` — shared value, identity, connection and mutation contracts.
- `src/lib/state/editor.svelte.ts` — workspace, pending changes and polling guards.
- `src/lib/components/` — shell, custom grid, cell editors and reference picker.
- `src/lib/components/ui/` — generated MIT shadcn-svelte components.
- `src/lib/db.remote.ts`, `validation.ts` — validated remote boundary.
- `src/lib/server/` — connection lifecycle, catalog metadata and transactional SQL.
- `src/app.css`, `components.json` — shared theme and shadcn configuration.

No persistent credentials, hosted authentication, multi-process sessions, views, schema
editing, SQL editor, or column-specific filters. Offset pagination is not a cross-page
snapshot under concurrent database changes. The app is intentionally a loopback-only tool.
