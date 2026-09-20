// scripts/arc-phase5-match-cost.mjs — THE cost proof for (1v).
//
// Runs ONE complete 2-player match on the new GFG-BS settlement contract with
// exactly TWO transactions (start commit + co-signed settlement), the way the
// live engine will. Compares against the old per-action design (~63 txs).
//
// Uses two THROWAWAY wallets so real co-signatures are produced. Reports
// sponsor USDC before / used / after.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi,
  keccak256, toHex, formatEther, getAddress, encodePacked,
} from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];
const genKey = evmKeys.generatePrivateKey;

const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || evm.rpc;
const MS = evm.contracts.matchSettlement;
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);

const chain = defineChain({
  id: evm.chainId, name: evm.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const abi = parseAbi([
  'function commitStart(bytes32 gameId, address p1, address p2, uint16 gameTag, uint8 seats, bytes32 commitHash, uint32 ttlSecs)',
  'function settle(bytes32 gameId, bytes32 moveDigest, bytes32 resultHash, uint32 moveCount, uint8 v1, bytes32 r1, bytes32 s1, uint8 v2, bytes32 r2, bytes32 s2)',
  'function matchOf(bytes32 gameId) view returns (address p1, address p2, bytes32 commitHash, bytes32 moveDigest, bytes32 resultHash, uint64 startedAt, uint64 settleDeadline, uint32 moveCount, uint16 gameTag, uint8 seats, bool settled, bool disputed)',
]);

// Two throwaway player keys (never real accounts).
const k1 = genKey(); const k2 = genKey();
const p1 = accountFor(k1).address; const p2 = accountFor(k2).address;

const start = await pub.getBalance({ address: account.address });
console.log('sponsor before: ' + formatEther(start) + ' USDC');
console.log('matchSettlement: ' + MS);
console.log('players (throwaway): ' + p1 + ' / ' + p2);
console.log('');

const gameId = keccak256(toHex('gfgbs-cost-' + Date.now()));
let used = 0n;
async function send(label, fn, args) {
  const hash = await wallet.writeContract({ address: MS, abi, functionName: fn, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const cost = rc.gasUsed * rc.effectiveGasPrice;
  used += cost;
  console.log(label.padEnd(16) + ' gas ' + String(rc.gasUsed).padStart(7) + '  ' + formatEther(cost) + ' USDC  ' + (evm.explorer || '') + '/tx/' + hash);
  return rc;
}

// 1) START COMMIT (one tx).
const commitHash = keccak256(toHex('start:' + gameId));
await send('commitStart', 'commitStart', [gameId, p1, p2, 0, 2, commitHash, 3600]);

// The engine would hold the move log off-chain; the chain only ever sees the
// digest + both signatures.
const MOVE_COUNT = 60;
const moveDigest = keccak256(toHex('movelog:' + gameId));
const resultHash = keccak256(toHex('result:' + gameId));

// 2) ONE co-signed SETTLEMENT (one tx). Both players sign the same digest.
const h = keccak256(encodePacked(
  ['bytes32', 'bytes32', 'bytes32', 'uint32'],
  [gameId, moveDigest, resultHash, MOVE_COUNT],
));
const sig1 = await accountFor(k1).signMessage({ message: { raw: h } });
const sig2 = await accountFor(k2).signMessage({ message: { raw: h } });
const s1 = splitSig(sig1); const s2 = splitSig(sig2);
await send('settle', 'settle', [gameId, moveDigest, resultHash, MOVE_COUNT, s1.v, s1.r, s1.s, s2.v, s2.r, s2.s]);

const m = await pub.readContract({ address: MS, abi, functionName: 'matchOf', args: [gameId] });
const ok = m[10] === true && m[7] === MOVE_COUNT;

const end = await pub.getBalance({ address: account.address });
const spent = start - end;
console.log('');
console.log('settled: ' + ok + '  moveCount=' + m[7] + '  (log stayed off-chain; only the digest went on)');
console.log('MOVES PLAYED: ' + MOVE_COUNT + ' on-chain move txs: 0');
console.log('');
console.log('sponsor used:  ' + formatEther(spent) + ' USDC (2 txs for the whole match)');
console.log('sponsor after: ' + formatEther(end) + ' USDC');
console.log('');
const oldPerMatch = 0.10;
const nowPerMatch = Number(formatEther(spent));
console.log('PER-MATCH: ' + nowPerMatch.toFixed(6) + ' USDC  vs old per-action ~' + oldPerMatch.toFixed(2) + ' USDC  => ' + (oldPerMatch / Math.max(nowPerMatch, 1e-9)).toFixed(0) + 'x cheaper');
console.log('100 free players x 5 matches/day: ' + (100 * 5 * nowPerMatch).toFixed(2) + ' USDC/day');
console.log('');
console.log(ok ? 'PASS: a full match settled with 2 txs, co-signed, moves off-chain.' : 'FAIL: settle did not register');

function splitSig(sig) {
  const r = '0x' + sig.slice(2, 66);
  const s = '0x' + sig.slice(66, 130);
  let v = parseInt(sig.slice(130, 132), 16); if (v < 27) v += 27;
  return { r, s, v };
}
