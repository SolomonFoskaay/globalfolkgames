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