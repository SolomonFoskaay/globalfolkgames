# Research Library — HARD RULE (do not skip)

This rule is auto-loaded into every session. It governs the staff **Research**
workspace, which holds explorations that happen BEFORE they become modules in
`architecture.json`.

## Where it lives

- Data: `public/changelog/research.json` (client-served for the staff page).
- Page: `/changelog/research.html` (staff-gated, same pattern as Architecture),
  with its own left-rail submenu in `public/changelog/research-nav.js`.
- Renderer: `public/changelog/research.js`.
- Entries have: `id`, `title`, `status` (researching / parked / adopted /
  closed), `updated`, `summary`, `decision`, and `sections` (paragraphs,
  bullets, and optional tables).

## The rules (non-negotiable)

1. **ALWAYS ASK before filing research.** Whenever a task produces research or
   analysis (a cost study, a tech evaluation, a market analysis, an idea
   exploration, a "should we" comparison), the agent MUST ask the owner whether
   to save it into the Research section. Never add, edit, or delete a research
   entry without the owner's explicit yes in that turn. Use the `question` tool.
2. **Research comes BEFORE architecture.** A research entry is NOT a module. It
   is an exploration the owner reads (often on mobile) and later decides on.
   Do not create an architecture module from research unless the owner approves
   it as a formal decision.
3. **CHECK RESEARCH BEFORE TOUCHING ARCHITECTURE.** Before adding a NEW module
   to `architecture.json`, or UPDATING an existing module, the agent MUST read
   `public/changelog/research.json` and check for pending (`researching` or
   `parked`) research that is relevant to that module. If relevant research
   exists, surface it to the owner and ask whether to fold it in FIRST. Never
   silently ignore pending research while changing the architecture.
4. **Keep it mobile-friendly.** The owner reads these on a phone. Every table
   MUST be wrapped in the scrollable `.research-table-wrap` container, never use
   fixed pixel widths on the page, and keep text wrapped (no horizontal page
   overflow). Test-ready rule: a wide table scrolls inside its card, and the
   page itself never grows wider than the screen.
5. **Never put secrets or unfixed security detail in it.** The file is
   client-served. No key material, no environment values, no unfixed exploit
   detail (that stays in `docs/changelog/security-queue.md`). Business research
   and public facts are fine.
6. **Statuses stay honest.** Update an entry's `status` as the owner decides:
   `researching` (open) -> `parked` (owner will read then decide) -> `adopted`
   (became a module/roadmap item, keep for reference) or `closed` (not pursued,
   keep for the record). Never delete an entry the owner asked to keep.
7. **Record the archive.** When research is adopted into a module, add a note in
   the module's `details` in `architecture.json` that it came from the Research
   library (with the entry id), so the trail is traceable.
