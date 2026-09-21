# GlobalFolkGames BS — Session Rails (STANDALONE PROJECT SPEC)

**Status:** approved in principle by the owner (2026-09-21). NOT built. No code until Step 1 is
explicitly started.
**Owner:** Solomon Foskaay
**Scope:** a standalone, chain-agnostic, game-type-agnostic on-chain execution layer for Arc
(Circle EVM). GlobalFolkGames is its FIRST user, not its purpose.

---

## 0. The one-line description

**GlobalFolkGames BS is the Arc equivalent of MagicBlock's Ephemeral Rollup: a room you open
on-chain, do everything inside for free, and settle back to the chain once.**

A game opens a session, plays however it wants inside (moves, dice, points, timers, trades,
rewards), and settles once. Everything inside is off-chain-but-signed; only open and settle
touch the chain. It is NOT a board-game system. Ludo is just the first thing that will live in it.

**Naming (owner decision 2026-09-21):** the full brand name is used everywhere a stranger can see
it. The product is written **"GlobalFolkGames BS"**; the short form **"GFG-BS"** is used only in
internal docs after the full name has appeared. npm packages: `@globalfolkgames/bs-sdk` and
`@globalfolkgames/bs-contracts`. Reason: a monogram is too generic to build a brand on, and every
install/README/import showing the full name is free brand distribution (MagicBlock did not brand
their product "MB-ER").

**Do not call it an "ER" unless it literally is one.** MagicBlock's ER is an SVM runtime; this is
a session/channel layer on EVM. Inaccurate naming that implies ER tech would break trust and
violate the project's terminology rule.

---

## 1. What is actually generic (the whole point)

MagicBlock does NOT know what a board game is. It gives you a room: delegated accounts, free
execution, commit back. The game fills the room. GFG-BS must be the same.

**Think of GFG-BS as a ROOM, not a board.** The room has walls (open/settle), a door (the session
key), a clock (session lifetime), and a locked box (the committed randomness seed). What happens
inside is entirely the game's business:
- Ludo: a board, tokens, dice.
- An idle game: plots, houses, streets, businesses, production ticks.
- An MMORPG: a persistent galaxy, territories, war zones, player cities.
- Anything else: whatever the designer invents.

To GFG-BS all of these are the SAME thing: a participant set, an opaque state model the game
defines, signed events, and one settlement. **The rail must never learn a single game concept.**
If GFG-BS ever contains the words board, token, position, seat count, turn or dice, it is already
wrong.

| Layer | Knows about games? | What it holds |
|---|---|---|
| **GFG-BS Core** (standalone) | NO | Sessions, seats/participants (any number), session keys, randomness, signed state, settlement, batching, fees |
| **A game** (Ludo, chess, idle, MMORPG) | YES | Its own world: board, houses, streets, war zones, galaxies, whatever. It only needs to emit signed state into the room. |

**Consequence:** an idle game's "real estate plot" and Ludo's "token position" are the SAME thing
to GFG-BS: an opaque signed state blob inside a session. The core must never inspect it.

### Must not be baked into the core
- No "board", "position", "token", "seat count is 2", "turn", "dice" concepts.
- No Ludo scoring, no Ludo finish order.
- No assumption that participants are humans, or that there is an opponent at all.

### Must be configurable data, never code
- Participant count (1 = solo/simulation, 2, 4, 6, 100, N).
- Session lifetime and inactivity rules.
- Randomness need (yes/no, how many streams).
- Fee profile.
- Which value rails attach (points, lives, premium, competitions, AGM, ERC-20 rewards).

---

## 2. The mechanism on Arc (and honest mapping to MagicBlock)

MagicBlock is SVM-only. It cannot run on Arc (confirmed: research library, section 4). The
*effect* ports; the *mechanism* differs. This table is the mental model:

| MagicBlock (Solana) | GFG-BS (Arc) | Same effect? |
|---|---|---|
| Delegate account to ER | **Open session** (one tx: participants + committed seed hash + rules) | Yes: room exists on-chain |
| Free ER execution | **Signed off-chain session state** inside the session window | Yes: zero chain cost inside |
| Commit account back | **Settle session** (one tx: reveal seed, final signed state) | Yes: result lands on-chain |
| Undelegate | **Session close** / batched flush | Yes: final, provable |
| Session key (ephemeral signer + token PDA) | **Session key** (ephemeral signer + scope/expiry recorded at Open) | Yes: silent, no popups |
| ER VRF | **Commit-reveal randomness** (one seed per session, derive all rolls from it) | Yes: verifiable, no per-roll cost |
| Commit batching (N commits) | **Merkle window flush** (many sessions, one root) | Yes: O(1) cost |
| Protocol fee on sessions/commits | **GFG-BS fee on open/settle** | Yes: self-sustaining |

