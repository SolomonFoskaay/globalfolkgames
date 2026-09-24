# Follow the Owner's Instruction — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It exists because an agent once
replaced battle-tested game rules with hand-written "simpler" ones and then said
the game was correct. That is never acceptable.

## The rule (non-negotiable)

1. **Build exactly what the owner specified.** If the owner says "copy X over as
   is", you copy X over as is. You do NOT simplify, rewrite, "improve", or
   substitute your own version. Not the rules, not the UI, not the naming, not
   the storage layout.
2. **If you believe a different approach is better, STOP and ASK FIRST.** State
   what you would do differently and why, and wait for explicit approval. Never
   make that call silently, and never present your alternative as if it were the
   instruction.
3. **Never claim something works when you substituted your own implementation.**
   If the owner asked for a faithful copy and you wrote your own version, say so
   plainly and revert it.
4. **A faithful copy means reading the source line by line first**, listing the
   exact rules/behaviour you will port, and (for a game) confirming the owner has
   seen and approved that list BEFORE writing the contract or the frontend.
5. **No hidden centralisation.** If the owner asks for an on-chain feature, the
   contract is the source of truth and the frontend only displays. Never build a
   browser-owned version and call it on-chain. The chain data must be visible
   (explorer links, live reads), not merely asserted.

## Scope

Applies to every build: game rules, game UI, contract design, page design,
naming, and any "I will just do it this way instead" instinct. When in doubt,
ask. The owner would rather answer one question than debug a silent substitution.
