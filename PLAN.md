# superbase — plan

## Intent

Build a small, local-only Postgres table editor with the useful parts of Supabase Studio's
UX, without its platform dependencies. Keep SvelteKit, direct server-owned SQL, and a custom
spreadsheet grid. Reuse shadcn-svelte for standard UI instead of maintaining equivalents.

Preserve PostgreSQL values exactly. Navigation, background refreshes, and connection changes
must never silently discard edits or send them to a different target. Favor simple, readable
solutions; add infrastructure only when a concrete feature needs it.

## TODO

Finish and verify the active item before starting the next. Queue new feature requests here
rather than interrupting work already underway.

- [x] Browser connections, lossless transactional editing, cross-page pending changes,
  retained rows during sorting, rich/resizable cell editors, and composite foreign-key
  selection/navigation. Regression tests and isolated browser checks cover the foundation.

- [x] Shadcn Select, DropdownMenu, Popover, Sheet and display tables replace native/custom
  standard controls. Single Set to actions are footer buttons; multiple actions use a menu.
  The resizable sheet leaves the table unblurred. Nested-menu Escape and focus are verified.

[x] JSON/JSONB uses CodeMirror with lossless indentation and highlighting in both editor
modes. Semantic undo/redo preserves SQL NULL, DEFAULT and literal text across expansion.
Precision, readonly behavior, keyboard handling and compact-editor bounds are verified.

[x] Optional live refresh polls the visible data view every five seconds. Idle results update;
local edits, drafts and selections instead receive a changed-data notice. Visibility/modal
pausing, race guards, failure recovery and actual database updates are verified.

[x] README covers running, connecting, editing and limits for users. Development setup,
test commands and architecture live in CODE.md.

### [ ] Validate cell values before Apply stages them

Use PostgreSQL's actual type rules, nullability and foreign-key checks for all cell types.
Reject invalid values inline without closing the editor or losing its buffer. Cover every
apply path, including outside-click dismissal. Do not use trial writes and rollback for
validation. Save remains authoritative for full constraints and concurrent changes.

For these items, completion includes focused regression tests and browser checks, not just
rendered controls. Keep CODE.md and user-facing documentation aligned with actual behavior.

## Later

- [ ] Schema editing and user-defined column filters.
- [ ] SQL editor with an explicit connection lifecycle.
- [ ] Publish a zero-config CLI launcher: `bunx superbase@latest` starts the local server
  and opens the browser. Bundle production assets and verify the Bun launch path.

Consider virtualization only if larger pages demonstrate a need.
