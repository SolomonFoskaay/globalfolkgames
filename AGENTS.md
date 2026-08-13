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

Sponsor key: env `GFG_SPONSOR_KEYPAIR` (JSON array of 64 ints, solana CLI
keypair format) or fallback `~/.config/solana/id.json`.

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
- [x] AI/computer turns skip VRF (`public/games/ludo/mechanics/actions/dice.js`).
- [x] **Timing + AI speed (HARD CONSTRAINT — do not change):** the owner
      deliberately slowed the AI to human-level playing speed (early versions
      were too fast, made the game hard, and felt like the AI hijacked the
      user's turn). Preserve current timing: computer dice roll ~1.2–1.5s
      after turn start, move execution ~1.5s delay, post-roll ~3.5s before
      pass/next, pass-sequence ~1.5s. Never speed these up.
- [x] **Board dice rendering (improved):** `public/games/ludo/physics.js`
      `renderPhysicalDiceCubes` now draws 46px rounded white dice with real
      pip dots (not unicode glyphs that render inconsistently on mobile),
      drop shadow + bevel for depth. Physics boundary size bumped to 46 to
      match. Keep dice big/readable — do not regress to tiny 2D glyphs.
- [x] Player-account feature: mandatory sign-in to start a match; exactly one
      seat is the signed-in user ("You" via `playerProfiles[color].isUser`);
      reward requires 1st-place user seat AND a valid on-chain proof roll
      (the first user roll of the match). `getOnchainProofUsedThisMatch()` +
      `getLastProofRollSignature()` gate the +100 reward in
      `win-detection.js`.
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
- [ ] **Robust admin dashboard (imminent build):** endpoint watchlist via a
      server-side probe function (`api/endpoints.mjs`) that returns status /
      latency / user-accessible vs staff-only / leak flags (leak results stay
      server-side per AGENTS.md rules); user stats with On-chain / Off-chain
      sub-tabs (wallets, last login, gameplay, points); project ops panel
      (Vercel env, Dynamic origins, sponsor balance/ledger totals, version,
      roadmap counts, git refs, ER/on-chain account inventory). Owner approved
      both scope options: server-side probe + "everything incl. usage analytics".
- [ ] Vercel deploy (near-done): domain `https://globalfolkgames.fun` live
      (personal repo + free plan works). `GFG_SPONSOR_KEYPAIR` env set (raw
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
      More native games from the world (current: Nigeria Ludo live, Ayo Olopon
      upcoming), Mainnet launch. Purely marketing/user-relevant — zero security
      or technical downside detail in the public payload.
- [x] **Approval gate live:** new roadmap items default to **admin-only**
      (`approved: false`) — visible on `/changelog/admin.html` (with a "Pending
      approval" badge) but hidden from the user page until the owner runs
      `node scripts/approve-roadmap.mjs "<title>" "<summary>"`. `bump-version.mjs`
      REFUSES to ship an unapproved roadmap item to the public changelog.
      User page defaults to the Planned tab (owner-approved forward-looking
      roadmap); it shows ONLY approved roadmap items.
- [ ] On-chain points mirror (future): a `record_points`-style instruction on the
      ER keyed to the proof roll; Supabase stays the fallback source of truth
      across devnet wipes (re-sync on redeploy).
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
