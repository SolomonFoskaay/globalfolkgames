# GlobalFolkGames — Agent Project State

This file is the source of truth for future coding sessions. If your context is
stale, read this first, then verify with `git status` and `git log --oneline -5`.

## What this project is

Classic folk games (Ludo first) played in the browser, with a **provably-fair,
GASLESS on-chain dice** powered by MagicBlock VRF. Players are onboarded
Web2-style: they sign in with email OTP (Dynamic), never hold or pay SOL, and
every dice roll is a cryptographically verifiable on-chain roll.

## Terminology (IMPORTANT — do not confuse these)

- **VRF** = the randomness primitive. All dice randomness comes from MagicBlock
  **VRF** (on-chain, verifiable). When talking about dice/randomness, use
  "VRF" — never "ER".
- **ER (Ephemeral Rollup)** = the gasless execution/points/rewards LAYER. The
  ER is where future on-chain rewards live (`record_points`-style instruction on
  the same delegated program) and where rolls are executed gaslessly. Do NOT
  call dice randomness "ER randomness"; calls it the "ER VRF queue" only when
  describing WHERE the VRF runs. When discussing rewards/points, use "ER".

## Module guide (THE master plan — never derail, read before any feature work)

The platform is built as **pluggable modules, not a rigid stack**. Every feature
(current, new, future) MUST belong to a module. Nothing gets built standalone,
and modules must seamlessly integrate with each other. The single source of
truth is `public/changelog/architecture.json` (rendered on the staff page
`/changelog/architecture.html`). Module status lives THERE, not in AGENTS.md
(AGENTS.md only mirrors the current state).

**Modules (M1-M9):**
- **M1 — Game core:** the games themselves (Ludo now), board rules, moves,
  win detection, timing/AI constraints. Game-agnostic: adding a game = adding a
  game module, the rest of the platform doesn't care which game is running.
  M1 is ONE module; its game core sub-module **M1A** covers EVERY game (the
  dropdown on the M1 admin page differentiates them: M1A Ludo locked, M1A Ayo
  Olopon planned, ...). Each game's LOCKED build spec lives under M1's `games`
  in architecture.json and is the build + test benchmark.
- **M2 — Universal result seam (the plug-and-play contract bus):** the one
  integration contract between every game and every reward module. Standalone
  because it is the platform's wiring, not a game and not a reward. Every game
  ends with `window.publishGameResult()`; every reward module subscribes via
  `window.onGameResult()`. 50 games = 1 reward plug, 1 competition plug.
  Its canonical home + the whole universal-modules tree lives in
  `public/universal/` (`result-seam/` = M2, plus homed folders for M3-M8).
- **M3 — Local points (pure):** per-game board points, no platform rule. The
  old "+100 1st-place" rule is DROPPED; a game's own scoring is purely its own.
  Consumes the seam (M2).
- **M4 — Global ledgers:** platform-wide ledgers (lifetime points, spendable
  points) that aggregate game results. Points flow game -> seam -> local ->
  global. Consumes the seam (M2).
- **M5 — Active Tier subscription + Premium points:** the money + launch engine.
  Premium points live on their own on-chain ledger ([gfgprem, player], buy-only,
  premium_lifetime + premium_spendable). The plan LADDER is CONFIG-DRIVEN
  (owner 2026-08-22) so more levels are added as data, never code. Launch ships
  **Level-2 2x** (5,000P activation; launch discount now $5, Nigeria N5,000,
  regular $10) and **Level-3 3x** (actual $20, discounted $10 / N13,500,
  Nigeria N8,000; 15 lives/day, 300P/day reward, 3x win multiplier, 1.5x earn
  competition final-points boost, AND ad-free (Monetag ads suppressed for
  active Level-3, so Free/L2 carry the ads and the upgrade is visible);
  activation premium cost TBD, proposed 10,000P). Plans are non-cancellable/non-refundable 30-day on-chain subs
  (no auto-renew); the win multiplier applies at M4 flow-up. Owner-approved
  2026-08-20; the M5 spec in architecture.json is the LAUNCH GUIDE (payment
  pipe, admin credit, receipts/logs, daily reward + lives boosted values,
  12-month affiliate, daily earn campaign).
- **M6 — Point sources:** launch = 500P signup bonus (once per wallet, permanent
  on-chain fence) + 12-month affiliate (20% of each referred plan’s PAYABLE USD price, read
  live from the config-driven plan ladder so a plan price change auto-updates
  the share (L2 $5 = $1.00, L3 $10 = $2.00), never fixed to a plan; USD cents
  on-chain; referrer must hold an ACTIVE qualifying sub that month or that
  month is forfeited, and 2 consecutive inactive periods (~60 days)
  permanently close that pair; manual Naira payout 3-7 days). Giveaway/social deferred. All feed M4b+M4c via kind=1
  credits, never M3/M4a. In-progress.
- **M7 — Competitions:** on-chain CONFIG-DRIVEN earn-competition framework
  (owner-approved 2026-08-22, in-progress). Every competition is an ON-CHAIN
  INSTANCE created through an ADMIN CREATOR UI (dropdowns + multi-selects):
  allowed subscription levels MULTI-SELECT (L2 + L3 + more, any-of, or
  all-of combinators), games multi, spendable-family multi, entry cost, window
  start/end + DURATION dropdown (6h..30d..1m, not fixed 24h), USD pool, prize
  shares, redemption + payout mode. **FINAL-POINTS RANKING (R17):** winner
  position = Total Points (in-window) x LIVE tier boost (L3 1.5x / L2 1.0x);
  the boost is re-read at every render, so a mid-window downgrade to a
  non-qualifying level hides the player instantly (not removed), and L1 at the
  final freeze earns no position. NO web2 db (no Supabase) for the competition
  lifecycle - rules R12-R18. Launch instance = LUDO EARN (72h, was 24h): $2 pool (= 1,000 pts @
  $0.002/pt) split TEN ways (1st N1,000 / 2nd N600 / 3rd N300 / 4th N200 /
  5th N150 cash, 6th-10th N100 airtime each = N2,750), and the public
  PAST-COMPLETED section shows each window’s winners + points/USD share +
  paid status from on-chain gfgwin. One entry/account/window, any-of {L2,L3}
  + 500P entry, manual payout, redemption agnostic. On-chain winners via additive [gfgwin, comp, rank] +
  record_competition_winners + mark_winner_paid (approved). Full
  multi-sponsor settlement + escrow stays DEFERRED until M1-M6 stable.
  Consumes the seam (M2). In-progress.
- **M8 — Sponsor escrow:** on-chain brand event rake (30/70, prizes escrowed).
  The escrow proof-of-life; product build waits behind M1-M4.
- **M10 — Lives + daily rewards:** the free-play gate (free 5 lives/day, Level-2
  10/day, Level-3 15/day, GMT+00 reset, consumed ONLY on match completion, never on abandon/reset/
  disconnect) + daily earn (free 25P/day, Level-2 200P/day, Level-3 300P/day, kind=1 credit into M4,
  new source_code 14). Ships inside the M5 build window. In-progress.

**HARD RULES (do not regress):**
0. **Surgical edits only, never rewrite.** When updating any code (adding a
   feature, fixing a bug, or changing behavior), the agent MUST:
   - **Read the entire file first** to understand what it does and every side
     effect it has (DOM manipulation, event listeners, global state, script
     loading order, other pages that depend on it).
   - **Identify the exact lines** that need to change for the specific task.
   - **Edit only those lines.** Never rewrite, reformat, or "clean up" unrelated
     code. Never remove existing functionality to make room for new code. Never
     reorder imports, script tags, or CSS unless the task explicitly requires it.
   - **Preserve all existing behavior** that is not part of the task. If the file
     has admin gates, auth checks, role rendering, event listeners, or any other
     side effect, those MUST continue working exactly as before.
   - **Check cross-file dependencies.** Before editing a shared file (header.js,
     profiles.js, auth.js, etc.), check EVERY page that loads it and confirm
     the edit won't break any of those pages.
   - **Ask the owner before removing anything.** If the agent thinks a piece of
     code is dead or unnecessary, it MUST ask the owner first, never silently
     remove it. The owner decides what stays and what goes.
   This rule exists because repeated rewrites have broken admin gates, auth
   checks, global header behavior, and menu rendering across multiple pages.
1. **Every feature = a module.** Before writing ANY feature code, state which
   module it belongs to and confirm it slots in (via the module status in
   `architecture.json`). If it doesn't fit a module, it does not get built.
   A feature that is important and standalone earns its OWN new module
   (recorded in `architecture.json` FIRST) — never bury it inside another
   module's details.
1b. **Module-First is enforced in the agent.** The project rule at
   `.opencode/rules/module-first.md` is auto-loaded into every opencode session
   (`opencode.json` `instructions`). It MUST be followed for ANY feature work —
   read `architecture.json` first, state the module, slot check, renumber by
   build order when inserting a module. Never skip it; the owner will not repeat
   this.
