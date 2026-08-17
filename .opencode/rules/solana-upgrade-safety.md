# Solana Upgrade Safety — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It governs EVERY change to the deployed
Solana programs in this repo (gfg-dice + gfg-comp on devnet, later mainnet) and every
account schema, seed, program ID, or instruction-signature change. The owner's
explicit rule: **what we do on devnet is what will replicate later on mainnet.**
Devnet is the rehearsal for mainnet. Never "just wipe" devnet data because it is free;
if a migration is not proven on devnet, it is not shippable.

## The ground truth (read this first)

- **A program upgrade NEVER deletes account data.** `solana program deploy` (same program ID)
  swaps the *code*; every PDA keeps its bytes on-chain.
- Data is lost only three ways, all avoidable:
  1. **PDA seed change.** Old accounts keep their bytes but the new code can't find
     them, and anyone can later close them to reclaim rent (that destroys the data).
  2. **Incompatible account-layout change** (reorder/rename/remove fields). Borsh
     deserialization then misreads old bytes → "corrupt" accounts.
  3. **Program ID change.** The whole program becomes unreachable; all its accounts
     are orphaned.
- **Anchor trap:** `init_if_needed` on a changed seed silently creates a NEW empty
  account at the new address. Everything *looks* fine while the real ledger is
  orphaned. This is the silent-data-loss bug; treat it as a red flag during review.
- Current permanent program ID: `CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ`.

## The rules (non-negotiable)

1. **R1 — Live seeds are immutable.** Once a seed ships to devnet, never change it.
   New capability = NEW seed prefix (e.g. `gfgpoints_v2`), never a changed seed on an
   existing prefix. If a seed MUST change, it requires the migration pattern (R4) in
   the SAME deploy.
2. **R2 — Live account layouts are versioned.** Every NEW account type puts a
   `version: u8` (or enum discriminant) field FIRST from day one. Layout changes =
   bump version + migrate-on-read in code; old versions must still deserialize.
   Never reorder/rename/remove fields of a live struct.
3. **R3 — The program ID is permanent.** Never change the deployed program ID while
   any account must stay readable. A new program means a new seed prefix + a
   migration, never a swap.
4. **R4 — Every breaking change ships a migration instruction in the SAME build.**
   The migration must be:
   - **permissionless** (anyone can run it for any account; no authority gate),
   - **idempotent** (safe to rerun; skip already-migrated accounts),
   - **data-preserving** (READ old bytes fully BEFORE writing new; never overwrite
     an unmigrated source),
   - **verifiable** (post-migration read-back asserts the new account holds the old
     values, e.g. old `total_points` → both new tracks),
   - **ordered** (migrate all known accounts before any downstream feature uses the
     new schema). Do not leave an orphan window open (R8).
5. **R5 — Deploy order + codebase sweep.** Before ANY deploy that touches a schema,
   grep the whole codebase (Rust AND JS/TS: client, relay, probe, profile,
   dashboards, competitions, lab harnesses) for every PDA derivation, instruction
   call, and account-field read tied to that program. Update them all in one commit.
   Deploy order: **program → regenerate IDL → server (relay/probe/api) → client**.
   Verify with a live on-chain read-back after each stage.
6. **R6 — Devnet = rehearsal for mainnet.** Test every migration on devnet exactly as
   it will run on mainnet. If a migration is not proven on devnet (fresh + already-
   migrated + double-run), it is not shippable.
7. **R7 — No silent-new-account traps.** Any review of a change that keeps an account
   type but alters its seed/layout must explicitly confirm there is no
   `init_if_needed` silently re-seeding an existing ledger.
8. **R8 — No orphan windows.** Orphaned accounts can be closed by anyone to reclaim
   rent, permanently destroying data. Migration runs promptly after deploy; treat an
   un-migrated legacy account as a live liability.
9. **R9 — Record before you break.** Every schema/seed/layout/instruction change is a
   feature: add/update the roadmap entry and the M3/M4 module spec in
   `public/changelog/architecture.json` BEFORE code, with the migration plan spelled
   out (old seed → new seed, old field → new field mapping, migration instruction
   name). Mirror in AGENTS.md. Follow the module-first gate.
10. **R10 — When in doubt, STOP.** Never make a breaking schema change without an
    approved migration plan. Ask the owner first.

## The established pattern (already in this repo)

- `migrate_points` in `programs/programs/gfg-dice/src/lib.rs`: converts the legacy
  `[gfgpoints, player]` account (old `total_points` layout) into the per-game
  `[gfgpoints, game_tag, player]` account (two-track `local_pure_lifetime` +
  `local_spendable_balance`, old total split 1:1). Permissionless, idempotent.
- Seed prefixes: `gfgplayerd` (dice), `gfgpoints` (points ledger), `gfgresult`
  (match results), `gfgcomp` (competitions).
- New per-game seed scheme: `[gfgpoints, game_tag, player]` — `game_tag` is stable
  per game (`ludo`, `ayo_olopon`, ...), so adding a game orphans nothing.
