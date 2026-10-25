# superbase — plan

## Intent

A small Postgres table editor with the useful parts of Supabase Studio's UX and none of its
platform. Two uses: run locally (`bunx`/`npx`) against your own databases, or deploy in
Docker/k8s as a viewer pinned to one database behind external auth.

Preserve values exactly; never silently drop edits or write to the wrong database. Otherwise
favor the simplest thing that works: the user already has full SQL, so forms generate SQL and
PostgreSQL validates. Keep code and tests minimal.

## Done

- Table editor: exact values, cell/range/paste edits with optimistic row-version conflicts,
  insert form, FK picker/navigation, filters, multi-sort, live polling, CSV export.
- Schema editing via previewed SQL: tables, columns, PK, indexes, UNIQUE/CHECK/FK.
- SQL console with per-tab sessions, transactions, cancel, autosaved draft; snippet library with
  favourites and built-in examples (adapted from Supabase Studio, Apache-2.0).
- Database workspace: all indexes (drop), query performance (pg_stat_statements), extensions (enable/update/disable) and curated
  database/role defaults, as previewed SQL.
- Connections: global server connection, saved browser profiles, SSL modes, locked mode via
  `DATABASE_URL`, `HOST`/`ORIGIN` for container deployments.
- Simplification pass (Oct 2026): removed per-browser sessions, validation layer, DDL
  fingerprints/fences, copy-schema SQL, auto-reconnect and draft-ownership machinery.

## TODO

- [ ] CLI launcher: `bunx superbase` / `npx superbase` starts the server and opens the browser.
  Needs runtime deps in `dependencies`, a `bin`, bundled build output, and a Node-only path.
- [ ] Docker image for the locked/viewer mode (document `DATABASE_URL`, `HOST`, `ORIGIN`).

## Later / maybe

- Read-only mode for the viewer deployment (would need SQL console restrictions).
- Roles/grants/RLS inspection; schema relationship diagram; activity (running queries, locks).
- Views; enum/schema management; nested/OR filters; virtualization if large pages need it.
- Event-driven refresh instead of polling, only with a real delivery path.
