# Todo Status Output — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It exists because long tasks get
interrupted, and without a visible, current task list the next session (or the
owner) loses track of what is done and what is in progress.

## The rule

1. **Before starting work on any multi-step task** (a feature, a migration, a
   multi-file change), the agent MUST first output a todo list covering every
   step, and keep it in the session todo tool (`todowrite`). Put it in the first
   message about the task, before any file edits.
2. **Update it in real time.** Mark a step `completed` the moment it is actually
   done (built, deployed, tested), not when it is intended. Exactly one step is
   `in_progress` at a time. New steps discovered mid-task get added.
3. **Re-output the FULL todo status** every time the agent reports back or
   pushes/commits. The full list, with:
   - `[x]` for completed steps,
   - `[ ]` for pending steps,
   - `[•]` (or a clear "in progress" marker) for the ONE currently ongoing step.
   Never output only the delta; always the whole list so the current state is
   unambiguous.
4. **On interruption/resume**, output the current full todo status FIRST, then
   continue. This is how a new session reconstitutes the task.

## Why

- Tasks often span many steps and multiple interruptions. The todo is the
  single, persistent view of progress.
- The owner needs to see, at a glance, what is done, what is ongoing, and what
  remains, without re-reading the whole transcript.
- It prevents duplicate work and half-finished steps after a break.

## Format

```
# Todos
(1) <parent task>
    (1i) <sub-step>
    (1ii) <sub-step>
    (1iii) <sub-step>
(2) <parent task>
    (2i) <sub-step>
    (2ii) <sub-step>
```

Every status marker stays: `[x]`/`[✓]` done, `[ ]` pending, `[•]` the ONE in
progress, at sub-step level. Keep step text short and outcome-focused (built /
deployed / tested / verified), so the status is readable at a glance.

## Structure: mirror the owner's request (HARD RULE)

7. **Keep the owner's numbering.** When the owner sends a numbered request
   (e.g. "(1) ... (2)(i) ... (2)(ii) ..."), the todo list MUST use the SAME
   structure and the SAME numbers/letters: `(1)`, `(1i)`, `(1ii)`, `(2)`,
   `(2i)`, `(2ii)`, etc. Never renumber, merge, or flatten the owner's items,
   and never split a parent into separate top-level todos.
8. **A todo grows, it never gets broken apart.** If fixing a parent uncovers
   sub-issues (the way the subscription fix uncovered more sub-issues), KEEP the
   parent and APPEND new sub-steps under it (`(2iii)`, `(2iv)`, ...). Do not
   close the parent early, and do not spin the sub-issues out into new
   top-level todos. The parent stays open until every sub-step under it is
   truly done.
9. **No digression.** Only the single `[•]` sub-step is worked at a time, but
   the FULL nested list is re-output on every report/commit/push. If a new
   request arrives mid-task, add it as a new numbered parent (or a sub-step
   under the right parent) WITHOUT losing or reordering the existing ones.
10. **Classify work where it matters.** For game/board changes, state per
    sub-step whether it is ON-CHAIN (account/instruction/program change) or
    OFF-CHAIN (client rendering/copy only), and that game CORE mechanics are
    not touched unless the owner explicitly asks. Cosmetics stay off-chain.
