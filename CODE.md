# superbase — code map

A standalone Postgres table editor built with SvelteKit 3 (Svelte 5 runes), Tailwind v4.
Currently UI-only, driven by mock data.

## Runtime shape

Single page app (`ssr = false`). One route, `/`, renders the editor shell. State lives in a
module-level `EditorState` instance; the grid keeps its own focus/selection/editing state.

```
+layout.svelte          imports app.css, favicon, title
+page.svelte            Sidebar | (TableToolbar, DataGrid|TableDefinition, GridFooter)
```

## Key modules

- `lib/types.ts` — Column/Table/Row/Sort. `Row.__key` is the stable row identity used by the
  edit overlay. Column carries both `type` (display) and `kind` (render/edit behaviour).
- `lib/data/mock.ts` — deterministic rows from a seeded PRNG. Tables: public.users/posts/
  comments/organizations, analytics.events. Rows are generated once per table and cached.
- `lib/state/editor.svelte.ts` — active schema/table, page, sort, search, edit overlay.
  Edits are scoped per table: `edits[tableKey][rowKey][column] = value`. New rows are tracked
  so "Revert" removes them. Sorting/filtering/pagination happen in memory (mock only).
- `lib/components/DataGrid.svelte` — the core. Div-based grid (not `<table>`), fixed 30px rows,
  sticky header + row-number column, per-column widths persisted with `PersistedState`.
  Focus is `{r,c}` state; one `keydown` listener on the scroll container; selection is
  anchor/head. Editing mounts a single input/select in the focused cell. Supports arrows,
  Tab, Enter/F2, Escape, Home/End, PageUp/Down, Delete, type-to-edit, Cmd+A, copy/paste TSV,
  header sort, and pointer-drag column resize.
- `lib/components/Sidebar.svelte` — schema select + table search/list.
- `lib/components/TableToolbar.svelte` — breadcrumb, tabs, insert, revert/save, refresh.
- `lib/components/GridFooter.svelte` — range, page size, paging.
- `lib/components/TableDefinition.svelte` — read-only column list (Definition tab).
- `lib/format.ts` — NULL/number/timestamp/json/array display.

## Conventions

- SvelteKit 3 uses Node subpath imports: `#lib/foo.js` (extension required; `.svelte.ts`
  state files are imported as `#lib/state/editor.svelte.js`).
- Dark theme tokens are defined in `app.css` under `@theme` and consumed as Tailwind
  utilities (`bg-surface`, `text-muted`, `border-line`, ...). Grid-specific CSS is scoped in
  the component.
- Editing writes to the overlay immediately; nothing touches the underlying rows until Save.

## Not there yet

- No server, no `pg`, no remote functions. Mock data is the only source.
- No row selection/deletion, no filters beyond the sidebar search (which is local to the
  sidebar), no column editing, no FKs picker, no virtualization (pages cap at 500 rows).
