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
and target tuples per constraint; a column in multiple FKs exposes the first by name/OID. A WeakMap caches metadata per pool for
30 seconds; `listTables` explicitly refreshes it. Each mutation acquires a transaction-local
ROW EXCLUSIVE table lock before reading fresh metadata, preventing column/key DDL races.
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

`DataGrid.svelte` keeps positional focus/range and a captured row/column/anchor for its editor,
never a mutable array index as an edit target. Replacing rows cancels positional selection
and editing. Bounds and full paste rectangles are validated before local mutation. Native
child controls own their keyboard events; the grid exposes active-cell focus through ARIA.

`CellEditor.svelte` owns one exact text/NULL/DEFAULT buffer shared between a bits-ui popover
and a shadcn dialog styled as a resizable right panel. Apply stages changes, Escape cancels;
compact outside-click also applies. A transparent overlay consumes that click so sorting or
navigation cannot run before dismissal applies the buffer. Opening an editor cancels any
queued toolbar search for the same reason. Expansion preserves the buffer and text selection.
Set to options depend on nullability, type and draft status. Temporal Now uses PostgreSQL's
`now` literal rather than JS date conversion; PostgreSQL resolves it when the batch is saved.
Read-only cells can still be inspected and expanded.

`ReferencePicker.svelte` queries 25 target records per page with debounced search and
superseded-response cancellation. It fills all source columns atomically, not just the clicked
cell. NULL-containing target tuples cannot be selected as references. The same resizable
panel hosts the picker; a raw-value editor remains available.

The grid uses fixed 35px rows/header and 100/250/500-row pages, without virtualization.
Widths use runed PersistedState keyed by connection/table. Resizing works with pointer or
keyboard. shadcn provides buttons, checkboxes and textareas; the cell layout stays custom.
`format.ts` keeps display text lossless and implements quoted TSV, including NULL/default
markers. Opening and closing a cell without input does not coerce its original value.

The shell uses generated shadcn-svelte Button/Input/Label/Dialog/NativeSelect/Badge components.
Dialogs provide focus containment/restoration. Connection URLs are masked with optional
reveal; all-table discard confirmation and beforeunload guards protect local work. The dark
neutral/emerald palette in `app.css` is shared by shadcn and the grid.

## Verification and limits

`bun run check` typechecks application code. `bun run test` exercises actual compiled runes
state with mocked remote I/O, connection lifecycle with mocked sockets/request context, and
value/schema regressions. With explicit `TEST_DATABASE_URL`, real PostgreSQL tests cover
precision, defaults, arbitrary names, inheritance/partitions, conflicts and transaction rollback.
`bun run test:production` builds and checks actual same-origin HTTP commands and Host/CSRF
rejection through the production launcher.

No persistent credentials, hosted authentication, multi-process sessions, views, schema
editing, SQL editor, or column-specific filters. Offset pagination is not a cross-page
snapshot under concurrent database changes. The app is intentionally a loopback-only tool.
