# superbase — code map

A local-only Postgres table editor: SvelteKit 3 / Svelte 5 SPA, shadcn-svelte, Tailwind v4,
and direct `pg`. No Supabase services, ORM, or public API. One Node process owns sessions.

## Runtime and boundaries

`+layout.ts` disables SSR. `+page.svelte` loads `connectionStatus()` before mounting either
onboarding or `EditorApp`. The latter initializes the module-level `EditorState` and renders
the sidebar, toolbar, grid and pagination. Connection changes reload the page
after confirming unsaved work; generation checks protect other tabs that did not reload.

`lib/db.remote.ts` validates structured intents using the Standard Schema adapters in
`lib/validation.ts` and `lib/schema-validation.ts`. It resolves a generation-checked pool
exactly once, before calling the row or schema SQL module. Database functions receive their pool explicitly, never consult cookies,
and never generate SQL on the client. Identifiers are quoted and values bound as parameters.
No arbitrary-SQL endpoint is exposed.

`hooks.ts` supplies a shared SvelteKit transport codec for records with an own `__proto__`
column key, which devalue otherwise rejects. It carries entries and reconstructs own data
properties without prototype assignment. Rows, PK identities, changes and exact filters
retain the same in-process contracts; ordinary remote validation still applies.

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
  Explicit copies of the identity and PK map avoid Svelte snapshot dropping `__proto__` keys.
  Writes require all three and exactly one affected row; otherwise the transaction rolls
  back. Physical table OIDs scope inherited/partitioned rows. Keyless tables refuse writes.
- Display keys encode tableoid/ctid/xmin and identify one loaded row version, not an enduring
  logical row. Pending mutations retain their own identity even after that version disappears.
- New-row form values are sparse: omission is DEFAULT, `null` is explicit SQL NULL, `''` is
  empty text. Its local draft Row is used only by nested editors, never added to grid rows.
  Identity/generated column metadata controls writability on both client and server.
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
Each mutation acquires a transaction-local ROW EXCLUSIVE table lock before reading fresh
metadata, preventing column/key DDL races.
Unknown/non-writable columns are rejected, never silently discarded.

Saves and deletions are transactional. Updates/deletes match PK + tableoid + xmin and check
rowCount; inserts also require one created row. Conflict handling is deliberately explicit:
no automatic retry, silent overwrite, or automatic merging of concurrent changes.

`RowsArgs.sort` is an ordered array of at most 20 unique column/direction pairs (empty means
no explicit sort). Validation rejects duplicate columns, invalid directions and malformed lists;
metadata validates every column. SQL emits rules in order with NULLS LAST for both directions,
then appends only missing PK columns and physical relation/tuple tie-breakers.
Pages use OFFSET/LIMIT with that deterministic ordering.
Fetching one extra row gives `hasMore`; there is no mandatory exact COUNT. `rowCount` is a
catalog estimate. The toolbar uses the exact loaded count when a successful, unfiltered
first page contains the whole table; other totals stay explicitly approximate, with a tooltip
explaining stale PostgreSQL statistics. Structured `RowFilter` conditions use a shared operator
whitelist (comparison, LIKE/ILIKE, NULL checks), native column typing and bound raw strings.
At most 20 conditions of up to 10,000 characters each combine with AND, including repeated
columns for ranges. Direct `listRows` calls share remote validation; metadata checks column
names before quoting. Invalid types/operators remain explicit PostgreSQL errors.

Exact FK constraints (`filter`) and user conditions (`filters`) combine with AND. The reference
picker retains its separate debounced, text-cast ILIKE search across columns, which can scan
large tables. Refresh reloads metadata and rows.

## Schema editing

`lib/schema.ts` defines catalog types, table definitions and structured DDL intents.
`lib/server/schema.ts` lists usable namespaces (including empty ones) and approved builtin,
enum/domain and array type OIDs, actual scalar/array relationships and ordered enum labels.
Domains remain opaque, including domains over arrays. Type names are resolved and quoted on
the server, never accepted as SQL. Strict validation bounds columns, UTF-8 identifier lengths,
literals/comments and type-specific integer modifiers. Array modifiers apply to their elements.
`schema-options.ts` shares modifier and contextual-default validation between client/server.
Literal defaults use pg's escaping; date/time, UUID and new-integer identity are fixed presets.
Text UUID defaults cast explicitly to text and reject character bounds below 36. Keeping a
default emits no replacement SQL, preserving arbitrary existing expressions.

