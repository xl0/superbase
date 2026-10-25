# superbase — plan

## Intent

Build a small, local-only Postgres table editor with the useful parts of Supabase Studio's
UX, without its platform dependencies. Keep SvelteKit, direct server-owned SQL, and a custom
spreadsheet grid. Reuse shadcn-svelte for standard UI instead of maintaining equivalents.

Preserve PostgreSQL values exactly. Navigation, background refreshes, and connection changes
must never silently discard edits or send them to a different target. Favor simple, readable
solutions; add infrastructure only when a concrete feature needs it.

Keep Connections and Settings as separate UI entry points: Connections manages client-side
profiles and database targets; Settings manages supported options for the selected database
and clearly scoped sessions/roles. Expand reusable SQL and database administration without
introducing Supabase platform services or nonfunctional navigation placeholders.

## TODO

Finish and verify the active item before starting the next. Queue new feature requests here
rather than interrupting work already underway.

- [x] Browser connections, lossless transactional editing, cross-page row selections,
  retained rows during sorting, rich/resizable cell editors, and composite foreign-key
  selection/navigation. Regression tests and isolated browser checks cover the foundation.

- [x] Shadcn Select, DropdownMenu, Popover, Sheet and display tables replace native/custom
  standard controls. Single Set to actions are footer buttons; multiple actions use a menu.
  The resizable sheet leaves the table unblurred. Nested-menu Escape and focus are verified.

[x] JSON/JSONB uses CodeMirror with lossless indentation and highlighting in both editor
modes. Semantic undo/redo preserves SQL NULL, DEFAULT and literal text across expansion.
Precision, readonly behavior, keyboard handling and compact-editor bounds are verified.

[x] Optional live refresh polls the visible data view every five seconds. Idle results update;
local edits, drafts and selections instead receive a changed-data notice. Visibility/modal
pausing, race guards, failure recovery and actual database updates are verified.

[x] README covers running, connecting, editing and limits for users. Development setup,
test commands and architecture live in CODE.md.

[x] Applied cell/reference changes and rectangular paste save immediately and atomically.
PostgreSQL errors retain editor input; concurrent changes still conflict. Insert row uses a
resizable, unblurred form with explicit NULL/defaults, rich fields and one Save action.
Failures retain the form; Create more resets it. Browser and state regressions are verified,
including arbitrary column names through transport and identity capture.

[x] Studio-like charcoal surfaces, inset dark inputs, neutral buttons/selections and muted
syntax colors replace broad green styling. Connect and small status accents retain green.

[x] Live updates start enabled; visibility pausing and local-work protection remain intact.

[x] Neutral skeletons cover connection/catalog, empty table and reference loading. Sorting
retains rows with a quiet progress bar; live polling never flashes placeholders. Busy/status
semantics, reduced motion and layouts are browser-verified.

[x] Remember one successful connection in browser storage, with explicit consent and a
credential warning. Restore only on page load; Disconnect pauses it and Forget erases the URL.
Browser checks cover edit protection, failed restoration, cross-tab races and storage denial.
Nonpersistent connections and grid resizing still work when browser storage is blocked.

[x] JSON opening uses a caret instead of selecting the document. Browser checks cover
first input, Escape, Enter/F2, expansion selections and typing-to-edit.

[x] Complete unfiltered first pages show exact counts; other totals explain their estimates.
Open cell is removed. Escape and blank grid clicks deselect cells/ranges without changing
checked rows. The permanent usage-hint strip is removed. Pagination, loading and mouse/keyboard
flows are verified.

[x] Outside-grid clicks clear cell selection without a dedicated button. Clicked controls
keep focus, checked rows remain selected, and open editors retain their buffers.

[x] Native cell fields open with a caret, not selected text. Text, numeric, timestamp, boolean
and UUID input preserve existing values; expand/collapse retains deliberate selections.

