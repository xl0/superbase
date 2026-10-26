# Changelog

## [Unreleased]

### Added

- Browser history and shareable links: the database, workspace and table are in the path, and filters, sort, page and followed foreign keys in the hash. Links to a saved connection reconnect to it.

### Fixed

- Tab in the filter bar accepts the highlighted column instead of leaving the field.

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