2. **M7/M8 scope gate.** The FULL multi-sponsor competition settlement platform
   (M7) and the sponsor escrow product (M8) do NOT start until M1-M6 are stable
   and verified for Ludo. The competition FRAMEWORK (owner-approved 2026-08-22,
   in-progress) is different: it ships for launch as an on-chain config-driven
   create-your-own-competition system (admin creator UI + on-chain instances,
   rules R12-R16, no Supabase) with the Daily Ludo Earn launch instance, because
   there is no ad budget and the daily campaign + 12-month affiliate ARE the
   launch marketing. The on-chain S2 escrow + Scope C finish-order code that
   ALREADY exists stays (program id unchanged, idempotent, verified live on
   devnet) but multi-sponsor settlement / sponsor-funded builds wait.
3. **Modules integrate cleanly.** Each module is a seam: games (M1) emit into
   the result bus (M2); local points (M3) and global ledgers (M4) consume it;
   spendable (M4) buys tiers (M5) or enters events (M7). Never hard-wire one
   game into the platform.
4. **Universal result seam (M2, the plug-and-play contract):** every game ends
    by calling `window.publishGameResult()` (`public/universal/result-seam/game-result.js`,
    canonical `gfg:game-result@1` envelope: `players[]` with seat/actor/position|score +
    optional on-chain proof). M3/M4/M7 subscribe via `window.onGameResult()` and
    NEVER read game internals. A game never ships its own reward/competition
    plug — 50 games = 1 reward plug, 1 competition plug. Adding a new game =
    emit the same envelope; the platform doesn't change.
4b. **Universal modules folder (`public/universal/`):** every platform-side
    module that plugs into any game has a canonical folder there
    (`result-seam/` = M2, `points/` = M3, `ledgers/` = M4,
    `subscription/` = M5, `point-sources/` = M6, `competitions/` = M7,
    `escrow/` = M8). A game plugs in ONCE (`publishGameResult`); a universal
    module subscribes ONCE (`onGameResult`) and updates inside its own folder
    without touching the game. UNIVERSAL MEANS REUSABLE BY NAME: a universal
    module is game-agnostic - ANY M1 game (Ludo, Ayo Olopon, ...) plugs into it
    and reuses it; it is NEVER tailored to one game the way M1 game code is.
    M1-only game tooling (like the `/verify/` receipt explorer, proof-of-play)
    is NOT a universal module and does NOT live in `public/universal/`. New
    universal capabilities land in this tree and mirror into `architecture.json`.
    **BUILD RULE (hard):** when building ANY universal module (M2-M8), the code
    MUST live in its canonical `public/universal/<folder>/` — never in `src/`,
    never in a game folder, never scattered across the repo. The folder is the
    module's home; its README documents the contract; `architecture.json` holds
    the spec. Before writing any universal module code, check this tree first.
4c. **RPC/region-agnostic build rule (hard, locked 2026-08-18):** every on-chain
    capability in ANY module MUST be RPC/region agnostic by construction.
    (1) Every new per-player PDA type ships its own `undelegate_*` instruction
    in the SAME program build, so any account can leave a flaky/banned ER region
    and be re-pinned to a healthy one (the 2026-08-18 US-route ban was survived
    by migrating all 13 tracked PDAs to AS, not by redesigning). (2) Client/
    relay/probe code never hardcodes a single ER endpoint or region: resolve
    each account's ACTUAL hosting region from the Magic Router
    (`getDelegationStatus` -> fqdn) and submit/poll there, with the 3-region
    registry + failover (`src/gfg-rpc.js`) as the base transport. (3) Delegate
    account maps use the relay's camelCase key form (`bufferGlobalPoints`/
    `globalPoints`), never snake_case, for the `#[delegate]` helper accounts —
    snake_case keys fail with "Reached maximum depth for account resolution".
    A banned/failing region is always a re-pin job, never a feature outage.
5. **Feature Tracker stays synced.** Roadmap items reference their module
   (e.g. "Earn competitions = M7"). Module statuses live in
   `architecture.json`; roadmap mirrors the same states.
6. **Admin visibility:** the Architecture workspace is admin-only, listed in the
   drawer Admin section below "Game Economics" and on the raw changelog header.
   Never move it to the public page.
7. **The module list is extensible.** M1-M9 cover the current roadmap, but any
   genuinely new domain (community/forum, support, profile, etc.) becomes a NEW
   module (M9+) recorded in `architecture.json` FIRST. A feature is never
   "unmodular" — either it slots into an existing module or it earns a new one.
   Existing and future features must integrate through the module seams, never
   standalone.
8. **Module-First is enforced in the agent.** The project rule at
   `.opencode/rules/module-first.md` is auto-loaded into every opencode session
   (`opencode.json` `instructions`). It MUST be followed for ANY feature work —
   read `architecture.json` first, state the module, slot check, renumber by
   build order when inserting a module. Never skip it; the owner will not repeat
   this.

**Current module status (mirror of architecture.json, 2026-08-15):**
- M1: in-progress — Ludo (ludo-lab) verified COMPLETE against its locked spec
  A-Z (2026-08-16: 107/107 harness + 3D dice + Scope A/B/C shipped). M1 also
  owns its proof-of-play TOOLING: the `/verify/` receipt explorer (game-tooling,
  NOT in `public/universal/` - it proves M1's rolls/matches on-chain by querying
  the MagicBlock ER + base devnet RPC directly, and the win popup's "See
  on-chain receipt" link opens it pre-filled). The next M1A game is Ayo Olopon
  (planned, spec not yet locked).
- M2: in-progress — universal result seam (built: `public/universal/result-seam/game-result.js`
  + the whole universal-modules tree `public/universal/` with homed folders for
  M3-M8; Ludo ludo-lab emits the envelope; subscribers for M3/M4/M7 land with
  those modules).
- M3: in-progress — local points, two-track on-chain per game (PURE unspendable
  lifetime + SPENDABLE split, one PDA seed [gfgpoints, game_tag, player], gasless
  on the ER, extended gfg program, NO new program). Owner-locked 2026-08-16:
  Ludo scoring 4P 1st=100/2nd=50/3rd=10/4th=0, 2P only 1st=100; ONLY the "You"
  seat earns. **Position-aware reason codes (2026-08-18):** 2nd banks WIN_2ND(2),
  3rd banks WIN_3RD(3) (reason stored as u8; previously every placed award was
  labelled WIN_1ST). Harness-verified live 2026-08-16: on-chain ER harness (0-SOL
  player, gasless record_points + spend_local, spendable-only decrement) PASS;
  M3 module harness 29/29 against the locked spec (scoring, user-only,
  idempotency, spend, + resilience: retry-on-transient, confirm-timeout ledger
  read-back recovery, hard-failure surfacing). LIVE-VERIFIED 2026-08-16 by the
  owner: the +100 2P win banked on-chain (test wallet FBWcuv...VnbCN ludo PDA
  7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB = pure 100/spendable 100/
  award_count 1/reason WIN_1ST bound to proof match_ref 0x136f6555f6).
  Earlier silent no-show root cause was browser-path error-swallowing; the
  write path itself is proven by scripts/browser-path-repro.mjs (0-SOL player
  as ER fee payer). CEREMONY NEVER-PROMISE RULE: ludo-lab shows "+N points
  loading... don't refresh the page" in flight and a neutral no-amount pending
  line on failure; "+N banked on-chain" appears ONLY once confirmed.
  clearTransient() on Play Again. **DISPLAY STABILITY CONTRACT (owner-approved
  2026-08-18, source of truth = architecture.json M3):** window.localPoints.get()
  ALWAYS background-refreshes; the last-known ledger renders into
  data-local-points-* slots on load and on failed/wallet-not-ready refresh; the
  cache is WALLET-KEYED (gfg_local_points_cache_v2, one wallet per user, so a
  shared browser never cross-shows numbers); the module re-fetches on a bounded
  wallet-ready poll after DOMContentLoaded in addition to gfg:auth-changed
  (a silently restored Dynamic session otherwise leaves the display stuck).
  migrate_points bug (an
  intermediate build zeroed legacy ledgers) FIXED + redeployed (ELF-verified;
  re-run on restored ledgers is a clean no-op). Restore tool
  scripts/restore-points.mjs (explicit + --from-supabase) restored the 3
  orphaned legacy accounts (400/200/5000, verified on-chain, idempotent).
  Display wired: module lastAward + (gameTag,ledger,award) notify + gfg:auth-changed
  re-fetch; global header "Local:" chip via initGlobalHeader({localPointsTag});
  ludo-lab ceremony "+N Ludo points banked on-chain"; client pointsPda(gameTag)
  powers the profile on-chain ledger card.
- M4: in-progress — global ledgers (M4a pure / M4b lifetime / M4c spendable).
  ON-CHAIN via the same delegated gfg program (seed [gfgpoints, 'global', player],
  GlobalPoints account type + record_global/spend_global instructions, gasless on
  the ER, no new program). Multiplier-blind flow-up: M4 banks the base unmultiplied
  win via the seam; M5 applies the tier boost as a separate kind-1 credit so M4a
  pure can never be multiplied. Track A complete: program deployed, relay wired,
  client SDK (recordGlobalPoints/spendGlobal/fetchGlobalPointsPda), universal
  module (public/universal/ledgers/global-ledger.js), profile 3-ledger card,
  both harnesses pass (M4 module harness 27/27 — the game-win scenarios fixed
  2026-08-18 to set the M3 award mock per the locked spec). **M4 FLOW-UP +
  DISPLAY STABILITY CONTRACT (owner-approved 2026-08-18, source of truth =
  architecture.json M4):** M4 credits the global ledger from the SAME seam
  envelope M3 banks, resolving the award by CROSS-MODULE match_ref against
  M3's lastSeenAward/lastAward (read synchronously at bank entry, bounded ~2s
  poll only when M3 hasn't set it yet — never a blind credit, never a stale
  award). window.globalLedger.get() ALWAYS background-refreshes; cache is
  WALLET-KEYED (gfg_global_ledger_cache_v2); the module renders cached numbers
  on load/failure and re-fetches on wallet-ready + gfg:auth-changed. The
  global-ledger module is loaded on EVERY page via header.js (it injects
  /universal/ledgers/global-ledger.js + local-points.js when absent) so the
  header pill never sits on a permanent Loading state. ludo-lab ceremony shows
  an M4 "global points banked on-chain" credit line beside the M3 line
  (never-promise rule); Play Again clears M4 transient state too.
