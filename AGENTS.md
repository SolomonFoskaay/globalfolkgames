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

**Modules (M1-M8):**
- **M1 — Game core:** the games themselves (Ludo now), board rules, moves,
  win detection, timing/AI constraints. Game-agnostic: adding a game = adding a
  game module, the rest of the platform doesn't care which game is running.
- **M2 — Universal result seam (the plug-and-play contract bus):** the one
  integration contract between every game and every reward module. Standalone
  because it is the platform's wiring, not a game and not a reward. Every game
  ends with `window.publishGameResult()`; every reward module subscribes via
  `window.onGameResult()`. 50 games = 1 reward plug, 1 competition plug.
- **M3 — Local points (pure):** per-game board points, no platform rule. The
  old "+100 1st-place" rule is DROPPED; a game's own scoring is purely its own.
  Consumes the seam (M2).
- **M4 — Global ledgers:** platform-wide ledgers (lifetime points, spendable
  points) that aggregate game results. Points flow game -> seam -> local ->
  global. Consumes the seam (M2).
- **M5 — Active Tier subscription:** the money module. Monthly tier bought from
  spendable points (Tier 2/3/4 = 1,000/2,500/5,000 spendable/mo -> 2x/3x/4x on
  base match win points, per-day +1,000 cap). S1 = in-progress.
- **M6 — Point sources:** referral program, giveaways, sub buy-in. All feed the
  spendable balance (M4). Planned.
- **M7 — Competitions:** earn events (daily/weekly/monthly), leaderboards.
  DEFERRED until M1-M4 are stable for Ludo. Consumes the seam (M2).
- **M8 — Sponsor escrow:** on-chain brand event rake (30/70, prizes escrowed).
  The escrow proof-of-life; product build waits behind M1-M4.

**HARD RULES (do not regress):**
1. **Every feature = a module.** Before writing ANY feature code, state which
   module it belongs to and confirm it slots in (via the module status in
   `architecture.json`). If it doesn't fit a module, it does not get built.
   A feature that is important and standalone earns its OWN new module
   (recorded in `architecture.json` FIRST) — never bury it inside another
   module's details.
2. **M7/M8 are deferred.** Competitions and sponsor escrow product work does NOT
   start until M1 + M2 + M3 + M4 are stable and verified for Ludo. The on-chain
   S2 escrow + Scope C finish-order code that ALREADY exists stays (program id
   unchanged, idempotent, verified live on devnet) but the PRODUCT/UI build for
   competitions waits.
3. **Modules integrate cleanly.** Each module is a seam: games (M1) emit into
   the result bus (M2); local points (M3) and global ledgers (M4) consume it;
   spendable (M4) buys tiers (M5) or enters events (M7). Never hard-wire one
   game into the platform.
4. **Universal result seam (M2, the plug-and-play contract):** every game ends
   by calling `window.publishGameResult()` (`public/game-result.js`, canonical
   `gfg:game-result@1` envelope: `players[]` with seat/actor/position|score +
   optional on-chain proof). M3/M4/M7 subscribe via `window.onGameResult()` and
   NEVER read game internals. A game never ships its own reward/competition
   plug — 50 games = 1 reward plug, 1 competition plug. Adding a new game =
   emit the same envelope; the platform doesn't change.
5. **Feature Tracker stays synced.** Roadmap items reference their module
   (e.g. "Earn competitions = M7"). Module statuses live in
   `architecture.json`; roadmap mirrors the same states.
6. **Admin visibility:** the Architecture workspace is admin-only, listed in the
   drawer Admin section below "Game Economics" and on the raw changelog header.
   Never move it to the public page.
7. **The module list is extensible.** M1-M8 cover the current roadmap, but any
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
- M1: in-progress — finalize Ludo (currently the focus; the game must be fully
  done and tested before any other module product work).
- M2: in-progress — universal result seam (built: public/game-result.js + Ludo
  emits the envelope; subscribers for M3/M4/M7 land with those modules).
- M3: planned — pure local points (no +100 rule).
- M4: planned — global ledgers (lifetime/spendable split; spendable is next).
- M5: in-progress — S1 Active Tier + spendable sink.
- M6: planned — referral / giveaways / sub buy-in.
- M7: planned (deferred) — competitions.
- M8: planned (deferred) — sponsor escrow.

**Build order:** M1+M2+M3+M4 stable for Ludo FIRST -> M5 (money) -> M6 -> M7/M8
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
| ER validator (US) | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| ER VRF queue (free) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |
| Base VRF queue (paid) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` |
| ER RPC | `https://devnet-us.magicblock.app/` (CORS `*`, wss ok) |
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
- Program work: `cd programs && anchor build && anchor deploy`.
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

## Security / anti-exploit rules (READ BEFORE CODING — non-negotiable)

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

## Status / next steps

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
- [ ] On-chain finish-order (Scope C, parked): commit full 1st..4th finish order
      on-chain (same delegated program), not just reward points.
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
