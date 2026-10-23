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
Browser-entered credentials stay in server memory; sessions expire after two idle hours or a
restart. **Remember on this browser** optionally saves your URL/password in browser storage
and reconnects on page load. **Disconnect** pauses automatic reconnection; **Forget saved
connection** erases the stored URL without disconnecting. Connecting without Remember also
erases it. No automatic reconnection runs underneath an active editor; reload after expiry.
Connection changes and reloads warn about unsaved work.

Saved credentials are **unencrypted** and readable by scripts on this site or anyone with
access to your browser profile. Use Remember only on a trusted browser. Storage belongs to
the exact app address, including its port; `localhost` and `127.0.0.1` are separate.

**Keep the app local.** Do not expose it to the network or a public reverse proxy.
Use a database role with only the permissions you need.

## Editing

- Double-click a cell or press Enter/F2 to edit. **Expand** opens a resizable side panel.
  Text and JSON columns use CodeMirror regardless of content length; other types keep native
  controls. Text stays literal. JSON/JSONB gets highlighting and indentation without rounding
  numbers or changing literal values. Opening a cell never auto-selects all its text.
- **Apply**, Ctrl/Cmd+Enter, or clicking outside a compact editor saves an existing cell
  immediately. Invalid values keep the editor open with an error and your input intact.
  Escape cancels unsaved input; Enter adds a newline. The outside click does not activate
  the control beneath it.
- **Insert row** opens a side panel with all fields. Fill the row, then **Save** once;
  **Create more** keeps a fresh form open. Defaults are supplied by PostgreSQL, and failed
  inserts retain the whole form. Cancel asks before discarding entered values.
  If a connection drops during insertion, check the table before retrying.
- **Set to** distinguishes SQL NULL, DEFAULT for new rows, and empty text. JSON `null` is
  different from SQL NULL. **Now** is resolved when saving, in the database session's timezone.
  Arrays use PostgreSQL literals, e.g. `{"a,b","",NULL}`.
- There is no global Save/Revert step. Row selections survive paging and table changes.
  Deletes execute after confirmation.
- Concurrent changes cause a conflict rather than an overwrite. Database-rejected writes
  roll back and preserve your input; cancel and refresh to work from the latest rows.
- Foreign-key cells open a searchable record picker. Selecting a record saves the whole
  key atomically, including composite keys; in a new-row form it only fills the form.
  The arrow opens the referenced row; **Show all rows** clears that filter.
- Arrow keys navigate; Shift-click/arrows extend a range; Shift+Space selects a row.
  Copy/paste uses quoted TSV, preserving tabs and newlines. Unquoted `\N` means NULL and
  `\D` means DEFAULT (only for new rows); literal marker strings are quoted. Pasting or
  clearing a range saves the whole operation atomically. Escape, clicking empty grid space,
  or clicking outside the grid clears cell selection without changing checked rows.

## Live updates and limits

**Live** starts enabled and checks the visible result page every five seconds. An idle grid
updates itself; open cell editors, new-row forms and selections instead get a changed-data
notice.
Polling pauses while the tab is hidden, the Definition view is open, or a connection dialog
is displayed. It reruns the current query, so turn it off for expensive searches.

Tables without a primary key are read-only. Generated fields can be inspected but not edited.
Row counts are exact when the entire unfiltered table is loaded on the first page; `~` marks
PostgreSQL estimates that may be stale. Pagination is not a snapshot across concurrent changes.
Schema editing, a SQL console, views and column-specific filters are not supported.

Development setup, test commands and architecture: [CODE.md](CODE.md).
