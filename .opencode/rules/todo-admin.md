# Admin Todo Ledger — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It extends
`.opencode/rules/todo-status.md` (which already requires the FULL nested todo
list to be re-output on every report/commit/push). This rule says WHERE that
list must also be persisted so the owner can read it in the admin dashboard,
and HOW to keep it from growing without bound.

## The admin todo page

- Page: `/dashboard/todo.html` (staff-gated like every dashboard page).
- Data: `public/changelog/todo.json` (client-served: task text only, NEVER
  secrets, keys, or unfixed security detail).
- Renderer: `public/changelog/todo.js`.

## The rule (run on EVERY report, commit and push)

1. **Write the fresh, full list as `current`.** Use the owner's exact nested
   numbering (`(1)`, `(1i)`, `(2)`, `(2i)` ...). One item per line, each with a
   status: `done` (`[x]`), `in_progress` (`[•]`), `pending` (`[ ]`), or
   `deprecated` (`[~]`, removed/replaced, kept for the record, do not build).
   Exactly one item is `in_progress` while work remains.
2. **Update on EVERY completed step, not just at the end.** The moment a step
   is truly finished (built, deployed, tested), flip its status in `todo.json`
   and then re-output the CURRENT full list in chat, so the file and the chat
   never drift. Mark an item `deprecated` the moment it is removed or replaced
   (keep the text, change the status), never delete it.
3. **Archive the previous `current` to the FRONT of `history`** (newest first)
   before you replace it with a fresh full list. Give the snapshot its own
   `title` and `updated`.
4. **Cap `history` at 3 snapshots.** If archiving makes it 4, drop the oldest
   (the one at the end). The file is always ONE live list plus AT MOST 3
   archives: the last 3 lists stay, and the newest (the 4th slot) is always the
   fresh current list.
5. **Never let the file grow unbounded.** Never append a list without archiving
   and trimming. Never keep more than 3 history entries.
6. **Update the top-level `updated` date** to the day you wrote it.

## Shape of `public/changelog/todo.json`

```json
{
  "updated": "YYYY-MM-DD",
  "note": "why this file exists (keep the existing note)",
  "statusLegend": { "done": "...", "in_progress": "...", "pending": "..." },
  "current": { "title": "...", "updated": "YYYY-MM-DD", "items": [ { "t": "(1) ...", "s": "done" } ] },
  "history": [ { "title": "...", "updated": "YYYY-MM-DD", "items": [ ... ] } ]
}
```

`items[].s` is one of `done`, `in_progress`, `pending`, `deprecated`.

## Safe edit (never rewrite the world)

- **Surgical JSON edit only.** Load `public/changelog/todo.json`, assert the
  top-level keys (`current`, `history`) survive, then write back the SAME
  object with `current` replaced and `history` prepended + trimmed. This is a
  protected content file: see `.opencode/rules/content-protection.md`. Never
  write back an object loaded from a different path, and never drop `history`
  entries beyond the 3-entry cap silently without preserving the rule.
- If the task has no multi-step work, still do not corrupt the file: only touch
  it when the todo list actually changes.

## Why

- The owner must be able to open `/dashboard/todo.html` on a phone at any time
  and see exactly what the agent is doing, without re-reading a transcript.
- A list that grows forever becomes unreadable, so only the current list plus
  the last 3 snapshots are kept.
