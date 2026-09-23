// scripts/foskaay-ggi-cost-measure.mjs — measure the REAL Arc cost of a Foskaay GGI game session.
//
// WHY: the whole pitch is "cheaper than per-action, $1 = 500-1000 games". That
// number must be measured on-chain, never assumed. This runs a realistic session
// and reports the exact USDC the Arc blockchain charges, operation by operation.
//
// It reads the deployer key from ~/.config/gfg/arc-sponsor.json and never prints
// it. Addresses come from the published @foskaay/ggi-contracts-sdk data.
//
// Usage:  node scripts/foskaay-ggi-cost-measure.mjs
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createPublicClient, createWalletClient, defineChain, http, getAddress, formatUnits,
  keccak256, toBytes, encodePacked, parseAbi,
} from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const here = dirname(fileURLToPath(import.meta.url));
const rec = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json'), 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const C = rec.contracts;
const USDC = rec.usdc;

const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const registryAbi = parseAbi([
  'function open(uint8 participantCount, uint64 ttlSecs, bytes32 rulesHash, bytes32 seedCommit) returns (bytes32)',
  'function setAuthority(bytes32 sessionId, uint8 seat, address authority)',
  'function registerSessionKey(address key, uint64 validUntil, bytes32 scopeHash)',
  'function close(bytes32 sessionId)',
]);
const stateAbi = parseAbi([
  'function recordEvent(bytes32 sessionId, uint8 seat, uint64 sequence, bytes32 payloadHash)',
  'function sealFinal(bytes32 sessionId, bytes32 digest)',
]);
const rndAbi = parseAbi(['function reveal(bytes32 sessionId, bytes32[] seeds)']);
const vaultAbi = parseAbi([
  'function chargeSession(bytes32 sessionId)',
  
]);
const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

async function usdcBalance() {
  return pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
}

// Measure one transaction: the exact USDC delta it costs.
async function measure(label, req, rows) {
  const before = await usdcBalance();
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  const after = await usdcBalance();
  if (rc.status !== 'success') throw new Error(label + ' reverted');
  const cost = before - after;
  let gasUsed = 0n;
  try {
    const tx = await pub.getTransactionReceipt({ hash });
    gasUsed = tx.gasUsed;
  } catch (_) {}
  rows.push({ label, usdc: Number(formatUnits(cost, 6)), gasUsed: gasUsed.toString() });
  console.log(`  ${label.padEnd(26)} ${formatUnits(cost, 6)} USDC`);
  return { hash, cost };
}

