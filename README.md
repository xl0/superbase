# superbase

A local Postgres table editor inspired by Supabase Studio, without the Supabase stack.
Browse tables, edit cells and schemas, follow foreign keys, and run SQL.
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

The connection button at the bottom of the navigation rail switches databases, disconnects,
or returns to an optional default.
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

## Filtering

Focus **Filter by…** to search the table’s columns, choose a comparison, then enter a value
and press Enter or **Apply filter**. Click a chip to edit it, its × to remove it, or
**Remove filters** to clear everything. Multiple conditions combine with **AND**; use two
conditions on the same column for a range.

Comparisons use PostgreSQL’s native types without rounding values. **Like** and **iLike**
accept `%` for any characters and `_` for one; iLike ignores case. **Is NULL** and
**Is not NULL** need no value. An empty text value is not SQL NULL.

Filters remain during sorting, paging, refresh and Live updates; changing tables resets them.
An empty table, no matching rows and invalid filter values have distinct messages.
PostgreSQL query warnings appear inside the empty-results panel. Edit or remove invalid filters;
use the toolbar’s Refresh button for transient failures.

## Sorting

**Sort**, beside the filters, accepts multiple columns in priority order. Choose each direction,
move rules up/down or remove them, then **Apply sorting**. Closing the menu discards unapplied
changes. NULL values sort last in either direction.

Clicking a column header cycles ascending → descending → off for that column, preserving the
other rules. Its chevron menu also offers ascending, descending and remove-sort actions. Header numbers show priority. Sorting remains during filtering, paging, refresh
and Live updates; changing tables resets it.

## Editing

- Double-click a cell or press Enter/F2 to edit. **Expand** opens a resizable side panel.
  Text and JSON columns use CodeMirror regardless of content length; other types keep native
  controls. Text stays literal. JSON/JSONB gets highlighting and indentation without rounding
  numbers or changing literal values. Opening a cell never auto-selects all its text.
- **Apply** or Ctrl/Cmd+Enter saves an existing cell. Invalid values keep the editor open
  with an error and your input intact. Escape cancels unsaved input; Enter adds a newline.
  Clicking outside or leaving a field never saves or discards changes, and does not activate
  the control beneath the editor.
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
- Foreign-key cells open a searchable record picker. Select a record, then **Apply** to save
  the whole key atomically, including composite keys; in a new-row form it only fills the form.
  The arrow opens the referenced row; **Show all rows** clears that filter.
- Arrow keys navigate; Shift-click/arrows extend a range; Shift+Space selects a row.
  Copy/paste uses quoted TSV, preserving tabs and newlines. Unquoted `\N` means NULL and
  `\D` means DEFAULT (only for new rows); literal marker strings are quoted. Pasting or
  clearing a range saves the whole operation atomically. Escape, clicking empty grid space,
  or clicking outside the grid clears cell selection without changing checked rows.

## Schema editing

Use **+** in the sidebar to create a table. Open a column header’s chevron menu to **Edit
column**, **Delete column**, or copy its name. The **+** header adds a column. Each table’s **⋮**
menu in the sidebar offers copy name/schema, duplication, CSV export, indexes, constraints, rename/delete and
adding a primary key to a keyless table.
Everything stays in the grid; there is no separate Definition view. New tables start with
an identity `id` primary key; you can change the columns and select a composite key.

Changes stay local until **Apply** or Ctrl/Cmd+Enter. Errors retain your form; Cancel asks
before discarding changes. Existing-column type changes use PostgreSQL casts and require
confirmation: conversions can round values, rewrite the table and block other work.
Foreign-key column casts also lock related tables and need their native LOCK permissions;
customized internal FK triggers require SQL rather than being silently reset.
Search base types, then choose integer size, timezone, array, length or precision/scale options.
The resulting SQL type is shown below. Existing settings stay exact until changed; incompatible
options/defaults are flagged rather than silently reset. A timestamp with timezone stores an
instant, not the original timezone name.

