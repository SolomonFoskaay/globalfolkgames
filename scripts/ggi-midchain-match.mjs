// scripts/ggi-midchain-match.mjs — play the midchain Generals match on Arc testnet.
//
// THE POINT: every move runs through a PURE function via eth_call (free) and is
// signed + hash-chained off-chain. Only the session endpoints touch the chain.
// Compare the measured cost to the on-chain-board port (about 0.098 USDC per
// match, about 10 games per 1 USD).
//
// Two modes:
//   unbatched : 1 match = open + setGameState + settle
//   batched   : N matches; each final hash is submitted into ONE window, then the
//               window is flushed once (BatchedSettlement). Per-match cost drops.
//
// It reads the public RPC directly for eth_call (no key needed) and uses the
// sponsor relay only for the on-chain writes, exactly like a browser would.
//
// Usage:  node scripts/ggi-midchain-match.mjs [unbatched|batched] [moveCount] [matches]
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, defineChain, http, keccak256, encodeAbiParameters, parseAbiParameters, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const RELAY = process.env.GGI_RELAY || 'http://localhost:8787';
const here = dirname(fileURLToPath(import.meta.url));
const rec = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json'), 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const MID = rec.contracts.GeneralsMidchain;
const REGISTRY = rec.contracts.SessionRegistry;
if (!MID) throw new Error('GeneralsMidchain address missing; run scripts/ggi-deploy-midchain.mjs first');

const artifact = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', 'GeneralsMidchain.sol', 'GeneralsMidchain.json'), 'utf8'));
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });

