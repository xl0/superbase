# superbase

A Postgres table editor inspired by Supabase Studio, without the Supabase stack.
Browse and edit rows, change schemas, follow foreign keys, export CSV and run SQL.
MIT licensed.

## Run locally

Requires Bun and Node 24+.

```sh
git clone https://github.com/xl0/superbase.git
cd superbase
bun install --frozen-lockfile
bun run build
bun run start            # http://127.0.0.1:3000, PORT=4000 to change
```

Click **Choose connection → Add connection**, paste a `postgres://` URL and pick an SSL mode
(a pasted `sslmode=` is moved into the SSL selector). **Save** keeps the connection in this
browser's localStorage, password included and unencrypted; **Connect** connects without saving.

The server holds one database connection, shared by every tab. Switching databases in one tab
makes other tabs ask for a reload. By default the server listens on 127.0.0.1 and refuses
requests whose Host is not localhost/loopback, so other websites cannot drive it.

## Run as a database viewer (Docker / Kubernetes)

Set `DATABASE_URL` to pin the app to one database: connection switching disappears. Set
`HOST=0.0.0.0` to listen on all interfaces; this also disables the localhost check, so put the
app behind your own authentication (e.g. an auth proxy). Behind a TLS proxy set
`ORIGIN=https://your.host` so SvelteKit's same-origin checks match. Anyone who can open the app
can do everything the database role can, including running arbitrary SQL — choose the role
accordingly.

## Table editor

- Pick a schema and table in the sidebar. Filters (column, comparison, value) combine with AND;
  **Sort** takes several columns in priority order; clicking a header cycles its sort.
- Double-click a cell or press Enter/F2 to edit; **Apply** or Ctrl/Cmd+Enter saves immediately.
  Expand opens a side panel. Text and JSON use a code editor; values are never rounded or
  reformatted. **Set to** offers NULL, Now and empty text.
- Foreign-key cells open a record picker; the arrow jumps to the referenced row.
- Arrow keys and Shift select ranges; copy/paste uses TSV (`\N` is NULL). Pasting or clearing
  a range saves it in one transaction. Shift+Space or the checkboxes select rows for deletion.
- **Insert row** opens a form; empty fields use the column default.
- Concurrent edits conflict instead of overwriting (rows are matched by primary key and
  version). Tables without a primary key are read-only until you add one.
- **Live** re-reads the visible page every five seconds; local edits and selections get a
  "database changed" notice instead of being replaced.

## Schema editing

The sidebar **+** creates tables; column header menus edit or delete columns; the trailing **+**
header adds one; each table's **⋮** menu renames, duplicates, deletes, manages indexes and
constraints (UNIQUE, CHECK, foreign keys) and adds a missing primary key.

Every form shows the SQL it will run. **Apply** runs it in one transaction with a 3-second
lock timeout; PostgreSQL errors keep the form open. Deleting a table or column requires typing
its name. Type changes use a plain cast (`using col::type`). Duplicating copies structure via
`LIKE … INCLUDING ALL` (not foreign keys, triggers, policies or grants); serial columns keep
using the original sequence. Anything more advanced belongs in the SQL editor.

## SQL editor

**Run** (Ctrl/Cmd+Enter) sends the selection, or the whole buffer, unchanged to a dedicated
connection for this tab: SET, temporary tables and transactions persist between runs, with
Commit/Rollback buttons while a transaction is open. **Reset session** closes it. Previews show
up to 1,000 rows per result; this does not limit what the SQL does. Statements time out after
30 s (change with `SET statement_timeout`). The draft autosaves per database in localStorage.

The left panel holds your snippets and built-in examples. **Ctrl/Cmd+S** saves the editor text
(new text gets a name you can edit in place; an opened snippet is updated). Hearts pin
favourites; the ⋮ menu renames or deletes. Snippets are shared by all databases in this browser.
Opening a snippet or example only loads its text — nothing runs until you press Run.

## Database

The rail's database icon opens **Indexes** (every index per schema, with definitions; drop), **Extensions** (enable in a chosen schema, optionally
with required extensions; update; disable) and **Configuration**: search_path, timezone,
statement/lock/idle-in-transaction timeouts and work_mem, set or reset as defaults for the
database or your role. Each change shows its SQL first and applies to new connections.

## CSV export

The toolbar download button exports every row matching the current filters, in grid order;
the sidebar **⋮ → Export CSV** exports the whole table. **Export options** chooses columns.
Values are exact PostgreSQL text; NULL is an empty unquoted field.

Most built-in SQL examples are adapted from Supabase Studio (Apache-2.0, see
[licenses/supabase-apache-2.0.txt](licenses/supabase-apache-2.0.txt)).

Development and architecture: [CODE.md](CODE.md).
