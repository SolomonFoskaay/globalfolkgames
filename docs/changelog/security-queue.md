# Security work queue (PRIVATE — never serve, never ship to client)

This file tracks unfixed security / anti-exploit work. It is committed to the
private git repo but is **never** referenced by any browser-served asset
(kept out of `public/`, out of any build input). Nothing here may ever appear
in `public/changelog/changelog.json` or any client-delivered payload:

- **Rule:** a browser bad actor must have zero ability to see this. Do NOT add
  an entry here to the changelog roadmap while it is unfixed. Keep the bytes
  out of the client entirely.
- **Lifecycle:** when a fix ships, add it to the changelog as a NORMAL shipped
  entry (the exploit no longer exists, so announcing the fix is safe and is
  expected). Remove it from this queue.

---

## Queue (unfixed — do not ship to client)

### Lootbox / random-reward farming (token-free, NFT-free model)

- Status: idea recorded (econ-001, raw) — added 2026-08-14
- Context: owner's decided model (no token, no sold NFTs) uses EARNED,
  randomly-discovered rewards ("lootbox-style") that open to unlock surprises
  like bonus points and, possibly, earned-only collectible NFTs. Anything with
  random value is a farm/stabilization target on mainnet.
- Hardening plan (do NOT ship anything here to client-served data):
  - Loot RNG must run through the SAME on-chain VRF path (no
    client-computable random), so nobody can pre-roll or predict rewards.
  - Earned-only gates (no purchases of rerolls/keys with real money at first;
    if keys ever exist they must be spendable-points and server-metered).
  - Anti-farm rails server-side (cap discoveries per player/day, funnel
    detection for multi-account discovery, audit in the spend ledger).
  - Any collectible unlock stays on-chain verifiable; never advertise
    "investment value" — the model's whole point is avoiding the token/NFT
    crash label, so no pricing talk in client payloads.
  - Never put any of this in client-served data until shipped.

### Free-with-limits value model — anti-abuse hardening (mainnet phase)

- Status: agreed shape; being designed — added 2026-08-13
- Context: the agreed value model gives every player a daily renewing
  sponsor-cost allowance ("free plays left today"), purchasable top-up via
  spendable points, and free refills during the early phase. On mainnet the
  per-player daily allowance is a real funding obligation for the sponsor, so
  it becomes a target: an attacker who can mint fresh wallets or farm refills
  drains the allowance/refill budget and, at worst, the sponsor reserve.
- Hardening plan (do NOT ship anything here to client-served data):
  - Allowance metering must be SERVER-side and authoritative (the spend ledger
    is the meter; the client only ever *displays* a server-provided
    "free plays left today" value — never computes or mints its own).
  - Refills in the early phase go through a server endpoint that requires the
    requester's verified signature (same challenge-signature gate as the staff
    route), so one identity can't farm unlimited refills. Funnel-refill
    detection (same email/IP/device minting many wallets) is a server audit
    task, tracked here, never public.
  - Points purchases mint points server-side after a verified on-chain payment
    (embedded wallet funds). Never accept a client-claimed "paid" flag that
    isn't backed by an on-chain tx the server confirmed.
  - Competition fairness guards are product rules (never pay-to-enter, finish
    allowance bundled), tracked on the public roadmap; the anti-cheat rails
    (leaderboard bracketing vs volume-grinding, cap-circumvention) are here.
  - Supabase mirrors stay fallback only (same pattern as points: ledger is
    authoritative; a wipe of devnet never grants free allowance).

### Server-side staff gate (stop wallet spoofing)

- Status: waiting (agreed; not started) — added 2026-08-12
- Problem: the changelog admin page's "staff-only" gate is client-side
  (`public/changelog/render.js` + public `roles.json`). Anyone can mock
  `window.getDynamicSolanaWallet` / the roles fetch, or call
  `window.renderChangelog('admin')`, to read the raw view.
- Fix: server issues a nonce → client signs it with the Dynamic wallet →
  server verifies the signature recovers the claimed wallet and checks it
  against a server-side staff list (env/secret, not `public/`). Only verified
  staff receive the raw changelog details.
