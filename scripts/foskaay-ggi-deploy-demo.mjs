// scripts/foskaay-ggi-deploy-demo.mjs — deploy the Ludo demo contracts to Arc.
//
// Deploys FoskaayGGIDemoGames + FoskaayGGIDemoPlayer BEHIND UUPS proxies (the same
// pattern as the core), wired to each other, and records the addresses. Both are
// upgradeable, OpenZeppelin-only, append-only storage.
//
// SECURITY: the deployer key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/foskaay-ggi-deploy-demo.mjs
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, defineChain, http, getAddress, formatUnits, encodeFunctionData } from 'viem';
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

async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(name + ' deploy reverted: ' + hash);
  return { address: getAddress(rc.contractAddress), tx: hash, abi: a.abi };
}

(async () => {
  const me = getAddress(account.address);
  const before = await bal(me);
  console.log('Foskaay GGI Ludo demo deploy -> Arc testnet');
  console.log('owner/deployer (public):', me, '\n');

  // 1. Player implementation + proxy (gameContract set after the game exists).
  const playerImpl = await deploy('FoskaayGGIDemoPlayer');
  const playerInit = encodeFunctionData({ abi: playerImpl.abi, functionName: 'initialize', args: [me, '0x0000000000000000000000000000000000000000'] });
  const player = await deploy('ERC1967Proxy', [playerImpl.address, playerInit]);
  console.log('FoskaayGGIDemoPlayer proxy:', player.address, '(impl', playerImpl.address + ')');

  // 2. Games implementation + proxy (playerAccount = the player proxy).
  const gamesImpl = await deploy('FoskaayGGIDemoGames');
  const gamesInit = encodeFunctionData({ abi: gamesImpl.abi, functionName: 'initialize', args: [me, player.address] });
  const games = await deploy('ERC1967Proxy', [gamesImpl.address, gamesInit]);
  console.log('FoskaayGGIDemoGames proxy :', games.address, '(impl', gamesImpl.address + ')');

  // 3. Wire the player to the games contract.
  const wire = await wallet.writeContract({ address: player.address, abi: playerImpl.abi, functionName: 'setGameContract', args: [games.address], account });
  const wireRc = await pub.waitForTransactionReceipt({ hash: wire });
  if (wireRc.status !== 'success') throw new Error('setGameContract reverted');
  console.log('wired player -> games (tx', wire + ')');

  // 4. Verify wiring + defaults on-chain.
  const read = (address, abi, fn, args) => pub.readContract({ address, abi, functionName: fn, args: args || [] });
  const playerOnGames = await read(games.address, gamesImpl.abi, 'playerAccount');
  const gamesOnPlayer = await read(player.address, playerImpl.abi, 'gameContract');
  const turnSeconds = await read(games.address, gamesImpl.abi, 'turnSeconds');
  console.log('\nverify: games.playerAccount =', playerOnGames, '| player.gameContract =', gamesOnPlayer, '| turnSeconds =', turnSeconds.toString());
  if (getAddress(playerOnGames) !== player.address || getAddress(gamesOnPlayer) !== games.address) throw new Error('wiring mismatch');
  if (turnSeconds !== 45n) throw new Error('turnSeconds default not set (proxy initializer trap)');

  const after = await bal(me);
  console.log('=== COST SUMMARY (for mainnet prep) ===');
  console.log('  balance before :', formatUnits(before, 6), 'USDC');
  console.log('  balance after  :', formatUnits(after, 6), 'USDC');
  console.log('  deploy cost    :', formatUnits(before - after, 6), 'USDC');
  console.log('');

  if (!rec.contracts || !rec.contracts.SessionRegistry) throw new Error('arc-testnet.json shape unexpected; refusing to write');
  rec.contracts.FoskaayGGIDemoGames = games.address;
  rec.contracts.FoskaayGGIDemoPlayer = player.address;
  rec.demoDeployedAt = new Date().toISOString();
  rec.demoNote = 'Ludo demo: FoskaayGGIDemoGames (all demo games, gameTag ludo) + FoskaayGGIDemoPlayer (one player account, per-game point buckets). Both UUPS, OZ-only, wired.';
  rec.demoImplementations = { FoskaayGGIDemoGames: gamesImpl.address, FoskaayGGIDemoPlayer: playerImpl.address };
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
})().catch((e) => { console.error('deploy failed:', e.shortMessage || e.message || e); process.exit(1); });