Existing-table DDL takes an ACCESS EXCLUSIVE lock with a three-second lock timeout, then
compares a semantic SHA-256 catalog fingerprint including table OID, column types/modifiers,
defaults, comments, constraints and indexes. Data writes and statistics do not invalidate it;
concurrent definition changes or same-name replacement do. Relation locks do not prevent
namespace/type renames: transaction-start/end catalog tuple versions fence those names
(including array elements and rename-and-restore), and pre-commit relation/type OID checks
verify the actual target.
These use namespace/type xmin, never table xmin or statistics. Transactions explicitly use
READ COMMITTED so catalog checks stay fresh even with a stricter role default. Introspection
and writes share a trusted search path. Each Apply is one transaction; errors roll back and retain the form.
There is no CASCADE, trial rollback, custom USING expression or automatic conversion fallback.
Only standalone ordinary tables are editable; inheritance and partition targets are rejected.

An explicit type selection uses a native PostgreSQL cast and requires acknowledgement that
values may change and the table may be rewritten. Keeping a type preserves its exact modifiers.
`SchemaTypePicker` groups integer sizes and timezone variants with an array checkbox;
JSON/JSONB remain distinct. Decoded modifiers seed contextual length/precision/scale controls
without triggering DDL. Unsupported existing modifiers stay exact until explicitly replaced.
Changing types retains modifier/default drafts; incompatible choices block Apply, never silently
reset values. Literal editors follow type: enum/boolean choices, JSON/plain CodeMirror, array
literals and native scalar inputs. Empty text, arrays and JSON containers are distinct from NULL.
Existing generated type/expressions and identity defaults stay unchanged. New tables can have composite PKs; keyless tables can add a PK, but existing PKs
cannot be replaced. Native constraints and permissions remain authoritative. Dropping a column
can remove its own indexes/constraints; external dependencies block restricted drops.

`SchemaEditor.svelte` owns local drafts in a resizable Sheet; shared `SchemaColumnFields`
serves create/add/alter forms. The sidebar creates tables; the table-name menu exposes rename,
delete and keyless-table PK creation. Grid header menus expose column edit/delete, and a trailing
sticky + header adds columns, including to zero-column tables. There is no separate Definition view.
Menus pass stable triggers to the panel for focus restoration; removed triggers fall back to the grid. Apply or Ctrl/Cmd+Enter submits; outside clicks do nothing, Cancel confirms dirty
form discard, and destructive operations require the exact target name. `schemaEditing` blocks
navigation, row writes and polling. Successful DDL invalidates metadata and clears stale query
conditions/selections before reloading the created/renamed/current table. A table with its last
column removed remains selected, with its add-column header and table menu available. A read failure after
acknowledgement never turns a successful DDL command into a retryable write failure.

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

`lib/remembered-connection.ts` stores one opt-in URL/password in browser localStorage,
scoped to the app origin (including port). It is not encrypted. ConnectForm saves only after
a successful connection; manual connection changes first pause automatic restoration.
Disconnect retains the URL with restoration disabled; Forget removes it without disconnecting.
Connecting without Remember removes the saved credential. A separate non-secret consent
cookie, scoped by protocol/port in its name, also gates restoration. Manual changes turn it
off before touching localStorage; this allows nonpersistent use when localStorage is denied
without reviving stale credentials once access returns. An intent nonce also prevents a late
connect response from overwriting a newer choice or undoing Forget in another tab.
Missing/expired consent fails closed.
Other storage failures are explicit; failed post-connect persistence does not undo a connection.

On page bootstrap, an enabled saved URL restores a missing session or replaces an implicit
environment default. An existing browser connection is never replaced automatically. Failed
restoration stays on onboarding, never falls through to the environment database. This runs
before EditorApp mounts, never during edits or background polling; after expiration, reload
with the normal unsaved-work guard. Browser-entered credentials are never persisted on the server.

## Browser state and grid

`EditorState` owns the active query and cross-page row selections, not staged edits.
Cell buffers and new-row form values stay in their components. `updateRows` validates and
captures an atomic mutation batch for an applied cell/composite reference, paste or range clear.
`insertRow` inserts one complete sparse form. Both await the real database write; PostgreSQL
validates all types and constraints. Failures throw to the owning editor without replacing
its rows or buffer. After acknowledgement, a refresh failure is a read error, not a failed
write that should be submitted again. Updated versions are removed from row selections;
unrelated selected identities survive.

Open editors/forms and pending mutations block navigation and connection reinitialization.
Mutations capture their target and invalidate older polls. Sort fetches retain displayed rows
and their page offset, with editing disabled; other fetches clear stale rows immediately.
A request counter discards out-of-order reads. User filter changes reset pagination and copy
the submitted conditions; sorting, page size, polling and refresh preserve them. Reference
arrows use a separate complete exact-key constraint. Switching tables clears user conditions;
Show all rows / Remove filters clears both user and FK constraints.

