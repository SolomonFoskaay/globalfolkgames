# GlobalFolkGames — Architecture 2.0 (draft spec for review — NOT built yet)

Goal: turn the platform into a **gassless, all-on-chain, people-to-people native-game arena** where the earn economy is player/brand-funded (not platform-funded), payments are direct crypto (Solana-first), and every rule is transparent and verifiable. This is the redraw; the current M1-M11 architecture is preserved and remains the guide for everything already shipped.

## 0. Principles (non-negotiable)
- ER/gassless first: users never sign per-action or pay fees (embedded Dynamic wallet silently signs; sponsor/relay covers ER). Base layer only where necessary: funding a match, withdrawing winnings to a wallet, one-time initialize/delegate.
- Everything that the user trusts us on lives on-chain (pools, boards, winners, escrow, fees). No hidden server state for money.
- No token sale, no resellable NFT marketing; early-backer contributions optional and relevant later (see §9).
- International + local coexist: each earn competition either Local (NG, any country) or International, priced and redeemed in its currency/asset.
- Anti-abuse by design: max turn clock, match time caps, no cancel-on-loss, on-chain board, reputation system.

## 1. Earn format — the two engines (2-in-1, like CEX+DEX)
The earn layer is inspiration from CEX (one platform-funded liquidity pool) and DEX (community-provided liquidity):
- **Option 2P · P2C (platform computer, CEX-like):** the platform funds a bank of computer seats so there is always a maker/taker to match. Players can always see an opponent is labelled `(Computer)` or `(Human)`, check rating/lives/level, accept or reject. Platform sets the universal reward split; platform takes a fee from each finished pool.
- **Option 1P · P2P (player vs player, DEX-like):** the **Automated Game Matcher (AGM, invented by Solomon Foskaay)** matches open orders: a player posts an order ($1–$1,000 stake), AGM finds a counterpart (or N-way for 3–20 players), both approve (they can inspect each other's profile/rating), escrow locks both stakes, game runs, and the platform's published formula splits the pool to the winners. AGM is the match-maker only; the money is player-to-player.
- **Future: cross-chain** for non-Solana wallets (EVM via Dynamic embedded EVM wallet later; Solana-first for beta).
- Fees: a sustainable 5–20% sliding (higher stakes = lower %). Premium plans stay for lives/points/ad-free/boost (covers gas), separate from match fees.

### Liquidity for P2C (the hard part) — honest trade-off analysis (research summary)
- CEX-like: the platform seeds the computer bank so there are always fills. Risk: players "solve" the computer over time → net losses the platform cannot claw back. This is real and irreversible (unlike a token price that might recover).
- DEX-like community liquidity: others deposit SOL/USDC into the AGM bank, earn a share of match fees + possibly game-wins. Risk of **impermanent/banking loss**: if the computers net-lose to skilled players, contributors lose principal irreversibly.
- Recommended mitigations to make contributing attractive without tricking players:
  1. **Loss-protection reserve:** keep a platform reserve that tops up contributors (capped % of principal) paid from the platform's own fee revenue, so contributors never lose principal below a floor and the platform absorbs tail loss.
  2. **Fee-shared wins, not full wins:** contributors share a defined slice (e.g., 50% of platform fee + calibrated win-share), not the whole upside/loss; keeps EV better and bounded.
  3. **Bounded exposure/limits:** hard caps (per contributor, per day) so nobody can drain.
  4. Computer difficulty is skill-banded and re-balanced from on-chain history (transparent rules, not rigged).
  5. Staggered settlement (daily/weekly) + withdrawal cooldown to keep the bank stable.
- Recommendation: launch with **platform-funded P2C bank, small stakes, tight own-loss cap**; add community contribution as a **second phase** only after live win/loss data to calibrate honest EV. This avoids the DEX-flaw of early contributors fleeing after real losses.

### Leverage (Option 3)
Suggested framing that protects the platform: **"prop-style" banked loans** — a player stakes a collateral + platform lends X times on a **loss-floor stop** (auto-exit at a predeclared stop level), fee charged per round, and any automatic stop-loss is executed on-chain. Player can only lose their collateral (never more); the platform never covers a win with borrowed funds beyond the declared risk cap. Treat as a Phase-2, requires a banker model + careful on-chain stop execution.

## 2. Match rules / anti-abuse (applies to all earn games)
- Max match time: 30 min (2 players) / 45 min (3) / 60 min (4); configurable downward by game.
- Max turn time per player (per game constant, e.g., Ludo 60s): idle timeouts skip the player and pass the turn (their pieces may auto-advance per game rules). Stall is impossible.
- No reset/cancel mid-match once stakes lock (except agreed draw / platform infra failure → refund escrow).
- Board/moves are committed on-chain; result is settled by the same verification pipeline (proof rolls + result signature → seam → escrow distribution).
- Reputation/rating per game (win/loss history), visible to match parties; computers carry a fixed band (e.g., "Computer · Mid").

## 3. Payments (international, crypto-first)
- **Solana-first (beta):** user pays with their embedded Dynamic SOL wallet which we fund by guiding them to a faucet/exchange deposit; payments are **Solana Pay** (request) or a plain SPL transfer (USDC/USDT/SOL) to the sponsor wallet. Exceptionally low fees, global, no KYC/business-registration gate.
- **Automation:** the relay watches incoming transfers to the sponsor wallet (or a pay request ref), **verifies amount + memo**, then instantly credits the buyer's on-chain premium points **on their own embedded wallet's premium PDA** (same account the site reads) → they use the existing Upgrade page to activate. Buildable together now; full auto-activation (upgrade on payment) is also buildable later since the credit already unlocks it — see proposed flow box below.
- Cross-chain stablecoin acceptance (USDC/USDT/USDG on EVM) is Phase-2 via Dynamic's embedded EVM wallet, same pattern.
- Abnormal-profit checks, memo-based order IDs to bind a payment to a purchase; on-chain receipt for every purchase.

## 4. Competitions split local vs international
- Local (NG, then per-country): pool + reward in that country's currency/airtime (existing structure).
- International (stablecoin/USD): winners paid in USDC to the embedded wallet; consider ≥5 winners (fewer, larger) so on-chain transfer fees remain worth paying on small amounts; micro-rewards (<$0.10) are batched or credited as points to avoid transfer economics.
- Both read the same Final-Points board + gfgwin winners; payout mode differs by instance (manual local manual Naira/airtime; international direct transfer).

## 5. Platform money model (sustainability)
- Sources: match/competition fees (5–20%), Premium plans (lives/points/ads-free/booster), 500P competition entry, affiliate 20%, future merch/ads/escrow rake.
- Earn competitions stop being subsidized from platform re-serves: their pools come from entrant fees + sponsor funding when a brand pays in.
- Launch: devnet = everyone plays free (devnet SOL is free), proving the pipeline; mainnet funding via early-backer contributions or grants (Solana Foundation / MagicBlock) with on-chain accounting (escrow, claims, no token sale).

## 6. On-chain inventory needed (additive; list for the build phase)
- P2P: escrow match vault per game (`[gfgms, players…]`), order/AGM state, settlement, fee split.
- P2C: computer bank account + risk caps.
- Anti-abuse: turn-clock + match-time commit.
- Rewards: winners → player points/ledger + optional direct USDC payout from sponsor.
- All additive seeds; no re-design of what exists (M1-M11 preserved).

## 7. Research grounding (to verify during build)
- MagicBlock ER: gasless execution layer; confirm SPL token account support inside ER sessions vs base-layer for settlements (funding/withdrawal base-layer is fine).
- Solana Pay spec + SPL Transfer for the payment link/QR; memo for order binding.
- Spl Token/Token-2022 for USDC/USDT; balances visible on-chain for auto-verify.
- AMM/impairment-loss literature for the P2C liquidity pool honesty (see §1).

## 8. Open questions for you to decide
1. Sliding fee table (exact %s per stake band) — pick a default table for the build.
2. Computer-difficulty banding + whether computers can be beaten net-of-fees (affects P2C bank economics).
3. Keep Premium plans as the "gas/comfort" subscription while match fees are separate? (Recommendation: yes.)
4. Entry rework: keep 500P competition entry or replace with direct $s to reduce friction (you mentioned possibly lowering/removing to grow P2P orders).
5. Receive the $10K early-backer as (a) escrowed SOL with 1–3yr profit-share claims, (b) grants-first, or (c) both.

## 9. Not going to change in 2.0
M1-M11 modules, seams, universal folders, identity=GFG handle, ER-gassless-first, anti-crypto wording on the homepage, Beta badge, the run-sheet/dashboard tooling, the logo/background, and the send/earn rules already tested.