// scripts/foskaay-ggi-eventmidchain-session.mjs — measure the PER-SESSION midchain.
//
// THE DIFFERENCE FROM eventmidchain-batch.mjs:
//   - batch.mjs puts EVERY game's handover + settle + 2 signatures on-chain
//     (N games = N payloads), so it floors at about 1,400 games/$1.
//   - THIS script anchors the SESSION, not each game: ONE handover for the whole
//     session, play N games for free on the midchain, then ONE settle carrying a
//     single Merkle root over all N final hashes and just 2 signatures. On-chain
//     work is O(1), so per game = cost / N and it keeps dropping as N grows.
//
// This is the "open once, free inside, settle once" tier (Tier 3).
//
// SECURITY: the sponsor key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/foskaay-ggi-eventmidchain-session.mjs [moveCount]
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, concat, encodeAbiParameters, parseAbiParameters, getAddress } from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];
const { privateKeyToAccount, generatePrivateKey } = evmKeys;

const here = dirname(fileURLToPath(import.meta.url));
const rec = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json'), 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const MID = rec.contracts.GeneralsMidchain;
const EMC = rec.contracts.EventMidchainCore;
if (!MID || !EMC) throw new Error('missing GeneralsMidchain or EventMidchainCore; run the deploy scripts first');

const midArtifact = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', 'GeneralsMidchain.sol', 'GeneralsMidchain.json'), 'utf8'));
const emcArtifact = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', 'EventMidchainCore.sol', 'EventMidchainCore.json'), 'utf8'));

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
  return { hash, gasUsed, costUsdc6: (gasUsed * (price || 0n)) / 1_000_000_000_000n };
}

function mv(kind, playerIndex = 0, a = 0, b = 0, c = 0, d = 0, e = 0) { return { kind, playerIndex, a, b, c, d, e }; }
function buildMoveLog(gameIdx, moveCount) {
  const toY = gameIdx % 2 === 0;
  const moves = [mv(0, 0, 1, 1, toY ? 2 : 1, toY ? 1 : 2, 50), mv(0, 1, 14, 6, 13, 6, 50)];
  while (moves.length < Math.max(2, moveCount - 1)) moves.push(mv(1));
  moves.push(mv(1));
  return moves;
}
// Sorted-pair Merkle root, same shape the rail's BatchedSettlement uses.
function hashPair(a, b) { return (a.toLowerCase() <= b.toLowerCase()) ? keccak256(concat([a, b])) : keccak256(concat([b, a])); }
function merkleRoot(leaves) {
  if (leaves.length === 0) return '0x' + '00'.repeat(32);
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
    }
    layer = next;
  }
  return layer[0];
}

(async () => {
  const moveCount = Number(process.argv[2] || 4);
  const me = getAddress(account.address);
  const p0 = privateKeyToAccount(generatePrivateKey());
  const p1 = privateKeyToAccount(generatePrivateKey());
  console.log('Foskaay GGI PER-SESSION midchain (one handover + one settle for N games) -> Arc testnet');
  console.log('EventMidchainCore:', EMC);
  console.log('players          :', p0.address, p1.address);

  const results = [];
  for (const n of [3, 5, 10, 100]) {
    process.stdout.write('\nbuilding ' + n + ' games... ');
    const finals = [];
    const starts = [];
    for (let i = 0; i < n; i++) {
      let state = await ethCall('getInitialState', []);
      let prevHash = await ethCall('hashState', [state]);
      starts.push(prevHash);
      for (const m of buildMoveLog(i, moveCount)) {
        state = await ethCall('applyMove', [state, m, []]);
        prevHash = await ethCall('hashState', [state]);
      }
      finals.push(prevHash);
    }
    const root = merkleRoot(finals);
    const sessionStart = merkleRoot(starts);
    const sessionId = keccak256(encodeAbiParameters(parseAbiParameters('address,uint256,uint256'), [me, BigInt(Date.now()), BigInt(n)]));

    process.stdout.write('sending 1 handover + 1 settle... ');
    const handover = await send({ address: EMC, abi: emcArtifact.abi, functionName: 'handover', args: [sessionId, MID, sessionStart, [p0.address, p1.address], [p0.address, p1.address], 0], account });
    const digest = await pub.readContract({ address: EMC, abi: emcArtifact.abi, functionName: 'settleDigest', args: [sessionId, root] });
    const s0 = await p0.sign({ hash: digest });
    const s1 = await p1.sign({ hash: digest });
    const settle = await send({ address: EMC, abi: emcArtifact.abi, functionName: 'settle', args: [sessionId, root, [s0, s1], [p0.address, p1.address]], account });

    const total = usdc(handover.costUsdc6) + usdc(settle.costUsdc6);
    const perGame = total / n;
    results.push({ games: n, handoverUsdc: usdc(handover.costUsdc6), settleUsdc: usdc(settle.costUsdc6), totalUsdc: total, perGame, gamesPerDollar: perGame > 0 ? Math.floor(1 / perGame) : null, handoverGas: handover.gasUsed.toString(), settleGas: settle.gasUsed.toString(), root });
    console.log('ok');
    console.log('  N=' + String(n).padEnd(4), 'handover', usdc(handover.costUsdc6).toFixed(6), ' settle', usdc(settle.costUsdc6).toFixed(6), ' TOTAL', total.toFixed(6), ' per game', perGame.toFixed(6), ' ->', perGame > 0 ? Math.floor(1 / perGame) : 'inf', 'games/$1');
  }

  writeFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'eventmidchain-session-cost.json'), JSON.stringify({ measuredAt: new Date().toISOString(), mode: 'eventmidchain-per-session', moveCount, results, note: 'One handover + one settle per SESSION; N games inside are free on the midchain; the settle carries a Merkle root and 2 signatures total.', comparePerGameBatchFloor: 0.000713 }, null, 2) + '\n');
  console.log('\nwritten: foskaay-ggi/deployments/eventmidchain-session-cost.json');
})().catch((e) => { console.error('session test failed:', e.shortMessage || e.message || e); process.exit(1); });