- M9: planned — player inventory (on-chain asset wallet [gfgassets, player]).
  Per-game item catalogs (skins, items, sounds) stored as media bytes directly
  on-chain. Each game defines its own catalog (like M1's game dropdown); M9
  owns the wallet infrastructure. Gasless grant/equip/revoke via session key,
  sliced reads (dataSlice). Module at public/universal/inventory/.
- M5: in-progress — Active Tier + Premium points launch engine, CONFIG-DRIVEN
  plan ladder (owner 2026-08-22): Level-2 2x now $5 / Nigeria N5,000 (was
  $3/N4,000, 5,000P activation unchanged) + NEW Level-3 3x actual $20, discount
  $10 / N13,500, Nigeria N8,000 (15 lives, 300P daily, 3x wins, 1.5x comp
  final-points, activation premium TBD ~10,000P), on-chain [gfgprem, player]
  buy-only ledger, 30-day sub no auto-renew, admin credit flow, 12-month
  affiliate + daily earn campaign in the same launch bundle. Launch-guide spec
  lives in M5.
  Booster (M5 v3, live): 72h unlimited-lives for 500P premium spendable ($1,
  base value $0.002 per point, USD rate never Naira) on any
  plan (no multiplier). PremiumPoints layout bumped to v3 (booster_active_until)
  with permissionless upgrade_premium_points_v3; premium undelegate ctx is
  unttyped so legacy v1/v2 ledgers can leave a region; scripts/upgrade-premium-v3.mjs
  swept every live premium ledger (v1/v2 -> v3) and re-pinned to AS. Client:
  magicblockDice.activateBooster (session-key, gasless, region-aware) + M10 lives
  reads boosterActiveUntil -> unlimited while active; card on /profile/upgrade.
- M6: in-progress — 500P signup bonus (on-chain fence) + 12-month affiliate
  (20% of the referred plan’s payable USD price, dynamic from the config plan
  ladder, active-sub monthly gate + 60-day pair-forfeit, manual Naira
  3-7 days). Giveaway/social deferred.
- M7: in-progress — on-chain config-driven earn-competition framework (admin
  creator UI + on-chain instances, rules R12-R18, no Supabase); launch
  instance = LUDO EARN (72h, was 24h): $2/N2,750 pool split 10 ways, window-fresh +
  auto-stop, FINAL-POINTS ranking with live tier boost (L3 1.5x / L2 1.0x,
  downgrade hides instantly, L1 freeze = no position), multi-select tier
  requirement any-of {L2,L3,...}, gfgwin on-chain winners + public past-winners
  paid-status proof, manual payout.
  Multi-sponsor platform + M8 escrow product deferred.
- M8: planned (deferred) — sponsor escrow.
- M10: in-progress — lives + daily rewards gate (ships with M5; ladder by plan:
  5/10/15 lives, 25/200/300P daily).

**Build order:** M1+M2+M3+M4 stable for Ludo FIRST -> **M5 + M10 launch engine**
(premium points + sub + multiplier + lives/daily) -> M6 launch sources -> M7
competition framework (admin creator UI + on-chain instances, launch instance =
Daily Ludo Earn, all launch gates in that order) -> M9
(inventory) -> M7 full multi-sponsor platform / M8 escrow
-> S3 rails (on-ramp, cosmetics) -> S4 ads -> S5 stake -> S6 licence. Never
build ahead of its module status.

## Core architecture (current)

- **Player identity:** Solana wallet via Dynamic wallet (email OTP). Session-key
  signing means no wallet popups. Player wallets hold 0 SOL by design.
- **VRF dice:** MagicBlock VRF + gfg-dice Solana program on **devnet**.
  Provably fair: two independent 16-byte VRF halves produce two 6-sided rolls.
- **Gasless model — MagicBlock Ephemeral Rollup (ER):** players never pay.
  1. On a player's first roll, a **sponsor relay** (the app) runs two base-layer
     transactions on the player's behalf:
     `initialize` (creates the dice PDA, sponsor pays rent) + `delegate` (moves
     the PDA into an ER session, sponsor pays the one-time session cost).
     Total onboarding cost ~0.0013 SOL.
  2. After delegation, every roll runs **free** on the ER (public ER nodes are
     gasless; VRF on the ER queue is free). Player's session key signs.
  3. Base-layer rolls via the paid queue (0.0005–0.0008 SOL) remain available as
     a fallback if the ER validator is unreachable.

## Key addresses (devnet)

| Item | Value |
| --- | --- |
| gfg-dice program | `CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ` (upgrade authority = deployer) |
| Deployer/sponsor wallet | `5ec9bYwVJVSfM3xnrzpg9jkoepX58pY1tWoGDsMdhdTQ` (~12.8 SOL) |
| Delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| ER validator (AS, relay pin since 2026-08-18) | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (new PDAs are pinned here; legacy US pin `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` still hosts pre-flip accounts) |
| ER VRF queue (free) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |
| Base VRF queue (paid) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` |
| ER RPC | `https://devnet-us.magicblock.app/` (CORS `*`, wss ok) — **rotation (2026-08-18):** the client/relay/probe use `src/gfg-rpc.js` ER registry + failover (US / AS `devnet-as.magicblock.app` / EU `devnet-eu.magicblock.app`; TEE excluded, needs a token). A failing/banned region goes to exponential cooldown and all readers/writers rotate to a healthy one. |
| Magic program | `Magic11111111111111111111111111111111111111` |
| Magic context | `MagicContext1111111111111111111111111111111` |

Dice PDA seed: `[b"gfgplayerd", player_authority.key()]` (the player's wallet,
NOT the payer — so any sponsor can fund it).

Program instructions: `callback_roll_dice, commit, delegate, initialize,
process_undelegation, roll_dice, undelegate`.

## Sponsor relay

Players' accounts are funded by an app-owned sponsor key through a relay:

- `scripts/delegate-relay.mjs` — core `handleDelegate(playerPubkey)`. Idempotent:
  returns `{pda, delegated: true, steps: []}` if already delegated; otherwise
  initializes + delegates and returns the signatures. Retries the account read
  (public devnet RPC is flaky) and recovers if the delegate tx loses a race.
- `scripts/relay-server.mjs` — local HTTP server on `:8787`, `POST /api/delegate`
  with `{player}`. Vite dev proxies `/api` → it.
- `api/delegate.mjs` — the same handler as a Vercel serverless function.

Sponsor key: env `GFG_Gasless_Sponsor_Keypair` (JSON array of 64 ints,
solana CLI keypair format) or fallback `~/.config/solana/id.json`.

Important gotcha (fixed): always compare `PublicKey` with `.equals()`, never
`someString === publicKeyObject`. `info.owner.toBase58() === DELEGATION_PROGRAM`
was silently false and made the relay re-delegate every time, failing with
web3.js's opaque `Unknown action 'undefined'` error.

## How to run

- Toolchain: Rust 1.97.1, solana-cli 3.1.10, anchor-cli 1.0.2, **Node 18.19.1**.
  `concurrently` requires Node 20, so dev uses `scripts/dev.mjs` instead.
- `npm install` then `npm run dev` → starts the sponsor relay (:8787) + Vite
  (:3000). Open http://localhost:3000. Vite binds `--host` (LAN-visible), so a
  phone on the same Wi-Fi can open `http://<your-LAN-IP>:3000` for real mobile
  preview (get the IP with `hostname -I`; the `/api` relay proxy follows along).
  Note: on the phone, a plain-`http://<LAN-IP>` page CANNOT do full Dynamic
  sign-in — browsers only expose WebCrypto (`crypto.subtle`) on HTTPS or
  localhost, so Dynamic wallet key generation fails with "Cannot read property
  of undefined (reading 'generateKey')". Use `npm run dev:tunnel` for real
  phone sign-in testing. UI-only preview on `http://<LAN-IP>:3000` still works
  fine (the header + changelog don't need sign-in to view).
- Mobile sign-in testing (99% of users are mobile — test here before you
  commit): `npm run dev:tunnel` = relay + Vite + a free Cloudflare quick
  tunnel. Cloudflared must be installed (`~/.local/bin/cloudflared`; no
  account or token needed). It prints a fresh `https://<random>.trycloudflare.com`
  URL each run. Vite `allowedHosts` is `true` so the tunnel isn't rejected.
  Add the wildcard origin `https://*.trycloudflare.com` to Dynamic's Allowed
  CORS Origins (Security settings) ONCE, and sign-in works on every future
  tunnel run. The `/api` relay proxy works through the tunnel unchanged.
  (`scripts/dev-tunnel.mjs`, `npm run dev:tunnel`.)
- Sign in with an email OTP (Dynamic). Play Ludo (Human vs 3 computers).
  First human roll logs `[VRF] Delegating player dice account (sponsored by
  GlobalFolkGames)...` then resolves instantly on-chain. Computer turns log
  `[Off-Chain Local Randomness] Computer turn — rolling locally`.
- `npm run relay` runs just the relay.
- **Program build + deploy (HARD RULE — fast path only, do not use `anchor deploy`):**
  1. Build: `cd programs && anchor build`
  2. Copy IDL: `cp programs/target/idl/gfg_dice.json src/gfg-dice-idl.json`
  3. Deploy: `source .env && solana program deploy programs/target/deploy/gfg_dice.so --program-id programs/target/deploy/gfg_dice-keypair.json --url "$GFG_DEVNET_RPC" --skip-fee-check`
  4. Do NOT use `anchor deploy` or `anchor program deploy` — they route through
     the slow public RPC (`devnet.rpcpool.com`) and frequently time out on
     devnet. The Alchemy RPC (`GFG_DEVNET_RPC` in `.env`) is a dedicated
     devnet endpoint and deploys in seconds. The Solana CLI respects `--url`
     as an override regardless of `solana config`.
  5. For mainnet later, swap `GFG_DEVNET_RPC` for the mainnet Alchemy/
     Helius/Quicknode RPC in the env file — same command, same flow.
- Build: `npm run build` (vite).

Node 18 + web3.js needs `"overrides": {"uuid": "^8.3.2"}` in package.json
(nested uuid v9 is ESM and breaks web3's CJS `require`).

## Verified

- Full ER VRF flow proven via harness (`/tmp/opencode/er-test/er-test.mjs`):
  init (base) → delegate (base) → roll on ER gasless (player fee payer with 0
  SOL) → VRF callback (`{roll1:1, roll2:1, seed:234}`) → undelegate.
- Relay: fresh player → sponsored init+delegate; already-delegated → no-op.
- Vite proxy `/api` → relay → on-chain: working.
- `npm run build` green.

## Feature workflow — READ BEFORE CODING (agreed process)

- **Plan first, code second.** When the owner agrees a feature (or several), the
  FIRST step of the task is to record it in the changelog Feature Tracker —
  before any implementation. Never start coding a new agreed feature without
  first adding its roadmap entry.
- **Two views of every feature, always:**
  - *Dev view (admin):* precise, technical details (bullets) — what's changing
    under the hood, files, trade-offs, remaining work.
  - *User view (public):* a light, watered-down summary of the same feature —
    the benefit to the player in plain language.
- **Add it with:** `node scripts/add-roadmap.mjs "<title>" "<user summary>" [--approved]`
  It folds the technical bullets from `docs/changelog/unreleased.md` into the
  item's dev-only `details`. New items are **ADMIN-ONLY by default** (see the
  approval gate below) — pass `--approved` only if the owner has explicitly
  agreed this item is ready for the public page right now.
- **Approval gate (HARD RULE — the admin pipeline is the source of truth):**
  the owner reviews features as we discuss them; the admin page
  (`/changelog/admin.html`) is where ALL of it is tracked technically. Nothing
  shows on the user page (`/changelog/`) until the OWNER explicitly approves
  it:
  - Every roadmap item carries `approved: true|false`. Default on add:
    **false** (admin-only).
  - Owner approves with: `node scripts/approve-roadmap.mjs "<title>" "<user summary>"`
    → sets `approved: true` and stores the public-facing summary.
  - `bump-version.mjs` REFUSES to promote (ship) any roadmap item that is not
    approved — a shipped entry always appears publicly, so it must be approved
    first. Approval is the manual go/no-go for user-side visibility, every time.
  - **Never bypass this to rush a feature onto the user page.** If in doubt,
    leave it admin-only and ask the owner.
- **Mark it as it lives:** each roadmap item carries a status:
  `planned` → `in-progress` → `shipped`.
  - Agreed but not started: leave or set `planned`.
  - Currently building: set `node scripts/set-roadmap-status.mjs <title> in-progress`
    (or edit `public/changelog/changelog.json` `roadmap[].status` directly).
  - Done and released: `node scripts/bump-version.mjs <major|minor|patch> "<title>" "<summary>"`
    promotes the matching roadmap item into a shipped changelog entry (with its
    version, date, git ref; existing summaries/details are preserved).
- **Public page shows the shape:** `/changelog/` organizes everything by
  3 status tabs — **Planned / In progress / Shipped** (user-view summaries of
  what's being built and where it stands) — plus per-tab pagination
  (Prev / pages / Next, ~6 per page) so history stays browsable as it grows.
  User mode shows ONLY approved items. All dev detail (numbered DEV Plan lists
  + git refs) stays on `/changelog/admin.html` (staff only), which also badges
  every unapproved item with "Pending approval" so the owner sees the full
  pipeline at a glance and can approve from there.
- **Public vs sensitive (hard rule):** the user-facing page must NEVER contain
  unfixed security/anti-exploit details — not even behind a flag or filter.
  A browser actor can read whatever bytes are in the client payload; hiding them
  with JS is theater. So security work is tracked ONLY in
  `docs/changelog/security-queue.md` (private git, never served) and NEVER added
  to `changelog.json` (client-served) until the fix ships. A shipped fix becomes
  a normal user-friendly changelog entry announcing it (the exploit no longer
  exists). Only user-relevant updates — new features, non-exploit UX/bug fixes
  — belong on the public roadmap. Never reintroduce a `sensitive` flag that
  ships the data and tries to hide it.
- **Public summary writing rule (owner's explicit instruction):** a roadmap
  item's public `summary` is a SHORT benefit for players — "what's in it for
  me, why is this exciting / worth waiting for" — never the technical plan of
  STEPS (how it'll be built) and never security language. Never write "security
  work is hidden from you" or anything that hints we're hiding something — even
  the *admission* of hiding exposes you. Benefits like "your games stay free",
  "a permanent tamper-proof record you can trust", "one tap away" are the
  frame. Reported/bug-fix items may say the fixed OUTCOME in plain user words
  ("fixed the board layout on small phones"), still never the fix pipeline or
  the security being fixed. The full technical steps live ONLY in `details`
  (admin-only).
- **No AI-style long dashes (owner's explicit instruction):** all
  user-facing copy on content pages must avoid the long/em dash ("—") that
  reads as AI-generated. Use natural human punctuation instead: parentheses,
  commas, "and", or rewrite the sentence. Example — write "a plain, familiar
  web experience (sign in with your email and play)" rather than "a plain,
  familiar web experience — sign in with your email and play". Applies to all
  normal text content on the menu/pages (About, Support, Forum, changelog
  intros, etc.); DO NOT touch code or JS string placeholders.
- **Golden rule:** if an agreed feature has no roadmap entry, the task is being
  done wrong — add it first, then do it, then mark it.

## Versioning + changelog (Feature Tracker)

- **Single numeric source:** `package.json` `version`. The bump script reads it,
  so npm, the site header and the changelog always agree.
- **Bump a release:** write engineer notes to `docs/changelog/unreleased.md`
  (one bullet per line), then:
  `node scripts/bump-version.mjs <major|minor|patch> "<title>" "<user summary>"`
  The script bumps package.json, prepends an entry to
  `public/changelog/changelog.json` (`summary` = public-facing watered-down
  text; `details` = admin-only bullets folded from unreleased.md; `git` = commit
  ref) and clears unreleased.md for the next cycle.
- **Published entries are IMMUTABLE (hard rule — do not violate):** once an
  item is promoted to a shipped entry (via `bump-version.mjs`) it is
  "published done" for BOTH the admin raw view and the public user page, and
  must NEVER be silently rewritten, reworded, relabeled, re-dated, or deleted
  in place afterwards. A changelog that quietly changes what was shipped
  yesterday looks untrustworthy and admin/user copies would drift. If a real
  mistake lands in a shipped entry, do NOT fix it silently: either add a new
  follow-up entry (patch bump) or get the owner's explicit go-ahead to amend.
  The "live" items — planned and in-progress roadmap entries — REMAIN freely
  editable (title, summary, dev details, status). The user-side visibility
  gate stays exactly as before: nothing reaches the user page without the
  owner's manual approval (`node scripts/approve-roadmap.mjs "<title>" "<summary>"`).
  Never bypass that gate to rush or reword anything onto the user page.
- **Pages (Vite inputs):** `/changelog/` = public changelog (v0.7.1+ entries,
  summaries always readable); `/changelog/admin.html` = raw engineer view
  (details + git refs), gated to staff. Both load the standard auth stack via
  `/src/main.js` → Dynamic wallet resolution.
- **Global header + slide-in menu (`public/header.js`):** every page gets the
  same header with a hamburger (☰) that opens a **glassmorphic drawer** —
  translucent blur, slides OVER the page (never pushes content), closes on
  scrim/✕/Esc. Sections: Play (Ludo, Home), Discover (What's New, About,
  Forum, Support, Contact), Account (My Profile). An extra **Admin** section
  (Dashboard, raw changelog) is shown only when the connected wallet is in
  `roles.json` — client-side UX hint, never a security boundary (no sensitive
  data behind it). New pages (about/, contact/, support/, forum/, profile/,
  dashboard/) are declared as Vite inputs in `vite.config.js`.
- **Brand theme colors (design rule):** the GlobalFolkGames brand is **Orange
  (#f39c12) + Purple (#9b59b6)** — those two are the primary brand colors and
  should lead every design, with black/dark (`#0f0f13`, `#1a1a24`) as the
  supporting backdrop. CSS vars in `public/style.css` `:root`: `--accent`
  (orange), `--accent-purple` (purple), `--bg-dark`/`--card-bg` (black
  supports). Keep orange-purple dominant in any UI you build; black is the
  canvas, never the accent.
- **Drawer is NO-BLUR, fully transparent (design rule — do not regress):** the
  slide-in menu must keep the page behind it CRISP — the drawer itself has NO
  `backdrop-filter` at all (blurring what's below was an active user complaint).
  The drawer background is `transparent` (no blur, no solid fill), and each
  menu item is its own solid dark card (`rgba(15,15,19,0.85)`, light border,
  white text — readable over anything WITHOUT needing a blur). Only the small
  item tiles sit over the page, never a panel. Scrim stays a light
  `rgba(0,0,0,0.18)` only. Never reintroduce `backdrop-filter` on the drawer,
  scrim or items.
- **Changelog auto-update (`render.js`):** the changelog pages poll
  `changelog.json` every 45s. When the payload changes, a "🔔 new update"
  pill appears above the tabs. It is **click-to-refresh** — never a silent
  refresh, so a reader mid-scroll never has content yanked away. The pill
  reapplies the current tab + page on click.
- **Web3 roles, not DB roles:** `public/changelog/roles.json` maps Solana
  wallets → `admin` / `moderator`. `public/changelog/render.js` resolves the
  connected wallet (`window.getDynamicSolanaWallet`) and bounces non-staff off
  the admin page. Admin wallet = sponsor `5ec9bYw...MdhdTQ`.
- **Gotcha (fixed):** Solana base58 addresses are case-sensitive on-chain but
  `roleForWallet` normalizes BOTH the wallet and the role lists to lowercase
  before matching — a mixed-case admin list otherwise never matches.
- "What's New" (`/changelog/`) is reachable from the slide-in drawer's
  Discover section (`public/header.js`, styled in `public/style.css`).
- Seed data: `public/changelog/changelog.json` holds real milestones v0.1.0
  (Dynamic sign-in) → v0.8.0 (roadmap live). Current deployed version: 0.8.0.
- Seeded/versioned docs: `docs/changelog/`; new engines notes land in
  `docs/changelog/unreleased.md`.

## Content writing style (auto-loaded rule, non-negotiable)

- **No AI dashes in user-facing content:** never use em dashes (—) or double
  dashes (--) in any text players or visitors read. Replace with parentheses,
  commas, "and", or full stops. Example: write `a big green "pea" (sent back
  home)` not `a big green "pea" — sent back home`. Full rules in
  `.opencode/rules/content-style-guide.md` (auto-loaded every session). Covers
  changelog summaries, page copy, UI labels, error messages, forum posts,
  README descriptions, and any other user-facing text. Does NOT apply to code
  comments, git commits, or internal dev notes.

## Explain like a beginner (auto-loaded rule, non-negotiable)

When explaining anything to the owner (architecture, errors, concepts, how things
work), always write like you're talking to someone who is smart but new to the
topic. Use everyday analogies, short sentences, and avoid unexplained jargon.

- **Use simple analogies:** "The backfill is like a bank teller fixing your
  balance. You (the player) tell the teller what went wrong. The teller (sponsor
  wallet) fixes it on your behalf. Your wallet doesn't touch the money."
- **Never dump raw technical terms** without a one-line plain explanation first.
- **Avoid stacking multiple concepts in one sentence.** Break them into short
  numbered steps.
- **When something fails, explain WHY it failed in plain words before showing
  the fix.** "The code was looking for the wallet address in the wrong place.
  Dynamic puts it here, not there."
- **Never blame the user or assume they should know.** Assume they're seeing
  this for the first time.
- If the owner says "explain like I'm 5" or "that's confusing", immediately
  rewrite with shorter words, more steps, and a real-world analogy.

## Commit conventions (enforced before every commit + push)

- **Format:** `<type>(<scope>): <short summary>` where type is one of:
  - `feat` = new feature (e.g. `feat(profile): wallet copy button`)
  - `fix` = bug fix (e.g. `fix(recovery): IDL load error logging`)
  - `chore` = tooling, config, deps (e.g. `chore: update Vite config`)
  - `docs` = docs only (e.g. `docs: update AGENTS.md commit rules`)
  - `refactor` = restructure without behavior change
- **Scope:** the module or area affected (e.g. `M3`, `M4`, `profile`, `recovery`, `dashboard`, `ludo`, `relay`).
- **Summary:** imperative mood, lowercase, no period. Say WHAT changed, not HOW.
- **Body (optional):** bullet points for non-obvious changes. Never include secrets, keys, or env values.
- **Before commit + push, always:**
  0. **Self-verification (HARD RULE):** stop and answer this honestly:
     "Are you sure all features/fixes you just completed are done correctly
     and working fine?" Re-analyze every change: read the edited files, trace
     the call paths, check method names match between caller and callee, verify
     DOM element IDs exist where referenced, confirm script loading order, and
     confirm the build passes. Only when you can confirm "yes, all correct"
     may you proceed. If ANY doubt remains, fix it first — never commit
     half-checked work.
  1. Run the leak scan (`.opencode/rules/security-leak-scan.md`) on staged + worktree diff.
  2. Verify no private keys, keypair JSON, mnemonics, service_role keys, JWTs, API tokens, or `.env` values are in the diff.
  3. ANY hit = HARD STOP. Never commit/push. Scrub or ask the owner.
  4. **Deploy-safety preflight (HARD RULE, enforced every push):** run `npm run build` (must be green) and `node --check` every changed script/serverless module. Confirm `git ls-files | grep programs/target` is EMPTY (no Rust build artifacts committed; committed `programs/` is source + Cargo only) so Vercel never bloats or chokes. Confirm only ONE serverless function exists: `api/` must contain ONLY `index.mjs` (see Serverless rule). If the owner reports a Vercel deploy failure, DO NOT assume; get the deployment id from the owner and inspect `npx vercel inspect <dpl_id> --logs` (needs a VERCEL token) or ask them to paste the deploy logs, then fix the root cause before the next push.
- **Serverless rule (Vercel):** Hobby plan caps functions at 12. The whole `/api` surface is a SINGLE function: `api/index.mjs` dispatches by request path to handler modules under `api_handlers/`. NEVER add a new file directly under `api/` (that is a second function and would break deploys). New endpoints = add a module under `api_handlers/` and register it in the `routes` map in `api/index.mjs`. Local dev uses `scripts/relay-server.mjs` (same routes) and is unaffected.
- **No cron / no external automation (HARD RULE):** NEVER introduce Vercel cron jobs, scheduled workflows, or Supabase-triggered automation to move game/economy state. Everything that automated (affiliate monthly settlement, competition window rolls, payouts) is run MANUALLY by the owner: an admin dashboard button or a local script (`node scripts/...`). Paid/subscription flows stay manual-on-chain like today. If a task would need a cron/scheduler to work, STOP and tell the owner that route is being proposed (they may decline); it is never added silently.
- **No new platform/stack without telling the owner:** before introducing any new backing service, dependency, or infra (e.g. a scheduler, queue, external API), explicitly state in the plan that it is a NEW dependency and get approval. The current stack is fixed: Solana/Anchor + MagicBlock ER (gasless), Vite, Node, Vercel (one function), dynamic-auth, Supabase (backup/restore only, never live truth).
- **Never amend a pushed commit without explicit owner approval.** If the commit is already on the remote, make a new commit instead.

## Security / anti-exploit rules (READ BEFORE CODING — non-negotiable)

- **Solana upgrade safety (auto-loaded rule, non-negotiable):** upgrades NEVER
  delete account data, but seed changes, layout changes, or program-ID changes
  orphan it (then anyone can close it for rent = permanent loss). Full rules live
  in `.opencode/rules/solana-upgrade-safety.md` (auto-loaded every session). The
  short version: seeds + program ID are immutable once shipped; new capabilities
  get NEW seed prefixes, never changed seeds; every breaking change ships a
  permissionless, idempotent, verifiable `migrate_*` instruction in the SAME
  deploy; never let `init_if_needed` silently re-seed an existing ledger; devnet
  is the mainnet rehearsal (never wipe devnet data to dodge a migration); when in
  doubt STOP and ask the owner for an approved migration plan.
- **Golden rule:** NEVER build a security boundary that the client can fake.
  Any gate enforced only in browser JS is cosmetic, not a gate. Always flag
  designs where the client declares its own identity/roles/access (self-reported
  wallet = no proof of control).
- **Known gap (accepted, interim):** the changelog admin page's "staff-only"
  gate is client-side (`public/changelog/render.js` + public `roles.json`). It
  is readable/bypassable via DevTools (mock `window.getDynamicSolanaWallet`, the
  roles fetch, or just call `window.renderChangelog('admin')`). Treat it as a
  UX convenience for the owner, NOT security — never put real secrets behind it.
- **Real fix (future roadmap item):** server-side challenge signature — the
  server issues a nonce, the client signs it with the Dynamic wallet, the server
  verifies the recovered pubkey against a SERVER-side staff list, and only then
  serves staff data. Never trust the client's wallet claim.
- **Never advertise live weaknesses:** security/anti-exploit work is never put
  in client-served data at all — no flag, no filter, no hidden bytes. It is
  tracked only in `docs/changelog/security-queue.md` (private git, never
  served) and becomes a public changelog entry only after it ships (fixed).
- Keep all secrets out of client bundles and out of `public/`. If a role check
  can be edited from the browser, it protects nothing.
- **Commit/push leak gate (HARD RULE, locked 2026-08-17):** before ANY
  `git commit` or `git push`, run the automated leak scan in
  `.opencode/rules/security-leak-scan.md` (auto-loaded every session): grep the
  staged + worktree diff for private keys, keypair JSON (64-int array / base58
  secret / `"secretKey"`), seed phrases/mnemonics, Supabase `service_role`,
  JWTs/`eyJ`, API tokens, `.env`/`.gfg-*` files, embedded credentials. ANY hit
  = HARD STOP: never commit/push, scrub or ask the owner first. A leaked secret
  on any remote is a live compromise — never "push and fix later". Public
  keys/program IDs are NOT secrets.

## Status / next steps

- [x] **Complete AS sweep (2026-08-19, shipped):** `scripts/migrate-to-as.mjs --all` was NOT sweeping every wallet - it only read the spend ledger, so wallets that onboarded before the ledger existed (or outside the relay, e.g. the owner's `42Xs2...`) stayed pinned to US with no ledger entry and were silently skipped. Fixed: `--all` now sweeps the UNION of spend-ledger players + Supabase `profiles.solana_wallet` (every signed-in user, the authoritative registry) + the house key; account existence is still checked on-chain per PDA so the wider list costs nothing. Live re-run re-pinned the 3 remaining US wallets (`42Xs2...`, `2TbJ...`, `3qNep...`) to AS, and the follow-up audit shows every delegated PDA on devnet-as. ALSO fixed: (a) `scripts/relay-server.mjs` backfill read the M4 global ledger at byte offset 2 (garbage) - the Anchor layout's discriminator is 8 bytes, so `global_pure_lifetime` lives at offset 8 (matches the M3 read); (b) `verify/verify.js` + `dashboard/recovery.html` excluded US entirely - they now try US LAST as a legacy fallback (matching the client's `regionCandidatesFor`: host first, AS/EU, then US), so a pre-flip US-pinned receipt still resolves. Note: the earlier "M4 Invalid account discriminator" for `42Xs2...` was a PROBE bug (fetched the global PDA with the `playerPoints` type instead of `globalPoints`); the product's `fetchGlobalPointsPda` (`src/magicblock-vrf.js`) always used the correct type and reads fine.
- [x] **ER RPC hardening (2026-08-18, shipped):** single-point `devnet-us.magicblock.app` (which began answering `-32005 client temporarily banned`) replaced with a 3-region registry + failover in `src/gfg-rpc.js` (`ER_ENDPOINTS` US/AS/EU, `pickErRpcUrl`/`markErRpcFailure`/`markErRpcSuccess`/`rotateErRpc`, exponential cooldown 5s→60s, round-robin fresh-session start so sessions don't all land on the same region). Every ER consumer rotates: `src/magicblock-vrf.js` (rolls + M3/M4/Scope C writes via `withErRetry`, `waitForErPickup`, callback polls; `banned` counts as a network error), `scripts/roll-relay.mjs` (house rolls), `scripts/endpoints-probe.mjs` (now probes every ER region with a real `getLatestBlockhash` RPC + reports `ops.erRotation`), `verify/verify.js` + `dashboard/recovery.html` (per-region failover), and the backfill/restore/harness scripts. `createConnection` gained a backoff-confirm option (`{backoffMs:[400,800,1200,1800,2500]}`) so a slow-to-confirm tx never hammers the RPC; the outage-monitor ping now probes `getLatestBlockhash` (works on every endpoint) instead of `getSlot`, and its interval went 8s→20s in ludo + ludo-lab. Verified live: rotation unit smoke PASS; devnet-us answers "client temporarily banned" while devnet-as + devnet-eu answer `getLatestBlockhash`; probe watchlist shows US DOWN / AS+EU OK.
- [x] **Region-aware ER targeting + dice re-pin to AS (2026-08-18, shipped):** a delegated account's ER state lives on EXACTLY ONE region (the validator the relay pinned it to via remainingAccounts), so the client now resolves each account's hosting region via the Router's `getDelegationStatus` -> fqdn (`regionUrlForFqdn` in gfg-rpc.js) and submits + polls THERE (`withErRetry(..., {regionUrl})`; rotation is only a fallback for accounts the Router has not reported yet). All PDAs the relay pins now target the AS validator `MAS1Dt9...` (delegate-relay, comp-relay, probe, gfg-dice-config, magicblock-vrf). The 11 legacy US-pinned player dice accounts were migrated live with `scripts/migrate-to-as.mjs` (undelegate on the hosting region, sponsor signs; then re-delegate DIRECTLY to AS as a single `delegate` step, bypassing handleDelegate's multi-PDA budget which trips the per-player cap on already-onboarded players). All 13 tracked dice PDAs now report devnet-as; point ledgers verified intact through the round-trip. Migration cost recorded honestly as `migration` spend events (sponsor-keyed, caps untouched). SCOPE CLOSED (2026-08-18, same day): the program gained ADDITIVE `undelegate_points/undelegate_result/undelegate_global_points` (same program id, no layout/seed change, solana-upgrade-safety compliant), so POINTS/RESULT/GLOBAL PDAs can be re-pinned off a flaky region like dice. `scripts/migrate-to-as.mjs` now migrates ALL PDA types per player; the full live run re-pinned every US-hosted PDA to AS (all 13 tracked PDAs report devnet-as or pin AS on next use). Gotcha FIXED during the run: Anchor `#[delegate]` helper accounts need the relay's camelCase keys (`bufferGlobalPoints`/`globalPoints`), NOT snake_case — the first house-global pass errored `Reached maximum depth for account resolution. Unresolved accounts: bufferGlobalPoints` then succeeded after mirroring delegate-relay.mjs exactly. RULE LOCKED INTO architecture.json keyRules + rules: every new per-player PDA type ships its own `undelegate_*` in the SAME program build (RPC/region-agnostic build rule) so a banned ER region is always a re-pin job, never a feature outage.
- [x] Program upgraded to ER (ephemeral/delegate/commit/undelegate), deployed.
- [x] IDL synced to `src/gfg-dice-idl.json`.
- [x] Sponsor relay (local + Vercel fn) built and tested.
- [x] Client rewritten for ER (`src/magicblock-vrf.js`, `src/gfg-dice-config.js`).
- [x] **ALL dice on-chain (Scope A, shipped):** every dice roll in the Ludo
      game now resolves on the MagicBlock ER VRF (fast/gasless queue
      `5hBR…`) — not just a one-off proof roll.
      * Human "You" seat: every turn rolls via the player's delegated dice
        PDA (`src/magicblock-vrf.js`; session key signs silently).
      * Computer seats: new server-side house-roll route
        (`scripts/roll-relay.mjs`, `POST /api/roll` on the local relay and
        `api/roll.mjs` on Vercel). The house = the sponsor key; its dice PDA
        is sponsored+delegated once (~0.0013 SOL, idempotent), then every
        computer roll runs FREE on the ER queue. The key never leaves the
        server. Rolls are serialized in-process (single-flight queue) so the
        shared house PDA can't race; delegation state is cached ~4min so warm
        rolls are ~1.3s (cold first ~3.1s), staying under the 2.5s p95 revert
        rule in the shipped anti-cheat decision.
      * Any seat has NO offline fallback for core dice: a failed on-chain
        roll is retried up to 3 times (~1.5s apart), then if the chain is
        genuinely down the match PAUSES with a visible banner (turn returned,
        never rolled locally, never advanced on a fake roll) and an 8s
        monitor pings base RPC + ER RPC (`window.magicblockDice.ping()`),
        alerting and auto-resuming the paused turn when the network returns.
        Devnet-wipe recovery: redeploy the program, restore points/game txs
        from Supabase backup, fresh matches continue. Computer "move" timing
        constants are unchanged.
- [x] **Timing + AI speed (HARD CONSTRAINT — do not change):** the owner
      deliberately slowed the AI to human-level playing speed (early versions
      were too fast, made the game hard, and felt like the AI hijacked the
      user's turn). Preserve current timing: computer dice roll ~1.2–1.5s
      after turn start, move execution ~1.5s delay, post-roll ~3.5s before
      pass/next, pass-sequence ~1.5s. Never speed these up. Note: the on-chain
      computer roll awaits the ER round trip (~1.3s warm) before that
      post-roll pause, which is the accepted cost of provably-fair AI dice.
- [x] **Board dice rendering (improved):** `public/games/ludo/physics.js`
      `renderPhysicalDiceCubes` now draws 46px rounded white dice with real
      pip dots (not unicode glyphs that render inconsistently on mobile),
      drop shadow + bevel for depth. Physics boundary size bumped to 46 to
      match. Keep dice big/readable — do not regress to tiny 2D glyphs.
- [x] **Render loop + verify-link honesty (fixed 2026-08-16, ludo + ludo-lab):**
      the board no longer clears + redraws at 60fps forever (the old blink
      engine rAF never stopped, thrashing CPU/battery and wiping transient
      canvas painting). The loop now runs ONLY while a movable token blinks;
      the dice physics loop self-renders its tumble + one settled frame, so
      dice/overlays persist and the canvas idles (zero rAF) otherwise. And
      per-roll "Verify on SolanaFM" links were removed: MagicBlock ER
      (ephemeral rollup) tx signatures are NOT indexed by any public explorer
      (SolanaFM/Solana explorer only index the base chain + settlement), so
      every click 404'd. Replaced with an honest "Roll resolved on-chain
      (MagicBlock ER VRF)" line plus, when the relay freshly sponsored it, a
      WORKING devnet link via `window.magicblockDice.getLastDiceDelegationSignature()`
      (the base-layer tx that created + delegated the player's dice account).
      HARD RULE: never link an ER tx signature on a standard explorer.
- [x] Player-account feature: mandatory sign-in to start a match; exactly one
      seat is the signed-in user ("You" via `playerProfiles[color].isUser`);
      reward requires 1st-place user seat AND a valid on-chain roll (every
      user roll is on-chain since Scope A; the flag is set once any roll
      succeeds). `getOnchainProofUsedThisMatch()` + `getLastProofRollSignature()`
      gate the +100 reward in `win-detection.js`.
- [x] Points flow fixed + hardened (`public/profiles.js`: `awardGlobalPoints`):
      optimistic header bump, audit row in `point_transactions`, profile totals +
      level update, and a device-level pending-award queue
      (`gfg_pending_awards_<userId>`) that re-syncs on the next `refreshAuthHeader`
      if Supabase was unreachable. RLS gap fixed — Dynamic users have no
      `auth.uid()`, so the original `auth.uid() = id` / `auth.uid() = user_id`
      policies 401/406-blocked all writes. The fix was a one-time Supabase SQL
      script (already RUN in the Supabase project; kept OUT of the repo on
      purpose — do not re-add it). The ludo award passes the on-chain
      proof-roll signature as `match_id`, tying the Supabase record to the
      verifiable roll. `syncPendingPointAwards()` de-dupes by `match_id`.
- [x] Crowns persist: `win-detection.js` exposes `serializeWinState()` /
      `hydrateWinState()` (finishOrder + reward-flag); `persistence.js` stores
      `winState` in the saved payload so crowns/positions survive reloads.
- [x] Proof-roll + reward tx IDs log a clickable Solana explorer link
      (`https://explorer.solana.com/tx/<sig>?cluster=devnet`).
- [x] Ludo page scroll: `100vw` gone on `#game-arena-wrapper`; body keeps
      `overflow-y:auto`/`overflow-x:hidden` + `touch-action:pan-y` +
      smooth `overscroll-behavior` for fluid up/down scrolling, no horizontal.
- [x] MagicBlock research: **VRF = randomness primitive** (dice — correct tool,
      used via the delegated VRF queue); **ER = gasless execution/runtime layer** for
      game state incl. points/rewards ("Rewards (Delegated VRF)" is an official
      MagicBlock example). Future on-chain points = a `record_*` instruction on
      the ER (same delegated program), NOT the VRF itself.
- [ ] Browser end-to-end test (login → pick "You" seat → sponsored first roll
      → gasless ER rolls → 1st-place reward gating → points appear in header +
      local display + Supabase profile).
- [x] Checkpoint committed (`23cf30b` points+RLS hardening, `256cd47` removed
      `rls_fix.sql` from the repo). Repo is now **private** (personal GitHub
      account on purpose — a GitHub org would force a paid Vercel plan).
- [x] **Sponsor spend caps + ledger (shipped `036c34d`):** the relay now enforces
      per-player (0.005 SOL default) + global (1.0 SOL) spend caps plus a
      sponsor reserve floor, authorized against the ESTIMATED budget before any
      SOL moves, with the REAL balance delta recorded to a durable file ledger
      (`scripts/spend-ledger.mjs`, `.gfg-spend-ledger.json`, gitignored,
      env-tunable). Also fixed a pre-existing relay bug: Anchor `.transaction()`
      is async under @anchor-lang/core 1.1.2; it was passed unawaited and every
      delegate threw 'transaction.instructions is not iterable'. Both call
      sites now `await`. Verified live on devnet (fresh player init+delegate
      0.0042 SOL recorded; idempotent re-call spent nothing).
- [ ] **Value model "free today, honest about limits" (recorded, planned, admin-only):**
      free tier = daily renewing sponsor-cost allowance metered from the spend
      ledger (shown as "free plays left today"); top-up via spendable points
      bought with the embedded wallet (Dynamic on-ramp); free refills during
      early phase via profile request, removed later without surprise.
      Tracked as roadmap item "Free-with-limits value model (spendable points)"
      (admin-only until owner approves). Anti-abuse hardening (server-side
      allowance metering, refill farming, verified purchase) is in
      `docs/changelog/security-queue.md` — never client-served. Devnet today is
      free money, so this is a mainnet-phase build.
- [x] **Robust admin dashboard (built, verified):** endpoint watchlist via a
      server-side probe function (`scripts/endpoints-probe.mjs`, served as
      `api/endpoints.mjs` on Vercel and `GET /api/endpoints` on the local
      relay) that returns per-endpoint status / latency / accessibility
      (user / staff / infra) across the RPC chain, both VRF queues, the
      delegation program, the ER validator, ER RPC and Supabase. Leak-scan
      + accepted-gap observations log server-side ONLY (console + 
      `.gfg-probe-log.jsonl`), never in the client payload (AGENTS.md rules).
      Ops panel: sponsor devnet balance, spend ledger totals + caps, version,
      roadmap counts, git ref (VERCEL_GIT_COMMIT_SHA → git → changelog), and
      the ER/on-chain account inventory. `dashboard/index.html` adds the
      watchlist (with re-probe button), the ops panel and Player activity
      with **On-chain / Off-chain sub-tabs**: On-chain = sponsored accounts
      from the spend ledger with live delegation status from the Magic Router
      (routers `getDelegationStatus`), plus sponsor balance. Off-chain =
      Supabase profiles + point_transactions aggregates (counts, by-reason,
      recent rows). Staff gate remains the client-side wallet-role gate (known
      accepted gap; no real secrets behind it). Verified: standalone probe
      8/8 ok + relay HTTP route via self-terminating harness. Deploy note:
      Vercel function has no writable fs, so the file-ledger/player list is
      per-instance (fine on devnet; durable store is the mainnet security item).
- [x] **Gas analytics dashboard (built, verified):** the spend ledger gained a
      per-spend **event log** (`ledger.events`; auto-migrates old totals into
      one synthetic onboarding event each) plus `recordSpend(player, lamports,
      {category, steps})` so the probe can report *what* burns the reserve.
      `scripts/endpoints-probe.mjs` now folds `ops.ledger.analytics` into
      `/api/endpoints`: period buckets (day/week/month from the event log),
      spend-by-category (onboarding vs house), top spenders, burn rate (7d
      avg), battery (sponsor balance vs `GFG_GAS_TANK_SOL` default 100,
      tiers full/low/critical with an animated CSS meter), and forecasts
      (`gasForecast`): 1/5/25 SOL → fresh players funded + months of runway
      at the current burn. `dash-core.js renderGas()` renders the feed
      (battery, inline-SVG donut for categories, bar rows per period, top
      players, forecast cards) on `dashboard/` home + `ops.html`. One-key
      devnet-airdrop "refill" was prototyped then REMOVED at the owner's
      request: the sponsor wallet IS the gas tank (same deployer keypair), so
      no separate reserve exists to top up and the owner refills manually by
      sending SOL to the sponsor pubkey whenever the battery looks low.
      Verified live: analytics present in the probe payload; `npm run build`
      green.
- [ ] Vercel deploy (near-done): domain `https://globalfolkgames.fun` live
      (personal repo + free plan works). `GFG_Gasless_Sponsor_Keypair` env set (raw
      contents of `~/.config/solana/id.json`). Dynamic CORS origin added
      (`https://globalfolkgames.fun`, plus localhost in sandbox). Remaining:
      final deploy (fix already made: `api/delegate.mjs` accepts Vercel's
      pre-parsed JSON body; `vercel.json` drops invalid `runtime` and pins node
      via `engines` — pushed by owner) then the on-chain onboarding probe
      (first roll must log sponsored `initialize + delegate`). Add
      `https://globalfolkgames.fun` to Dynamic allowed origins if OTP breaks.
      Per-player sponsor spend cap still pending (matters on mainnet).
- [x] Extend `programs/programs/gfg-dice/README.md` with the ER/gasless notes.
- [x] **Versioning + Feature Tracker:** `scripts/bump-version.mjs` bumps
      `package.json` and prepends a changelog entry (public `summary` +
      admin-only `details` from `docs/changelog/unreleased.md` + git ref);
      `/changelog/` public page + `/changelog/admin.html` staff-only raw view
      (both Vite inputs), web3 roles via `roles.json`, "What's New" header link.
- [x] **Plan-first workflow (agreed):** agreed features are recorded in the
      Feature Tracker BEFORE any code. `scripts/add-roadmap.mjs` creates a
      two-view roadmap item (public `summary` + dev-only `details` folded from
      unreleased.md); `scripts/set-roadmap-status.mjs` marks it
      `planned` → `in-progress`; `scripts/bump-version.mjs` promotes the
      matching item into a shipped entry (version, git ref; summary + details
      preserved). Roadmap renders as 3 status tabs (Planned / In progress /
      Shipped) with per-tab pagination on `/changelog/`.
- [x] **Roadmap seeded with the user-facing USP:** Planned tab now carries 7
      exciting, user-safe items players look forward to — Full on-chain gaming,
      Earn competitions, Referral program, Community forum, Giveaways & events,
      More native games from the world (current: Ludo live, origin corrected to
      India via Pachisi, popular in Nigeria; Ayo Olopon (Nigeria native)
      upcoming), Mainnet launch. Purely marketing/user-relevant — zero security
      or technical downside detail in the public payload.
- [x] **Approval gate live:** new roadmap items default to **admin-only**
      (`approved: false`) — visible on `/changelog/admin.html` (with a "Pending
      approval" badge) but hidden from the user page until the owner runs
      `node scripts/approve-roadmap.mjs "<title>" "<summary>"`. `bump-version.mjs`
      REFUSES to ship an unapproved roadmap item to the public changelog.
      User page defaults to the Planned tab (owner-approved forward-looking
      roadmap); it shows ONLY approved roadmap items.
- [x] **Game Economics admin workspace (built, verified):** a dedicated
      staff-only page `/changelog/economics.html` (Vite input, staff-gated the
      same way as the raw changelog) tracks the break-or-make platform
      economics through a 3-stage pipeline: **raw → fine-tuned → ready**.
      `public/changelog/economics.json` holds the items (title, stage, summary,
      dev notes, tags, dates); `public/changelog/economics.js` renders the
      sub-tab UI (Raw / Fine-tuned / Ready to implement); `scripts/econ-add.mjs`
      captures new ideas (default stage raw); `scripts/econ-promote.mjs` moves
      an item forward. When an item reaches "ready" it is finalized and gets
      promoted into the normal changelog roadmap (`scripts/add-roadmap.mjs`).
      Admin links in the drawer + changelog admin header. Same public-vs-
      sensitive rule as the roadmap: no unfixed security/anti-exploit detail
      ever goes into economics.json (kept in security-queue.md only).
- [x] **Token/NFT stance (owner decision, recorded in econ workspace):** never
      launch a token and never sell NFTs — both crash the project when bad
      actors fixate on "token must go up" and label it a scam when it drops,
      evaporating the USP. Instead rewards are EARNED and randomly discovered
      (lootbox-style), opened to unlock surprises such as bonus points; some
      in-game rewards may unlock an earned (never sold) NFT. This eases
      web2-native players into web3 without the token/NFT crash taste.
- [x] **On-chain points (Scope B, built + verified live on devnet):** `record_points`
      on the same delegated gfg-dice program, gasless on the ER. Program deployed
      (program id unchanged; init+delegate now support two PDAs per player).
      * Program: `PlayerPoints` account (seed `gfgpoints`, fields
        `total_points/last_points/last_reason/last_match_ref/last_recorded_ts/award_count`)
        + `initialize_points`/`delegate_points`/`record_points` instructions.
      * Relay (`scripts/delegate-relay.mjs`) `handleDelegate` now creates AND
        delegates BOTH the player dice PDA (`gfgplayerd`) and the player points
        PDA (`gfgpoints`) in one idempotent call (fresh onboarding = 4 steps,
        ~0.0086 SOL verified; per-player spend cap default raised 0.005 → 0.012
        SOL to cover two PDAs with margin). Verified: fresh = 4 steps, second
        call = clean no-op.
      * Client (`src/magicblock-vrf.js`): `recordPoints(points, reason, matchRef)`
        is a pure gasless ER write (session key signs, 0-SOL player); returns the
        receipt signature. `matchRefFromSignature()` = first 8 bytes of the
        proof-roll sig as u64 (binds the reward to the exact winning roll).
        `fetchPointsPda()` reads the ledger (own account only). `POINT_REASONS`
        (WIN_1ST=1) exposed on window.
      * win-detection.js: on a +100 1st-place user win with a valid proof roll,
        after the Supabase award it fires `magicblockDice.recordPoints(100, 1,
        matchRef)` as a soft-fail mirror (never blocks the win UX); logs the
        receipt explorer link.
      * Admin tracker (`scripts/endpoints-probe.mjs`) now lists each wallet's
        dice PDA AND points PDA (roles "Player points PDA (Scope B ledger)");
        dashboard renders both with live delegation status. Profile page
        (`profile/index.html`) adds "Your on-chain points ledger" card reading
        the player's own points PDA (own-account only, gasless).
      * Verified live: gasless `record_points` from a 0-SOL player accumulated
        total_points/award_count on the delegated ER PDA; tracker shows both PDAs
        delegated to the ER validator. Supabase stays aggregation/fallback.
- [x] **On-chain finish-order (Scope C, in-game):** the winners ceremony now
      commits the FULL 1st..4th finish order on-chain via `record_result`
      (gasless ER write, session key signs, soft-fail that never blocks the
      win UX; win-detection `commitGameResultOnchain`, proof-bound `match_ref`
      from the winning roll sig; relay idempotently creates+delegates the
      result PDA `gfgresult`). The ceremony shows a copyable receipt and, when
      the result account was freshly created this session, a working devnet
      link to that base-layer creation tx. Program instruction + relay steps +
      client `recordResult` existed and were harness-verified (2026-08-14);
      the missing game-level wiring + ceremony UI landed 2026-08-16.
- [ ] **Settled economics (2026-08-14, consult econ workspace, DO NOT re-litigate):**
      `public/changelog/economics.json` is the source of truth. econ-003 settled
      the ACTIVE TIER ladder (Tier 1 free 1x; Tier 2 = 1,000 spendable/mo -> 2x;
      Tier 3 = 2,500 spendable/mo -> 3x; Tier 4 = 5,000 spendable/mo -> 4x.
      Multiplier on base match win points ONLY, per-day cap +1,000 boosted pts).
      econ-006 settled SEVEN revenue streams deciding the build order:
      (1) on-ramp spendable purchases (primary), (2) brand event rake 30/70 with
      on-chain escrow, (3) Active Tier monthly buy, (4) ads support line,
      (5) cosmetics store non-NFT, (6) stake mode rake, (7) tournament licence.
      BUILD ORDER (revenue-first, roadmap item "Platform economy: revenue-first
      build order"): S0 ledgers (today) -> S1 Active Tier + spendable sink ->
      S2 comps + brand escrow -> S3 on-ramp + cosmetics -> S4 ads -> S5 stake ->
      S6 licence. Each stage gates what we build on-chain; never build ahead of
      its revenue reason.
- [ ] **Analytics (LAST STEP, after rewards are stable):** add usage tracking.
      Google Analytics 4 (free) + gravity/event-based option for game events,
      hotjar/ms clarity (free) for session replays/funnels, and a free
      game-testing/analytics layer if needed. Also research ad monetization:
      player-friendly rewarded-ads (not intrusive) for ads platforms that pair
      with webgames. Log the 1 add platform per-game. Keep GDPR/consent light
      (email-OTP users) and avoid selling/anonymizing on-chain data.

## Product direction

- Devnet now, mainnet later. App pays all fees; players never fund wallets.
- Showcase/grant-ready: folk games with Web2 onboarding + real on-chain
  verifiable fairness. Competition-based earn, no token launch.
