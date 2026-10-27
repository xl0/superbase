# Changelog

## [Unreleased]

### Added

- Browser history and shareable links: the database, workspace and table are in the path, and filters, sort, page and followed foreign keys in the hash. Links to a saved connection reconnect to it.
- Views and materialized views in the table editor, read-only; materialized views can be refreshed from their menu.
- Realtime per table (⚡ next to Live, or Database → Realtime): a statement-level trigger notifies via LISTEN/NOTIFY and open table editors refresh at once instead of polling. Superbase's own objects live in the `__superbase` schema. If notifications can't arrive (transaction-mode poolers), the app says so and keeps polling.
- View as role: on RLS tables, the table editor can read and edit rows as another role with session settings, to test policies.
- Database → Policies: row-level security per table (enable, disable, force), policies (create, edit, drop) and table privileges; also as a side panel from the table editor.
- Database → Roles: create, edit and drop roles, including login, password, BYPASSRLS and membership.
- Database → Enums: create, rename, add values to, or drop enum types.
- Database → Schemas: create, rename, change owner or drop schemas. Empty schemas appear in the table editor, ready for a first table.
- Database → Triggers: list triggers with their and their function's definitions; enable, disable or drop them.
- Table definition (⋮ → Definition): a table's or view's DDL rebuilt from the catalogs, ready to copy.
- Database → Activity: client sessions with state, running time, waits and blocking sessions; cancel a query or terminate a session.

### Changed

- Tabs can work on different databases at the same time: the server keeps a connection pool per database, and each request names the database its page shows. A server restart now asks to reload (which reconnects a saved connection) instead of reporting a change in another tab.
- Saving a new connection connects to it right away.
- Array cells copy as JSON, and pasting a JSON array into an array cell converts it (Postgres literals paste as before).
- Performance page laid out like Supabase's: time share bars, min time, role filter, a details panel per statement and CSV export.

### Fixed

- Tab in the filter bar accepts the highlighted column instead of leaving the field.
- Clicks inside the cell editor and other popups are instant on large pages (they restyled the whole page).

## [0.2.0] - 2026-10-25

### Added

- A live demo that runs PostgreSQL in the browser (PGlite) on sample data, published to GitHub Pages.
- Schema diagram (Database → Schema): tables, columns and foreign keys of one schema, laid out automatically; ↗ opens a table.

### Changed

- Array values are shown and edited as JSON (`["a","b"]`), like Supabase; numbers keep their exact spelling.
- Database sections (schema, indexes, performance, extensions, configuration) moved from top tabs into the side panel.
- The SQL editor's snippet panel is resizable; all workspaces share one side panel width.

## [0.1.1] - 2026-10-25

### Added

- Docker image (`ghcr.io/xl0/superbase`, Docker Hub) for running the app pinned to one database behind your own auth.
- README screenshots of the main features.

### Fixed

- Column headers keep the column name visible before its type in narrow columns.
- The schema breadcrumb no longer truncates short schema names.
- Underscores render in monospace inputs.

## [0.1.0] - 2026-10-25

### Added

- First release: `npx @xl0/superbase` starts a local Postgres table editor, schema editor (previewed SQL), SQL editor with snippets and examples, and a database workspace with indexes, query performance, extensions and configuration.