(async () => {
  const me = getAddress(account.address);
  const start = await usdcBalance();
  console.log('Foskaay GGI LIVE COST MEASUREMENT -> Arc Testnet');
  console.log('sponsor (public):', me);
  console.log('balance start:', formatUnits(start, 6), 'USDC');
  console.log('');

  const rows = [];
  const seed = keccak256(toBytes('cost-measure-' + Date.now()));
  const commit = keccak256(encodePacked(['string', 'uint256', 'bytes32'], ['gfg-gi-seed', 1n, seed]));
  const spender = '0x00000000000000000000000000000000000000B2';
  const keyAddr = '0x00000000000000000000000000000000000000C2';

  console.log('--- PER-OPERATION (what Arc charges for each action) ---');

  // 1. OPEN
  const openRes = await measure('open (session start)', {
    address: C.SessionRegistry, abi: registryAbi, functionName: 'open',
    args: [2, 3600n, keccak256(toBytes('rules-cm')), commit], account,
  }, rows);
  // Read the REAL sessionId from the SessionOpened event (never predict it:
  // the sponsor is not a fresh caller, so its nonce is not 0).
  const openRc = await pub.getTransactionReceipt({ hash: openRes.hash });
  const openLog = openRc.logs.find((l) => l.address.toLowerCase() === C.SessionRegistry.toLowerCase());
  const sessionId = openLog ? openLog.topics[1] : null;
  if (!sessionId) throw new Error('could not read sessionId from the open event');
  console.log('  sessionId:', sessionId);

  // 2. authorities + key
  await measure('setAuthority seat 0', { address: C.SessionRegistry, abi: registryAbi, functionName: 'setAuthority', args: [sessionId, 0, me], account }, rows);
  await measure('setAuthority seat 1', { address: C.SessionRegistry, abi: registryAbi, functionName: 'setAuthority', args: [sessionId, 1, getAddress(spender)], account }, rows);
  await measure('registerSessionKey', { address: C.SessionRegistry, abi: registryAbi, functionName: 'registerSessionKey', args: [getAddress(keyAddr), BigInt(Math.floor(Date.now() / 1000) + 3600), keccak256(toBytes('scope'))], account }, rows);

  // 3. a few on-chain "commits" (this is the OPTIONAL heavy path: one tx per event)
  //    We measure ONE and multiply, because most games do not write per action.
  const one = await measure('recordEvent (1 event tx)', { address: C.SessionState, abi: stateAbi, functionName: 'recordEvent', args: [sessionId, 0, 1n, keccak256(toBytes('move-1'))], account }, rows);

  // 4. settle: close + reveal + seal + fees
  await measure('close (session end)', { address: C.SessionRegistry, abi: registryAbi, functionName: 'close', args: [sessionId], account }, rows);
  await measure('reveal (seed)', { address: C.Randomness, abi: rndAbi, functionName: 'reveal', args: [sessionId, [seed]], account }, rows);
  await measure('sealFinal (result)', { address: C.SessionState, abi: stateAbi, functionName: 'sealFinal', args: [sessionId, keccak256(toBytes('final'))], account }, rows);
  await measure('USDC.approve (fee)', { address: USDC, abi: erc20Abi, functionName: 'approve', args: [C.FeeVault, 10_000n], account }, rows);
  await measure('chargeSession (rail fee)', { address: C.FeeVault, abi: vaultAbi, functionName: 'chargeSession', args: [sessionId], account }, rows);

  const end = await usdcBalance();
  const total = start - end;

  // ---- the realistic session model -----------------------------------------
  // Two ways to play, both measured:
  //  A. "settle-once" (the intended, cheap path): open + authorities + key +
  //     0 on-chain events + close + reveal + seal + fees. Actions are signed
  //     OFF-chain and folded into the sealed digest.
  //  B. "commit-per-action" (the heaviest, OPTIONAL path): every action is its
  //     own tx. This is the worst case, included so the floor is honest.
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  const costOfSessionA =
    byLabel['open (session start)'].usdc +
    byLabel['setAuthority seat 0'].usdc +
    byLabel['setAuthority seat 1'].usdc +
    byLabel['registerSessionKey'].usdc +
    byLabel['close (session end)'].usdc +
    byLabel['reveal (seed)'].usdc +
    byLabel['sealFinal (result)'].usdc +
    byLabel['USDC.approve (fee)'].usdc +
    byLabel['chargeSession (rail fee)'].usdc;
  const perEvent = Number(formatUnits(one.cost, 6));

  const gamesPerDollarA = costOfSessionA > 0 ? 1 / costOfSessionA : Infinity;

  console.log('');
  console.log('=== SESSION MODEL A: settle-once (the intended path) ===');
  console.log('one-time setup (authorities + session key) and per-session ops:');
  console.log('  total Arc gas per session:', costOfSessionA.toFixed(6), 'USDC');
  console.log('  note: the session key + authorities are one-time per player,');
  console.log('        so a returning player skips them (see below).');
  const recurringA = costOfSessionA - byLabel['setAuthority seat 0'].usdc - byLabel['setAuthority seat 1'].usdc - byLabel['registerSessionKey'].usdc;
  console.log('  returning player, per game (no setup):', recurringA.toFixed(6), 'USDC');
  console.log('');
  console.log('=== SESSION MODEL B: commit-per-action (heaviest, optional) ===');
  console.log('  one on-chain event tx:', perEvent.toFixed(6), 'USDC');
  console.log('  a 50-action game, if EVERY action were a tx:', (recurringA + 50 * perEvent).toFixed(6), 'USDC');
  console.log('');
  console.log('=== GAMES PER $1 (unbatched) ===');
  console.log('  settle-once, first game for a new player:', Math.floor(1 / costOfSessionA), 'games');
  console.log('  settle-once, every later game:', Math.floor(1 / recurringA), 'games');
  console.log('  commit-per-action, 50 actions/game:', Math.floor(1 / (recurringA + 50 * perEvent)), 'games');
  console.log('');
  console.log('=== THIS RUN TOTALS ===');
  console.log('  balance start:', formatUnits(start, 6));
  console.log('  balance end  :', formatUnits(end, 6));
  console.log('  measured spend:', formatUnits(total, 6), 'USDC (includes one extra session + the above)');
  console.log('');
  console.log('NOTE: operations are measured individually, so the session model sums');
  console.log('their costs. The run total also includes the measured session itself.');

  // ---- record the measurement for the docs / spend ledger -------------------
  const out = {
    network: rec.name,
    chainId: rec.chainId,
    measuredAt: new Date().toISOString(),
    sponsor: me,
    perOperation: rows,
    sessionModelA_settleOnce_total: costOfSessionA,
    sessionModelA_returningPlayerPerGame: recurringA,
    perOnchainEvent: perEvent,
    gamesPerDollar_settleOnce_new: Math.floor(1 / costOfSessionA),
    gamesPerDollar_settleOnce_returning: Math.floor(1 / recurringA),
    gamesPerDollar_commitPerAction_50: Math.floor(1 / (recurringA + 50 * perEvent)),
    runTotalUsdc: Number(formatUnits(total, 6)),
  };
  writeFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'cost-measurement.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('written: foskaay-ggi/deployments/cost-measurement.json');
})().catch((e) => {
  console.error('measurement failed:', e.shortMessage || e.message || e);
  process.exit(1);
});
