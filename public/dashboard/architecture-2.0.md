# GlobalFolkGames — Architecture 2.0 (FINAL DRAFT for review — NOT built yet)

Scope: a gasless, **fully on-chain**, people-to-people native-game arena. Earn = P2P / P2C / Leverage only. No "earn competitions", no local/international split, no subsidized pools. The existing M1-M11 architecture (shipped modules, seams, universal folders, identity = GFG handle) is preserved and is the foundation; v2 rebuilds the M1 game core around multiplayer + matched play, and layers the earn rails on the same seams.

## 0. Principles (non-negotiable)
1. **Everything that is money/trust lives on-chain.** Pools, locks, boards, winners, fees, payouts, margin, stop-losses. There is no hidden off-chain state that affects value.
2. **Gasless for the player.** They never sign per action or feel fees. The embedded Dynamic wallet silently signs; the ER does the execution.
3. **About the "relay" (honest answer to your question):** a server-side *signer* is unavoidable in every system, because a private key must live somewhere and 'watching' an inbox/settling at a trigger is off-chain automation. What we guarantee: the relay **never holds or controls value**; every action it takes is a signed on-chain transaction anyone can verify (payments, credits, escrow releases, payouts). Its only authority is what the program's rules give it (admin/creator gates), and the contract's on-chain state is the single source of truth. There is no off-chain ledger, balance, or hidden rule.
4. **Base layer only where required**: funding a match/pool, withdrawing to a wallet, one-time initialize/delegate. Everything else ER (gasless).
5. No token, no resellable NFT, no VC. Early-backer contributions are escrowed on-chain with time-based profit-share claims (see §7).

## 1. M1 v2 — Game core with multiplayer
- Rebuild M1 around **multiplayer** while keeping the M2 result seam: every game emits `publishGameResult` exactly as today.
- Modes (per game): **Solo** (you vs computer/human seats, free, points only) and **Multiplayer** (abbreviated 2mp, 3mp, 4mp... = the number of HUMAN wallets in the match, earn-capable). There are NOT two versions of a game: the single game build powers both - Solo just has no money+AGM attached. Per-game seat capacity is dynamic (Ludo supports 2-seat or 4-seat; Monopoly 5-8 seats; etc.), so '2p/4p' (seat count within Ludo) is never confused with 'mp' (how many humans).
- Earn fill rules: an earn match fills 2..N human wallets via AGM; if not enough humans accept within the window, the remaining SEATS get a labelled (Computer) seat only when the mode is P2C-allowed (player can reject).
- Deterministic game logic + **on-chain board/move state** for any match that involves value (could be heavy; we ship move-hashes + committed board snapshots at checkpoints; final settlement on-chain). Confirm with MagicBlock ER limits during build (see §9).
- Turn clocks + match time caps enforced by the program/time service (§4).

## 2. Earn engines (2-in-1, CEX bank + DEX community)
- **P2C (platform computer, CEX-like "bank"):** the platform funds a pool of computer seats so matches always have a counterpart. Opponents are always labelled `(Computer)` vs `(Human)` with skill band; players accept/reject. Platform publishes the reward formula and takes its fee from the finished pool.
- **P2P (player vs player):** the **Automated Game Matcher (AGM, invented by Solomon Foskaay)** matches open orders. Player posts an order ($1..$1,000 stake), AGM matches a counterpart (2-way; N-way up to 20 for tournaments), both approve (profile/rating visible, reject allowed), escrow locks both stakes, game runs, the published split pays winners. AGM matches only; money is player-to-player.
- **Leverage (prop-style):** player posts collateral; the bank extends X multiples on a declared **stop-loss floor**; auto stop is executed on-chain. Player can only lose their collateral; the platform's exposure is capped by the risk floor and a per-round fee. Phase-2 (needs banker accounting + on-chain stop execution).
- **P2C break-even that does NOT need cheating (owner question, honest answer):** the platform charges 10% of the POT (not of one side). For a 2-side match each side stakes S, pot = 2S, winner gets 1.8S, the loser gets 0. If the platform is the computer side:
  * computer wins  -> platform collects 0.8S profit (its 0.8S share over its stake).
  * computer loses -> platform loses S (its stake).
  EV per match = S x (1.8w - 0.8), where w = computer win rate. Break-even is w ≈ 44.4%. So the computer only needs to win roughly 45%+ of matches for the platform to break even - and any skill band above that is profit. Players mastering and beating a mid computer (say 40-45% win rate) is FINE: the house isn't losing at 44%. Mitigations we will build, in order:
  1. **Flat 10% pot fee** pays the house first (this is the core anti-loss lever - no manipulation needed).
  2. **P2C begets P2P:** computers fill seats when no human counterpart exists, at capped low stakes; P2P is the primary and it is fee-only revenue with NO house exposure.
  3. **Daily/maximum loss cap** on the computer bank (e.g., pause funding for the day if net loss hits X) on top of stake caps per match - tail risk bounded.
  4. Difficulty bands set transparently from on-chain history; computer strength is loud and visible, never rigged per-hand.
  5. Community liquidity is PHASE-2 (later), after live data proves the bank EV, and only with the loss-protection floor + caps from §1.