[x] CodeMirror is chosen by column type: literal, wrapping text or formatted JSON/JSONB.
Scalars stay native. Browser and unit checks cover mixed line endings, long text, semantic
undo, expansion, insert labels/Create more and JSON precision; content never selects the mode.

[x] Studio-like filter chips suggest columns and comparisons, combine with AND, and support
editing/removal. Validated native PostgreSQL parameters preserve precision and FK constraints.
Empty tables, no matches, empty later pages and query errors are distinct. SQL/state and browser
checks cover keyboard focus, local-work guards, sorting, paging and Live.

[x] PostgreSQL query warnings appear inside the empty-results panel with filter removal,
without a redundant Retry button; toolbar Refresh remains available.
Panels fit their content and stay pinned during horizontal scrolling. Browser checks cover
compact/long messages, narrow viewports, recovery actions and no duplicate top banner.

[x] Multi-column Sort shares the filter row, with local drafts, direction, priority moves,
removal and Apply. Headers cycle individual rules and show priority. SQL/state and browser
checks verify typed ordering, NULLs, stable pages, keyboard flows, Live and local-work guards.

[x] Cell and FK edits require explicit Apply. Outside clicks/blur retain the buffer without
saving or discarding. Browser checks cover composite tuples, cancellation, expansion and nested
insert editors; deliberate paste/clear actions remain immediate.

[x] Schema editing creates/renames/drops ordinary tables and adds/edits/drops columns,
including confirmed native type casts, nullability, comments and literal/preset defaults.
New tables and keyless tables support PK creation. Resizable panels use explicit Apply,
discard guards and typed destructive confirmation. Transactional DDL, short lock waits,
semantic fingerprints and catalog identity checks protect concurrent changes and name reuse.
SQL/state and isolated browser checks verify rollback, preservation, errors, zero-column tables,
keyboard/narrow layouts and metadata refresh. Inheritance/partitions, FK/index/enum/namespace
management and existing PK replacement remain outside this first pass.

[x] Schema actions live in grid column menus and a sticky add-column header; table operations
sit in sidebar table-row menus. The separate Definition view is removed. Browser checks verify
explicit Apply, confirmations, metadata access, focus restoration, sorting, protected drafts,
clipboard boundaries and zero-column tables. Narrow filter/pagination controls fit the viewport.

[x] Schema forms use searchable base types with integer size, timezone, array and validated
length/precision/scale options. Type-specific defaults/literal editors preserve drafts and exact
existing definitions; incompatible choices block Apply without resets. SQL previews, native
round-trips, lossless defaults, custom types, keyboard flows and narrow layouts are verified.

[x] Table operations use each sidebar row’s ⋮ menu, not breadcrumbs. Explicit targets keep
inactive-table actions safe; Cancel and unrelated deletion preserve the current table.
Browser checks verify native writes, confirmations, guards, narrow menus and restored focus.

[x] Sidebar actions copy exact names/schema SQL, duplicate structure with optional rows and
independent owned sequences, and stream full-table CSV. Scope/permission warnings are explicit.
SQL round-trips, RLS, sequence safety, catalog races, stream cleanup and browser clipboard/download
flows are verified, including exact values across pages and narrow panels.

[x] SQL editor and Tables/SQL/connection rail preserve both workspaces. A PostgreSQL editor
runs selections/buffers with bounded exact-text read-only result sets.
Dedicated per-tab sessions support transactions/temp/SET, guarded cancellation and explicit
reset; connection replacement, expiry and unload cleanup release them. Automated and isolated
browser checks verify native semantics, precision, preview/write independence, cancellation
races, cross-tab/generation isolation, drafts, reload/bfcache cleanup, keyboard and narrow/short
layouts. SQL Tab accepts completion or indents, Shift+Tab outdents, and Escape then Tab exits.
UTF8 is required; COPY streams, binary results and psql commands are unsupported.

