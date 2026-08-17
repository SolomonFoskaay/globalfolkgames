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
4. **Input/Output contract check (MANDATORY).** Read the `expectedInput` and
   `expectedOutput` sections of BOTH the module you are building AND every module it
   connects to (upstream and downstream). Verify:
   - Your module's inputs exist and are defined in the upstream module's `expectedOutput`.
   - Your module's outputs match what downstream modules expect in their `expectedInput`.
   - You are NOT duplicating work another module already does (e.g. recomputing scoring
     tables that M3 already owns). If you find a mismatch, STOP and fix the
     architecture.json contract BEFORE writing code.
5. **Renumber by build order.** Module numbers reflect the order modules are actually
   built/used (M1 game core -> M2 result seam -> M3 local points -> ... -> then
   next used module). When a new module is inserted, renumber the list so future
   games plug in M1 -> M2 -> M3 ... cleanly. Keep AGENTS.md mirror + roadmap/
   economics references in sync.
6. **Integrate through the seams, never standalone.** Consume via `window.onGameResult()`
   (universal result seam, `public/universal/result-seam/game-result.js`) / source tags / module APIs. Never
   hard-wire one game into the platform.
7. **Respect status.** M7/M8-style deferred modules: product work does NOT start until
   their dependencies (per `implementationOrder`) are stable. Never build ahead of a
   module's status.
8. **M1A per-game LOCKED specs are the build + test benchmark (HARD RULE).** Each game
   under M1 (M1A) has its own LOCKED spec stored in `public/changelog/architecture.json`
   under M1's `games` (dropdown: Ludo locked, Ayo Olopon planned, ...). When working on a
   game's M1:
   - READ the locked spec for that game BEFORE and DURING the build (alongside external
     docs like MagicBlock), so the build never drifts from what was agreed.
   - TEST against the locked spec: every implemented behavior is checked against the
     spec's bullets; the spec is the benchmark, not memory.
   - BEFORE concluding M1 for a game, re-check the finished work A-Z against its locked
     spec. Only when it matches end to end is M1 considered complete for that game, and
     only then commit + push as "M1 complete for <game>".
   If the spec is missing/stale for the game you are about to build, STOP and ask the
   owner to lock it first - never build an unlocked game spec on assumptions.

## Consequences of skipping

Skipping this gate is a regression. If you are about to write feature code without a
stated module, STOP. Do the gate first. The owner's instruction is explicit: it is a
MUST-enforced rule for any new feature.

## Architecture is the source of truth (never change silently)

`architecture.json` is the single source of truth for every module's spec, including
its expectedInput, expectedOutput, details, status, and all sub-sections. When building
a module, the final test is: does the built code match the architecture spec end to end?

**NEVER modify architecture.json without the owner's explicit approval.** This means:
- Do NOT add, remove, or reword any expectedInput/expectedOutput item silently.
- Do NOT change a module's status (planned/in-progress/shipped) without being told.
- Do NOT adjust details, summaries, or rules without the owner seeing and approving.
- If you find a mismatch between the code and the architecture, STOP and tell the owner
  what needs to change in the architecture BEFORE changing code to match. The owner
  decides what the spec should be; you implement it.

The architecture is the contract the owner approved. Changing it without approval breaks
the trust that the spec matches what was agreed. Code must match the spec, never the
other way around.