- Work: rework render.js page flow to POST the signed proof to the server
  instead of trusting `window.getDynamicSolanaWallet`; keep `roles.json` in
  `public/` as a UX hint only, never authoritative.

### Match-state authority is client-fakeable (the "full on-chain" upgrade rationale)

- Status: agreed; being designed — added 2026-08-13
- Problem: today only the FIRST human roll is provably on-chain (MagicBlock
  VRF). Everything else in a live match — roll values (local `Math.random()`),
  turn sequence, token movements, captures, win/finish order, point awards —
  is authored by the browser's game engine. A determined bad actor can inject
  their own local rolls, advance tokens, or report a win, and the app has no
  server/chain state to contradict them.
- Fix (the "Full on-chain Ludo upgrade" roadmap item): move match-state
  authority on-chain so the ER/conttract is the ONLY writer. The browser
  becomes a pure presenter: it sends intended actions (roll request, token
  move, capture) and the delegated program validates rules, computes the next
  state, and records it. Client-authored state can then never be trusted,
  because the client never writes state — there is no input vector for a bad
  actor to exploit. Points likewise move to a `record_points`-style ER
  instruction keyed to the proof roll, so Supabase stays a fallback mirror,
  not an authoritative claim.
- Hard requirements already locked in (do NOT trade these away for
  decentralization):
  - Human-pace AI: unchanged timing (~1.2–1.5s dice, ~1.5s move, ~3.5s post-roll,
    ~1.5s pass). Never make the AI faster/instant — it breaks playability.
  - Web2 UX: gasless via ER, no wallet popups mid-match, no per-action signing
    delay beyond the current feel.
  - Roll latency acceptable on devnet; if on-chain match state causes visible
    lag, keep the CURRENT UX and ship gradual (proof roll on-chain now; moves
    on-chain when no-lag on the ER is verified).
- Work: design ER state account layout + instruction set for moves/captures/
  wins; verify no-lag roll experience on the ER before committing the UX;
  keep the sponsor relay and human-pace AI intact.

### Local off-chain roll values are browser-controlled

- Status: known; deliberately kept until the match-state-upgrade ships (human
  turns after the first roll, and all computer/local seat rolls, use
  `Math.random()` in the client). Not exploitable for *rewards* today (reward
  gated on the on-chain proof roll), but it is a fairness gap for casual
  play. The match-state upgrade above closes this client-side gap entirely.
- Work: none now (superseded by the match-state authority fix).

### Client tamper-notice pipeline (owner-requested)

- Status: agreed; being built — added 2026-08-13
- Goal: when a session shows signs of client-side tampering (edited
  localStorage auth/game state, mocked `window.getDynamicSolanaWallet`,
  replaced dice/random globals, forged profile claims), the client RECORDS a
  tamper notice to Supabase (user, kind, detail, date) and the staff dashboard
  surfaces it. If a cheater later claims "the platform is broken", the owner
  has the recorded attempt as evidence for moderation.
- Honest limitation (be clear in docs/comments, never overstate): the client
  itself can always lie. A determined bad actor can delete or forge the notice,
  so this is a deterrence + audit trail, NOT a security boundary. It catches
  opportunistic tampering (DevTools edits, localStorage pokes) and gives the
  owner accountability data, but it does not stop a determined cheat.
- Work:
  - `public/tamper-guard.js`: integrity checks on key globals (dice source,
    `getDynamicSolanaWallet`, local-points setters) + a localStorage checksum
    of signed-in profile/points so edits are detected on next load.
  - On detection, insert into `point_transactions` (or a `tamper_notices`
    table) with user, kind, detail JSON, created_at.
  - Dashboard "Notices" section reads these and lists user + attempt + date.
  - RLS: rely on the existing anon-write policy used by point awards. If a
    dedicated table is used, it must be created + policy added by the owner via
    Supabase SQL (kept out of the repo, like the rls_fix.sql pattern).