Defaults offer type-appropriate literals, current date/time, UUID or new-integer identity,
not SQL expressions. JSON, enum and boolean literals have dedicated editors; empty text/array
shortcuts remain distinct from NULL. Text types also offer an advanced UUID preset.
Existing expressions can be kept unchanged. Deletes require typing the target name; column
deletion can remove its indexes and table constraints, but external dependencies block deletion.
Concurrent schema changes conflict rather than overwrite. After a lost connection, check the
database before retrying an operation.

Only ordinary standalone tables are supported, not inheritance or partitions. Existing
generated expressions and identity defaults are preserved. Enum/namespace management and
replacing existing primary keys are not supported.

## Indexes

Open a table’s **⋮ → Indexes** to inspect definitions, methods, status, comments and ownership.
**Create index** accepts ordered columns, a standard access method and optional uniqueness.
Nothing changes until **Apply**; PostgreSQL errors retain the form. Dropping requires typing
its name. Constraint-owned and replica-identity indexes are protected, and dependencies block
removal rather than being dropped automatically.

Index changes lock the table and can block reads and writes. Creation uses plain columns and
PostgreSQL’s default ordering, collations and operator classes. Use SQL for concurrent builds,
expressions, partial indexes, INCLUDE columns and other advanced options.

## Constraints

**Edit column** includes a simple UNIQUE checkbox, related CHECK constraints and foreign keys.
Composite constraints show their complete keys; removing one removes the whole constraint,
not just this column's membership. All drafts save together with the column's **Apply**; a
failure rolls back all column/constraint changes. When renaming a column, use its current name
in constraint drafts.

**⋮ → Constraints** retains the complete table overview, including checks with no column references,
and supports create, edit, rename, drop and validation. UNIQUE supports ordered keys,
NULLS NOT DISTINCT (PostgreSQL 15+) and transaction deferral. CHECK accepts a PostgreSQL boolean
expression; NULL passes. **NOT VALID** skips existing rows but still checks new writes;
**Validate** checks the remaining rows later.

Foreign keys map complete tuples to an existing primary or nondeferrable unique key, with
update/delete actions, MATCH SIMPLE/FULL and optional deferral. Referenced tables must also be
ordinary standalone tables. **Reload target** refreshes its captured definition without clearing
the mapping. New-column/create-table forms do not yet embed constraint controls.

Apply is explicit, locks the table and retains the form on errors. Edits replace the constraint
atomically, preserving comments; dependencies block replacement/removal. Dropping requires its
name. Replica-identity constraints are protected. Foreign-key replacement also exclusively locks
the old referenced table and needs its native LOCK permissions beyond REFERENCES. Advanced native
options, including customized internal FK triggers, remain inspectable and renameable;
changing them requires SQL. PostgreSQL functions, type-input routines and DDL
event triggers are not sandboxed and may have side effects during parsing or validation.

## Copying and exporting tables

- **Copy name** copies the exact table name. **Copy table schema** previews server-generated
  SQL before **Copy SQL**; the preview and copied SQL state omissions and prerequisites.
  This is not a full database backup or `pg_dump` replacement.
- **Duplicate table** creates a new table in the same schema, empty by default. **Include rows**
  copies all rows your role can read, regardless of grid filters or pagination. Owned sequences
  are independent; generated values and checks run in PostgreSQL, so shared functions may have
  side effects. Review and acknowledge the copy scope:
  foreign keys, triggers, rules, policies, grants and ownership are not copied. RLS flags remain,
  so a copy without policies may deny access. PostgreSQL default privileges apply to the new
  table; external types, functions and unowned sequences remain shared.
- **Export CSV** in the sidebar table menu downloads all accessible rows from an ordinary
  standalone table, ignoring grid filters and pagination.
