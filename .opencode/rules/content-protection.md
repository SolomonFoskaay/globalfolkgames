# Content & File Protection — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It is NON-NEGOTIABLE. It exists
because a full-file rewrite of `public/changelog/architecture.json` once wiped
every module (M1-M11) and broke the entire 1.0 admin workspace. It must never
happen again.

## The gate (run BEFORE writing any file that already exists)

1. **Never rewrite a whole existing file to "clean it up".** If you must change
   an existing file, edit the EXACT lines (surgical `edit`), never a full
   `write`/`cat >`/`json.dump` that replaces the file wholesale.
2. **JSON content files are protected**: `public/changelog/architecture.json`,
   `public/changelog/changelog.json`, `public/changelog/economics.json`, and any
   other file that is the "source of truth" of platform content. When you must
   modify one:
   - **Read it first** and asserts MUST verify the expected top-level keys are
     still present BEFORE you write back (e.g. `architecture.json` MUST still
     contain `modules`, `rules`, `implementationOrder`; `changelog.json` MUST
     still contain `entries`, `roadmap`). If an assertion fails, STOP.
   - **Never write back an object that was loaded from a different file** (this
     exact mistake replaced architecture.json with changelog.json's shape and
     deleted every module). Double-check the variable you dump is the one you
     loaded from the same path.
   - Preserve ALL existing keys/fields; you only add or adjust. Removing
     content (a module, a roadmap entry, a rule, any shipped/existing data)
     requires the OWNER's explicit approval in that turn.
3. **No silent deletes.** Do not remove a file, a feature, a module, or shipped
   content "because it looks unused" — ask the owner first (see AGENTS.md rule 0).
4. **Before `git add -A` / commit / push**, verify the diff on protected files
   shows additive changes (new lines) and NOT a large deletion/structural
   rewrite. If `git diff --stat` on a protected JSON shows thousands of removed
   lines, that is a red flag: STOP and inspect.
5. **Automated protection**: if writing `architecture.json`/`changelog.json`
   from a script, the script must (a) load from the same path it writes to,
   (b) assert the top-level keys survive, and (c) never `git add -A` blindly.

## Consequences

Violating this rule regresses the whole admin/product workspace. Any rewrite
that removes existing content without owner approval is never committed.