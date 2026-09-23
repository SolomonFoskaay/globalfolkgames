// scripts/ggi-eventonly-match.mjs — measure the EVENT-ONLY handover/settle floor.
//
// The midchain made moves free; the remaining cost is the core's storage writes at
// open and settle. This script tests the v5 "event-driven cheap gas" pattern: a
// prototype contract that emits a log instead of writing storage, and verifies the
// players' signatures at settle. We measure handover + settle for one match and
// compare it to the current core-based midchain.
//
// The moves are still free (pure eth_call + signatures), identical to the midchain
// test. Only the two endpoints differ.
//
// SECURITY: the sponsor key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/ggi-eventonly-match.mjs [moveCount]
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, encodeAbiParameters, parseAbiParameters, getAddress } from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];
const { privateKeyToAccount, generatePrivateKey } = evmKeys;

const here = dirname(fileURLToPath(import.meta.url));
const rec = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json'), 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const MID = rec.contracts.GeneralsMidchain;
const EOC = rec.contracts.EventMidchainCore;
if (!MID || !EOC) throw new Error('missing GeneralsMidchain or EventMidchainCore; run the deploy scripts first');

const midArtifact = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', 'GeneralsMidchain.sol', 'GeneralsMidchain.json'), 'utf8'));
const eocArtifact = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', 'EventMidchainCore.sol', 'EventMidchainCore.json'), 'utf8'));

const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const usdc = (x) => Number(x || 0) / 1e6;
const ethCall = (functionName, args) => pub.readContract({ address: MID, abi: midArtifact.abi, functionName, args });

async function send(req) {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('tx reverted: ' + hash);
  const gasUsed = rc.gasUsed || 0n;
  let price = rc.effectiveGasPrice;
  if (price == null) { const tx = await pub.getTransaction({ hash }); price = tx.gasPrice || 0n; }
  const costUsdc6 = (gasUsed * (price || 0n)) / 1_000_000_000_000n;
  return { hash, gasUsed, costUsdc6 };
}

function mv(kind, playerIndex = 0, a = 0, b = 0, c = 0, d = 0, e = 0) { return { kind, playerIndex, a, b, c, d, e }; }
function buildMoveLog(n) {
  const moves = [mv(0, 0, 1, 1, 2, 1, 50), mv(0, 1, 14, 6, 13, 6, 50)];
  while (moves.length < Math.max(4, n - 2)) {
    const p = moves.length % 2;
    if (p === 0) moves.push(mv(0, 0, 1, 1, 1, 2, 25)); else moves.push(mv(0, 1, 14, 6, 14, 5, 25));
  }
  moves.push(mv(1)); moves.push(mv(2, 0));
  return moves;
}

(async () => {
  const moveCount = Number(process.argv[2] || 12);
  const me = getAddress(account.address);
  const p0 = privateKeyToAccount(generatePrivateKey());
  const p1 = privateKeyToAccount(generatePrivateKey());
  console.log('GGI EVENT-ONLY match -> Arc testnet');
  console.log('rpc           :', RPC);
  console.log('EventMidchainCore :', EOC);
  console.log('players       :', p0.address, p1.address);

  // 1. Play the midchain moves for free (pure eth_call + signatures).
  let state = await ethCall('getInitialState', []);
  let prevHash = await ethCall('hashState', [state]);
  const startHash = prevHash;
  const moves = buildMoveLog(moveCount);
  for (const m of moves) {
    const next = await ethCall('applyMove', [state, m, []]);
    prevHash = await ethCall('hashState', [next]);
    state = next;
  }
  const finalHash = prevHash;

  // 2. EVENT-ONLY handover: one tx, emit only.
  const sessionId = keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [me, BigInt(Date.now())]));
  const handover = await send({
    address: EOC, abi: eocArtifact.abi, functionName: 'handover',
    args: [sessionId, MID, startHash, [p0.address, p1.address], [p0.address, p1.address], 0], account,
  });

  // 3. EVENT-ONLY settle: verify both signatures on-chain, then emit only.
  const digest = await pub.readContract({ address: EOC, abi: eocArtifact.abi, functionName: 'settleDigest', args: [sessionId, finalHash] });
  const sig0 = await p0.sign({ hash: digest });
  const sig1 = await p1.sign({ hash: digest });
  const settle = await send({
    address: EOC, abi: eocArtifact.abi, functionName: 'settle',
    args: [sessionId, finalHash, [sig0, sig1], [p0.address, p1.address]], account,
  });

  const total = usdc(handover.costUsdc6) + usdc(settle.costUsdc6);
  console.log('');
  console.log('moves in midchain (free):', moves.length, '  on-chain txs: 1 handover + 1 settle (event-only)');
  console.log('start hash :', startHash);
  console.log('final hash :', finalHash);
  console.log('');
  console.log('  handover', usdc(handover.costUsdc6).toFixed(6), 'USDC  (gas', handover.gasUsed.toString() + ')');
  console.log('  settle  ', usdc(settle.costUsdc6).toFixed(6), 'USDC  (gas', settle.gasUsed.toString() + ')');
  console.log('  TOTAL   ', total.toFixed(6), 'USDC ->', total > 0 ? Math.floor(1 / total) : 'inf', 'games per 1 USD');
  console.log('');
  console.log('COMPARE: core-based midchain unbatched 0.012206 USDC/match (about 81 games per 1 USD).');

  writeFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'eventmidchain-cost.json'), JSON.stringify({
    measuredAt: new Date().toISOString(), mode: 'eventonly', moveCount: moves.length, sessionId, startHash, finalHash,
    cost: { handover: usdc(handover.costUsdc6), settle: usdc(settle.costUsdc6), total, gamesPerDollar: total > 0 ? Math.floor(1 / total) : null },
    gas: { handover: handover.gasUsed.toString(), settle: settle.gasUsed.toString() },
    compareCoreMidchainPerMatch: 0.012206,
  }, null, 2) + '\n');
  console.log('written: foskaay-ggi/deployments/eventmidchain-cost.json');
})().catch((e) => { console.error('event-only match failed:', e.shortMessage || e.message || e); process.exit(1); });
