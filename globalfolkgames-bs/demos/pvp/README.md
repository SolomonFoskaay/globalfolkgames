# Genre: PvP / arena / 1v1 / battle cards

**Status: PLANNED. No demo built yet.**

## Who this is for
Developers building player-vs-player arenas, 1v1 battles, battle card games, or any competitive
game where two players directly contest an outcome.

## Why GlobalFolkGames BS fits
PvP is the genre where money and fairness actually matter, so the trust story matters most:
per-participant authority means a modified client cannot act as the opponent; a dispute is resolved
by the game's own verifier; and the players still pay nothing.

## Planned demo
`arena-1v1` — two players, turn-based battle, with a deliberate dispute path to demonstrate the
verifier.

## What it must prove
- Two real participants, each signing their own actions with a session key (no popups).
- The contract rejects an action signed by the wrong participant.
- A disagreement is resolved by the game's verifier, for free.
- The result settles once, and the loser cannot block it.

## Adapter surface (what a dev writes)
Roughly 50 lines plus a verifier for the game's own rules (the verifier is the referee that replays
the moves and decides the truth). The verifier is the only real work PvP adds.
