# superbase — code map

A local-only Postgres table and SQL editor: SvelteKit 3 / Svelte 5 SPA, shadcn-svelte, Tailwind v4,
and direct `pg`. No Supabase services, ORM, or public API. One Node process owns sessions.

## Runtime and boundaries

`+layout.ts` disables SSR. `+page.svelte` loads `connectionStatus()` before mounting either
onboarding or `EditorApp`. The latter initializes the module-level `EditorState` and renders
the navigation rail, table workspace and lazily mounted SQL workspace. Hidden workspaces stay
mounted to retain drafts, selection/history, filters and scroll state without reconnecting.
Connection changes reload the page
after confirming unsaved work; generation checks protect other tabs that did not reload.

`lib/db.remote.ts` validates structured intents using the Standard Schema adapters in
`lib/validation.ts` and `lib/schema-validation.ts`. It resolves a generation-checked pool
exactly once, before calling the row or schema SQL module. Database functions receive their pool explicitly, never consult cookies,
and never generate table/schema SQL on the client. Identifiers are quoted and values bound as
parameters. The separate SQL-console commands intentionally accept arbitrary SQL, validated by
`sql-validation.ts` and confined to dedicated clients rather than table-editor pool leases.

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

`RowQuery` shares filters, exact FK constraints, search and sorting between paginated rows
and unpaginated query exports. `validation.rowQuery` validates these fields at both boundaries;
`server/db.rowSelection` builds the shared parameterized WHERE and deterministic ORDER BY.
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
serves create/add/alter forms. The sidebar creates tables; each table row's `TableMenu` exposes
copy name/schema, duplicate, CSV export, rename, delete and keyless-table PK creation.
Breadcrumbs are display-only. Opening a menu/form
captures its own table target without changing the active grid; cancelling preserves that view.
Deleting another table leaves the current table selected. Grid header menus expose column edit/delete, and a trailing
sticky + header adds columns, including to zero-column tables. There is no separate Definition view.
The panel snapshots its menu trigger before parent intent teardown for focus restoration;
removed triggers fall back to the grid. Apply or Ctrl/Cmd+Enter submits; outside clicks do
nothing, Cancel confirms dirty
form discard, and destructive operations require the exact target name. `schemaEditing` blocks
navigation, row writes and polling. Successful DDL invalidates metadata and clears stale query
conditions/selections before reloading the created/renamed/current table. A table with its last
column removed remains selected, with its add-column header and table menu available. A read failure after
acknowledgement never turns a successful DDL command into a retryable write failure.

## Table copying and CSV export

Schema SQL is a read-only server-generated preview, copied only by an explicit browser gesture.
Its scope warnings travel with the copied SQL; it is not a full database backup. Duplication
uses a new name in the source schema, defaults to no rows, and requires acknowledging the copy
scope. `server/table-actions.ts` builds the catalog snapshot and native LIKE clone, with
independent owned sequences. Direct nextval defaults (including cross-column references) are
rebound without SQL text substitution; complex owned-sequence expressions, including dynamic
builtin sequence calls in CHECK trees, are rejected before creating the clone.
Sequence options/ownership and RLS flags participate in fingerprints, but live sequence values
do not. New sequence positions use PostgreSQL numeric/int8 arithmetic past copied extrema;
exhaustion fails explicitly. External types/functions/unowned sequences remain shared.
Generated values are recomputed when rows are included. RLS flags remain but policies,
foreign keys, triggers, rules, grants and ownership are not copied; PostgreSQL default privileges
apply to the destination. Copy/duplicate use ACCESS SHARE locks and source/destination catalog
identity checks. Schema SQL includes exact types/collations/defaults, owned sequences,
constraints/FKs, non-constraint indexes and comments, with unsupported physical/security settings
listed as omissions. Non-FK constraints and indexes precede FKs, so self-references backed by
standalone unique indexes restore correctly. No arbitrary SQL is accepted from the client for
either action.

`server/export.ts` streams exact CSV with a read-only SQL cursor in 256-row batches; one value
can still be large. Optional `CsvExportArgs.query` applies the grid's exact filters/FK tuple
and sort to all matching rows, without pagination or checked-row selection. Query exports
read fresh metadata on the locked lease, reuse the grid's WHERE/order builder and bind values
in DECLARE. Catalog reads use a trusted search path; DECLARE/FETCH retain the connection's
original path so custom operators (e.g. citext), functions and RLS behave as in grid reads.
Full-table exports omit the query and retain unspecified ordering. Optional `columns` selects
unique, existing names in table column order; filtering/sorting still uses the complete table.
Omission means all columns, and an empty selection is rejected rather than silently broadened.
Non-null values (including empty strings and headers) are quoted; SQL NULL
is an unquoted empty field. Per-query text parsing and array-mode rows preserve precision and
hostile column names. An ACCESS SHARE lock, namespace tuple-version fences and cursor field
relation OIDs verify the bound target before response headers. The cursor supplies a consistent
snapshot without OFFSET pagination and respects the role's RLS visibility. Zero-column and
non-standalone tables are rejected explicitly. Abort/cancellation destroys only the leased
client; successful/error completion rolls back the read-only transaction before reuse.

