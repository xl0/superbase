# Changelog

## [Unreleased]

### Added

- Browser history and shareable links: the database, workspace and table are in the path, and filters, sort, page and followed foreign keys in the hash. Links to a saved connection reconnect to it.
- Views and materialized views in the table editor, read-only; materialized views can be refreshed from their menu.
- Realtime per table (⚡ next to Live; realtime tables are marked ⚡ in the table list): a statement-level trigger notifies via LISTEN/NOTIFY and open table editors refresh at once instead of polling. Superbase's own objects live in the `__superbase` schema; dropping it (Database → Schemas, cascade) removes them all. If notifications can't arrive (transaction-mode poolers), the app says so and keeps polling.
- View as role: on RLS tables, the table editor can read and edit rows as another role with session settings, to test policies.
- Database → Policies: row-level security per table (enable, disable, force), policies (create, edit, drop) and table privileges; also as a side panel from the table editor.
- Database → Roles: create, edit and drop roles, including login, password, BYPASSRLS and membership.
- Database → Enums: create, rename, add values to, or drop enum types.
- Database → Schemas: create, rename, change owner or drop schemas. Empty schemas appear in the table editor, ready for a first table.
- Database → Triggers: list triggers with their and their function's definitions, and drop them.
- Table definition (⋮ → Definition): a table's or view's DDL rebuilt from the catalogs, ready to copy.
- Database → Activity: client sessions with state, running time, waits and blocking sessions; cancel a query or terminate a session.
- Database → Configuration shows and edits role-in-database settings (`alter role … in database … set`), which win over database and role defaults.
- Pasting one value into a selected range fills the range.

### Changed

- Tabs can work on different databases at the same time: the server keeps a connection pool per database, and each request names the database its page shows. A server restart now asks to reload (which reconnects a saved connection) instead of reporting a change in another tab.
- Saving a new connection connects to it right away.
- Array cells copy as JSON, and pasting a JSON array into an array cell converts it (Postgres literals paste as before).
- `json[]`/`jsonb[]` cells show and edit the Postgres literal: as JSON, a nested array could be a dimension or a document, and multi-dimensional values were saved back flattened.
- Performance page laid out like Supabase's: time share bars, min time, role filter, a details panel per statement and CSV export.
- CSV export is one toolbar button: choose columns, then download the rows matching the grid's filters in grid order. The table menu no longer exports.
- Editing a constraint edits its full definition as PostgreSQL prints it, so clauses the form doesn't show (DEFERRABLE, NOT VALID, NULLS NOT DISTINCT, INCLUDE…) are kept; a new name alone renames it.
- Connection URLs are used as typed: every option reaches the driver, and `sslmode` has its libpq meaning, also in `DATABASE_URL` (no `sslmode` means `prefer`, as in psql). The SSL select and a new channel-binding checkbox just edit the URL. Saved connections from earlier versions keep their URL but lose their separate SSL choice: pick it again.
- The SQL console has no statement or idle-in-transaction timeouts of its own (use Cancel); an idle session still closes after 15 minutes.
- Column type changes are marked destructive. Toggling Array converts values (`x` ↔ `{x}`, refusing arrays that don't hold exactly one element) and drops a default that can't be converted.
- Live updates keep applying while a cell is selected, and changes held during an edit apply as soon as it ends.

### Fixed

- Tab in the filter bar accepts the highlighted column instead of leaving the field.
- Clicks inside the cell editor and other popups are instant on large pages (they restyled the whole page).
- Saved connections whose URL leaves out the user, port or database (or uses an IPv6 host) reconnect after a server restart, and opening `/` no longer hangs on them.
- Editing a role changes only the attributes you changed, so admins without superuser (PostgreSQL 16+) can edit roles.
- With port 3000 taken, the launcher printed and opened :3000 as well as the port it actually used.
- Schema forms (indexes, constraints, edit column) always read the current table definition.
- Resetting query statistics works when pg_stat_statements is installed in a schema outside the search path.
- Enums count array columns (`mood[]`) among the columns using them.
- Docker images install `pg` and its dependencies at the lockfile's versions.
- Duplicating a table with its rows no longer restarts identity columns at 1 when the source is empty (or fails with a higher minimum); it also copies columns added since the table list was loaded.
- "Set to Now" is no longer offered for date/time arrays.
- Refreshing the table list, or changes made on Database pages, no longer send the table editor back to page 1 and blank the grid.
- The SQL console says when results or messages beyond the first 50 were left out.
- The column form: unticking Primary key restores the previous Allow NULL choice, and turning a column into an array drops an identity or preset default that no longer fits.
- Connecting with a wrong password to a database the server already has open fails instead of reusing the open connection; new working credentials replace it.
- Tables and schemas whose names contain `/`, `#`, `?` or `%` open correctly from links.
- LIKE/ILIKE filters work on non-text columns; `json` columns compare as text.
- Revoking a role membership that another role granted works on PostgreSQL 16+.
- Constraints: exclusion constraints can be edited and dropped; inherited constraints and a foreign key's copies for partitions are no longer listed, and table definitions with such a key run again.
- Duplicate copies only an inheritance parent's own rows; enum usage counts include domains and count partitions once.
- `json` cells keep their text as written when edited; pasting text that starts with a quote no longer fails; names over 63 bytes are refused instead of silently truncated.
- SQL console: DDL refreshes the table list and autocomplete, cancelled statements leave no empty result, and the "earlier commits" warning appears only when it applies.
- Links with sorts or filters on unknown columns open with those dropped; Enter no longer adds line breaks in number or date cells; the active cell stays put after a save; keyboard focus is no longer lost after navigation, removing a filter or sorting.
- Smaller form and dialog fixes: RLS badge, policy edit and drop dialogs, varchar length and the Array checkbox while keeping a type, dialog spacing, stale dialog errors.

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
