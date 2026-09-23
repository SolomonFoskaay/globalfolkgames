# Designing Games for Foskaay GGI — HARD RULE (read BEFORE any game/demo design)

This rule is auto-loaded into every session. It governs ANY work that designs or
builds a game (or a game demo) on **Foskaay GGI** (`arcv2m18`), whether it is a
GlobalFolkGames game or an outside game. Read it, and the docs section it points
at, BEFORE writing a contract, a schema, or a design.

## The mandatory first step (do not skip)

Before designing any game contract for Foskaay GGI, READ the docs section
**"Designing a game for Foskaay GGI"** in `foskaay-ggi/docs/index.html`
(anchor `#designing`, live at `/foskaay-ggi/docs/#designing`). It is the source of
truth for how to optimise a game for the rail. Then state, in your first message,
how your design satisfies it (account count, where points are credited, where the
board lives).

## What Foskaay GGI actually is (the mindset)

- Foskaay GGI is a **transport, not a ledger and not a policy**. It takes the
  accounts a game already owns, lifts them off the base chain into the free room
  (the midchain), lets everything happen there for free, and commits them back.
- It does **not** create the game, players, points, lives or rules. The game's own
  contracts own all of that, permanently, on the base chain.
- The session is the room; the game and player accounts are the truth. Closing a
  session never erases them.

## The optimisation rules (from the owner's live MagicBlock ER experience)

The owner built on MagicBlock's ER as a beginner and hit this trap first-hand:
one account for the game, one for points, one for subscriptions, one for lives,
one for the player. Playing meant delegating 6 accounts at once. Adding a second
game (chess) forced a seventh. At 50 games it would be unmaintainable and the
fees multiply. The fix is consolidation. Every game design MUST follow it:

1. **One game account, not one per game.** Every game is a module or a bucket
   inside a single account. Adding game 50 costs nothing extra to lift.
2. **One player account, not one per game or feature.** Points, lives, records and
   per-game buckets live in ONE player account, lifted once for any number of
   games. Points are a storage field there, not a separate account.
3. **The player account is lifted WITH the match**, so crediting points is a free
   write inside the room, exactly like a move.
4. **The board is data (compact bytes), never graphics.** Store positions, counts
   and status as bytes. Never put images or SVGs on-chain. Graphics live in the
   browser, which only displays what the chain says.
5. **The target shape is 2 delegated accounts** (one game, one player) for any
   number of games. That is the 50 to 75 percent cost cut versus 6 to 8 accounts
   per player. The owner will not stop a dev lifting ten accounts, but the smart
   design is one game plus one player, and that is what we recommend and build.

## The runtime rules (keep it cheap and fully on-chain)

- **Nothing runs before the session is live.** No move, dice, timer, computer turn
  or point credit happens until the connect is confirmed (account lifted, fee
  paid).
- **Nothing runs after the session is gone.** Undelegating loses the free room;
  the game waits for the next session instead of paying base-chain fees.
- **Everything happens inside the room.** Moves, dice, turn timers, computer
  moves, lives and points are all writes inside the free room. Reaching for the
  base chain to credit a point makes the sponsor pay and destroys the saving.
- **Points are credited at game end, inside the room**, not at session settlement,
  because a batched session stays open across many games.
- **The frontend only displays.** No game state in the browser, no local storage.
  The contract is the only source of truth. The dice value comes from the rail's
  committed seed, never from the frontend.

## The pattern to mirror (MagicBlock, then Foskaay GGI)

MagicBlock's own examples (`rewards-delegated-vrf`, `rock-paper-scissor`) use three
layers: a game contract the outsider owns, a per-player account the outsider owns
that persists independently of any session, and the rail (their ER, our Foskaay
GGI). Mirror that: **game contract + player account + our two core contracts**.
The game links itself to the rail through `handover(gameLogic, ...)`, exactly as
their `delegate` links a game account to the ER.

## Before any game build, report

State plainly: (a) how many accounts will be lifted and why that number is minimal,
(b) where the board lives and its bytes size, (c) where and when points are
credited, (d) that nothing runs outside the session window. Then build only after
the owner approves the design.
