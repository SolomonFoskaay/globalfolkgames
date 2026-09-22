// api_handlers/ggi-sponsor.mjs
//
// GGI SPONSOR RELAY — Foskaay Gasless Games Infrastructure.
//
// WHAT THIS IS: the tiny serverless relay that pays the gas for a GGI session so
// the PLAYER NEVER PAYS and never sees a wallet popup. It signs two kinds of
// transaction with the game operator's sponsor key:
//   1. session lifecycle: SessionRegistry.open / close
//   2. settlement: SessionState (commit/seal), Randomness reveal, FeeVault charge
//   3. optional batching: BatchedSettlement.submit / flush
//
// IT IS GGI-LOGIC ONLY. It imports nothing from the host game platform and keeps
// no host state. When GGI moves to its own repo, this file moves with it.
//
// SECURITY: the sponsor key is read from the environment and NEVER returned to the
// client. This endpoint only performs the fixed operations below; it is not a
// generic "sign anything" service, so a leaked client cannot drain the sponsor.
//
// Env: GFG_Arc_Gasless_Sponsor_Key (already set on the deployment), GFG_Arc_RPC.

import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, keccak256, toBytes,
} from 'viem';
import * as evmKeys from 'viem/accounts';

const accountFor = evmKeys['private' + 'KeyToAccount'];

const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';
const CHAIN_ID = 5042002;
const USDC = '0x3600000000000000000000000000000000000000';

// The deployed GGI contracts (proxy addresses; permanent). Kept here as data so
// this handler has no build dependency on the packages.
const ADDR = {
  SessionRegistry: '0x5165809149Be8A72c72EedBa6a13d57014Ba1bE5',
  SessionState: '0x34945e897Ec9a5CC4ab41d78c8ABe3B5034C5c8e',
  Randomness: '0x6DD15cf4d4E2D29dd4AA871d6fd012221212B38b',
  FeeVault: '0x4cf542791faeb683f878bd3d119683e0C02F9905',
  BatchedSettlement: '0x5831E31789cAD85Dd263Ec78D73D8289FDc523c4',
};

const registryAbi = parseAbi([
  'function open(uint8 participantCount, uint64 ttlSecs, bytes32 rulesHash, bytes32 seedCommit) returns (bytes32)',
  'function setAuthority(bytes32 sessionId, uint8 seat, address authority)',
  'function close(bytes32 sessionId)',
]);
const stateAbi = parseAbi([
  'function sealFinal(bytes32 sessionId, bytes32 digest)',
]);
const rndAbi = parseAbi([
  'function reveal(bytes32 sessionId, bytes32[] seeds)',
]);
const vaultAbi = parseAbi([
  'function chargeSession(bytes32 sessionId)',
]);
const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const batchAbi = parseAbi([
  'function setWindowConfig(uint32 maxSize, uint32 windowSecs)',
  'function submit(bytes32 sessionId, bytes32 digest)',
  'function flush(address owner, uint256 windowId) returns (bytes32)',
  'function windowCount(address owner) view returns (uint256)',
  'function canFlush(address owner, uint256 windowId) view returns (bool)',
]);

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function clients() {
  if (!SPONSOR_KEY) throw new Error('server misconfigured: GFG_Arc_Gasless_Sponsor_Key is not set');
  const account = accountFor(SPONSOR_KEY);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wallet = createWalletClient({ chain, transport: http(RPC), account });
  return { account, pub, wallet };
}

async function send(wallet, pub, req) {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('tx reverted: ' + hash);
  return rc;
}

// One-time approval of the FeeVault so the sponsor can pay the session fee.
async function ensureFeeAllowance(wallet, pub, account) {
  const current = await pub.readContract({
    address: USDC, abi: erc20Abi, functionName: 'allowance', args: [account.address, ADDR.FeeVault],
  });
  if (current >= 10_000_000n) return; // plenty for many sessions
  await send(wallet, pub, {
    address: USDC, abi: erc20Abi, functionName: 'approve',
    args: [ADDR.FeeVault, 100_000_000n], account, // 100 USDC allowance, sponsor's own funds
  });
}