Live mode starts enabled and is scoped to the current result page. EditorApp invokes `poll()` every
five seconds and on visibility changes, gated by document visibility and connection modal state.
Schema forms pause polling through the workspace guard. Polls never overlap or invalidate foreground reads. Foreground request and live
mode generations reject obsolete responses, including reads begun before a mutation.
Unchanged results keep the existing row array. Changes update an idle view, or set a notice
when an open editor/form, row selections or cell/range focus need preserving.
Live errors are separate from foreground errors and never clear rows. DataGrid reports cell
selection independently of its edit buffer. Polling does not refresh schema metadata in the UI.

`DataGrid.svelte` keeps positional focus/range and a captured row/column/anchor for its editor,
never a mutable array index as an edit target. Replacing rows cancels positional selection
and editing. Bounds and full paste rectangles are validated before local mutation. Native
child controls own their keyboard events; the grid exposes active-cell focus through ARIA.
There is no permanent usage-hint/status strip above the column headers.
Cells open by double-click, Enter or F2. Escape, blank grid clicks and outside-grid clicks
clear cell/range focus without changing checkbox row selections. Outside clicks never steal
focus from controls or clear selection underneath an open cell editor.

`CellEditor.svelte` owns one exact text/NULL/DEFAULT buffer shared between a shadcn Popover
and a resizable Sheet. Apply saves existing rows immediately; Escape cancels the buffer.
Outside clicks and blur neither save nor discard the buffer. FK selection prepares a complete
local tuple; Apply writes it together with any subsequent field edit. The editor stays open on
database errors, disables changes/dismissal while saving, and closes only after acknowledgement.
A transparent overlay consumes outside clicks so navigation cannot bypass Apply or Cancel.
Filter changes are likewise blocked
while cell editors or insert forms are open. Opening a cell places a caret rather than selecting
all text. Expansion preserves the buffer and deliberate text selection.
Set to options depend on nullability, type and draft status. Temporal Now uses PostgreSQL's
`now` literal rather than JS date conversion; PostgreSQL resolves it when the batch is saved.
Read-only cells can still be inspected and expanded. Sheets do not blur the underlying table;
regular confirmation and connection dialogs keep their backdrop. Applicable Set to actions
sit at the footer's right: one action is a button, multiple actions a DropdownMenu.
Select handles enum/boolean choices; Escape dismisses the innermost menu first.

`TextEditor.svelte` uses CodeMirror for text and JSON/JSONB columns, chosen from `Column.kind`,
never content or length. Plain text stays literal and soft-wraps; only JSON gets indentation
and syntax highlighting. Other kinds retain native controls. Both the cell editor and insert
form use this component. EditorState survives cell-panel expansion, preserving selection and
undo history. Initial formatting and external buffer changes do not emit edits.
A shared history field tracks the semantic buffer value alongside the document:
undo/redo preserves SQL NULL, DEFAULT, explicit empty text and original literal spelling.
Set-to actions are independently undoable, even when the visible document stays empty.
`json.ts` formats parser tokens without decoding numbers, strings or duplicate keys.
Incomplete JSON stays editable. CodeMirror splits only LF, retaining CRLF and lone CR bytes
even through edits; special-character markers make CR visible. Rendering uses text nodes,
never injected HTML.

`InsertRow.svelte` is a resizable, unblurred Sheet with all column fields, a scrollable body
and fixed Save/Cancel footer. Defaults are placeholders, never evaluated into form values.
Generated/always-identity fields stay omitted. Save performs one insert; errors retain the
whole form. Create more resets fields and undo history after acknowledgement. Discarding a
populated form requires confirmation. Nested cell/text/reference editors only update this
local form until its Save action.

`FilterBar.svelte` replaces broad table search with searchable column suggestions, grouped
comparison choices, raw values and editable/removable chips. Bits UI Combobox and shadcn
Select/Popover provide keyboard navigation and focus handling. Draft conditions stay local
until Apply (unary NULL checks apply immediately); no AI, SQL expression parser or nested OR.
The grid distinguishes an empty table, zero filtered matches (with Remove filters), and read
failures. Failed reads show the PostgreSQL warning inside the empty-results panel, not a
duplicate top banner; errors with retained rows keep the banner. There is no
panel Retry button: edit/remove invalid filters, or use the toolbar Refresh for transient errors.
Empty-result panels fit their content, wrap long messages within the viewport, and stay sticky
at the grid's left edge during horizontal scrolling.
A type error is never presented as a successful query with no results. If Live empties
a later page, it says No rows on this page and offers Go to first page without removing filters,
rather than incorrectly claiming the whole table or filtered result is empty.

