# superbase — plan

## Intent

Build a small, local-only Postgres table editor with the useful parts of Supabase Studio's
UX, without its platform dependencies. Keep SvelteKit, direct server-owned SQL, and a custom
spreadsheet grid. Reuse shadcn-svelte for standard UI instead of maintaining equivalents.

Preserve PostgreSQL values exactly. Navigation, background refreshes, and connection changes
must never silently discard edits or send them to a different target. Favor simple, readable
solutions; add infrastructure only when a concrete feature needs it.

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
sit beside the table name. The separate Definition view is removed. Browser checks verify
explicit Apply, confirmations, metadata access, focus restoration, sorting, protected drafts,
clipboard boundaries and zero-column tables. Narrow filter/pagination controls fit the viewport.

[x] Schema forms use searchable base types with integer size, timezone, array and validated
length/precision/scale options. Type-specific defaults/literal editors preserve drafts and exact
existing definitions; incompatible choices block Apply without resets. SQL previews, native
round-trips, lossless defaults, custom types, keyboard flows and narrow layouts are verified.

For these items, completion includes focused regression tests and browser checks, not just
rendered controls. Keep CODE.md and user-facing documentation aligned with actual behavior.

## Later

- [ ] SQL editor with an explicit connection lifecycle.
- [ ] Publish a zero-config CLI launcher: `bunx superbase@latest` starts the local server
  and opens the browser. Bundle production assets and verify the Bun launch path.

Consider virtualization only if larger pages demonstrate a need.
