// scripts/foskaay-ggi-eventmidchain-batch.mjs — measure the EVENT-BASED Foskaay GGI Midchain, batched.
//
// The event-based Foskaay GGI Midchain binds the session and the game in ONE Handover event
// (no separate link tx), and its batch functions hand over / settle MANY games in
// ONE transaction. This script measures the per-game cost for N = 3, 5, 10, 100
// games batched into a single handoverMany + settleMany pair.
//
// Moves are free (pure eth_call + signatures), identical to the Foskaay GGI Midchain test.
//
// SECURITY: the sponsor key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/foskaay-ggi-eventmidchain-batch.mjs [moveCount]
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
  while (moves.length < Math.max(2, moveCount - 2)) moves.push(mv(1)); // ticks are free
  moves.push(mv(1)); moves.push(mv(2, 0));
  return moves;
}

(async () => {
  const moveCount = Number(process.argv[2] || 6);
  const me = getAddress(account.address);
  const p0 = privateKeyToAccount(generatePrivateKey());
  const p1 = privateKeyToAccount(generatePrivateKey());
  console.log('Foskaay GGI EVENT-BASED Foskaay GGI Midchain batch -> Arc testnet');
  console.log('rpc              :', RPC);
  console.log('EventMidchainCore:', EMC);
  console.log('players          :', p0.address, p1.address);

  // Play ONE game's moves for free and return its start/final hashes.
  async function playOne(gameIdx) {
    let state = await ethCall('getInitialState', []);
    let prevHash = await ethCall('hashState', [state]);
    const startHash = prevHash;
    for (const m of buildMoveLog(gameIdx, moveCount)) {
      state = await ethCall('applyMove', [state, m, []]);
      prevHash = await ethCall('hashState', [state]);
    }
    return { startHash, finalHash: prevHash };
  }

  const results = [];
  for (const n of [3, 5, 10, 100]) {
    process.stdout.write('\nbuilding ' + n + ' games... ');
    const ids = []; const starts = []; const finals = []; const players = []; const sigs = []; const signers = [];
    for (let i = 0; i < n; i++) {
      const g = await playOne(i);
      const id = keccak256(encodeAbiParameters(parseAbiParameters('address,uint256,uint256'), [me, BigInt(Date.now()), BigInt(i)]));
      const digest = await pub.readContract({ address: EMC, abi: emcArtifact.abi, functionName: 'settleDigest', args: [id, g.finalHash] });
      const s0 = await p0.sign({ hash: digest });
      const s1 = await p1.sign({ hash: digest });
      ids.push(id); starts.push(g.startHash); finals.push(g.finalHash);
      players.push([p0.address, p1.address]); sigs.push([s0, s1]); signers.push([p0.address, p1.address]);
    }
    process.stdout.write('done. sending 1 handoverMany + 1 settleMany... ');
    const handover = await send({ address: EMC, abi: emcArtifact.abi, functionName: 'handoverMany', args: [ids, MID, starts, players, players, 0], account });
    const settle = await send({ address: EMC, abi: emcArtifact.abi, functionName: 'settleMany', args: [ids, finals, sigs, signers], account });
    const total = usdc(handover.costUsdc6) + usdc(settle.costUsdc6);
    const perGame = total / n;
    results.push({ games: n, handoverUsdc: usdc(handover.costUsdc6), settleUsdc: usdc(settle.costUsdc6), totalUsdc: total, perGame, gamesPerDollar: perGame > 0 ? Math.floor(1 / perGame) : null, handoverGas: handover.gasUsed.toString(), settleGas: settle.gasUsed.toString() });
    console.log('ok');
    console.log('  N=' + String(n).padEnd(4), 'handover', usdc(handover.costUsdc6).toFixed(6), ' settle', usdc(settle.costUsdc6).toFixed(6), ' total', total.toFixed(6), ' per game', perGame.toFixed(6), ' ->', perGame > 0 ? Math.floor(1 / perGame) : 'inf', 'games/$1');
  }

  writeFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'eventmidchain-batch-cost.json'), JSON.stringify({ measuredAt: new Date().toISOString(), mode: 'eventmidchain-batched', moveCount, results, compareCoreMidchainPerMatch: 0.012206, compareOnChainBoardPerMatch: 0.098172 }, null, 2) + '\n');
  console.log('\nwritten: foskaay-ggi/deployments/eventmidchain-batch-cost.json');
})().catch((e) => { console.error('batch failed:', e.shortMessage || e.message || e); process.exit(1); });