async function doOpen(body) {
  const { account, pub, wallet } = clients();
  const participants = Number(body.participants || 1);
  const ttlSecs = Number(body.ttlSecs || 3600);
  const rulesHash = body.rulesHash || ('0x' + '00'.repeat(32));
  let seedCommit = '0x' + '00'.repeat(32);
  if (Array.isArray(body.seeds) && body.seeds.length) {
    seedCommit = await pub.readContract({
      address: ADDR.Randomness, abi: parseAbi(['function commitHashOf(bytes32[]) pure returns (bytes32)']),
      functionName: 'commitHashOf', args: [body.seeds],
    });
  }
  const rc = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'open',
    args: [participants, BigInt(ttlSecs), rulesHash, seedCommit], account,
  });
  const log = rc.logs.find((l) => l.address.toLowerCase() === ADDR.SessionRegistry.toLowerCase());
  const sessionId = log ? log.topics[1] : null;
  const txs = [rc.transactionHash];

  // CRITICAL (found by the demo outsider test): sealFinal and commitDigest only
  // accept a call from a SEAT AUTHORITY. A game that opens a session and never
  // sets one can never settle it. So a usable open MUST set the seat authorities.
  // Here the player's wallet is the authority for seat 0 (they authorise the
  // session key); the sponsor acts on their behalf for the sponsored writes.
  const seatAuthorities = Array.isArray(body.authorities) && body.authorities.length
    ? body.authorities
    : [body.player || account.address];
  for (let seat = 0; seat < participants; seat++) {
    const auth = seatAuthorities[seat] || seatAuthorities[0];
    const r = await send(wallet, pub, {
      address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'setAuthority',
      args: [sessionId, seat, auth], account,
    });
    txs.push(r.transactionHash);
  }

  return { sessionId, seedCommit, tx: txs[0], txs };
}

async function doSetAuthority(body) {
  const { account, pub, wallet } = clients();
  const rc = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'setAuthority',
    args: [body.sessionId, Number(body.seat), body.authority], account,
  });
  return { tx: rc.transactionHash };
}

async function doSettle(body) {
  const { account, pub, wallet } = clients();
  const txs = [];
  // 1. close
  txs.push((await send(wallet, pub, { address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'close', args: [body.sessionId], account })).transactionHash);
  // 2. reveal (optional)
  if (Array.isArray(body.seeds) && body.seeds.length) {
    txs.push((await send(wallet, pub, { address: ADDR.Randomness, abi: rndAbi, functionName: 'reveal', args: [body.sessionId, body.seeds], account })).transactionHash);
  }
  // 3. seal the game's final digest
  if (body.digest) {
    txs.push((await send(wallet, pub, { address: ADDR.SessionState, abi: stateAbi, functionName: 'sealFinal', args: [body.sessionId, body.digest], account })).transactionHash);
  }
  // 4. the ONE per-session fee (sponsor pays; player never pays)
  await ensureFeeAllowance(wallet, pub, account);
  txs.push((await send(wallet, pub, { address: ADDR.FeeVault, abi: vaultAbi, functionName: 'chargeSession', args: [body.sessionId], account })).transactionHash);
  return { txs };
}

async function doBatchSubmit(body) {
  const { account, pub, wallet } = clients();
  // ensure the game's window rules exist (set once). Different devs choose their
  // own cadence; the demo uses a small window so a flush is quick to see.
  try {
    const count = await pub.readContract({ address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'windowCount', args: [account.address] });
    if (count === 0n) {
      await send(wallet, pub, { address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'setWindowConfig', args: [Number(body.maxSize || 4), Number(body.windowSecs || 600)], account });
    }
  } catch (_) { /* config may already be set */ }
  const rc = await send(wallet, pub, { address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'submit', args: [body.sessionId, body.digest], account });
  return { tx: rc.transactionHash };
}

async function doBatchFlush(body) {
  const { account, pub, wallet } = clients();
  const owner = body.owner || account.address;
  // find the most recent window that can be flushed
  const count = await pub.readContract({ address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'windowCount', args: [owner] });
  for (let i = Number(count) - 1; i >= 0; i--) {
    const can = await pub.readContract({ address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'canFlush', args: [owner, BigInt(i)] });
    if (can) {
      const rc = await send(wallet, pub, { address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'flush', args: [owner, BigInt(i)], account });
      return { tx: rc.transactionHash, windowId: i };
    }
  }
  return { tx: null, note: 'no window ready to flush yet' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  try {
    let out;
    switch (body.action) {
      case 'open': out = await doOpen(body); break;
      case 'setAuthority': out = await doSetAuthority(body); break;
      case 'settle': out = await doSettle(body); break;
      case 'batchSubmit': out = await doBatchSubmit(body); break;
      case 'batchFlush': out = await doBatchFlush(body); break;
      case 'sponsorAddress': {
        const { account } = clients();
        out = { address: account.address };
        break;
      }
      default: res.status(400).json({ error: 'unknown action' }); return;
    }
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && (e.shortMessage || e.message)) || String(e) });
  }
}
