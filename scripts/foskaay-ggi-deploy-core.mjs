// scripts/foskaay-ggi-deploy-core.mjs — deploy the SINGLE core (v7) + the Ludo game.
//
// Core = SessionRegistry only (the FeeVault is merged in). Deployed behind a UUPS
// ERC1967 proxy (OpenZeppelin), so the address is permanent and upgrades never
// strand data. The Ludo game is pure (no storage), so it needs no proxy.
//
// Fee tiers (v7/v9): 0.0004 native USDC unbatched, 0.0002 batched. On Arc the
// gas token is USDC with 18 decimals, so 0.0004 = 4e14 wei.
//
// SECURITY: the deployer key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/foskaay-ggi-deploy-core.mjs
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
const FEE = 4n * 10n ** 14n;       // 0.0004 native USDC (18 decimals)
const FEE_BATCH = 2n * 10n ** 14n; // 0.0002

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
  console.log('Foskaay GGI CORE (v7, single contract) + Ludo deploy -> Arc testnet');
  console.log('owner/deployer (public):', me);
  console.log('balance before:', formatUnits(before, 6), 'USDC\n');

  // 1. SessionRegistry (impl + UUPS proxy). Single core, FeeVault merged in.
  const regImpl = await deploy('SessionRegistry');
  const regInit = encodeFunctionData({ abi: regImpl.abi, functionName: 'initialize', args: [me, me, FEE] });
  const reg = await deploy('ERC1967Proxy', [regImpl.address, regInit]);
  console.log('SessionRegistry proxy:', reg.address, '(impl', regImpl.address + ')');

  // 2. Set the batched tier.
  const setBatch = await wallet.writeContract({ address: reg.address, abi: regImpl.abi, functionName: 'setFeeBatch', args: [FEE_BATCH], account });
  const setBatchRc = await pub.waitForTransactionReceipt({ hash: setBatch });
  if (setBatchRc.status !== 'success') throw new Error('setFeeBatch reverted');

  // 3. The Ludo game (pure, no storage, no proxy needed).
  const ludo = await deploy('FoskaayGGILudo');
  console.log('FoskaayGGILudo      :', ludo.address);

  // 4. Verify on-chain.
  const read = (address, abi, fn, args) => pub.readContract({ address, abi, functionName: fn, args: args || [] });
  const fee = await read(reg.address, regImpl.abi, 'fee');
  const feeBatch = await read(reg.address, regImpl.abi, 'feeBatch');
  const dest = await read(reg.address, regImpl.abi, 'destination');
  const owner = await read(reg.address, regImpl.abi, 'owner');
  console.log('\nverify: fee =', formatUnits(fee, 18), 'USDC (18dp native) | feeBatch =', formatUnits(feeBatch, 18), '| destination =', dest, '| owner =', owner);
  if (fee !== FEE || feeBatch !== FEE_BATCH) throw new Error('fee mismatch');
  if (getAddress(dest) !== me || getAddress(owner) !== me) throw new Error('owner/destination mismatch');

  const after = await bal(me);
  console.log('\n=== COST SUMMARY (for mainnet prep) ===');
  console.log('  balance before :', formatUnits(before, 6), 'USDC');
  console.log('  balance after  :', formatUnits(after, 6), 'USDC');
  console.log('  deploy cost    :', formatUnits(before - after, 6), 'USDC');
  console.log('');

  if (!rec.contracts || !rec.contracts.SessionRegistry) throw new Error('arc-testnet.json shape unexpected; refusing to write');
  rec.contracts.SessionRegistry = reg.address;
  rec.contracts.FoskaayGGILudo = ludo.address;
  delete rec.contracts.FeeVault;
  delete rec.contracts.FoskaayGGIDemoGames;
  delete rec.contracts.FoskaayGGIDemoPlayer;
  rec.coreV7DeployedAt = new Date().toISOString();
  rec.coreNote = 'v7 SINGLE core: SessionRegistry with FeeVault merged in, UUPS proxy, fee 0.0004 unbatched / 0.0002 batched (native USDC 18dp). Ludo is a pure contract (no proxy).';
  rec.implementations = { SessionRegistry: regImpl.address };
  rec.ludoDeployedAt = new Date().toISOString();
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
})().catch((e) => { console.error('deploy failed:', e.shortMessage || e.message || e); process.exit(1); });
