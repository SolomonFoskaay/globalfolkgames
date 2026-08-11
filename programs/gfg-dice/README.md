# gfg-dice — MagicBlock VRF dice program

Provably-fair dice for GlobalFolkGames. A player requests verifiable randomness
from the MagicBlock VRF program (devnet base-layer queue); a verified oracle
fulfills the request and calls back into `callback_roll_dice`, storing two dice
values (`1..=6`) on the player's PDA.

The game client reads the PDA and uses those values for the roll.

## Requirements

| Tool  | Version   | Install |
| ----- | --------- | ------- |
| Solana | 3.x      | https://docs.anza.xyz/cli/install |
| Rust  | 1.8x      | https://rustup.rs |
| Anchor | 1.0.x   | https://www.anchor-lang.com/docs/installation |
| Node  | >= 18     | (already present) |

## Deploy (devnet, one-time)

```bash
cd programs/gfg-dice

# 1. Create a devnet deployer wallet (once) and fund it
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
solana config set --url https://api.devnet.solana.com
solana airdrop 5

# 2. Generate a program keypair + declare its ID, then paste the ID into:
#    - src/lib.rs  `declare_id!("...")`
#    - Anchor.toml below `[programs.devnet]`
solana-keygen new --no-bip39-passphrase -o target/deploy/gfg_dice-keypair.json
solana program show --programs | grep gfg_dice   # or use the generated pubkey

# 3. Build + deploy
anchor build
anchor deploy
```

After deploy, put the program ID + the generated IDL JSON
(`target/idl/gfg_dice.json`) into the browser client. See
`src/magicblock-vrf.js` for how the client loads them.

## Note on the TWO_OF_TWO threshold

`request`'s `caller_seed` uses `client_seed` (1 byte) repeated across 32 bytes.
Keep `client_seed` unique per roll — it is the client-side entropy commitment
included in the VRF proof.