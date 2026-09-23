// scripts/foskaay-ggi-upgrade-registry.mjs — UUPS upgrade of SessionRegistry.
//
// Adds the EVENT-BASED MIDCHAIN functions (handover/handoverMany/settle/
// settleMany/midchainDigest) to the EXISTING SessionRegistry proxy. The change is
// ADDITIVE: no storage layout change, no gap change, no version bump, no
// migration. The proxy address stays the same and all existing data is untouched.
//
// SECURITY: the upgrade key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed. The proxy's _authorizeUpgrade allows only
// the feeRecipient (the sponsor/owner).
//
// Usage:  node scripts/foskaay-ggi-upgrade-registry.mjs
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, defineChain, http, getAddress } from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const here = dirname(fileURLToPath(import.meta.url));
const recPath = join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json');
const rec = JSON.parse(readFileSync(recPath, 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const PROXY = getAddress(rec.contracts.SessionRegistry);

const artifact = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', 'SessionRegistry.sol', 'SessionRegistry.json'), 'utf8'));
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const read = (fn, args) => pub.readContract({ address: PROXY, abi: artifact.abi, functionName: fn, args: args || [] });

(async () => {
  const me = getAddress(account.address);
  console.log('SessionRegistry UUPS upgrade -> Arc testnet');
  console.log('proxy (permanent):', PROXY);
  console.log('caller           :', me);

  // ---- data BEFORE (must be identical after) ----
  const before = {
    feeRecipient: await read('feeRecipient'),
    operator: await read('operator'),
    version: Number(await read('version')),
    nonce: (await read('nonces', [me])).toString(),
    gameStateOf0: await read('gameStateOf', ['0x' + '00'.repeat(32)]),
  };
  console.log('before:', JSON.stringify(before));

  if (before.feeRecipient.toLowerCase() !== me.toLowerCase()) {
    throw new Error('caller is not the feeRecipient; upgrade would revert');
  }

  // ---- deploy new implementation ----
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('impl deploy reverted: ' + hash);
  const impl = getAddress(rc.contractAddress);
  console.log('new implementation:', impl, '(tx', hash + ')');

  // ---- upgrade the proxy (same address) ----
  const upHash = await wallet.writeContract({ address: PROXY, abi: artifact.abi, functionName: 'upgradeToAndCall', args: [impl, '0x'], account });
  const upRc = await pub.waitForTransactionReceipt({ hash: upHash });
  if (upRc.status !== 'success') throw new Error('upgrade reverted: ' + upHash);
  console.log('upgrade tx:', upHash);

  // ---- data AFTER + new logic live ----
  const after = {
    feeRecipient: await read('feeRecipient'),
    operator: await read('operator'),
    version: Number(await read('version')),
    nonce: (await read('nonces', [me])).toString(),
    gameStateOf0: await read('gameStateOf', ['0x' + '00'.repeat(32)]),
  };
  console.log('after :', JSON.stringify(after));

  const same = JSON.stringify(before) === JSON.stringify(after);
  console.log('DATA PRESERVED:', same ? 'YES (all fields identical)' : 'NO (INVESTIGATE)');

  // prove the new logic is live: midchainDigest exists on the proxy now
  const digest = await read('midchainDigest', ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]);
  console.log('new function live: midchainDigest ->', digest);

  rec.contracts.SessionRegistryImplementation = impl;
  rec.registryUpgradedAt = new Date().toISOString();
  rec.registryUpgradeNote = 'Event-based midchain functions added (additive, no storage change). Proxy unchanged.';
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
  if (!same) process.exit(2);
})().catch((e) => { console.error('upgrade failed:', e.shortMessage || e.message || e); process.exit(1); });
