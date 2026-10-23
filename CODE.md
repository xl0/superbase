# superbase — code map

A standalone Postgres table editor built with SvelteKit 3 (Svelte 5 runes), Tailwind v4.
Talks to Postgres through typed remote functions backed by a `pg` pool.

## Runtime shape

Single page app (`ssr = false`). One route, `/`, renders the editor shell. State lives in a
module-level `EditorState` instance; the grid keeps its own focus/selection/editing state.

Flow: `src/env.ts` declares `DATABASE_URL` (dynamic private) → `lib/db.remote.ts` exposes
one `query` (`database`, `tableRows`) and commands (`saveTable`, `deleteRows`, `executeSql`)
→ `lib/server/db.ts` runs the SQL. The client never builds SQL.

```
+layout.svelte          imports app.css, favicon, title
+page.svelte            Sidebar | (TableToolbar, DataGrid|TableDefinition, GridFooter)
```

## Key modules

- `lib/types.ts` — Column/Table/Row/Sort. `Row.__key` is the stable row identity used by the
  edit overlay. Column carries both `type` (display) and `kind` (render/edit behaviour).
- `lib/server/db.ts` — lazy `pg` pool from `DATABASE_URL`; catalog queries for tables,
  columns, enums and FKs; paged reads with `count(*)` and PK ordering; updates/inserts in a
  transaction; deletes; `runSql` for the SQL editor. Row identity is the primary key, or
  `ctid` for tables without one. Type parsers keep int8 as safe numbers and timestamps as
  strings, matching what the grid expects.
- `lib/db.remote.ts` — typed remote functions. `database()` returns tables + server info;
  `tableRows()` is a query keyed by schema/table/page/sort/search (refreshed after writes);
  `saveTable()` and `deleteRows()` are commands.
- `lib/state/editor.svelte.ts` — active schema/table, page, sort, search, server rows,
  edit overlay, drafts, row selection. Edits and drafts are scoped per table. Every
  navigation action (`fetch`) calls `tableRows`; saves send one command and refetch.
  `#request` guards against out-of-order responses.
- `lib/components/DataGrid.svelte` — the core. Div-based grid (not `<table>`), fixed 35px rows,
  sticky header + row-number column, per-column widths persisted with `PersistedState`.
  Focus is `{r,c}` state; one `keydown` listener on the scroll container; selection is
  anchor/head. Editing mounts a single input/select in the focused cell. Supports arrows,
  Tab, Enter/F2, Escape, Home/End, PageUp/Down, Delete, type-to-edit, Cmd+A, copy/paste TSV,
  header sort, and pointer-drag column resize. The 64px gutter holds row selection checkboxes
  plus the row number; the header checkbox selects the page.
- `lib/components/Sidebar.svelte` — schema select + table search/list.
- `lib/components/TableToolbar.svelte` — breadcrumb + tabs; actions row with insert, delete,
  refresh, sort select, and row filter.
- `lib/components/GridFooter.svelte` — range, page size, editable page number.
- `lib/components/TableDefinition.svelte` — read-only column list (Definition tab).
- `lib/format.ts` — NULL/number/timestamp/json/array display.

## Server error surface

`src/hooks.server.ts` returns the real error message from `handleError`, so connection
failures and constraint violations reach the UI instead of "Internal Error".

## Conventions

- SvelteKit 3 uses Node subpath imports: `#lib/foo.js` (extension required; `.svelte.ts`
  state files are imported as `#lib/state/editor.svelte.js`).
- Dark theme tokens are defined in `app.css` under `@theme` and consumed as Tailwind
  utilities (`bg-surface`, `text-muted`, `border-line`, ...). Grid-specific CSS is scoped in
  the component.
- Editing writes to the overlay immediately; nothing touches the underlying rows until Save.

## Not there yet

- Connection is `DATABASE_URL` only; no connect dialog or per-session URLs.
- No row selection persistence across pages, column editing, FK picker, or SQL editor UI
  (`executeSql` exists but is unused).
- No virtualization; pages cap at 500 rows. No metadata cache, so each page fetch runs the
  catalog queries again.
