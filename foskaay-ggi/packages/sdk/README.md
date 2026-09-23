# @foskaay/ggi-sdk

Add **gasless play** to any on-chain game on Arc. Open a session, do everything
inside for free, settle once. Players never pay gas and never see a wallet popup.

This package is the **Foskaay Gasless Games Infrastructure (Foskaay GGI)** client: the
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

## Who pays what (read this first)

This is the part most first-time integrators get wrong, so it is stated plainly:

- **Players pay nothing.** Ever. No gas, no top-ups, no popups. This rail has no
  player-pay option at all, by design.
- **The game pays a small fixed fee per session** (charged once, at settle). It is
  charged in USDC, and the amount is read from the chain at runtime with
  `ggi.fees()`, never hardcoded here.
- **The game operator (a sponsor/relayer) submits and pays the transactions.** The
  player's wallet is their **identity** and the **session-key authoriser**, nothing
  more. A player with an empty wallet plays fine.
- **During play, nothing is sent to the chain.** Actions are signed by a session
  key and folded into a digest locally. Only open and settle are transactions.

So a real game has two roles: the **player's wallet** (identity, no funds needed)
and your **sponsor wallet** (pays the tiny gas and the per-session fee).

---

## A wallet is required (it is the identity)

You cannot credit points to nobody, so a wallet must be connected. Which wallet is
your choice: Dynamic, MetaMask, or anything that provides a viem `WalletClient`.
The SDK is wallet-agnostic: it accepts any `walletClient`.

```js
import { createWalletClient, custom, http } from 'viem';

// Any provider works. For an injected wallet:
const walletClient = createWalletClient({
  chain,
  transport: custom(window.ethereum),
  account: (await window.ethereum.request({ method: 'eth_requestAccounts' }))[0],
});
```

The player signs **one** thing per session (authorising their session key). After
that, every action signs silently and costs nothing.

---

## The authority rule (the #1 integration trap)

A session that never sets a **seat authority** can never be settled. `commitDigest`
and `sealFinal` only accept a call from an authorised seat signer, so if you open a
session and skip authorities, settlement reverts and you will not know why.

Two ways to get it right:

```js
// Option A (easiest): pass authorities to open(), it sets them for you.
const { sessionId } = await ggi.open({
  participants: 1,
  ttlSecs: 3600,
  authorities: [playerAddress],   // index = seat
});

// Option B: call setAuthority yourself before you settle.
await ggi.setAuthority(sessionId, 0, playerAddress);
```

If you forget, `settle()` now throws a clear message instead of a terse revert:
"this session has no seat authority, so it cannot be settled."

---

## In the browser (no bundler needed)

The package ships a ready browser bundle, so a plain HTML page can use it:

```html
<script src="https://cdn.jsdelivr.net/npm/@foskaay/ggi-sdk/dist/ggi-sdk.browser.js"></script>
<script>
  const { foldDigest, payloadHashOf, ZERO_DIGEST, GgiClient } = window.GgiSdk;
</script>
```

Or with a bundler, import it normally: `import { GgiClient } from '@foskaay/ggi-sdk'`.

---

## The four calls

```js
import { GgiClient, ZERO_DIGEST } from '@foskaay/ggi-sdk';
import { createWalletClient, http } from 'viem';

// The walletClient is your SPONSOR wallet (the one that pays gas). On a server
// it is a key you control; for a quick local test it can be any funded wallet.
const ggi = new GgiClient({
  network: 'testnet',                 // 'testnet' | 'mainnet'
  walletClient,                       // pays gas for open and settle
});

// 1. OPEN a session (one transaction)
const { sessionId } = await ggi.open({
  participants: 2,
  ttlSecs: 3600,
  rulesHash: myRulesHash,            // optional commitment to your rules
  seeds: [mySeed],                    // optional: only if your game needs randomness
});

// 2. ACT during play: FREE, signed, no popup, no chain write
const key = ggi.createSessionKey();   // the player's throwaway signer
await ggi.registerSessionKey(key.address, Math.floor(Date.now() / 1000) + 3600);

let state = { sessionId, digest: ZERO_DIGEST, eventCount: 0 };
const step = await ggi.actSigned(
  state,
  { seat: 0, sequence: 1, payload: myMove },
  key
);
state = step.state;                   // keep this; store step.signature with your log

// 3. SETTLE once at the end (one transaction): close + reveal + seal + fee
await ggi.settle(sessionId, { digest: state.digest, seeds: [mySeed] });

// 4. DISPUTE is optional and game-level: hand the signed reveal to your verifier
if (disagreement) ggi.dispute(sessionId, myReveal);
```

That is the entire API surface. Everything else is read helpers.

---

## Proving it is tamper-proof (the whole point)

An action's signature is what makes the result trustable. You can show this in
four lines: sign an action, verify it, then change the action and watch the
signature stop matching.

```js
const key = ggi.createSessionKey();
const state = { sessionId, digest: ZERO_DIGEST, eventCount: 0 };

const a = await ggi.actSigned(state, { seat: 0, sequence: 1, payload: { move: 'e4' } }, key);
await ggi.verifyAction(a.signThis, a.signature, key.address);   // true

// Tamper with the move: the same signature no longer matches.
const b = ggi.act(state, { seat: 0, sequence: 1, payload: { move: 'e5' } });
await ggi.verifyAction(b.signThis, a.signature, key.address);   // false
```

That is why a fake result cannot settle: the digest the chain receives is bound
to signatures over the exact actions.

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
const key = ggi.createSessionKey();                       // make one
await ggi.registerSessionKey(key.address, validUntil);    // authorise it once
// sign every action with it:
await ggi.signAction(key, someActionString);
// when the player leaves or you suspect a leak:
await ggi.revokeSessionKey(key.address);
```

`createSessionKey()` holds the private key in memory only. If you persist it,
store it encrypted (for example in IndexedDB behind a key), never in plain text.

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
