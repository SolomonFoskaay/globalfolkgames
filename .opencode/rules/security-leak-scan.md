# Security / Sensitive-Data Leak Scan — HARD RULE (run before EVERY commit/push)

This rule is auto-loaded into every session. It is NON-NEGOTIABLE. Before the
agent runs `git commit` OR `git push` (or requests a commit/push), it MUST run
the leak scan below. The owner's instruction is explicit: **always check that
no security or sensitive data/info is leaked through the code before ever
committing and pushing.** A secret that lands on the remote (even a private
repo, even devnet) is a live compromise; never "push and fix later".

## Step 0: Self-verification (HARD RULE — run BEFORE the leak scan)

Before the leak scan and before `git commit`, stop and answer honestly:

**"Are you sure all features/fixes you just completed are done correctly
and working fine?"**

If you cannot answer a confident "yes", do NOT proceed. Instead:
- Re-read every file you edited.
- Trace the call paths: does the caller's method name match the callee?
- Check DOM element IDs exist where referenced.
- Confirm script loading order (does the module exist at the time it's called?).
- Confirm `npm run build` passes.
- Fix anything you find before continuing.

This catches bugs like calling `magic.globalPointsPdaFor()` when the method is
named `globalPointsPda()`, or referencing `window.globalLedger` on a page that
never loads `global-ledger.js`, or capturing a DOM element that gets rebuilt
after sign-in. The leak scan cannot catch logic errors; this step can.

## What counts as a leak (scan for ALL of these)

1. **Solana secret key material:**
   - A keypair as a JSON array of 64 integers (`[13, 2, ...]`) — the repo's own
     `GFG_Gasless_Sponsor_Keypair` format and `~/.config/solana/id.json` format.
   - Base58 private keys (87–88 char base58 strings that look like a secret),
     `"secretKey"` / `"privateKey"` fields, `sk:` prefixed keys.
   - Seed phrases / mnemonics (12/24 words, e.g. "abandon ... about").
   - The words: `secret`, `private key`, `seed phrase`, `mnemonic`, `id.json`
     contents, `GFG_Gasless_Sponsor_Keypair`, `keypair` + literal array values.
2. **API keys / tokens / credentials:**
   - Supabase: `service_role` (SECRET — never in client code), `anon` keys in
     server-only files are OK but double-check they are the public `anon` key
     and go only where the client truly needs them; `sb_publishable`/`sb_secret`.
   - JWT / Bearer tokens (`eyJ...`, `Bearer `), OAuth client secrets.
   - Dynamic (wallet) API keys/secrets, Vercel/Cloudflare tokens, GitHub PAT
     (`ghp_...`), AWS keys (`AKIA...`), OpenAI (`sk-...`), any `<KEY>`/`<SECRET>`
     that is a real value, not a placeholder.
   - RPC URLs or connection strings that embed a username/password or token.
3. **Environment secrets:** any literal contents that should only live in
   `.env` / Vercel env / local config. `.env`, `.env.*`, and `.gfg-*` ledger
   files must stay untracked (gitignored) — they must NEVER appear in a diff.
4. **Personal/sensitive data:** wallet private keys, emails/phones beyond
   consented test data, or data a page promises to hide but ships to the client.

## The scan (run before commit AND before push)

```bash
# 1) What is actually staged / about to go out?
git diff --cached --name-only
# 2) Grep the FULL staged diff text for secret patterns.
git diff --cached | grep -nEi \
  'service_role|sb_secret|ghp_|AKIA|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9]|BEGIN (RSA|OPENSSH|EC) PRIVATE|private ?key|seed ?phrase|mnemonic|GFG_Gasless_Sponsor_Keypair|\"secretKey\"|sk:[A-Za-z0-9]{20,}|[0-9]{2,3},\s*[0-9]{2,3},[0-9,]{80,}' \
  || echo "CLEAN (staged)"
# 3) Also scan the full working-tree diff (unstaged edits you are about to stage).
git diff | grep -nEi '<same pattern>' || echo "CLEAN (worktree)"
# 4) Confirm no ignored secret files would slip in (must print EMPTY for the guarded files).
git status --porcelain | grep -E '\.env|\.gfg-' || echo "CLEAN (ignored files)"
# 5) Spot-check the .gitignore actually covers them.
git check-ignore .env .gfg-spend-ledger.json 2>/dev/null || echo "WARN: check .gitignore"
```

On the local machine only, it is also fine to run a repo-wide scan:
`git grep -nEi '<same pattern>' -- ':!public/changelog/changelog.json'`
but the authoritative gate is the **staged/worktree diff** — only what leaves
in the commit matters.

## Verdicts

- **Any hit in the staged or worktree diff = HARD STOP.** Do NOT commit, do NOT
  push. Remove/scrub the secret, add it to `.gitignore` or `.env` if it is real
  config, then re-run the scan until CLEAN. If the secret already reached a
  remote, tell the owner immediately (rotate/revoke is the owner's call).
- **CLEAN = proceed.** Then the commit/push may run.
- **Public-key and program-id constants are NOT secrets** (deployer pubkey
  `5ec9bYw...MdhdTQ`, program ids, ER validator pubkeys — they are already in
  AGENTS.md and are safe to reference). Only the *private* half is sensitive.
- **Client-served data rule stays:** never commit client payloads that contain
  unfixed security/anti-exploit detail (that goes in
  `docs/changelog/security-queue.md` only) — see AGENTS.md.

## Note for the agent

If the task is a feature/tooling change, this scan is ONE line in the final
step list, not extra work: `commit` is not allowed to run before it. When the
owner asks for a commit/push, still run the scan — never skip it because the
owner asked. The scan protects the owner.

**Remember the order:** Step 0 (self-verify your work) THEN the leak scan
THEN commit/push. Never skip step 0 — the owner will not repeat this.
