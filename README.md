# superbase

A standalone Postgres table editor. The same grid you know from Supabase Studio, without the
self-hosted stack: one process, one database connection.

**Status:** UI shell running on deterministic mock data. The database layer comes next.

## Stack

- SvelteKit 3 (Svelte 5, runes) — SPA mode, no SSR
- Tailwind CSS v4
- `runed` for small Svelte utilities
- `lucide-svelte` for icons

## Develop

```sh
bun install
bun run dev
bun run check
```

## Layout

- `src/lib/components/` — shell, sidebar, toolbar, grid, definition view
- `src/lib/state/editor.svelte.ts` — editor state (selection lives in the grid)
- `src/lib/data/mock.ts` — deterministic tables/rows until the server exists
- `src/lib/format.ts` — value display helpers
