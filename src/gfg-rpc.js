// src/gfg-rpc.js
// Devnet Solana base-layer RPC resolution + MagicBlock Router helpers.
//
// ARCHITECTURE (MagicBlock-first): the single Magic Router endpoint
// (devnet-router.magicblock.app) is the PRIMARY connection for every base-layer
// RPC call AND transaction. The Router inspects each tx's writable accounts:
// delegated PDAs are auto-routed to the Ephemeral Rollup (gasless, ~10 ms
// blocks), everything else goes to Solana devnet. We only fall back to a
// third-party provider key / public RPCs when the Router is unreachable.
//
// Consumers:
//   - the gfg-dice client (src/magicblock-vrf.js, src/gfg-dice-config.js)
//   - the sponsor relay (scripts/delegate-relay.mjs)
//   - the lab harnesses (scripts/lab/*, er-test.mjs)
//
// Exports:
//   - routerUrl()          -> the Magic Router devnet endpoint
//   - baseRpcEndpoints()   -> priority-ordered failover chain (Router first)
//   - baseRpcUrl()         -> first usable endpoint (primary)
//   - createConnection(url)-> Connection whose confirmTransaction polls
//                             getSignatureStatuses (MagicBlock's own confirm
//                             strategy; also the only way to confirm on RPCs
//                             that lack the signatureSubscribe WS method).
//   - closestValidatorCn() -> Router getIdentity helper for delegating a PDA
//                             to the nearest ER validator.
//   - sendMagicTx()        -> getBlockhashForAccounts-aware send for txs that
//                             touch delegated accounts (standard getLatestBlockhash
//                             is WRONG there: blockhash progression differs per layer).
//
// See: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router

import { Connection, PublicKey } from '@solana/web3.js';

// Magic Router (the recommended single endpoint for devnet dApps).
export const ROUTER_DEVNET = 'https://devnet-router.magicblock.app';

export function routerUrl() {
  return ROUTER_DEVNET;
}

// Failover chain: Magic Router first; provider-key override (relay/server) or
// build-time VITE key (browser) next; keyless public endpoints last-resort.
const PUBLIC_ENDPOINTS = [
  'https://solana-devnet.api.onfinality.io/public',
  'https://api.devnet.solana.com',
];

function envEndpoints() {
  const out = [];
  try {
    if (typeof process !== 'undefined' && process.env?.GFG_DEVNET_RPC) out.push(process.env.GFG_DEVNET_RPC);
  } catch (e) { /* not a node env */ }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEVNET_RPC) out.push(import.meta.env.VITE_DEVNET_RPC);
  } catch (e) { /* no build-time env */ }
  return out;
}

export function baseRpcEndpoints() {
  return [ROUTER_DEVNET, ...envEndpoints(), ...PUBLIC_ENDPOINTS];
}

export function baseRpcUrl() {
  return baseRpcEndpoints()[0];
}

// Create a Solana Connection whose confirmTransaction polls getSignatureStatuses
// instead of subscribing via websocket. This mirrors MagicBlock's own
// confirmMagicTransaction (polling is their documented strategy) and, unlike
// signatureSubscribe, works on EVERY RPC in the failover chain (Alchemy's
// devnet endpoint does not implement the WS method, so web3's default confirm
// would hang even when the tx landed).
export function createConnection(url, commitment = 'confirmed', timeoutMs = 30000) {
  const conn = new Connection(url, commitment);
  conn.confirmTransaction = async (strategy, commit) => {
    const signature = typeof strategy === 'string' ? strategy : strategy.signature;
    const comm = commit || conn.commitment || 'confirmed';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { value } = await conn.getSignatureStatuses([signature]);
      const status = value && value[0];
      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmationStatus === comm || status.confirmationStatus === 'finalized') {
          return { value: status };
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Transaction was not confirmed in ${timeoutMs / 1000}s (${signature})`);
  };
  return conn;
}

// Ask the Magic Router which ER validator is closest to us. The Router inspects
// where our requests land and returns the nearest validator identity + its
// per-region ER base URL. Use the returned validator when delegating a PDA so
// rolls execute on the fastest available Ephemeral Rollup.
export async function closestValidator(connection) {
  const res = await fetch(connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getIdentity', params: [] }),
  });
  const data = await res.json();
  if (!data.result || !data.result.identity) throw new Error('getIdentity: invalid response from router');
  return { pubkey: new PublicKey(data.result.identity), fqdn: data.result.fqdn || null };
}

// Ask the Magic Router whether an account is currently delegated to an ER, and
// if so WHERE it lives. This is the authoritative delegation check — it must be
// used instead of `getAccountInfo().owner === DELeGG`, because the Router (and
// any ER region endpoint) returns the account as owned by its ORIGINAL program
// (the ER hosts the account's state, so the delegation program is not its
// owner). `getAccountInfo` on the base layer shows the delegation-program owner,
// but after switching to the Router as the primary RPC that view is gone.
// Endpoint is the router's /getDelegationStatus method (their SDK calls it).
export async function getDelegationStatus(connection, account) {
  const accountAddress = typeof account === 'string' ? account : account.toBase58();
  const res = await fetch(`${connection.rpcEndpoint}/getDelegationStatus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getDelegationStatus',
      params: [accountAddress],
    }),
  });
  const data = await res.json();
  if (!data.result) throw new Error(`getDelegationStatus failed: ${JSON.stringify(data.error || data)}`);
  return data.result; // { isDelegated, fqdn, delegationRecord? }
}

// Correct per-layer blockhash for a transaction: the Router looks at the tx's
// writable accounts and returns the blockhash of whichever layer they live on
// (ER or base). Standard getLatestBlockhash is NOT valid for txs that write
// delegated accounts — blockhash progression differs between the layers.
// `accounts` = the writable account pubkeys of the transaction.
export async function getBlockhashForAccounts(connection, accounts) {
  const res = await fetch(connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBlockhashForAccounts',
      params: [accounts.map(a => (typeof a === 'string' ? a : a.toBase58()))],
    }),
  });
  const data = await res.json();
  const inner = data && data.result ? (data.result.value && data.result.value.blockhash ? data.result.value : data.result) : null;
  if (!inner || !inner.blockhash) throw new Error(`getBlockhashForAccounts failed: ${JSON.stringify(data.error || data)}`);
  return inner; // { blockhash, lastValidBlockHeight }
}

// Collect the writable accounts of a legacy Transaction (fee payer + all
// instruction keys flagged writable). Mirrors MagicBlock's getWritableAccounts.
export function getWritableAccounts(transaction) {
  const writable = new Set();
  if (transaction.feePayer) writable.add(transaction.feePayer.toBase58());
  for (const instruction of transaction.instructions) {
    for (const key of instruction.keys) {
      if (key.isWritable) writable.add(key.pubkey.toBase58());
    }
  }
  return Array.from(writable);
}

// MagicBlock-native send for base-layer txs through the Magic Router.
// Standard getLatestBlockhash returns the ROUTER's blockhash (its own layer),
// which base Solana rejects. getBlockhashForAccounts returns the correct
// base-layer blockhash for as-yet-undelivered accounts, so we fetch it, set it
// on the tx, sign, then send raw. Returns the signature.
//
// signers: array of web3 Signer (e.g. [sponsorKeypair] for the relay).
export async function sendMagicTx(connection, transaction, signers = [], sendOptions) {
  const blockhash = await getBlockhashForAccounts(connection, getWritableAccounts(transaction));
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  transaction.partialSign(...signers);
  const wire = transaction.serialize();
  return connection.sendRawTransaction(wire, sendOptions);
}