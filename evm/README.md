# evm/ — Arc rail (arcv2m16)

Phase 0 scaffold for the Arc (Circle EVM) rail. Nothing here touches the live
Solana flow: it is a separate Foundry project that compiles and tests locally.

## What Phase 0 proves

The model, with no chain and no cost:

- `GameRegistry`: a game starts with a TTL deadline, settles once, and an
  abandoned game can be expired by anyone after the deadline. Batch roots let
  one transaction commit many games (the cost saver).
- `Randomness`: one seed is committed per batch and revealed later; every game
  roll is derived as `keccak256(seed, gameId, counter)`, so rolls cost nothing
  extra and are verifiable.

## Commands (local only)

```
cd evm
forge build
forge test
```

From the repo root: `npm run evm:build` and `npm run evm:test`.

## Not here yet (later phases)

Deploy + measured cost on Arc Testnet (Phase 1), the gasless relayer
(self-hosted, no paid sponsor plan), batching at scale and the per-game cost
table (Phase 3), and mainnet (Phase 5). No key material is ever stored here.

## Deployed on Arc Testnet (Phase 1, measured 2026-09-18)

- GameRegistry: `0xC0d3c82994e31d8C97A589aCCd480B2Cf36311eb`
- Randomness:   `0xb406295b4F7E5B513b656122AfFF29AF720E9E23`
- Chain 5042002, `https://rpc.testnet.arc.io`, gas 25 Gwei, USDC is gas.
- Deploy cost for BOTH contracts: about 0.023 USDC.

Measured gas and cost per action (one real session, `node scripts/arc-phase1.mjs`):

| Action | Gas | USDC |
| --- | --- | --- |
| commitBatch (opens, 100 games in ONE tx) | 28,985 | 0.000724625 |
| openGame (single) | 97,153 | 0.002428825 |
| commitSeed | 46,041 | 0.001151025 |
| revealSeed | 48,554 | 0.00121385 |
| settleGame (single) | 50,506 | 0.00126265 |
| commitBatch (settles, 100 games in ONE tx) | 46,087 | 0.001152175 |
| a dice roll (derived from the revealed seed) | 0 (read) | 0 |

Batched per game (100 games sharing one open tx and one settle tx): about
**0.000019 USDC**, roughly **50,000 games per USDC**. Single (unbatched) game:
about 0.005 USDC. This confirms the batching design beats the 0.0001 USD/game
target by roughly 5x.
