# superbase

A Postgres table editor in the spirit of Supabase Studio, without the Supabase stack.
Browse and edit rows, change schemas through previewed SQL, follow foreign keys, run SQL,
manage indexes and extensions, and find slow queries. One command, any Postgres. MIT licensed.

**[Try the live demo](https://xl0.github.io/superbase/)**: PostgreSQL runs in your browser (PGlite) on
sample data, so nothing leaves your machine and a reload starts over.

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

The address bar follows you: database, workspace, table, filters and sort, so Back and Forward
work and views can be bookmarked or shared. The database appears only as a short hash of its
host, port, name and user; opening a link reconnects the matching saved connection.

Each tab works on the database in its URL, so tabs on different databases don't interfere. The
server listens on 127.0.0.1 and refuses requests whose Host is not localhost, so other websites
can't drive it.

From a checkout: `bun install --frozen-lockfile && bun run build && bun run start`.

## Run as a database viewer (Docker / Kubernetes)

```sh
docker run -p 127.0.0.1:3000:3000 -e DATABASE_URL=postgres://user:pass@db:5432/app xl0xl0/superbase
```

The same image is on GitHub's registry as `ghcr.io/xl0/superbase`.

```yaml
# docker-compose.yml
services:
  superbase:
    image: xl0xl0/superbase            # or build: https://github.com/xl0/superbase.git
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
  JSON get a code editor; arrays are shown and edited as JSON. Values are never rounded. **Set to** offers NULL,
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

The side panel lists the sections:

- **Schema:** a diagram of one schema's tables and foreign keys (including references to other
  schemas); ↗ opens a table.
- **Enums:** create enum types, rename them or their values, add values, or drop them.
- **Indexes:** every index per schema, with definitions; drop with a preview.
- **Performance:** the most expensive statements from `pg_stat_statements`: share of total time,
  calls, max/mean/min time, rows and cache hit rate, sortable and filterable by role, with a
  details panel per statement and CSV export; enables the extension for you if it's missing (the
  server must preload it).
- **Activity:** live overview (connections against `max_connections`, active, idle in transaction,
  blocked, top blocker, longest running) and the database's sessions with state, duration, waits
  and blockers; filter by state, role, application or root blockers, hover a query to read it,
  and cancel or terminate a session with a preview.
- **Extensions:** enable (choosing the schema), update or disable.
- **Configuration:** search_path, timezone, timeouts and work_mem as database or role defaults.

![Schema diagram of the shop tables](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/schema-diagram.png)

![Query performance](https://raw.githubusercontent.com/xl0/superbase/master/docs/screenshots/performance.png)

---

Not affiliated with Supabase. Most built-in SQL examples are adapted from Supabase Studio
(Apache-2.0, see [licenses/supabase-apache-2.0.txt](licenses/supabase-apache-2.0.txt)).
Development and architecture: [CODE.md](CODE.md).

---

Like this work? [Hire me](https://alexey.work/cv?ref=superbase)
