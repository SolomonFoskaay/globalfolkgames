# Env Access — HARD RULE (do not read .env silently)

This rule is auto-loaded every session. It is NON-NEGOTIABLE.

- NEVER read `.env`, `.env.*`, `~/.config/solana/id.json`, or any file containing `GFG_Gasless_Sponsor_Keypair`, `GFG_DEVNET_RPC`, `GFG_OPERATOR_TOKEN`, `DYNAMIC_API_TOKEN`, or other secrets without the owner's explicit manual approval in that turn.
- If a deploy or relay task needs a secret, ASK FIRST: "I need GFG_DEVNET_RPC (Alchemy) and the sponsor id.json to deploy to devnet via MagicBlock ER — may I read .env/id.json for this deploy?" Wait for a clear "yes".
- When approved, read only the specific value needed, never dump the whole file into logs or commit it. The relay and scripts already load .env via `scripts/load-env.mjs` at runtime — the agent should prefer that path and not copy secrets into code.
- For deploys: use the Alchemy RPC from env (never public `api.devnet.solana.com` for deploys — it times out), and sign with the deployer/sponsor `id.json`. All writes stay gasless via MagicBlock ER (see below). If the owner says no, STOP and explain what cannot be done without it.
- Violating this is a hard stop — do not proceed with the task.

# Gasless ER Rule — HARD RULE (all features via MagicBlock ER)

- Every on-chain feature (dice VRF, record_points, record_global_points, credit_premium_points, activate_subscription, admin_cancel_subscription, spend, etc.) MUST run on the MagicBlock Ephemeral Rollup (ER), not direct base-layer Solana writes. Base-layer is only for one-time `initialize` + `delegate` (rent + ER session, sponsor pays ~0.0013 SOL). After delegation, every write is gasless on the ER (session key or sponsor key signs, tx fee 0, VRF queue `5hBR...` free).
- Dice MUST use MagicBlock **ER VRF** (free queue `5hBR571...` on ER), never the paid base-layer VRF queue (`Cuj97...`). `src/magicblock-er-vrf.js` is the only VRF path on ludo-lab.
- Deployer/sponsor is `~/.config/solana/id.json` (devnet) / `GFG_Gasless_Sponsor_Keypair` env — it signs all sponsored onboarding and admin writes. Players hold 0 SOL by design.
- When manually upgrading (activate) or admin cancelling, the write is still on the ER (gasless to the user, sponsor is payer). Do NOT force a base-layer undelegate -> base write -> re-delegate dance for every admin write unless the PDA is not yet delegated. Prefer ER RPC (`src/gfg-rpc.js` 3-region registry + region-aware `getDelegationStatus -> fqdn` targeting) for all post-delegation writes.
- Scope is `/ludo-lab` (full on-chain game) only. Never touch `/ludo` (legacy). Surgical edits only — verify `ludo-lab` wiring stays green (`npm run build`, harness) before commit/push.