- Fees: FLAT 10% of each finished pot for every earn match, all modes, all games (one number everywhere, printed up front). Premium plans stay as the separate comfort/gas subscription (lives, points, ad-free, booster, bigger daily).

## 3. Match rules / anti-abuse (all earn modes)
- Max match time: 30 min (2p) / 45 min (3p) / 60 min (4p+), per-game override.
- Max turn time per game (e.g., Ludo 60s): idle → the turn passes / auto-moves per game logic; stalling impossible.
- No cancel on loss: once stakes lock, only a rules draw or platform-infra refund ends it.
- Reputation/rating per game, visible to match parties; computers carry a fixed band label.

## 4. Payments & payouts (crypto-first, honest)
- **Solana-first (beta):** pay with the user's embedded Dynamic SOL wallet or any external wallet; **Solana Pay / SPL transfer (USDC/USDT/SOL)** to the sponsor key, with a memo order id. Instant on-chain credit of premium points/upgrade to the **same embedded wallet** the site reads (existing Upgrade flow completes it). Low/near-zero fees, global, no business-registration gate. EVM stablecoins (USDC) later via Dynamic embedded EVM wallet.
- Payouts: on-chain (to the player's embedded/wallet), or escrow release to winners; small amounts batched/credited as points when on-chain transfer economics would eat the value.

## 5. Platform money model (sustainability — earn is NOT subsidized)
- Revenue: match fees (5–20%), Premium plans, competitive entry (S point or S-credit), affiliate 20%, later merch/ads/escrow.
- Earn pools come from players (P2P escrow) or the platform P2C bank's own capital; no grants to keep competitions going.
- Devnet launch: everyone plays free (devnet SOL is free) to prove the pipeline; mainnet funding via early-backer escrow or grants (Solana Foundation / MagicBlock) with fully on-chain accounting.

## 6. On-chain inventory needed (build list, all additive)
- Escrow match vault per game/players (`[gfgms, …]`), order book / AGM state, settlement + fee split.
- P2C bank + risk caps account.
- Turn-clock + match-time commit.
- Leverage margin + on-chain stop (Phase-2).
- Winners → player points/ledger + optional direct USDC payout.
- No changes to existing M3-M11 seeds/layouts.

## 7. Early backer (no token, no resellable NFT)
- $100–$500 contributions toward the ~100 SOL mainnet runway via on-chain escrow; backers get 1–3 years of highest membership + a percentage share of platform revenue over that band, claimable (daily/weekly/monthly) on-chain; distribution ends at the term. Uses the same on-chain accounting/escrow so every income stream is traceable.

## 8. What does NOT change in v2
M1-M11 seams & universal folders, GFG-handle identity, ER-gassless-first, base-layer rules, homepage anti-copy wording, Beta badge, tooling/run-sheet, brand colors, no-token stance; the old earn competition module (M7 launch) is **retired from v2** (superseded by the AGM engines).

## 9. Research to confirm before/while building
- MagicBlock ER: limits on arbitrary read/simple state per tx; whether on-chain board snapshots per turn are affordable vs commit-hash+checkpoint.
- Solana Pay + SPL transfer for payments; memo binding; balances on-chain.
- Token-2022 for USDC/USDT; base-layer settlement for escrow/payoffs.
- AMM/impermanent-loss literature for the P2C bank (already summarized in §2) and on-chain stop mechanics for leverage.

## 10. Open decisions before we build (want your picks)
1. Fee table (default: \$1-\$10=10%, \$10-\$100=7%, \$100+\$1000=5% — confirm or set your own).
2. P2C computer difficulty bands & whether the bank must net-break-even per month.
3. Keep Premium plans separate from match fees (recommendation: yes).
4. Competitive entry: keep S-credit entry or drop to reduce P2P friction.
5. Funding: early-backer escrow vs grants-first vs both.
6. Multiplayer real-time latency target (e.g., cross-turn ≤ 5s) and whether any game ships P2P at launch or solo+P2C first.

Finalize these six and the doc becomes the build guide; we start the M1 v2 rebuild (multiplayer + AGM seams) from there.
---

## M1 v2 MODULE SPEC (draft for approval - will become the build contract)

### Summary
M1 v2 = the multiplayer native-game core. Every game keeps the existing M2 result seam, but the game core now also supports 3 play modes: **Solo** (vs computer, free, points only), **Multiplayer** (AGM-matched real players; match-code for private games), **P2C** (AGM-matched computer, earn). Deterministic moves are committed on-chain (board snapshot checkpoints + move hashes; full board replay on chain for earn games where affordable, ER permitting). Turn-clock + match-time are enforced. Identity = GFG handle (never name/email/wallet).

### expectedInput (what M1 v2 receives)
- FROM M2 SEAM: the normalized `gfg:game-result@1` envelope (seat/actor/position, proof sig, finishedAt) - unchanged, games keep emitting it.
- FROM THE LOBBY/AGM MODULE (new): match config `{ mode, players:[{wallet,handle,rating}], poolUsdCents/stake, ruleset, clocks, escrowRef }`. Earn matches only start when escrow (AGM) confirms funds are locked.
- FROM M5 (plans): allowed-tier gate for earn modes (mirror of competition tier gating).
- FROM GAME RUNTIME: per-turn state checkpoints `{ matchRef, turn, hash }` the game posts to the on-chain board.

### expectedOutput (what M1 v2 exposes)
- `publishGameResult` completes as today PLUS additive fields: `mode`, `players[]` (handle + wallet), `stake/PoolUsdCents`, `escrowRef` so M3 (local points), M4 (global), and the earn engines can consume without reading game internals.
- On-chain board records per match: participants, committed move checkpoints, turn times, final result → readable by M3/M4/AGM/escrow for rewards, fees and dispute checks.
- A `matchState(matchRef)` API (relay) returning participants/rules/timers so the AGM + escrow lock and settle deterministically.

### Dependencies/order
Build M1 v2 in this order: (1) on-chain board + move commit instruction; (2) AGM lobby + P2P match lock; (3) clocks/timeouts; (4) P2C bank binding; (5) settle/fee. Solo/non-earn play keeps working with zero changes (existing seams).

---

## M6 v2 AFFILIATE (automated instant payout — owner 2026-08-25)
- Replace the manual monthly settle with an **atomic on-chain split at payment time**: when a paying upgrade/subscription/booster purchase finalizes, the program credits **80% to the platform wallet** and **20% to the referrer's embedded wallet instantly** (premium points/ledger), all in one transaction. No manual worker, no monthly batch, no admin payout step.
- Referral pairs are already recorded on-chain at signup (affiliate module present, M6). Only the payment seat for the referred first-paid purchase triggers the split; subsequent paying months keep splitting the same way (they are still "this purchase pays the referrer").
- If no referrer: 100% to the platform wallet. Non-refundable policy stays and is shown.
- Fees journey: pay → split (80 platform / 20 referrer) → buyer's premium points credited (existing 5,000/10,000/500P flow) → Upgrade page completes activation.
