# M3 — Local points (per game, PURE)

Verified gameplay + win only. No multiplier, no purchase, no bonus, no
referral. Never diluted. The bragging-rights source of truth per game.

## Contract (future; this folder is the canonical home)

- On-chain per-game points PDA: seed `[gfgpoints, game_tag, player]`, one
  ledger per game (`ludo`, `ayo_olopon`, ...) so 50+ games each stay isolated.
- `record_points` writes ONLY the pure base win (100), never a multiplied total.
- Proof-of-play gated: a valid on-chain roll must exist for the win to bank.
- Consumes the seam (M2): subscribe via `window.onGameResult` and bank local
  points from verified finishes (`status === 'finished'` only).
- Feeds local in-game levels; future: level as an untransferable on-chain NFT.

## Status

`planned` (architecture.json is the source of truth). Today's single
`gfgpoints` PDA that records a multiplied total is the pre-module model; the
next build migrates it here (to purely own-game pure wins).