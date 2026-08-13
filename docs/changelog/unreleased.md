- Changelog polls for updates every 45s; new content shows a refresh pill
- Reader chooses when to apply the update (no silent refresh)
- Devtools console shows a security warning for player who open it (like
  Dynamic's): never paste unknown code / share login codes
- Sponsor spend guard: relay now enforces per-player (0.005 SOL default) and global (1.0 SOL) spend caps plus a sponsor reserve floor, with a durable ledger of real spend (file-based, env-tunable). Server-side only; never shipped to client.
- Relay bug fixed: Anchor `.transaction()` returns a Promise in @anchor-lang/core 1.1.2; the relay passed it unawaited to `sendMagicTx`, throwing 'transaction.instructions is not iterable' on every delegate. Both call sites now `await` the transaction. Verified live on devnet (fresh player init+delegate OK, idempotent no-op OK).