[x] Compact SQL status and Commit/Rollback controls replace permanent explainers; session
and preview details live behind an info button. Browser checks verify real commit/rollback,
failed/deferred-commit recovery, retained drafts/selection, focus and narrow/short layouts.
Native batch transactions and standalone administrative commands remain unchanged.

[x] SQL drafts autosave per database/tab and restore without execution. Saved text and idle
SQL sessions reload without prompts; active/uncertain work and unsaved edits remain protected.
Tests and isolated browsers verify duplicate-tab ownership, database/generation changes,
reload/BFCache conflicts, real quota recovery, denied storage, clearing and retained drafts.

For these items, completion includes focused regression tests and browser checks, not just
rendered controls. Keep CODE.md and user-facing documentation aligned with actual behavior.

## Queued requests

These are planned, not implemented. Choose the next item before starting; finish and verify
one feature at a time. Preserve the completed items above in their existing order.

### [x] Direct CSV downloads and optional column selection

Both export actions download all columns immediately, without an info panel or new tab.
Optional column-selection modals preserve table order and full-table versus filtered scope.
Brief request confirmations acknowledge clicks without claiming completion; errors replace them.
Native streaming, exact projections, retained error state, concurrent large downloads,
notification timing and keyboard/narrow layouts are verified. Use modals for interaction options like this; reserve
right-hand panels for database manipulation.

### [x] Resizable left and right panels

The sidebar and existing editor Sheets use small neutral grips for pointer and keyboard
resizing with viewport bounds. Resizing preserves drafts, focus/history and grid ranges; sidebar width survives
workspace switches and temporary viewport narrowing. Browser checks verify all four handles,
mouse/touch cancellation, long-name layouts, reachable short-panel footers and ordinary dismissal.

### [ ] Connections: multiple database profiles

Give Connections its own UI, separate from Settings. Manage named profiles for multiple
servers/databases: add, edit, remove, connect and switch targets. Keep credential persistence
opt-in, with the existing unencrypted-storage warning and Remember/Forget protections.
Preserve database-scoped SQL drafts/snippets and guard open transactions, unsaved work,
stale generations and cross-tab changes so commands never reach a replacement target.
Start with multiple saved profiles and one active target per workspace; decide separately
whether simultaneous connected workspaces are needed. A profile is not a PostgreSQL database:
adding/removing a connection must not create/drop a database.

### [ ] Settings: database administration, not connection credentials

Add a separate Settings entry point for the selected target. Expose only implemented,
permission-aware controls; host, credentials and TLS policy stay in Connections.

- [ ] Extensions: list installed and server-available extensions/versions; install, update
  and remove with explicit Apply, dependency warnings and no automatic CASCADE. Installing
  missing server packages is outside the app; availability and permissions are authoritative.
- [ ] Curated settings: inspect effective values and configured defaults, then deliberately
  change/reset useful options such as search_path, timezone, statement timeout and lock timeout.
  Make SQL-session versus database/role-default scope explicit, including new-connection effects.
  Coordinate database timeouts with app-side limits rather than offering ineffective controls.
  No broad ALTER SYSTEM, server filesystem, authentication-file or restart management UI.

### [ ] SQL library: saved snippets and favourites

Save named SQL snippets independently of the per-tab recovery draft. Provide explicit Save,
open, rename, delete, search and heart/favourite actions, with a favourites view/order.
Persist locally and make saved items available across browser tabs; decide database-specific
versus reusable/global scope before implementation. Preserve unfinished editor text when
opening another item and prevent concurrent saves from silently overwriting each other.
Opening a snippet only loads editable SQL—it never executes it or silently changes connections.
Keep sensitive-SQL storage warnings and failures explicit; cloud sharing/sync is not required.

### [ ] SQL templates and examples

Provide a small, first-party collection of useful PostgreSQL examples: common queries,
transactions, schema operations and inspection. Load a copy into the editor, with clear target
placeholders and warnings for destructive examples; never execute on selection. Users can
adapt examples and save them as their own snippets. No copied non-MIT Studio templates,
template engine, or large tutorial surface unless concrete usage calls for it.

