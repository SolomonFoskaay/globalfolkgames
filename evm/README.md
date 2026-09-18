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