- **Export query results** (the toolbar download button) exports every row matching the current
  filters, including foreign-key navigation, in the grid's sort order—not just the current page
  or checked rows. Both exports use a fresh cursor snapshot and stream directly to the browser.
  NULL is an unquoted empty field; empty text is quoted. Numbers and other PostgreSQL text
  values are not converted through JavaScript. Raw spreadsheet formulas are also preserved:
  import untrusted data as text rather than opening it directly in a spreadsheet.
  Downloads start immediately with all columns, without an info panel or new tab. A brief
  confirmation acknowledges the request, not completion. Initial errors appear in the app;
  later transfer failures are reported by your browser's download manager.
- **Export options** beside the toolbar download button or in the sidebar table menu opens a column-selection
  modal. All columns start selected; selected columns retain table order. Row scope remains the
  same as the action: matching rows from the toolbar, all accessible rows from the sidebar.

## SQL editor

Choose **SQL editor** in the navigation rail. **Run** or Ctrl/Cmd+Enter executes the selection,
or the whole buffer if nothing is selected. PostgreSQL highlighting and keyword completion are
included. Tables and SQL retain their state when switching views. SQL drafts autosave locally,
separately per database and browser tab, and restore on reload without executing anything.
Results are read-only and preserve exact values, NULLs and duplicate column names.

Saved SQL is **unencrypted** and may contain sensitive values. Clearing the editor removes its
saved draft; clearing this site's browser storage removes all drafts, including abandoned tabs.
A fresh browser tab gets a separate draft. Only text is restored—not results, temporary tables,
session settings or transactions. Reload warns for active transactions/queries, unsaved table
edits or SQL text that could not be saved, but not for a safely saved draft or idle SQL session.
Storage failures appear in the editor; copy your SQL before leaving if autosave is unavailable.

SQL runs with your database role’s permissions, including writes and DDL. Each browser tab gets
a separate SQL connection: temporary tables, SET and explicit **BEGIN / COMMIT / ROLLBACK**
persist between runs without affecting the table editor. Buffers follow PostgreSQL’s native
multi-statement transaction rules, without an extra transaction wrapper. The status bar offers
**Commit / Rollback** while a transaction is open; a failed transaction enables only Rollback.
These actions keep your SQL draft unchanged. **Reset session** closes the connection and rolls
back uncommitted work while keeping the draft. The info button contains session and preview
details. Refresh Tables after SQL schema changes.

**Cancel** interrupts the current query, not earlier committed statements. Previews stop at
1,000 rows per result, 50 results or 2 MB; these limits do **not** limit SQL execution or writes.
Statements default to 30 seconds; the app closes the connection after 60 seconds. A lost
connection does not prove a write failed—check before retrying. Sessions expire after 15 idle
minutes; idle transactions default to 5 minutes. Reload/close sends best-effort cleanup;
crashed/offline tabs rely on expiry. Up to four SQL sessions can be open per browser connection.
COPY streams, binary cursor results and psql commands are unsupported. Keep **client_encoding
at UTF8**, including inside functions. Persistent encoding changes close the session; changes
restored within one buffer can evade detection and produce incorrect results/messages or native
conversion errors. No saved query history or editor tabs yet.

## Live updates and limits

**Live** starts enabled and checks the visible result page every five seconds. An idle grid
updates itself; open cell editors, new-row forms and selections instead get a changed-data
notice.
Polling pauses in the SQL workspace, while the tab is hidden, or while a connection/schema panel is displayed. It reruns the current query, so turn it off for expensive searches.

Row data without a primary key is read-only; add one through its sidebar **⋮** menu to enable writes.
Generated fields can be inspected but not edited.
Row counts are exact when the entire unfiltered table is loaded on the first page; `~` marks
PostgreSQL estimates that may be stale. Pagination is not a snapshot across concurrent changes.
Views and nested/OR filter groups are not supported.

Development setup, test commands and architecture: [CODE.md](CODE.md).