`SortMenu.svelte` shares the filter toolbar row. Its local draft supports adding columns,
toggling direction, moving priorities up/down and removing rules. Apply snapshots all rules
in one retained-row fetch; closing the popover discards the draft. Grid headers cycle one
column through ascending/descending/off without replacing other rules, and display priority
numbers. Only the primary header uses `aria-sort`; other sorted headers have descriptive names.
Sorting survives filters, paging, refresh and polls, but resets when switching tables.
`ColumnMenu.svelte` provides explicit ascending/descending/remove-sort actions without replacing
other priorities, plus copy-name and schema actions. Header chevrons are separate from the sort
button and resize handle. Header tooltips retain comments, nullability, defaults/generation,
enum values and FK targets; the trailing action column never enters cell selection or clipboard data.

`ReferencePicker.svelte` queries 25 target records per page with debounced search and
superseded-response cancellation. Selection prepares all source columns in the cell editor;
Apply saves them atomically for existing rows, or fills the new-row form locally. NULL-containing target tuples cannot be selected.
The same resizable panel hosts the picker; a raw-value editor remains available.

The grid uses fixed 35px rows/header and 100/250/500-row pages, without virtualization.
Widths use runed PersistedState keyed by connection/table, with in-memory sizing when browser
storage is denied at mount. Resizing works with pointer or keyboard. shadcn provides buttons, checkboxes and textareas; the cell layout stays custom.
`format.ts` keeps display text lossless and implements quoted TSV, including NULL/default
markers. Opening and closing a cell without input does not coerce its original value.

The shell uses generated shadcn-svelte buttons, inputs, labels, dialogs, selects and badges.
ReferencePicker uses shadcn Table; its outer scroll container
owns scrolling so the table header remains sticky. The spreadsheet remains custom.
Dialogs provide focus containment/restoration. Connection URLs are masked with optional
reveal; discard confirmation and beforeunload guards protect open editors/forms and writes. The dark
charcoal palette in `app.css` is shared by shadcn and the grid. Inputs are inset/darker,
buttons and selections neutral; only Connect and small status accents use brand green.
JSON syntax uses a muted editor palette rather than green strings.

`LoadingShell.svelte` keeps the sidebar/main layout while connection/catalog data loads.
Neutral Skeleton bars cover empty table/reference loads; retained rows during sorts show
only a small progress bar. Live polls do not flash skeletons. Loading regions expose status
and busy semantics; pulse animation respects reduced-motion preferences.

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
value/schema regressions, lossless JSON formatting, literal text/line endings and semantic
CodeMirror history.
With explicit `TEST_DATABASE_URL`, real PostgreSQL tests cover
precision, defaults, arbitrary names, inheritance/partitions, conflicts, transaction rollback,
typed/parameterized filters, multi-column order/NULL placement and stable page boundaries.
Schema integration tests cover literal quoting, contextual presets, scalar/array modifiers,
domain/enum metadata, exact modifier preservation, casts/default ordering, rollback,
concurrent fingerprints and catalog-name reuse, dependency restrictions, PKs, lock timeouts
and metadata invalidation. Isolated schema browser checks exercise all DDL flows, native-error
recovery, stale definitions, protected drafts, keyboard handling and narrow/resizable panels.
Type-option browser checks verify exact existing settings, retained incompatible drafts,
contextual defaults, custom/array types, SQL previews and PostgreSQL-persisted definitions.
Browser filter checks cover keyboard focus, same-column ranges,
NULL versus empty, invalid-type recovery, FK constraints, sorting/paging/polling, and distinct
empty-page/table/no-match/error states.
`bun run test:production` builds and checks actual same-origin HTTP commands and Host/CSRF
rejection through the production launcher.

## Source layout and limits

- `src/lib/types.ts`, `schema.ts` — shared row, connection and structured DDL contracts.
- `src/lib/state/editor.svelte.ts` — workspace, pending changes and polling guards.
- `src/lib/components/` — shell, custom grid, filter bar, cell editors and reference picker.
- `src/lib/components/ui/` — generated MIT shadcn-svelte components.
- `src/lib/db.remote.ts`, `validation.ts` — validated remote boundary.
- `src/lib/server/` — connection lifecycle, catalog metadata and transactional SQL.
- `src/app.css`, `components.json` — shared theme and shadcn configuration.

No server-side credential persistence, hosted authentication, multi-process sessions, views,
SQL editor, or nested/OR filter groups. Schema editing excludes FK/index/unique/check editing,
enum/namespace management and replacing existing primary keys. Offset pagination is not a
cross-page snapshot under concurrent changes. The app is intentionally a loopback-only tool.
