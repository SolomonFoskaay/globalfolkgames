# GlobalFolkGames BS — Session Rails (standalone project)

**Status: SKELETON ONLY. No logic yet. Step 1 of the build order.**
Nothing here is deployed, and nothing in the GlobalFolkGames app uses it yet.

The full design is in [`../docs/globalfolkgames-bs-spec.md`](../docs/globalfolkgames-bs-spec.md). Read that first.

---

## What this is (one paragraph)

GlobalFolkGames BS is a **room** you open on-chain, do everything inside for free, and settle back
to the chain once. It is the Arc (Circle EVM) equivalent of MagicBlock's Ephemeral Rollup: free
execution inside a session, one small on-chain cost to open and one to settle. It is a **standalone
project** on purpose: any game can plug into it, and GlobalFolkGames is only its first user.

It is **not** a board-game system. Ludo, chess, an idle game and an MMORPG are all the same thing to
this rail: a set of participants, an opaque state model the game defines, signed events, and one
settlement. If this repo ever contains the words board, token, position, seat count, turn or dice,
it has already gone wrong.

---

## The four calls (the entire API)

1. **OPEN** — start a session (participants, rules blob, lifetime, optional committed seed, fee
   profile, attached value rails). Returns a session id.
2. **ACT** — record a signed session event (session id, signer, opaque payload, sequence number).
   Zero chain cost. The rail never parses the payload.
3. **DISPUTE** — optionally challenge the state; the game's own verifier decides the truth. Free.
4. **SETTLE** — close the session (final signed summary + revealed seed). One on-chain record, then
   batched into a Merkle root with many other sessions.

---

## Naming

The full brand name is used everywhere a stranger can see it: **GlobalFolkGames BS**. The short
form **GFG-BS** is used only in internal docs after the full name has appeared. Packages are
`@globalfolkgames/bs-sdk` and `@globalfolkgames/bs-contracts`.

Never call this an "ER": MagicBlock's ER is an SVM runtime, this is a session/channel layer on EVM.

---

## Layout (planned)

```
globalfolkgames-bs/
  src/
    SessionRegistry.sol      open / close sessions; participant authorities; scope + expiry
    SessionState.sol         accept signed session events; sequence numbers; digest
    Randomness.sol           commit-reveal seed(s); derive hash(seed, counter)
    BatchWindow.sol          Merkle root per window; per-session proof
    ParticipantAccount.sol   ONE account per player; append-only value slots
    FeeVault.sol             rail fee collection; configurable destination / escrow
    verifiers/               per-game verifiers (Ludo ships first)
  demos/                     playable demos organised BY GENRE (see demos/README.md)
    idle/                    idle / clicker / farming
    casual/                  hyper-casual / arcade / runner
    pvp/                     PvP arena / 1v1 / battle cards
    mmorpg/                  RPG / MMORPG / MMO strategy
    metaverse/               sandbox / virtual land / building
    board/                   board / tile / traditional (GlobalFolkGames' own, live)
  test/                      Foundry tests
  packages/
    sdk/                     @globalfolkgames/bs-sdk — the one-line integration
    contracts/               @globalfolkgames/bs-contracts — interfaces + deployed addresses
```

All files are empty placeholders right now. They are created in later steps, one at a time, each
ending with a live Arc testnet proof before the next step starts.

---

## The two laws this project must obey

### 1. The rail never learns a game concept
No board, token, position, seat count, turn or dice in the rail. The game's state is an opaque
payload. A real-estate grid, a war zone and a galaxy are all the same to the rail.

### 2. ONE participant account per player, append-only
Learned the hard way on Solana: a separate on-chain account per player per feature made sponsor
cost grow with every feature, and the whole program had to be rebuilt to consolidate. The fix was a
single `PlayerCore` account per player holding lives, points, premium and a bounded table of
per-game buckets keyed by an 8-byte game tag. Adding a game or a feature never adds an account.

So here: one account per participant for the whole platform. New games and new features add
**slots**, never accounts. A `version` byte goes FIRST from day one, new fields go LAST, and any
layout change ships a permissionless, idempotent `migrate_*` in the SAME deploy, so an existing
player's points and lives can never be touched or orphaned by an upgrade.

---

## Economics (why this sustains itself)

Modelled on MagicBlock, who charge for **sessions and commits**, not usage:

- A small **fixed fee per session**, charged on open and on settle. Never per action, never per
  feature. So Ludo, chess, an idle session and an MMORPG session all carry the same tiny fee.
- The fee applies on **devnet too**, and goes to the owner's wallet. This is deliberate: MagicBlock's
  devnet looks free, so developers cannot tell what mainnet will cost them. Here a developer tests
  against the true economics before committing.
- GlobalFolkGames **pays like any other game** — it is the proof of concept and the battle test.
- The owner takes 100% at first; a protocol/node split can come later if dedicated infrastructure
  is added.
- Players always pay nothing.

---

## Build order

1. **This skeleton + README.** No logic.
2. SessionRegistry + SessionState + session keys. Test open/act/settle with a fake game.
3. Randomness (commit-reveal, N streams) + BatchWindow (Merkle flush). Test.
4. ParticipantAccount + FeeVault. Test.
5. Plug Ludo in as the first game (single-player first, then multiplayer).
6. Then points, lives and premium as slot/event types; later competitions, AGM, ERC-20 rewards.

Each step ends with a **live Arc testnet proof** before the next step starts.
