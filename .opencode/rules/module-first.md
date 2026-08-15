# Module-First — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It is NON-NEGOTIABLE for ANY feature work
(new feature, bug fix, refactor, docs change about the platform, roadmap/roadmap-item
edit, new file, new page). Before writing ANY code for ANY new thing, you MUST pass the
module gate below. The owner will not repeat this; enforce it yourself every time.

## The gate (run BEFORE any feature code)

1. **Read the module guide first.** Open `public/changelog/architecture.json` (single
   source of truth) and read its `modules`, `rules`, and `implementationOrder`. Also read
   `AGENTS.md` if your context is stale. NEVER design or code a feature without doing this.
2. **State the module.** For the feature at hand, write the module classification line:
   `Module: M<n> — <module title> (status: <planned|in-progress|shipped>)`. Put it in
   your first message about the feature, before any file edits.
3. **Slot check.** Does the feature fit the module's existing summary/details? It must.
   If it is a NEW capability:
   - If it slots into an existing module: update that module's `details` in
     architecture.json to note it, and mirror in AGENTS.md.
   - If it does NOT fit any existing module category: **it earns its OWN new module.**
     Add it to `architecture.json` as a new module (M8+) FIRST, then build it. A feature
     is never "unmodular". Do NOT bury an important standalone capability inside another
     module's details.
4. **Renumber by build order.** Module numbers reflect the order modules are actually
   built/used (M1 game core -> M2 result seam -> M3 local points -> ... -> then
   next used module). When a new module is inserted, renumber the list so future
   games plug in M1 -> M2 -> M3 ... cleanly. Keep AGENTS.md mirror + roadmap/
   economics references in sync.
5. **Integrate through the seams, never standalone.** Consume via `window.onGameResult()`
   (universal result seam, `public/game-result.js`) / source tags / module APIs. Never
   hard-wire one game into the platform.
6. **Respect status.** M7/M8-style deferred modules: product work does NOT start until
   their dependencies (per `implementationOrder`) are stable. Never build ahead of a
   module's status.

## Consequences of skipping

Skipping this gate is a regression. If you are about to write feature code without a
stated module, STOP. Do the gate first. The owner's instruction is explicit: it is a
MUST-enforced rule for any new feature.