Honest note: on Arc there is no "delegation program" to delegate to. The session account is a
normal contract account; "delegation" here means "your session is active and hosted by the rail".
The economics are modelled on MagicBlock's (see §6), the implementation is EVM-native.

---

## 3. The four things a game does (the entire API surface)

Generic, game-agnostic, participant-count-agnostic:

1. **OPEN** — start a session.
   Input: participant identities (N), rules blob (opaque to the rail), session lifetime,
   optional randomness (a committed seed hash), optional fee profile, optional attached value rails
   (points/lives/premium/AGM/ERC-20).
   Output: a session id.

2. **ACT** — record a signed session event.
   Input: session id, actor's session key signature, an opaque payload (the game's own state delta),
   a monotonically increasing sequence number.
   Effect: stored off-chain in the session log. **Zero chain cost.**
   The rail never parses the payload. The game defines its meaning.

3. **DISPUTE** — optionally challenge the state.
   Input: session id, the full signed log (a reveal), the game's own verifier.
   Effect: the rail asks the game's verifier for the truth. Free (rides the same window).
   No bond, no per-dispute fee (matches MagicBlock's no-penalty feel).

4. **SETTLE** — close a session.
   Input: session id, the final signed summary (the digest), the revealed randomness seed.
   Effect: ONE on-chain record. Result, participants, move/event count, randomness proof.
   Then: **batching** folds many settled sessions into ONE Merkle root per window.

That is the whole rail. A game onboards by implementing exactly these calls.

---

## 4. Why this is tamper-proof WITHOUT co-signing

The earlier design (GFG-BS v1) required BOTH players to co-sign a settlement. That was wrong:
- MagicBlock does not do it.
- Solo play has no second signer.
- It made the anchor unbuildable and was the source of the recent pain.

**Correct model (matches MagicBlock):**
1. Each participant signs their OWN actions with their own **session key** (silent, no popups).
2. The session account records WHO may sign for WHICH participant (authority, set at OPEN).
3. The rail (or, on-chain, the contract) rejects any action signed by the wrong authority.
4. The AI / house / computer is simply a participant whose authority is the **relayer key**
   (the server-side signer). That is legitimate and needs no player signature.
5. Everything is provable AFTER the fact: the seed is committed before play and revealed at
   settle, so randomness cannot be adapted; the signed log is bound to the digest; a dispute
   reveals the log and the game's own verifier decides.

Net: no popups, no player fees, no co-sign bottleneck, still tamper-evident. This is the fix.

---

## 5. Value rails plug in, the core does not know them

Points, lives, premium, competitions, AGM, ERC-20 rewards and future features are all just
**session events** to the rail. They never create a new contract or a new account per player.

### THE ACCOUNT LAW (learned the hard way on Solana — do not repeat the mistake)

On Solana the first build had a separate delegated PDA per player per feature (a points account,
a lives account, a premium account, a result account, ...). The sponsor cost grew with every
feature and every player, and the whole program had to be rebuilt to consolidate. The fix was
`PlayerCore`: seed `[gfgcore, player]`, ONE account per player holding lives, the global ledgers,
premium, the last result, and a bounded table of per-game buckets (24 bytes each, keyed by an
8-byte game tag). Adding a game never adds an account and never needs a program change.

**GFG-BS must obey the same law from day one:**

- ONE account per PARTICIPANT, not one per feature, not one per game, not one per match.
- The account holds every platform value the participant earns or owns, in fixed slots.
- A new game = a new slot/row keyed by a game tag. No new account, no contract change.
- A new feature (points, lives, premium, competitions, AGM, rewards) = a new slot. Same.
- **Offsets are append-only.** New fields go LAST. A `version` byte goes FIRST from day one, and
  any layout change ships a permissionless, idempotent `migrate_*` in the SAME deploy, so a
  player's existing points/lives can never be touched or orphaned by an upgrade.
- Never `init_if_needed` onto a changed seed: that silently creates a NEW empty account and
  orphans the real data on-chain.

**Sessions** (the rooms) are separate from participant accounts. A session account exists for the
life of one room and is closed/ finalized at settle. Participant accounts persist across all games
and all sessions. This keeps the permanent footprint at exactly one account per player, no matter
how many games or features the platform ever adds.

```
Game  --emit signed event-->  GFG-BS Session  --batched-->  Arc
                                   |
                                   +--> value rail (points, lives, premium, AGM, ERC-20 ...)
                                   |
                                   +--> participant account [one per player, append-only slots]
```

This is exactly why MagicBlock scales: new features are new event kinds, not new infrastructure.
Tomorrow an ERC-20 reward, a shared wallet, a traded AGM challenge, or a payout to NFT holders is
one more slot/event type inside the same room, at no per-action cost.

---

## 6. Economics and sustainability (modelled on MagicBlock, not copied)

**How MagicBlock earns (verified from their docs):** ER transactions are free; they charge for a
**delegation session (0.0003 SOL)** and **commits (0.0001 SOL each)**. About 10% goes to the
protocol, 90% to the validator. They monetise **sessions and state commits**, not usage.

**GFG-BS equivalent:**
- The rail charges a **small fee on OPEN (session) and on SETTLE/commit**, configurable per game.
- Fee destination is configurable to: the GFG-BS deployer/admin wallet, or an on-chain escrow
  the deployer withdraws from.
- **The fee applies on DEVNET TOO, and it goes to the owner's wallet.** This is deliberate and is
  a real differentiator: MagicBlock's devnet "everything looks free" left devs unable to know what
  mainnet would cost them. GFG-BS devnet charges the same shape as mainnet, so a dev tests against
  the true economics before they commit.
- **GlobalFolkGames pays like any other game.** It is the proof of concept and the battle test; if
  the first user is exempt, the economics are never actually exercised before mainnet.
- At first the owner takes **100%** of the rail fee. If dedicated/faster infrastructure is added
  later, it can split the way MagicBlock does (protocol + node operator).
- No token, no subscription requirement to use the rail.

**Why the fee does not break the cheapness (the hard constraint):** the fee is a small **fixed
amount per session**, never per action and never per feature. Inside the session is free. So a
Ludo match, a chess game, an idle-game session and an MMORPG session all carry the same tiny fee,
and adding moves, dice, points, lives or rewards adds nothing. Cost tracks **sessions**, not
activity. That is what makes it a no-brainer for a dev to plug in.

**Player cost:** always zero. **Sponsor cost per session:** one open + one settle, both batched,
target well under a cent per session at scale.

## 6b. How a developer plugs in (the SDK question)

MagicBlock's integration is a package + macros, not a code copy:
- Program side: `cargo add ephemeral-rollups-sdk --features anchor`, then `#[delegate]` /
  `#[ephemeral]` macros.
- Client side: `@magicblock-labs/ephemeral-rollups-sdk` alongside `@solana/web3.js`.

GFG-BS must ship the same way. Consuming it must never mean forking it or copying contracts:

- **`@globalfolkgames/bs-sdk`** (npm package): `open()`, `act()`, `dispute()`, `settle()`, plus read
  helpers. This is the one-line integration a game uses.
- **`@globalfolkgames/bs-contracts`** (Solidity interfaces + deployed addresses per network): for a
  game's own contract to call the rail directly.
- **A per-game adapter** (small, ~50 lines) that serialises that game's state into the opaque
  session payload. Ludo has one; chess has one; an idle game has one. This is the ONLY game-specific
  code, and it lives in the GAME, never in GFG-BS.

So: adding GFG-BS to an existing game = install the package, write a small adapter, call four
functions. No contract editing, no rebuild of the rail.

**Package naming rule (do not regress):** the npm scope is `@globalfolkgames`, NEVER `@gfg`.
"GFG" is a monogram and is too generic to build a brand on; every install, README and import that
shows the full name is free brand distribution. The short "GFG-BS" is for internal prose only.

**Deploy cost:** one-time gas, single-digit to low-tens of dollars on Arc (research: roughly 100x
cheaper than Solana's refundable rent). Using the rail yourself costs only the per-session fee,
which returns to your own wallet.

---

## 7. Deployment shape (standalone, deploy once)

Separate from the GlobalFolkGames contracts. Suggested folder in the repo root for now
(it should become its own repo later):

```
globalfolkgames-bs/          <- standalone project (own Foundry project, own contracts)
  src/
    SessionRegistry.sol      <- open / close sessions; participant authorities; scope+expiry
    SessionState.sol         <- accept signed session events; sequence numbers; digest
    Randomness.sol           <- commit-reveal seed(s); derive hash(seed, counter)
    BatchWindow.sol          <- Merkle root per window; verifiable per-session proof
    ParticipantAccount.sol   <- ONE account per player; append-only value slots (PlayerCore law)
    FeeVault.sol             <- rail fee collection + configurable destination/escrow
    verifiers/               <- per-game verifiers (Ludo ships first)
  packages/
    sdk/                     <- @globalfolkgames/bs-sdk (the one-line integration)
    contracts/               <- @globalfolkgames/bs-contracts (Solidity interfaces + addresses)
  README.md                  <- the contract for any game to plug in
```

GlobalFolkGames then keeps its OWN contracts (game core, points, lives, subscription) and
**calls into GlobalFolkGames BS**. The game owns its economy; the rail owns the room.

Contract size: EVM cap is 24 KB per contract. This split keeps every piece small. Research
estimate for the core: roughly 500-1,500 lines of Solidity.

---

## 8. What GFG-BS explicitly does NOT do

- It does not enforce game rules (except inside an optional per-game verifier during a dispute).
- It does not know participant counts, seat meanings, boards, dice, or scoring.
- It does not hold player funds (an escrow module can, later, as a separate opt-in).
- It does not run any RPC, validator, or rollup node. No infrastructure to maintain.
- It does not require players to sign a result or pay gas.

---

## 9. Decisions (owner answers, 2026-09-21) and remaining questions

**Decided by the owner:**
1. **Fee timing:** at sessions AND commits (mirrors MagicBlock), i.e. open + settle. NOT per action.
2. **Fee value:** a small fixed amount per session; must not change the cheapness target.
3. **Fee destination:** the owner's wallet (or an escrow the owner withdraws from). Owner takes
   **100%** at first; a protocol/node split can come later if dedicated infrastructure is added.
4. **GlobalFolkGames DOES pay** the fee, on devnet too — it is the proof of concept and the battle
   test, and devnet must show true mainnet economics (a deliberate improvement over MagicBlock's
   "devnet looks free" confusion).
5. **The rail must be a standalone, separately-deployed project**, not the GlobalFolkGames
   contracts, so other game devs can use it without touching GlobalFolkGames.
6. **Randomness:** build ONE committed seed by default, with the field shaped as a LIST so a game
   may declare more than one independent stream later. No extra cost now, no game locked out later.
7. **Ludo verifier ships in v1.** It is the referee: if players disagree, the off-chain verifier
   replays the moves with real Ludo rules and decides the true winner, for free. It proves the
   tamper-proof claim end to end, it is half of the points-trust fix, and it is the pattern every
   future game copies.
8. **Naming:** the full brand goes everywhere a stranger can see it. The product is written
   **"GlobalFolkGames BS"**; the short form "GFG-BS" is used only in internal docs after the full
   name has appeared. npm packages are **`@globalfolkgames/bs-sdk`** and
   **`@globalfolkgames/bs-contracts`**. Reason: a monogram ("GFG") is too generic to build a brand
   on, and every install/README/import that shows the full name is free brand distribution. This
   mirrors MagicBlock, who did not brand their product "MB-ER".

**Still open (answer before build):**
9. **Participant account scope:** one account per player for the whole platform (the PlayerCore
   lesson), or one per player per game? Recommendation: ONE for the whole platform, with per-game
   slots, because that is what kept Solana cheap and what avoids the per-feature account explosion.

---

## Appendix A — the plain-language answers (read this, not the sections)

These are the answers given to the owner's questions, written simply, kept here so they can be
re-read later without the technical sections.

### What is "randomness" and why does it need a whole design?

Some games need unpredictable numbers (Ludo dice, a random bonus on a plot, a monster spawn point).
Chess needs none. Arc has NO built-in randomness: its random function always returns zero
(a known EVM issue). So the rail must supply it.

The rail seals ONE number on-chain before play starts (like sealing an envelope). Every random
event during play is then CALCULATED from that one sealed number: `result = hash(seed, counter)`.
At the end the envelope is opened, so anyone can prove every roll really came from that number and
was not chosen after the fact. This is "commit-reveal randomness".

The only open point was whether a game ever needs TWO sealed numbers at once (two players drawing
from their own separate decks). The answer: build one by default, but store it as a LIST, so a game
can ask for a second stream later without a redesign.

### What is a "verifier" and why build the Ludo one first?

A verifier is the referee. Settlement normally trusts the players' signed result. But if two players
disagree, someone has to check the actual moves and decide who really won. The verifier does that:
it replays the move list with the real Ludo rules and produces the true result. It runs off-chain
and costs nothing, and only when there is an actual disagreement.

Building the Ludo verifier in v1 matters because (a) Ludo is the first game and the demo, so it
proves the whole tamper-proof claim, (b) today points are credited on trust, and the verifier is
part of fixing that, and (c) every future game copies this pattern.

### Why not call it "GFG-BS" everywhere?

"GFG" is a monogram: it means nothing unless you already know the brand. For a standalone product
that OTHER developers will install, the full name should be what they see. So the product is
"GlobalFolkGames BS", packages are `@globalfolkgames/...`, and the short form is only an internal
convenience. Every developer who installs it, reads the README, or imports it in their code sees
"GlobalFolkGames" — free brand distribution. MagicBlock did the same: their product is not "MB-ER".

---

## 10. Build order (after this document is approved)

1. Write `globalfolkgames-bs/` skeleton + `README.md` (the plug-in contract). No logic.
2. `SessionRegistry` + `SessionState` + session keys. Test open/act/settle with a fake game.
3. `Randomness` (commit-reveal) + `BatchWindow` (Merkle flush). Test.
4. `FeeVault`. Test fee routing to the chosen destination.
5. Plug **Ludo** in as the first game (single-player first, then multiplayer).
6. Then points, lives, premium, and later competitions / AGM / ERC-20, as event types.

Each step ends with a live Arc testnet proof before the next step starts.
