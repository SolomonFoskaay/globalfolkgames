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