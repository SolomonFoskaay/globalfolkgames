# @foskaay/ggi-sdk

Add **gasless play** to any on-chain game on Arc. Open a session, do everything
inside for free, settle once. Players never pay gas and never see a wallet popup.

This package is the **Foskaay Gasless Games Infrastructure (GGI)** client: the
one-line integration. Installing it is the whole setup; there is no fork and no
contract to copy.

- Overview and contract addresses: **/foskaay-ggi-docs**
- Network details ship in `@foskaay/ggi-contracts`

---

## Install

```bash
npm install @foskaay/ggi-sdk viem
```

`viem` is a peer dependency, so it stays in your app where it already lives.

---

## The four calls

```js
import { GgiClient } from '@foskaay/ggi-sdk';
import { createWalletClient, http } from 'viem';

const ggi = new GgiClient({
  network: 'testnet',                 // 'testnet' | 'mainnet'
  walletClient,                       // a viem WalletClient that signs
});

// 1. OPEN a session (one transaction)
const { sessionId } = await ggi.open({
  participants: 2,
  ttlSecs: 3600,
  rulesHash: myRulesHash,            // optional commitment to your rules
  seeds: [mySeed],                    // optional: only if your game needs randomness
});

// 2. ACT during play: FREE, signed, no popup, no chain write
let state = { sessionId, digest: ZERO_DIGEST, eventCount: 0 };
state = ggi.act(state, { seat: 0, sequence: 1, payload: myMove }).state;

// 3. SETTLE once at the end (one transaction): close + reveal + seal + fee
await ggi.settle(sessionId, { digest: state.digest, seeds: [mySeed] });

// 4. DISPUTE is optional and game-level: hand the signed reveal to your verifier
if (disagreement) ggi.dispute(sessionId, myReveal);
```

That is the entire API surface. Everything else is read helpers.

---

## Why it is cheap

`act()` does **not** write to the chain. It folds your action into a running
digest locally and returns the exact string to sign. The chain only sees **open**
and **settle**, so a thousand actions cost the same as one. The per-session fee
is read from the contract at runtime (`ggi.fees()`), never hardcoded.

---

## Session keys (no popups during play)

A session key is a throwaway signer your player authorises once, so actions sign
silently while they play:

```js
await ggi.registerSessionKey(sessionKeyAddress, validUntil, scopeHash);
// when the player leaves or you suspect a leak:
await ggi.revokeSessionKey(sessionKeyAddress);
```

---

## Read helpers

```js
await ggi.getSession(sessionId);      // the full session record
await ggi.canSign(sessionId, seat, who); // is this address allowed to act?
await ggi.digestOf(sessionId);        // the running digest
await ggi.streamCountOf(sessionId);   // how many random streams this session uses
await ggi.derive(seed, counter);      // a random value from a revealed seed
await ggi.fees();                     // live per-session fee (never hardcoded)
```

---

## Utilities

```js
import { payloadHashOf, foldDigest, predictSessionId, ZERO_DIGEST, actionDigestString } from '@foskaay/ggi-sdk';
```

`foldDigest` reproduces the on-chain digest formula **exactly** (there is a
Foundry test that pins this, so the two can never drift). You can build the whole
off-chain log and know it will match the chain.

---

## Write a small adapter (the only game-specific code)

Your game turns its own state into a payload. The rail never reads it:

```js
function toPayload(move) {
  // anything serialisable, and it must be stable for the same move
  return { from: move.from, to: move.to, die: move.die };
}
```

That adapter is the ONLY game-specific code, and it lives in your game.

---

## Optional patterns

These are offered, never enforced. Use them, ignore them, or build your own:

- **Batched settlement**: fold many settlements into one Merkle root per window.
- **Managed accounts**: one account per player with slots for every feature.
- **Verifiers**: a per-game referee that settles a disagreement.
- **House or relayer as a participant**: for games with an AI opponent.

---

## License

MIT
