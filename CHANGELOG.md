# Changelog

## [Unreleased]

### Added

- A live demo that runs PostgreSQL in the browser (PGlite) on sample data, published to GitHub Pages.

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
