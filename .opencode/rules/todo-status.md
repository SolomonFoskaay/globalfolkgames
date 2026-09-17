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
[✓] <completed step>
[✓] <completed step>
[•] <current ongoing step>
[ ] <pending step>
[ ] <pending step>
```

Keep step text short and outcome-focused (built / deployed / tested / verified),
so the status is readable at a glance.
