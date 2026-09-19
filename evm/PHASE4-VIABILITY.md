# Phase 4 — Viability report (arcv2m16, Arc rail)

Status: measured on Arc Testnet, 2026-09-18. Gate before mainnet.

## 1. Verdict

The Arc rail is viable and cheaper than the Solana rent model at any real scale.
Gasless holds for the player (the app's own relayer pays), and batching removes
the per-game cost almost entirely. Remaining work is engineering and ops, not
cost. Two things still to decide: the settlement window length, and the exact
receipt UX while a batch is open (both explained below).

## 2. How single vs batch actually works (no manual watching)

The relayer runs a small background loop. There is ONE rule for every window:

    FLUSH when (games in the pending batch >= N) OR (window age >= T)

whichever comes first, and at the same time ALWAYS flush when a window closes,
even if it holds only one game. Nobody watches players, and nothing waits for a
"full" batch.

- Low volume (launch): the window timer fires and the batch closes with the few
  games it has. One transaction. No waiting for 100.
- High volume: N is reached long before T, so batches fill naturally.
- Empty window: if no games happened, there is nothing to flush and no cost.

So "scattered through the day" is handled by T, and "busy" is handled by N.

## 3. Early-stage cost (5 to 10 games a day)

One flush transaction is about 0.000725 USDC (measured, 28,985 gas at 25 Gwei),
plus one seed commit and reveal per window (about 0.00237 USDC).

| Window T | Flushes/day | Open+settle roots/day | Seed/day | Total/day | Games/day | Cost per game | USDC per 1,000 games |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 24 hours | 1 | 0.00145 | 0.00237 | 0.00382 | 10 | 0.000382 | 0.38 |
| 6 hours | 4 | 0.0058 | 0.00237 | 0.00817 | 10 | 0.000817 | 0.82 |
| 1 hour | 24 | 0.0348 | 0.00237 | 0.03717 | 10 | 0.003717 | 3.72 |

So at launch a **daily window** costs well under 0.01 USDC/day (about 0.11 USDC
a month) and already sits near **1 USD per 2,600 games**. A shorter window costs
more per game but shows the proof sooner.

Recommendation: **start with T = 1 hour and N = 100, then widen T if the cost
matters.** At real launch volume the timer rarely fires because N fills first.
Make T and N config, not code, so this is a setting you can change any time.

## 4. Cost table (measured)

Unbatched, one game end to end: **0.011034 USDC** (open, seed commit, charge
life, seed reveal, record points, settle).

Batched root, one transaction for N games (O(1) gas):

| N games in one tx | Gas | Per-game USDC |
| --- | --- | --- |
| 1 | 28,985 | 0.00072463 |
| 20 | 28,985 | 0.00003623 |
| 100 | 28,985 | 0.00000725 |
| 1000 | 28,997 | 0.00000072 |

At N = 1000 a game costs about 0.0000007 USDC, so **1 USD covers about 1.4
million games**. Even N = 100 gives **137,000 games per USD**.

## 5. Receipts while a batch is open (the UX answer)

Every game gets TWO receipts, so the player always has something instantly and
a hard on-chain proof soon after:

1. **Instant receipt (at game end, free).** The app signs the match result
   (matchId, players, result hash, the committed dice-seed hash, points). The
   card shows it right away, labelled "pending on-chain flush" with the window
   it will land in (for example "within 1 hour"). It already commits to the dice
   seed that was published BEFORE the game started, so the roll cannot be
   changed by anyone.
2. **On-chain receipt (at flush).** When the batch transaction lands, the card
   upgrades to "verified on-chain" and shows the batch transaction hash plus the
   game's **Merkle proof**, which the verify page checks against the on-chain
   root. The first, second, and hundredth game in the batch all get their own
   proof. No game depends on another game's receipt.

If instant on-chain proof is preferred over lowest cost, there is a config knob:
anchor each match start with its own tiny transaction (about 0.00243 USDC), which
is about **1 USD per 400 games** at launch volume, then keep the batch for the
settle and points. Switchable per environment.

## 6. Optimizations to reach 1 USD per 1,000 to 10,000 games and better

1. **Window flush** (above): one transaction per window instead of per game.
2. **Combine the per-game writes**: charge life, record points and settle can be
   one contract call instead of several, cutting the unbatched game to about
   0.004 USDC.
3. **One seed per window** instead of per game.
4. **At scale, Merkle root plus claim**: the batch records a root, and balances
   are updated when claimed (or lazily), so the per-game cost approaches the
   batch share (0.0000007 at N = 1000).
5. **Sponsor guardrails**: a balance monitor and a daily spend cap on the
   relayer, so a bug can never drain it.

## 7. Mainnet projection

- Deploying the contracts: gas only, a few dollars. No rent, no per-player
  account, unlike Solana (about 1,009 USD program rent plus about 0.56 USD per
  player).
- Running cost: window flushes plus sponsor gas. At 10,000 games a day with an
  hourly window and Merkle batching, the monthly figure is roughly single-digit
  USDC, and the per-game cost keeps falling as volume grows.

## 8. Remaining gaps before mainnet

1. Wire the chain adapter so the browser actually uses Arc (`VITE_GFG_CHAIN=evm`).
2. Relayer hosting (a small always-on service, still no paid platform) and its
   uptime plan.
3. Dispute window and a bond for the optimistic result model.
4. Merkle proof generation and the verify page for Arc.
5. Sponsor cap plus balance alerts.
6. Decide the window T and the instant-versus-pending receipt default.

## 9. Recommendation

Proceed. Use a config-driven window (T = 1 hour, N = 100 at launch), Merkle
proofs for verification, the self-hosted relayer for gasless, and revisit T as
volume grows. This meets the cost goal (1 USD per thousands to millions of
games) and preserves the web2 feel.
