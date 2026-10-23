# superbase — plan

## Intent

A small, standalone Postgres table editor. SvelteKit + direct `pg`, no Supabase services.
The server owns SQL. The grid must never silently change a value or mutation target.

## [x] Safe editor and browser connections

Lossless text cells, isolated row metadata, optimistic transactional writes, immutable pending
batches, and connection generations replace the prototype's unsafe mutation assumptions.
Keyless tables are read-only. Runtime-validated remotes have no arbitrary-SQL endpoint.

Browser connect/change/disconnect/default flows are complete, with server-memory credentials,
fail-closed sessions, masked URLs, and unsaved-work protection. Both development and production
are loopback-only. Production HTTP retains CSRF checks. Browser TLS verification is opt-in
through a URL-backed checkbox; explicit plaintext connections remain supported.

shadcn-svelte is initialized and used for standard controls/dialogs; the custom grid shares
its Studio-inspired theme. Keyboard editing, exact clipboard round-trips, selection bounds,
and cross-page edits/selections are covered. Metadata is cached with deliberate refresh;
pagination avoids full-table counts and filtering is debounced.

State, value, validation, connection, PostgreSQL, and production-HTTP regression tests are in
place. Browser checks cover layouts, keyboard editing, CRUD/defaults, connection switching,
stale-tab rejection, and operation without an environment default.

## Later

- [ ] Schema editing and column-specific filters.
- [ ] SQL editor with an explicit connection lifecycle.
- [ ] Docker packaging that preserves the local-only boundary.
- [ ] Virtualization only if larger pages justify it.
