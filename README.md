# superbase

A Postgres table editor in the spirit of Supabase Studio, without the Supabase stack.
Browse and edit rows, change schemas through previewed SQL, follow foreign keys, run SQL,
manage indexes and extensions, and find slow queries. One command, any Postgres. MIT licensed.

![Table editor with a filter and sort applied](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/table-editor.png)

## Run it

Requires Node 22+.

```sh
npx @xl0/superbase                # or: bunx @xl0/superbase
npx @xl0/superbase postgres://…   # pin to one database
npx @xl0/superbase --port 4000 --no-open
```

It serves on http://127.0.0.1:3000 (or the next free port) and opens your browser. Click
**Choose connection → Add connection**, paste a `postgres://` URL and pick an SSL mode (a pasted
`sslmode=` moves into the SSL selector). **Save** keeps the connection in this browser's
localStorage, password included and unencrypted; **Connect** connects without saving. After a
restart the app reconnects to the saved connection you used last.

The server holds one database connection shared by every tab. It listens on 127.0.0.1 and
refuses requests whose Host is not localhost, so other websites can't drive it.

From a checkout: `bun install --frozen-lockfile && bun run build && bun run start`.

## Run as a database viewer (Docker / Kubernetes)

```sh
docker run -p 127.0.0.1:3000:3000 -e DATABASE_URL=postgres://user:pass@db:5432/app ghcr.io/xl0/superbase
```

```yaml
# docker-compose.yml
services:
  superbase:
    image: ghcr.io/xl0/superbase       # or build: https://github.com/xl0/superbase.git
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
      ORIGIN: https://db.example.com   # the public URL, when behind a TLS proxy
    ports: ["127.0.0.1:3000:3000"]     # expose through your auth proxy, not directly
```

`DATABASE_URL` pins the app to one database; connection switching disappears. The image
listens on all interfaces (`HOST=0.0.0.0`), which disables the localhost check, so put it behind
your own authentication (e.g. an auth proxy) and set `ORIGIN` to the public URL. Anyone who can
open the app can do everything the database role can, including arbitrary SQL — choose the role
accordingly.

## Table editor

- Filters (column, comparison, value) combine with AND; **Sort** takes several columns in
  priority order; clicking a header cycles its sort.
- Double-click a cell, or press Enter/F2, to edit; **Apply** or Ctrl/Cmd+Enter saves. Text and
  JSON get a code editor, and values are never rounded or reformatted. **Set to** offers NULL,
  Now and empty text.
- Foreign-key cells open a record picker; the arrow jumps to the referenced row.
- Arrow keys and Shift select ranges; copy/paste uses TSV (`\N` is NULL) and saves in one
  transaction. **Insert row** opens a form where empty fields use the column default.
- Concurrent edits conflict instead of overwriting: rows are matched by primary key and
  version. Tables without a primary key are read-only until you add one.
- **Live** re-reads the visible page every five seconds without disturbing your edits.
- The download button exports all rows matching the filters as CSV, in grid order.

![Editing a JSON cell](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/cell-editor.png)

![Choosing a referenced customer for an order](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/reference-picker.png)

## Schema editing

The sidebar **+** creates tables, column header menus edit or delete columns, and each table's
**⋮** menu renames, duplicates, deletes, manages indexes and constraints (UNIQUE, CHECK,
foreign keys) and adds a missing primary key.

Every form shows the SQL it will run. **Apply** runs it in one transaction with a 3-second lock
timeout; errors keep the form open. Deleting a table or column requires typing its name.
Anything more advanced belongs in the SQL editor.

![Editing a column with its SQL preview](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/schema-editor.png)

## SQL editor

**Run** (Ctrl/Cmd+Enter) sends the selection, or the whole buffer, unchanged to a dedicated
session for this tab: SET, temporary tables and transactions persist between runs, with
Commit/Rollback buttons while a transaction is open. Results preview up to 1,000 rows per
statement. Autocomplete knows your schemas, tables and columns.

The left panel holds saved snippets (Ctrl/Cmd+S), favourites and built-in examples. Opening one
only loads its text; nothing runs until you press Run.

![SQL editor with snippets and results](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/sql-editor.png)

## Database

- **Indexes:** every index per schema, with definitions; drop with a preview.
- **Performance:** the most expensive statements from `pg_stat_statements`, sortable, with
  cache hit rates; enables the extension for you if it's missing (the server must preload it).
- **Extensions:** enable (choosing the schema), update or disable.
- **Configuration:** search_path, timezone, timeouts and work_mem as database or role defaults.

![Query performance](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/performance.png)

---

Not affiliated with Supabase. Most built-in SQL examples are adapted from Supabase Studio
(Apache-2.0, see [licenses/supabase-apache-2.0.txt](licenses/supabase-apache-2.0.txt)).
Development and architecture: [CODE.md](CODE.md).

---

Like this work? [Hire me](https://alexey.work/cv?ref=superbase)
