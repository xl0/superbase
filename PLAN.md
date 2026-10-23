# superbase — plan

## Intent

A standalone Postgres table editor with the feel of Supabase Studio's editor, but as one
small app that connects to a database directly. No self-hosted Supabase stack, no PostgREST,
no auth service. SvelteKit front to back. MIT.

Two principles:

- The browser asks the server to do things (structured intents); the server builds and runs
  the SQL. No client-built SQL strings.
- The grid is the product. Everything else exists to support it.

## Now

Build and validate the table editor against mock data, then swap the data source for a real
Postgres. The UI must be honest about what the DB will actually do.

## TODO

## [x] Project setup

SvelteKit 3 + Svelte 5 + Tailwind v4 + adapter-node. `#lib` subpath imports. MIT license.

## [x] Mock data and editor shell

Deterministic mock tables (users/posts/comments/organizations/events), sidebar, toolbar,
pagination, definition tab.

## [~] Grid MVP

- [x] Sticky header, fixed rows, row numbers, per-type rendering (NULL, bool, number, JSON,
  array, timestamp, UUID)
- [x] Keyboard navigation (arrows/Tab/Enter/Escape/Home/End/PageUp/Down), type-to-edit
- [x] Range selection, select-all, copy/paste TSV, delete
- [x] Inline editors (text/number, enum and boolean selects)
- [x] Dirty overlay, revert/save, insert row
- [x] Header sort, drag-to-resize with persisted widths
- [ ] Row selection + delete selected rows
- [ ] Column filters / "where" bar
- [ ] Virtualization (only if page sizes above ~500 need it)
- [ ] Optimistic edit batching (one transaction per save)

## [ ] Real database

- [ ] `pg` pool + `/query`-style server module, `DATABASE_URL` from env
- [ ] Structured intents over remote functions: `tables()`, `tableMeta()`, `rows()`,
  `saveRows()`, `sql()`
- [ ] Catalog SQL adapted from pg-meta (MIT) for tables, columns, PK/FK/index metadata
- [ ] Connection handling: env default, paste-a-URL connect session (HttpOnly cookie → pool map)
- [ ] Type generation? (later)

## [ ] Desktop / packaging

Docker image first (`adapter-node`). Tauri + Bun sidecar only if the web app is good.