### [ ] Evaluate table-level realtime controls

Distinguish our existing Live polling from Supabase Realtime's replication/publication-backed
change delivery. Decide whether the desired feature is faster event-driven grid refresh,
publication membership management for an existing consumer, or both. A publication alone
does not deliver browser updates; LISTEN/NOTIFY alone does not observe arbitrary table writes.

Retain polling until an end-to-end alternative is justified. Assess privileges, required server
configuration, connection lifecycle, missed-event recovery and local-edit protection. Do not
silently add triggers, publications or replication slots, or introduce unbounded WAL retention.
Only expose an Enable realtime action if the corresponding consumer and delivery path exist;
do not add a cosmetic Supabase-style toggle or require Supabase services.

## Outstanding core work

Agreed order: filtered/sorted CSV export, indexes, UNIQUE/CHECK constraints, then foreign keys.
Each feature must pass focused tests and browser checks before the next starts.

- [x] Toolbar CSV exports every matching row in grid order, including exact FK navigation
  constraints, independent of pages/checked rows. Full-table export stays separate. Shared
  validation/query building, streaming snapshots and native operator semantics are covered by
  regression tests. Browser downloads verify exact bytes/order, long filters, errors, guards
  and narrow layouts.
- [x] Table-menu index tools inspect definitions/status and create/drop column-based indexes
  with ordered keys, standard methods and optional uniqueness. Native errors retain drafts;
  explicit Apply, typed drop confirmation, ownership/replica guards and catalog/name-reuse
  fences are verified by PostgreSQL tests and isolated browser QA. Advanced definitions and
  concurrent builds remain SQL-only; concurrent operations need a separate failure model.
- [x] UNIQUE/CHECK tools inspect/create/rename/edit/drop and validate existing checks, with
  explicit Apply, retained native errors and atomic comment-preserving replacement. Native
  expression boundaries, index/catalog identity fences, dependencies/replica identity, deferral
  and NULL semantics are covered by PostgreSQL tests and isolated browser QA. Advanced native
  replacement options remain SQL-only; shared editor Escape/Tab and narrow layouts are verified.
- [x] Edit column embeds a simple UNIQUE checkbox, relevant CHECKs and full FK mappings,
  while table overviews retain every constraint. Composite membership/removal shows the whole
  constraint; column and constraint drafts share one atomic Apply. Native tests, independent
  review and isolated browsers verify rollback, referential actions/validation, target races,
  RI-trigger preservation, permissions, typed removal, retained history, unambiguous identifier
  labels, keyboard handling and narrow layouts.
- [ ] Publish a zero-config CLI launcher: `bunx superbase@latest` starts the local server
  and opens the browser. Bundle production assets and verify the Bun launch path.

## Later / candidates

These capture discussed ideas and existing scope gaps, not commitments to build them all.

- [ ] Roles & permissions workspace: roles, memberships, grants and RLS policies across tables.
  Start with inspection; privilege changes need explicit scope and confirmation. PostgreSQL
  roles are not Supabase Auth users or hosted application authentication.
- [ ] Schema overview: a read-only relationship/ER diagram with navigation to tables.
- [ ] Activity workspace when useful: running queries, open transactions and blocking locks;
  permission-aware cancellation/termination with clear consequences for other sessions.
- [ ] Remaining schema coverage: schema/namespace and enum management, replacing existing PKs,
  and browsing views/materialized views. Design each separately rather than bundling a schema IDE.
- [ ] SQL editor tabs and execution history, if saved snippets and current drafts prove insufficient.
  History must not become an implicit execution/replay or sensitive-data retention mechanism.
- [ ] Nested/OR filters when the current AND-only filter model becomes limiting.
- [ ] Docker distribution alongside the CLI, if needed.

Consider virtualization only if larger pages demonstrate a need.
