# superbase

A local Postgres table editor inspired by Supabase Studio, without the Supabase stack.
Browse tables, edit cells, follow foreign keys, and copy/paste spreadsheet selections.
MIT licensed.

## Run

Requires Bun and Node 24+. Run from a checkout:

```sh
git clone https://github.com/xl0/superbase.git
cd superbase
bun install --frozen-lockfile
bun run build
bun run start
```

Open **http://127.0.0.1:3000** and paste a Postgres connection URL.
Use `PORT=4000 bun run start` to choose another port.

For a local database without TLS:

```text
postgresql://user:password@127.0.0.1:5432/mydb?sslmode=disable
```

Connections entered in the UI use TLS without certificate verification by default.
Enable **Verify server certificate** (`sslmode=verify-full`) to authenticate the server;
without it, traffic is encrypted but the server's identity is not verified.
`sslmode=disable` explicitly selects plaintext. There is no automatic plaintext fallback.
Percent-encode URL punctuation in credentials.

**Change connection** switches databases, disconnects, or returns to an optional default.
To provide that default, copy `.env.example` to `.env` and set `DATABASE_URL`.
Browser-entered credentials stay in server memory; sessions expire after two idle hours
or a server restart. Connection changes warn about unsaved work.

**Keep the app local.** Do not expose it to the network or a public reverse proxy.
Use a database role with only the permissions you need.

## Editing

- Double-click a cell or press Enter/F2 to edit. **Expand** opens a resizable side panel.
  JSON/JSONB has syntax highlighting and indentation without rounding numbers or changing
  literal values.
- **Apply** or Ctrl/Cmd+Enter stages the value; **Save** writes the current table's pending
  edits and inserts, including other pages. Escape cancels the cell editor. Enter adds a
  newline. Clicking outside a compact editor applies without activating the control beneath.
- **Set to** distinguishes SQL NULL, DEFAULT for new rows, and empty text. JSON `null` is
  different from SQL NULL. **Now** is resolved when saving, in the database session's timezone.
  Arrays use PostgreSQL literals, e.g. `{"a,b","",NULL}`.
- Edits and row selections survive paging and table changes. **Revert** discards the current
  table's pending work. Deletes execute separately after confirmation.
- Concurrent changes cause a conflict rather than an overwrite. A failed batch rolls back
  and keeps your edits; revert and refresh to work from the latest rows.
- Foreign-key cells open a searchable record picker. Selecting a record fills the whole
  key, including composite keys. The arrow opens the referenced row; **Show all rows** clears
  that filter.
- Arrow keys navigate; Shift-click/arrows extend a range; Shift+Space selects a row.
  Copy/paste uses quoted TSV, preserving tabs and newlines. Unquoted `\N` means NULL and
  `\D` means DEFAULT; literal marker strings are quoted. Escape clears cell selection.

## Live updates and limits

**Live** optionally checks the visible result page every five seconds. An idle grid updates
itself; edits, drafts, open editors and selections instead get a changed-data notice.
Polling pauses while the tab is hidden, the Definition view is open, or a connection dialog
is displayed. It reruns the current query, so leave it off for expensive searches.

Tables without a primary key are read-only. Generated fields can be inspected but not edited.
Row counts are estimates; pagination is not a snapshot across concurrent changes.
Schema editing, a SQL console, views and column-specific filters are not supported.

Development setup, test commands and architecture: [CODE.md](CODE.md).
