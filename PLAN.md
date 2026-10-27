# superbase — plan

## Intent

A small Postgres table editor with the useful parts of Supabase Studio's UX and none of its
platform. Two uses: run locally (`bunx`/`npx`) against your own databases, or deploy in
Docker/k8s as a viewer pinned to one database behind external auth.

Preserve values exactly; never silently drop edits or write to the wrong database. Otherwise
favor the simplest thing that works: the user already has full SQL, so forms generate SQL and
PostgreSQL validates. Keep code and tests minimal.

## Done

- Table editor: exact values (arrays shown/edited as JSON), cell/range/paste edits with optimistic
  row-version conflicts, insert form, FK picker/navigation, filters, multi-sort, live polling, CSV export.
- Realtime per table: notify trigger (`__superbase`) → LISTEN → SSE; falls back to polling when
  notifications don't arrive (transaction-mode poolers).
- Schema editing via previewed SQL: tables, columns, PK, indexes, UNIQUE/CHECK/FK.
- SQL console with per-tab sessions, transactions, cancel, autosaved draft; snippet library with
  favourites and built-in examples (adapted from Supabase Studio, Apache-2.0).
- Database workspace: schema diagram, all indexes (drop), query performance (pg_stat_statements),
  activity (sessions, blockers, cancel/terminate), extensions (enable/update/disable), curated
  database/role defaults, enums, RLS policies, table privileges and roles, schemas, triggers (drop),
  as previewed SQL through one shared dialog; table/view definitions.
- Layout: left rail with three workspaces sharing one resizable side panel.
- CLI: `npx|bunx @xl0/superbase [url] [--port] [--host] [--no-open]` (unscoped name rejected by npm).
- Live demo: static build with PGlite in the browser on sample data (GitHub Pages).
- Releases: `bun run release` → CI stages npm (2FA approve), pushes ghcr.io/xl0/superbase and
  xl0xl0/superbase images and creates the GitHub Release. The demo deploys from master on every push.
- Connections: a server pool per database (requests name it), saved browser profiles, SSL modes,
  locked mode via `DATABASE_URL`, `HOST`/`ORIGIN` for container deployments.
- Simplification passes (Oct 2026): removed per-browser sessions, validation layer, DDL
  fingerprints/fences, copy-schema SQL, auto-reconnect and draft-ownership machinery; then the
  Realtime page, trigger enable/disable, table-menu CSV export and form-based constraint edits.

## TODO

- [ ] Review leftovers: count `enum[]` columns as enum users; Dockerfile installs `pg` without
  the lockfile.

## Later / maybe

- Read-only mode for the viewer deployment (would need SQL console restrictions).
- Schema diagram editing: drag column→column to open the FK form prefilled; table menu on cards.
- Nested/OR filters.
- Functions page (list, read source, drop), like Triggers.
- Load-over-time charts: sample pg_stat_database/pg_stat_statements counters in the server
  process (in-memory ring buffer, no database objects); history only while the server runs.
- AI assistant in the SQL editor (shelved): pi-agent-core loop and tools in the browser
  (schema, run SQL with per-call approval, edit buffer). Model calls go direct with a
  browser-stored API key, or, when bound to loopback, through a server `/api/stream`
  (`streamProxy`) using pi's auth.json so subscriptions work.
