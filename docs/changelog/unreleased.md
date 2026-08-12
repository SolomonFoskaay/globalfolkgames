- Server-side staff gate so the changelog admin page cannot be spoofed from the
  browser. Current gate (client-side render.js + roles.json) is cosmetic only.
- Server issues a nonce; client signs it with the Dynamic wallet; server
  verifies the signature recovers the claimed wallet and checks it against a
  server-side staff list (env/secret, not public/). Only verified staff receive
  the raw changelog details.
- Rework render.js/require-staff page flow to POST proof to the server instead
  of trusting window.getDynamicSolanaWallet.
- Keep roles.json in public/ as a fallback UX hint only; never authoritative.
