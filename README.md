# superbase

A standalone Postgres table editor. The same grid you know from Supabase Studio, without the
self-hosted stack: one process, one database connection.

**Status:** connects to a real Postgres. Table browsing, editing, inserting, deleting, sorting,
and filtering work. The SQL editor and a connect dialog are next.

## Stack

- SvelteKit 3 (Svelte 5, runes) — SPA mode, no SSR
- Tailwind CSS v4
- `runed` for small Svelte utilities
- `lucide-svelte` for icons

## Develop

```sh
bun install
cp .env.example .env      # point DATABASE_URL at any Postgres
bun run dev
bun run check
```

No database handy? Start one and seed it:

```sh
docker run -d --name superbase-db -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:18-alpine
docker exec -i superbase-db psql -U postgres < dev/seed.sql
# DATABASE_URL=postgresql://postgres:postgres@localhost:55433/postgres
```

## Layout

- `src/lib/components/` — shell, sidebar, toolbar, grid, definition view
- `src/lib/state/editor.svelte.ts` — editor state (selection lives in the grid)
- `src/lib/db.remote.ts` — typed remote functions (queries and commands)
- `src/lib/server/db.ts` — pg pool, catalog metadata, paged rows, transactions
- `src/lib/format.ts` — value display helpers
