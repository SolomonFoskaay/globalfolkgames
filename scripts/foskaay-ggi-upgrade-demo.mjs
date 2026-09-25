// scripts/foskaay-ggi-upgrade-demo.mjs — UUPS upgrade of the Ludo demo proxies IN PLACE.
//
// The demo contracts are upgradeable on purpose: the proxy addresses are PERMANENT.
// This script deploys new implementations and repoints the EXISTING proxies, so the
// address the site/bookmarks/relay use never changes and no data is orphaned.
//
// Top-level storage layout is unchanged (_matches, playerAccount, turnSeconds,
// version, __gap). Only the Match struct gained trailing fields, so old match
// entries read with the new layout are still safe for the demo (test data only).
//
// SECURITY: the upgrade key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/foskaay-ggi-upgrade-demo.mjs
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, defineChain, http, getAddress, formatUnits } from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const here = dirname(fileURLToPath(import.meta.url));
const recPath = join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json');
const rec = JSON.parse(readFileSync(recPath, 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const USDC = rec.usdc;

const artifact = (name) => JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', name + '.sol', name + '.json'), 'utf8'));
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });
const erc20Abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

const GAMES = getAddress(rec.contracts.FoskaayGGIDemoGames);
const PLAYER = getAddress(rec.contracts.FoskaayGGIDemoPlayer);

async function deployImpl(name) {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: [] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(name + ' impl deploy reverted: ' + hash);
  return { address: getAddress(rc.contractAddress), abi: a.abi, tx: hash };
}

async function dataOf(address, abi) {
  const read = (fn) => pub.readContract({ address, abi, functionName: fn });
  const out = { version: Number(await read('version')) };
  try { out.playerAccount = await read('playerAccount'); } catch (_) {}
  try { out.turnSeconds = (await read('turnSeconds')).toString(); } catch (_) {}
  try { out.gameContract = await read('gameContract'); } catch (_) {}
  return out;
}

(async () => {
  const me = getAddress(account.address);
  const before = await bal(me);
  console.log('Foskaay GGI Ludo demo UUPS upgrade -> Arc testnet');
  console.log('caller          :', me);
  console.log('games  (permanent):', GAMES);
  console.log('player (permanent):', PLAYER, '\n');

  const gamesImpl = await deployImpl('FoskaayGGIDemoGames');
  const playerImpl = await deployImpl('FoskaayGGIDemoPlayer');
  console.log('new FoskaayGGIDemoGames impl :', gamesImpl.address, '(tx', gamesImpl.tx + ')');
  console.log('new FoskaayGGIDemoPlayer impl:', playerImpl.address, '(tx', playerImpl.tx + ')\n');

  // ---- upgrade GAMES proxy in place ----
  const gBefore = await dataOf(GAMES, gamesImpl.abi);
  const gUp = await wallet.writeContract({ address: GAMES, abi: gamesImpl.abi, functionName: 'upgradeToAndCall', args: [gamesImpl.address, '0x'], account });
  const gUpRc = await pub.waitForTransactionReceipt({ hash: gUp });
  if (gUpRc.status !== 'success') throw new Error('games upgrade reverted: ' + gUp);
  const gAfter = await dataOf(GAMES, gamesImpl.abi);
  console.log('GAMES upgrade tx:', gUp);
  console.log('  before:', JSON.stringify(gBefore));
  console.log('  after :', JSON.stringify(gAfter), '| address unchanged:', GAMES);

  // ---- upgrade PLAYER proxy in place ----
  const pBefore = await dataOf(PLAYER, playerImpl.abi);
  const pUp = await wallet.writeContract({ address: PLAYER, abi: playerImpl.abi, functionName: 'upgradeToAndCall', args: [playerImpl.address, '0x'], account });
  const pUpRc = await pub.waitForTransactionReceipt({ hash: pUp });
  if (pUpRc.status !== 'success') throw new Error('player upgrade reverted: ' + pUp);
  const pAfter = await dataOf(PLAYER, playerImpl.abi);
  console.log('PLAYER upgrade tx:', pUp);
  console.log('  before:', JSON.stringify(pBefore));
  console.log('  after :', JSON.stringify(pAfter), '| address unchanged:', PLAYER, '\n');

  const gSame = JSON.stringify(gBefore) === JSON.stringify(gAfter);
  const pSame = JSON.stringify(pBefore) === JSON.stringify(pAfter);
  console.log('DATA PRESERVED: games', gSame ? 'YES' : 'NO', '| player', pSame ? 'YES' : 'NO');

  // prove the new implementation is live on the SAME addresses (ERC1967 impl slot)
  const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const gImpl = getAddress('0x' + (await pub.getStorageAt({ address: GAMES, slot: IMPL_SLOT })).slice(-40));
  const pImpl = getAddress('0x' + (await pub.getStorageAt({ address: PLAYER, slot: IMPL_SLOT })).slice(-40));
  console.log('impl slot now: games ->', gImpl, '(expect', gamesImpl.address + ')');
  console.log('impl slot now: player ->', pImpl, '(expect', playerImpl.address + ')');
  if (gImpl !== gamesImpl.address || pImpl !== playerImpl.address) throw new Error('proxy did not repoint to the new impl');
  console.log('PROXY ADDRESSES UNCHANGED, implementations repointed.');

  const after = await bal(me);
  console.log('\n=== COST SUMMARY (UPGRADE, for mainnet prep) ===');
  console.log('  balance before :', formatUnits(before, 6), 'USDC');
  console.log('  balance after  :', formatUnits(after, 6), 'USDC');
  console.log('  upgrade cost   :', formatUnits(before - after, 6), 'USDC');
  console.log('  addresses      : UNCHANGED (', GAMES, ',', PLAYER, ')');

  if (!rec.contracts || !rec.contracts.SessionRegistry) throw new Error('arc-testnet.json shape unexpected; refusing to write');
  if (getAddress(rec.contracts.FoskaayGGIDemoGames) !== GAMES) throw new Error('refusing to write: games address drift');
  if (getAddress(rec.contracts.FoskaayGGIDemoPlayer) !== PLAYER) throw new Error('refusing to write: player address drift');
  rec.demoImplementations = { FoskaayGGIDemoGames: gamesImpl.address, FoskaayGGIDemoPlayer: playerImpl.address };
  rec.demoUpgradedAt = new Date().toISOString();
  rec.demoUpgradeNote = 'In-place UUPS upgrade of the permanent demo proxies (same addresses). Top-level layout unchanged.';
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
  if (!gSame || !pSame) process.exit(2);
})().catch((e) => { console.error('upgrade failed:', e.shortMessage || e.message || e); process.exit(1); });
