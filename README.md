# superbase

A small, standalone Postgres table editor inspired by Supabase Studio. One local process,
no Supabase stack. SvelteKit 3, Svelte 5, shadcn-svelte, Tailwind v4, and `pg`. MIT.

Browse schemas and tables, edit cells, insert/delete rows, sort, filter, and copy/paste
rectangular selections. Changes stay local until **Save**; deletion has its own confirmation.

## Run locally

Requires Node 24+ and Bun.

```sh
bun install --frozen-lockfile
bun run dev                 # http://127.0.0.1:5173
```

Paste a connection string on the welcome screen. Use **Change connection** in the sidebar
to switch databases, disconnect, or return to the optional environment default.

For a local Postgres without TLS:

```text
postgresql://postgres:postgres@127.0.0.1:55433/postgres?sslmode=disable
```

Browser connections use TLS without certificate verification by default (`sslmode=require`).
Check **Verify server certificate** to set `sslmode=verify-full`; the checkbox reflects the URL.
`sslmode=disable` explicitly disables TLS and the verification checkbox. There is no automatic
plaintext fallback. Without verification, TLS encrypts traffic but does not authenticate the server.
Other browser URL options, including server certificate-file paths, are rejected.
Credentials containing URL punctuation must be percent-encoded.

An optional default can be configured in `.env`:

```sh
cp .env.example .env
```

No database handy?

```sh
docker run -d --name superbase-db -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:55433:5432 postgres:18.3-alpine
docker exec -i superbase-db psql -U postgres < dev/seed.sql
```

### Production build, still local-only

```sh
bun run build
bun run start               # http://127.0.0.1:3000
# PORT=4000 bun run start
```

Use `bun run start`, not `node build`: `server.mjs` binds loopback and supplies the actual
HTTP scheme to adapter-node without trusting forwarded headers. CSRF checks remain enabled.

**Do not expose this app to the network or put it behind a public reverse proxy.** It is a
local administration tool, not a multi-user hosted service. Requests must have both a
loopback socket peer and a localhost/loopback Host header. Proxy address/host/port header
configuration is prohibited.
The database role determines what the editor can read and write; prefer a least-privilege role.

## Editing semantics

- Values use PostgreSQL's exact text format. Big integers, decimals, timestamps, JSON, and
  arrays are not converted through JavaScript numbers/dates. Enter JSON as JSON and arrays
  as PostgreSQL array literals, e.g. `{"a,b","",NULL}`.
- New rows start with **DEFAULT** (omitted column). **Set NULL**, **Empty text**, and
  **Use default** are distinct actions. Generated/always-identity columns are read-only.
- Edits and row selections survive pagination and table switching. Save affects the current
  table, including its off-page edits. Navigation/editing are blocked while a mutation runs.
- Concurrent changes produce a conflict, not a silent overwrite. A failed batch rolls back
  completely and keeps pending edits. Revert and refresh to start from the latest data.
- Tables without a primary key are read-only. Physical row addresses are never used as a
  substitute primary key for writes.
- Arrow keys navigate; Enter/F2 edits; Escape cancels; Shift+Enter adds a newline.
  Tab finishes an edit, then moves through controls. Shift+Space selects a row.
  Shift-click/arrows extend a range; Ctrl/Cmd+A selects the loaded page's cells.
- Clipboard data is quoted TSV: tabs/newlines/quotes round-trip. Unquoted `\N` means SQL
  NULL and `\D` means DEFAULT; literal marker strings are quoted. Paste never silently
  truncates data outside the loaded grid.
- Table row counts are estimates. Pagination fetches one extra row instead of
  running a full-table count. Filtering uses `ILIKE` across columns and can be expensive.

## Connections

Credentials and pools stay in server memory. The browser has an opaque HttpOnly cookie;
a separate public connection generation accompanies every database request. A stale tab
cannot write to a connection selected in another tab. Expired sessions never silently fall
back to `DATABASE_URL`.

Disconnect is explicit, including when an environment default exists. Sessions expire after
two idle hours or a process restart. Switching connections warns about unsaved work across
all tables. There is no persistent credential storage, connection history, or multi-process
session sharing. The registry allows 32 browser sessions and 8 simultaneous connection tests.

## Checks

```sh
bun run check
bun run test                # state, values, validation and connection lifecycle
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55433/postgres bun run test
bun run test:production     # builds, then tests real HTTP commands and origin/Host checks
```

Postgres tests require an explicit `TEST_DATABASE_URL`, create a uniquely named schema, and
remove it afterward. They never default to your application database URL. Use a disposable DB.

## Layout

- `src/lib/types.ts` — lossless cells, row identities, connection and mutation contracts
- `src/lib/state/editor.svelte.ts` — browser workspace and pending edits
- `src/lib/components/` — editor shell and custom spreadsheet grid
- `src/lib/components/ui/` — generated MIT shadcn-svelte components
- `src/lib/db.remote.ts`, `validation.ts` — validated remote boundary
- `src/lib/server/` — connection lifecycle, metadata and transactional SQL
- `src/app.css`, `components.json` — shared Studio-inspired theme and shadcn configuration

Schema editing, column-specific filters, and a SQL editor are not implemented yet.