`/export` accepts only connection/schema/table GET parameters for full-table downloads.
The UI uses a native URL-encoded POST form with one JSON `export` field, avoiding URL
length limits and filter values in URLs/history. Both validate strict structured arguments and
capture one generation-checked pool. Loopback/session guards still apply; cross-origin requests
are rejected, and POST requires a matching Origin and the expected form content type. Native attachment
downloads avoid buffering the whole file in browser JavaScript. `CsvExport.svelte` captures
requests and submits to a hidden, script-disabled download frame, without navigating the app or
opening tabs. A new request replaces the previous frame; already-started attachments belong to
the browser download manager. Initial error documents appear in the app, not as CSV files.
The toolbar downloads all matching rows/columns immediately; the sidebar downloads the full
table. A brief, dismissible request acknowledgement (or modal button label) confirms the click,
not transfer completion; initial errors replace it. Its timer resets per request and is cleared
on unmount. Optional Export options opens a modal with all columns initially checked, preserving
the action's captured table/query scope. The schema-editing Sheet no longer handles CSV.
Options/errors remain available for correction; browser-native downloads report later transfer
failures. Browser-level URL blocking that produces neither a download nor a frame load event
cannot be detected by this native handoff; there is no speculative failure timeout. Query exports use a fresh cursor snapshot, not the grid's displayed row versions.
Responses are no-store/nosniff/same-origin; filenames are safely encoded.

## SQL console

`sql.ts` defines positional field/row results: every value is PostgreSQL text or NULL,
including duplicate/hostile column names. `server/sql.ts` owns up to four dedicated clients per
browser connection generation. Each SQL workspace lazily opens its own server-generated session;
SET, temporary tables and explicit transactions survive subsequent runs without affecting pools.
Buffers/selections are submitted unchanged using PostgreSQL's simple protocol: no splitting,
LIMIT injection, implicit BEGIN wrapper or automatic retry. Multi-statement buffers follow
PostgreSQL's native transaction rules. Earlier explicit commits can survive a later error.
COPY protocol streams and binary cursor results explicitly close the session; this is not a
psql terminal. UTF8 client encoding is required and established at startup. Reported encoding
changes close the session and discard that run's previews. PostgreSQL does not report temporary
change-and-restore within one buffer: changing client_encoding, including inside functions, is
unsupported and may corrupt results/messages or cause native conversion errors. No SQL blacklist
pretends to enforce arbitrary function behavior.

Streaming `pg.Query` row events retain at most 1,000 rows per result, 50 results and a 2 MB
aggregate preview budget, including metadata/notices and reserved error space. Excess previews
are discarded without cancelling SQL or changing write semantics. A small, documented adapter
to pinned pg 8.23.1 internals drops old driver result metadata too. One incoming protocol
frame/value can still be large before the preview bound applies. Error text and notices are
redacted/bounded. ReadyForQuery, not Query's earlier error event, determines actual idle/open/
failed transaction status. Transport failures report unknown outcomes and require explicit Reset.

Cancellation uses a separate bounded client with original credentials, checks the run ID again
after connecting, and keeps the SQL session busy until cancellation settles. Idle/stale requests
cannot cancel a later run. Connection replacement, disconnect and expiry retire all dedicated
and connecting/cancelling clients. Defaults: 10-second connect, 30-second statement timeout,
5-minute idle-transaction timeout, 15-minute SQL idle expiry and a 60-second application wall
limit which destroys the socket even if SQL changes server timeouts. Socket destruction does
not guarantee immediate database interruption; unfinished work has an unknown outcome.
Closed/expired sessions never reconnect transparently. A same-origin JSON `/sql/close` beacon
on non-bfcache pagehide releases abandoned sessions; expiry also covers crashes/offline tabs.

`SqlState` is instantiated per mounted workspace. It snapshots submitted SQL/run IDs, retains
drafts through errors and resets, and guards duplicate runs/connection changes.
SQL text autosaves synchronously on actual edits to versioned localStorage keys containing a
per-tab UUID and exact host/port/database/user tuple, never credentials or connection generations.
The UUID lives in sessionStorage; a held Web Lock prevents duplicated tabs (which clone that
storage) from sharing a write slot. A duplicate copies the current target's text into its own slot.
The editor is read-only during initial restoration/ownership acquisition. Restoration never opens
a SQL connection or executes text; a nonempty restored draft opens the SQL workspace unless the
user already chose a workspace. Clearing the buffer removes its saved text.

