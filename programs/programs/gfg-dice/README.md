# gfg-dice — MagicBlock VRF dice program

Provably-fair dice for GlobalFolkGames. A player requests verifiable randomness
from the MagicBlock VRF program (devnet base-layer queue); a verified oracle
fulfills the request and calls back into `callback_roll_dice`, storing two dice
values (`1..=6`) on the player's PDA.

The game client reads the PDA and uses those values for the roll.

## Status

**Deployed on Solana devnet.**

| Item            | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| Program ID      | `CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ`                        |
| Cluster         | `devnet` (base-layer VRF queue `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`) |
| Upgrade auth    | `~/.config/solana/id.json` (deployer wallet)                           |
| Client config   | `src/gfg-dice-config.js` + `src/gfg-dice-idl.json` (repo root)         |

## Requirements

| Tool    | Version | Install                                      |
| ------- | ------- | -------------------------------------------- |
| Solana  | 3.x     | https://docs.anza.xyz/cli/install            |
| Rust    | 1.8x    | https://rustup.rs                            |
| Anchor  | 1.0.x   | `cargo install --git https://github.com/solana-foundation/anchor avm --force` then `avm use 1.0.2` |

## Rebuild (after code changes)

```bash
cd programs            # Anchor workspace root (contains Anchor.toml)
anchor build
```

Artifacts land in `programs/target/deploy/` (`.so` + program keypair) and
`programs/target/idl/gfg_dice.json`. The `target/` dir is gitignored — the
program keypair must never be committed.

## Redeploy / upgrade

```bash
cd programs
anchor program deploy \
  --program-keypair target/deploy/gfg_dice-keypair.json \
  --provider.cluster https://api.devnet.solana.com
```

Keep the deployer wallet (`~/.config/solana/id.json`) and the program keypair
(`programs/target/deploy/gfg_dice-keypair.json`) backed up together. Losing both
means you cannot upgrade the program; you'd deploy a fresh program with a new ID.

If you want to bump the program ID, instead generate a new keypair and update
`declare_id!` in `src/lib.rs` + `[programs.devnet]` in `Anchor.toml`, then build
and deploy.

## Client note (important)

The program is built with **Anchor 1.x**, which emits the new "spec" IDL format.
The browser client MUST use the matching 1.x SDK — `@anchor-lang/core` (NOT the
old `@coral-xyz/anchor` 0.32 client, which crashes parsing spec IDLs).
`src/magicblock-vrf.js` imports `Program`/`AnchorProvider` from
`@anchor-lang/core` and constructs it as `new Program(idl, provider)` (the
program ID is read from `idl.address`, not passed separately).

`programs/` is not built by Vercel — the site only ships `src/`. The program ID
and IDL are already baked into `src/gfg-dice-config.js` + `src/gfg-dice-idl.json`.

## Note on the TWO_OF_TWO threshold

`request`'s `caller_seed` uses `client_seed` (1 byte) repeated across 32 bytes.
Keep `client_seed` unique per roll — it is the client-side entropy commitment
included in the VRF proof.