async function post(action, body = {}) {
  const res = await fetch(RELAY + '/api/ggi-sponsor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
  const json = await res.json();
  if (!json.ok) throw new Error(action + ' failed: ' + (json.error || res.status));
  return json;
}
const usdc = (x) => Number(x || 0) / 1e6;
const ethCall = (functionName, args) => pub.readContract({ address: MID, abi: artifact.abi, functionName, args });

function mv(kind, playerIndex = 0, a = 0, b = 0, c = 0, d = 0, e = 0) {
  return { kind, playerIndex, a, b, c, d, e };
}
function buildMoveLog(n) {
  const moves = [mv(0, 0, 1, 1, 2, 1, 50), mv(0, 1, 14, 6, 13, 6, 50)];
  while (moves.length < Math.max(4, n - 2)) {
    const p = moves.length % 2;
    if (p === 0) moves.push(mv(0, 0, 1, 1, 1, 2, 25));
    else moves.push(mv(0, 1, 14, 6, 14, 5, 25));
  }
  moves.push(mv(1)); // tick
  moves.push(mv(2, 0)); // finish check
  return moves;
}
const DOMAIN = { name: 'Foskaay GGI', version: '1', chainId: rec.chainId, verifyingContract: REGISTRY };
const MOVE_TYPES = {
  Move: [
    { name: 'sessionId', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
    { name: 'playerIndex', type: 'uint8' }, { name: 'prevHash', type: 'bytes32' },
    { name: 'newHash', type: 'bytes32' }, { name: 'payloadHash', type: 'bytes32' },
  ],
};

// Play one midchain match: open on-chain, then every move free via eth_call and a
// silent signature. Returns the sessionId, final hash and whether the replay check
// passed. `p0`/`p1` are the players' in-memory session keys.
async function playMatch(p0, p1, moveCount) {
  const open = await post('open', { participants: 2, ttlSecs: 3600 });
  const sessionId = open.sessionId;
  const linked = await post('setGameState', { sessionId, stateAccount: MID });

  const moves = buildMoveLog(moveCount);
  let state = await ethCall('getInitialState', []);
  let prevHash = await ethCall('hashState', [state]);
  const startHash = prevHash;
  const log = [];
  let nonce = 1;
  for (const m of moves) {
    const next = await ethCall('applyMove', [state, m, []]);
    const newHash = await ethCall('hashState', [next]);
    const payloadHash = keccak256(encodeAbiParameters(parseAbiParameters('uint8,uint8,uint8,uint8,uint8,uint8,uint8'), [m.kind, m.playerIndex, m.a, m.b, m.c, m.d, m.e]));
    const signer = m.playerIndex === 0 ? p0 : p1;
    const signature = await signer.signTypedData({ domain: DOMAIN, types: MOVE_TYPES, primaryType: 'Move', message: { sessionId, nonce: BigInt(nonce), playerIndex: m.playerIndex, prevHash, newHash, payloadHash } });
    log.push({ nonce, playerIndex: m.playerIndex, payloadHash, prevHash, newHash, signature });
    state = next; prevHash = newHash; nonce += 1;
  }
  const finalHash = prevHash;
  const terminal = await ethCall('isTerminal', [state]);

  // verify by replay + signature recovery (what any third party can do)
  let verified = true;
  let replayHash = startHash;
  for (const row of log) {
    if (row.prevHash !== replayHash) { verified = false; break; }
    const recovered = await recoverTypedDataAddress({ domain: DOMAIN, types: MOVE_TYPES, primaryType: 'Move', message: { sessionId, nonce: BigInt(row.nonce), playerIndex: row.playerIndex, prevHash: row.prevHash, newHash: row.newHash, payloadHash: row.payloadHash }, signature: row.signature });
    if (recovered.toLowerCase() !== (row.playerIndex === 0 ? p0 : p1).address.toLowerCase()) { verified = false; break; }
    replayHash = row.newHash;
  }
  verified = verified && replayHash === finalHash;
  return { sessionId, startHash, finalHash, verified, terminal, openCost: usdc(open.costUsdc6), linkedCost: usdc(linked.costUsdc6), moveCount: log.length };
}

(async () => {
  const mode = (process.argv[2] || 'unbatched').toLowerCase();
  const moveCount = Number(process.argv[3] || 12);
  const matches = Number(process.argv[4] || 3);
  const info = await post('sponsorAddress');
  const p0 = privateKeyToAccount(generatePrivateKey());
  const p1 = privateKeyToAccount(generatePrivateKey());

  console.log('Foskaay GGI MIDCHAIN match -> Arc testnet   mode:', mode);
  console.log('rpc             :', RPC);
  console.log('GeneralsMidchain:', MID);
  console.log('players (public):', p0.address, p1.address);

  if (mode === 'batched') {
    const runs = [];
    for (let i = 0; i < matches; i++) runs.push(await playMatch(p0, p1, moveCount));
    let submitCost = 0;
    for (let i = 0; i < runs.length; i++) {
      const sub = await post('batchSubmit', { sessionId: runs[i].sessionId, digest: runs[i].finalHash, maxSize: matches, windowSecs: 60, setConfig: i === 0 });
      submitCost += usdc(sub.costUsdc6);
    }
    const flush = await post('batchFlush', {});
    const flushCost = usdc(flush.costUsdc6);
    const opens = runs.reduce((a, r) => a + r.openCost, 0);
    const links = runs.reduce((a, r) => a + r.linkedCost, 0);
    const total = opens + links + submitCost + flushCost;
    const perMatch = total / runs.length;
    console.log('');
    console.log('matches:', runs.length, ' moves each:', runs[0].moveCount, ' all moves free in the midchain');
    console.log('chain verify:', runs.every((r) => r.verified) ? 'PASS (all replays match)' : 'FAIL');
    console.log('  opens        ', opens.toFixed(6), 'USDC');
    console.log('  setGameState ', links.toFixed(6), 'USDC');
    console.log('  batchSubmit  ', submitCost.toFixed(6), 'USDC (', runs.length, 'leaves into 1 window )');
    console.log('  batchFlush   ', flushCost.toFixed(6), 'USDC ( whole window, permissionless )');
    console.log('  TOTAL        ', total.toFixed(6), 'USDC ->', perMatch > 0 ? Math.floor(1 / perMatch) : 'inf', 'games per 1 USD (per match ', perMatch.toFixed(6), ')');
    console.log('');
    console.log('COMPARE: on-chain-board port 0.098172 USDC/match (about 10 games per 1 USD).');
    writeFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'midchain-cost-batched.json'), JSON.stringify({ measuredAt: new Date().toISOString(), mode: 'midchain-batched', matches: runs.length, moveCount: runs[0].moveCount, verified: runs.every((r) => r.verified), cost: { opens, setGameState: links, batchSubmit: submitCost, batchFlush: flushCost, total, perMatch, gamesPerDollar: perMatch > 0 ? Math.floor(1 / perMatch) : null }, compareOnChainBoardPerMatch: 0.098172 }, null, 2) + '\n');
    console.log('written: foskaay-ggi/deployments/midchain-cost-batched.json');
    return;
  }

  // unbatched
  const run = await playMatch(p0, p1, moveCount);
  const settle = await post('settle', { sessionId: run.sessionId, digest: run.finalHash });
  const total = run.openCost + run.linkedCost + usdc(settle.costUsdc6);
  console.log('');
  console.log('moves in midchain (free):', run.moveCount, '  on-chain txs: 1 open + 1 setGameState + 1 settle');
  console.log('start hash  :', run.startHash);
  console.log('final hash  :', run.finalHash);
  console.log('terminal    :', run.terminal[0], 'winner', run.terminal[1]);
  console.log('chain verify:', run.verified ? 'PASS (replayed hashes match)' : 'FAIL');
  console.log('');
  console.log('  open        ', run.openCost.toFixed(6), 'USDC');
  console.log('  setGameState', run.linkedCost.toFixed(6), 'USDC');
  console.log('  settle      ', usdc(settle.costUsdc6).toFixed(6), 'USDC');
  console.log('  TOTAL       ', total.toFixed(6), 'USDC ->', total > 0 ? Math.floor(1 / total) : 'inf', 'games per 1 USD');
  console.log('');
  console.log('COMPARE: on-chain-board port was 0.098172 USDC per match (about 10 games per 1 USD).');
  writeFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'midchain-cost.json'), JSON.stringify({ measuredAt: new Date().toISOString(), mode: 'midchain-unbatched', sessionId: run.sessionId, startHash: run.startHash, finalHash: run.finalHash, moveCount: run.moveCount, verified: run.verified, terminal: { finished: run.terminal[0], winner: run.terminal[1] }, cost: { open: run.openCost, setGameState: run.linkedCost, settle: usdc(settle.costUsdc6), total, gamesPerDollar: total > 0 ? Math.floor(1 / total) : null }, compareOnChainBoardPerMatch: 0.098172 }, null, 2) + '\n');
  console.log('written: foskaay-ggi/deployments/midchain-cost.json');
})().catch((e) => { console.error('midchain match failed:', e.shortMessage || e.message || e); process.exit(1); });
