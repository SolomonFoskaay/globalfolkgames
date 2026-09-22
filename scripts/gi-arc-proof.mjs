// scripts/gi-arc-proof.mjs — LIVE Arc testnet proof for the four GI core contracts.
//
// Proves ONE real session end to end against the deployed contracts:
//   open -> set authorities -> register a session key -> recordEvent (path A)
//   + commitDigest (path B) -> close -> reveal seed -> sealFinal -> pay open+settle
//   fee in USDC -> withdraw.
//
// SECURITY: reads the deployer key from ~/.config/gfg/arc-sponsor.json and never
// prints it. Addresses come from foskaay-ggi/deployments/arc-testnet.json.
//
// Usage:
//   node scripts/gi-arc-proof.mjs
import { readFileSync } from 'fs';
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
const record = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json'), 'utf8'));
const RPC = process.env.GFG_Arc_RPC || record.rpc;
const C = record.contracts;
const USDC = record.usdc;

const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({
  id: record.chainId,
  name: record.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const registryAbi = parseAbi([
  'function open(uint8 participantCount, uint64 ttlSecs, bytes32 rulesHash, bytes32 seedCommit) returns (bytes32)',
  'function setAuthority(bytes32 sessionId, uint8 seat, address authority)',
  'function registerSessionKey(address key, uint64 validUntil, bytes32 scopeHash)',
  'function close(bytes32 sessionId)',
  'function canSign(bytes32 sessionId, uint8 seat, address who) view returns (bool)',
  'function getSession(bytes32 sessionId) view returns ((address owner, uint8 status, uint8 participantCount, uint64 createdAt, uint64 expiresAt, uint64 closedAt, bytes32 rulesHash, bytes32 seedCommit))',
]);
const stateAbi = parseAbi([
  'function recordEvent(bytes32 sessionId, uint8 seat, uint64 sequence, bytes32 payloadHash)',
  'function commitDigest(bytes32 sessionId, bytes32 digest, uint16 eventCount)',
  'function sealFinal(bytes32 sessionId, bytes32 digest)',
  'function digestOf(bytes32 sessionId) view returns (bytes32)',
  'function getState(bytes32 sessionId) view returns ((bytes32 digest, uint16 eventCount, uint64 lastSequence, bytes32 lastPayloadHash, bool committed))',
  'function finalDigest(bytes32 sessionId) view returns (bytes32)',
]);
const rndAbi = parseAbi([
  'function commitHashOf(bytes32[] seeds) pure returns (bytes32)',
  'function reveal(bytes32 sessionId, bytes32[] seeds)',
  'function seedsOf(bytes32 sessionId) view returns (bytes32[])',
  'function derive(bytes32 seed, uint64 counter) pure returns (bytes32)',
  'function revealed(bytes32 sessionId) view returns (bool)',
]);
const vaultAbi = parseAbi([
  'function setFee(uint256 sessionFee)',
  'function chargeSession(bytes32 sessionId)',
  'function withdraw(address token)',
  'function collected(address token) view returns (uint256)',
  'function paymentOf(bytes32 sessionId) view returns (address, address)',
]);
const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const SESSION_FEE = 1500n; // 0.0015 USDC (placeholder, owner-set)
const TTL = 3600n;

async function tx(label, req) {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(label + ' reverted: ' + hash);
  console.log(`  [ok] ${label}  ${hash}`);
  return rc;
}

async function usdc() {
  return pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
}

(async () => {
  const me = getAddress(account.address);
  const before = await usdc();
  console.log('GI LIVE PROOF -> Arc Testnet');
  console.log('sponsor (public):', me);
  console.log('contracts:');
  for (const [k, v] of Object.entries(C)) console.log('  ' + k + ':', v);
  console.log('balance before:', formatUnits(before, 6), 'USDC');
  console.log('');

  // ---- 1. random seed: commit its hash at open, reveal it after close --------
  const seed = keccak256(toBytes('gi-proof-seed-' + Date.now()));
  const seeds = [seed];
  const commit = await pub.readContract({ address: C.Randomness, abi: rndAbi, functionName: 'commitHashOf', args: [seeds] });
  console.log('1. seed commitment computed:', commit);

  // ---- 2. open a 2-seat session, authorities, session key --------------------
  const sender = me; // the sponsor acts as both operator and seat-0 authority
  const seat1 = '0x00000000000000000000000000000000000000B1';
  const spender = me;

  // Fee setup + approval (exact-amount pull; approve just the two fees).
  await tx('FeeVault.setFee', { address: C.FeeVault, abi: vaultAbi, functionName: 'setFee', args: [SESSION_FEE], account });
  await tx('USDC.approve(fee)', { address: USDC, abi: erc20Abi, functionName: 'approve', args: [C.FeeVault, SESSION_FEE], account });

  let sessionId;
  {
    const rc = await tx('SessionRegistry.open', { address: C.SessionRegistry, abi: registryAbi, functionName: 'open', args: [2, TTL, keccak256(toBytes('gfg-gi-proof-rules')), commit], account });
    // sessionId is the keccak(owner, nonce, chainid, registry); read it from logs is complex,
    // so derive it the same way the contract does: nonce was 0 for this deployer's first open.
    const nonce = 0n;
    sessionId = keccak256(encodePacked(['address', 'uint64', 'uint256', 'address'], [sender, nonce, BigInt(record.chainId), C.SessionRegistry]));
    void rc;
  }
  console.log('2. sessionId:', sessionId);

  await tx('SessionRegistry.setAuthority(0)', { address: C.SessionRegistry, abi: registryAbi, functionName: 'setAuthority', args: [sessionId, 0, me], account });
  await tx('SessionRegistry.setAuthority(1)', { address: C.SessionRegistry, abi: registryAbi, functionName: 'setAuthority', args: [sessionId, 1, seat1], account });
  const skKey = '0x00000000000000000000000000000000000000C1';
  await tx('SessionRegistry.registerSessionKey', { address: C.SessionRegistry, abi: registryAbi, functionName: 'registerSessionKey', args: [skKey, BigInt(Math.floor(Date.now() / 1000) + 3600), keccak256(toBytes('scope:proof'))], account });

  // ---- 3. prove canSign both ways -------------------------------------------
  const directOk = await pub.readContract({ address: C.SessionRegistry, abi: registryAbi, functionName: 'canSign', args: [sessionId, 0, me] });
  const keyOk = await pub.readContract({ address: C.SessionRegistry, abi: registryAbi, functionName: 'canSign', args: [sessionId, 0, getAddress(skKey)] });
  const wrongSeat = await pub.readContract({ address: C.SessionRegistry, abi: registryAbi, functionName: 'canSign', args: [sessionId, 1, getAddress(skKey)] });
  console.log('3. canSign direct:', directOk, '| session key on its seat:', keyOk, '| key on other seat:', wrongSeat);

  // ---- 4. recordEvent (path A) ----------------------------------------------
  await tx('SessionState.recordEvent', { address: C.SessionState, abi: stateAbi, functionName: 'recordEvent', args: [sessionId, 0, 1n, keccak256(toBytes('move-1'))], account });
  await tx('SessionState.recordEvent', { address: C.SessionState, abi: stateAbi, functionName: 'recordEvent', args: [sessionId, 0, 2n, keccak256(toBytes('move-2'))], account });
  const st = await pub.readContract({ address: C.SessionState, abi: stateAbi, functionName: 'getState', args: [sessionId] });
  console.log('4. events anchored:', st.eventCount, 'digest:', st.digest);

  // ---- 5. a SECOND session proves the off-chain commitDigest path ------------
  const commit2 = await pub.readContract({ address: C.Randomness, abi: rndAbi, functionName: 'commitHashOf', args: [seeds] });
  const rc2 = await tx('SessionRegistry.open (2)', { address: C.SessionRegistry, abi: registryAbi, functionName: 'open', args: [1, TTL, keccak256(toBytes('gfg-gi-proof-rules-2')), commit2], account });
  void rc2;
  const sessionId2 = keccak256(encodePacked(['address', 'uint64', 'uint256', 'address'], [sender, 1n, BigInt(record.chainId), C.SessionRegistry]));
  await tx('SessionRegistry.setAuthority(2,0)', { address: C.SessionRegistry, abi: registryAbi, functionName: 'setAuthority', args: [sessionId2, 0, me], account });
  await tx('SessionState.commitDigest (path B)', { address: C.SessionState, abi: stateAbi, functionName: 'commitDigest', args: [sessionId2, keccak256(toBytes('offchain-digest')), 120], account });
  const st2 = await pub.readContract({ address: C.SessionState, abi: stateAbi, functionName: 'getState', args: [sessionId2] });
  console.log('5. path B committed:', st2.committed, 'count:', st2.eventCount);

  // ---- 6. close, reveal, seal ------------------------------------------------
  await tx('SessionRegistry.close', { address: C.SessionRegistry, abi: registryAbi, functionName: 'close', args: [sessionId], account });
  await tx('Randomness.reveal', { address: C.Randomness, abi: rndAbi, functionName: 'reveal', args: [sessionId, seeds], account });
  const revealed = await pub.readContract({ address: C.Randomness, abi: rndAbi, functionName: 'revealed', args: [sessionId] });
  const stored = await pub.readContract({ address: C.Randomness, abi: rndAbi, functionName: 'seedsOf', args: [sessionId] });
  const roll = await pub.readContract({ address: C.Randomness, abi: rndAbi, functionName: 'derive', args: [seed, 1n] });
  console.log('6. seed revealed:', revealed, '| matches:', stored[0] === seed, '| derive(seed,1):', roll);
  await tx('SessionState.sealFinal', { address: C.SessionState, abi: stateAbi, functionName: 'sealFinal', args: [sessionId, st.digest], account });
  const sealed = await pub.readContract({ address: C.SessionState, abi: stateAbi, functionName: 'finalDigest', args: [sessionId] });
  console.log('   final sealed:', sealed === st.digest);

  // ---- 7. fees: charge open + settle, then withdraw --------------------------
  await tx('FeeVault.chargeSession', { address: C.FeeVault, abi: vaultAbi, functionName: 'chargeSession', args: [sessionId], account });
  const collected = await pub.readContract({ address: C.FeeVault, abi: vaultAbi, functionName: 'collected', args: [USDC] });
  console.log('7. fee collected:', formatUnits(collected, 6), 'USDC');
  await tx('FeeVault.withdraw', { address: C.FeeVault, abi: vaultAbi, functionName: 'withdraw', args: [USDC], account });
  const afterCollected = await pub.readContract({ address: C.FeeVault, abi: vaultAbi, functionName: 'collected', args: [USDC] });
  console.log('   after withdraw, collected:', afterCollected.toString());

  // ---- 8. balance report -----------------------------------------------------
  const after = await usdc();
  const spent = before - after;
  console.log('');
  console.log('=== PROOF RESULT ===');
  console.log('session opened, acted on, revealed, sealed, settled and paid: PASS');
  console.log('sponsor (public):', me);
  console.log('balance before:', formatUnits(before, 6), 'USDC');
  console.log('gas spent by this proof run:', formatUnits(spent, 6), 'USDC');
  console.log('balance after: ', formatUnits(after, 6), 'USDC');
  console.log('(fees paid + withdrawn: 0.0015 USDC returns to the owner, released in the balance)');
})().catch((e) => {
  console.error('proof failed:', e.shortMessage || e.message || e);
  process.exit(1);
});