Pagehide freezes writes before releasing the lock; a lifecycle counter rejects late acquisitions.
BFCache resume reacquires ownership and compares the saved snapshot before enabling persistence.
Conflicts preserve both cached text and newer stored text, with autosave paused and an explicit
warning. Failed initial reads likewise never enable writes to unread storage. Quota/write failures
retain unsaved text; subsequent edits can retry. Storage events and a synchronous pre-navigation
check detect cleared/changed data or lost tab identity without recreating deleted records.
Only safely saved SQL text and idle sessions avoid reload warnings: running/cancelling work,
open/failed transactions, unknown outcomes and unsaved table forms still warn. Connection changes
retain a separate session-loss confirmation; successful teardown does not save an artificial empty
draft. Local SQL is unencrypted; sessions/results/history are never restored, and abandoned tab
records remain until their editor is cleared or the site's storage is removed.
`SqlEditor` uses TextEditor's PostgreSQL CodeMirror mode, keyword completion, line numbers,
selection-or-buffer Run/Ctrl+Enter, a keyboard/pointer resizer and paged read-only result sets.
Tab accepts a selected SQL completion or indents; Shift+Tab outdents without leaving the editor.
CodeMirror's Escape-then-Tab accessibility escape hatch remains available. Cell editors retain
native Tab navigation.
Compact status reports idle/open/failed transactions. Commit/Rollback buttons send only their
literal command through the existing run path, preserving the draft/selection and session;
Commit is disabled in a failed transaction. There is no transaction wrapper or mode switch.
Session/preview details live in an info popover rather than permanent explainers. Errors,
messages, truncation and session reset remain explicit. The rail shows
Tables, SQL and connection controls only. Table Live polling pauses in SQL; returning preserves
the table workspace. Schema changes made through SQL require a table Refresh.

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
five seconds and on visibility changes, gated by document visibility, active workspace,
SQL execution and connection modal state.
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
never content or length. Plain text stays literal and soft-wraps; JSON gets indentation
and syntax highlighting. The SQL workspace selects a separate PostgreSQL language mode with
line numbers/completion, without changing cell semantics. Other column kinds retain native controls. Both the cell editor and insert
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
Table-action regressions cover SQL round-trips, independent/cross-column sequence defaults,
sequence exhaustion, dynamic CHECK rejection, self-FK ordering, RLS and unchanged sources.
CSV tests cover exact bytes, multiple batches, snapshot visibility, permissions, catalog races,
abort/error cleanup and GET/POST route security. Filtered exports are compared with both native
SQL and paginated grid reads, including multi-sort/NULLs/tie-breaks, FK tuples, hostile names,
RLS, custom operator/search-path semantics, empty matches and native comparison errors. SQL-console tests cover exact/duplicate-name multiple
results, preview bounds without truncating writes, transaction errors/ReadyForQuery ordering,
session isolation, cancellation races, disposal/expiry, unsupported COPY and unknown outcomes.
Connection and runes-state tests verify generation ownership, draft retention and no replay;
production HTTP checks exercise every SQL command's generation/CSRF boundary and cleanup origin.
Isolated SQL browser checks cover selection/keyboard execution, preview versus real write counts,
transactions/cancellation/reset, navigation state, cross-tab isolation, reload/beacon/bfcache
cleanup, connection-discard confirmations, unsupported protocols and narrow/short layouts.
Draft-persistence checks cover exact restoration without execution, duplicate-tab ownership,
database/generation isolation, genuine BFCache, real quota exhaustion and cancelled-reload
recovery, denied storage/locks, external conflicts and unchanged table-edit guards.
Browser checks verify actual clipboard contents and
native full-table, filtered/sorted and selected-column downloads against exact PostgreSQL
bytes/order. Checks include composite FK constraints, long form values, empty matches, inline
initial errors, focus and narrow modals. Concurrent 32.8 MB downloads survive frame replacement
with exact hashes; midstream failures cancel browser downloads rather than producing success.
Browser filter checks cover keyboard focus, same-column ranges,
NULL versus empty, invalid-type recovery, FK constraints, sorting/paging/polling, and distinct
empty-page/table/no-match/error states.
`bun run test:production` builds and checks actual same-origin HTTP commands and Host/CSRF
rejection through the production launcher.

## Source layout and limits

- `src/lib/types.ts`, `schema.ts`, `sql.ts` — row/connection, structured DDL and SQL contracts.
- `src/lib/state/` — table workspace/polling guards and per-workspace SQL execution state.
- `src/lib/components/` — shell, custom grid, filter bar, cell editors and reference picker.
- `src/lib/components/ui/` — generated MIT shadcn-svelte components.
- `src/lib/db.remote.ts`, `*validation.ts` — validated remote boundaries.
- `src/lib/server/` — connection lifecycle, catalog metadata and transactional SQL.
- `src/app.css`, `components.json` — shared theme and shadcn configuration.

No server-side credential persistence, hosted authentication, multi-process sessions, views,
SQL multi-tabs/saved history, or nested/OR filter groups. Schema editing excludes FK/index/unique/check editing,
enum/namespace management and replacing existing primary keys. Offset pagination is not a
cross-page snapshot under concurrent changes. The app is intentionally a loopback-only tool.
