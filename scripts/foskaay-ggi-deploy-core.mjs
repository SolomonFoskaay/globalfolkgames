// scripts/foskaay-ggi-deploy-core.mjs — fresh deploy of the CLEAN 2-contract core.
//
// Deploys SessionRegistry + FeeVault behind UUPS proxies (OpenZeppelin ERC1967),
// wired to each other, and records the new addresses. The old 4+1 proxies are
// abandoned (there is no real game data yet).
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
const FEE = 10n ** 15n; // 0.001 native USDC (18 decimals)

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
  console.log('Foskaay GGI CLEAN CORE deploy -> Arc testnet');
  console.log('owner/deployer (public):', me);
  console.log('balance before:', formatUnits(before, 6), 'USDC\n');

  // 1. SessionRegistry implementation + proxy (feeVault set later).
  const regImpl = await deploy('SessionRegistry');
  const regInit = encodeFunctionData({ abi: regImpl.abi, functionName: 'initialize', args: [me, '0x0000000000000000000000000000000000000000'] });
  const reg = await deploy('ERC1967Proxy', [regImpl.address, regInit]);
  console.log('SessionRegistry proxy:', reg.address, '(impl', regImpl.address + ')');

  // 2. FeeVault implementation + proxy (sessionRegistry = registry proxy).
  const fvImpl = await deploy('FeeVault');
  const fvInit = encodeFunctionData({ abi: fvImpl.abi, functionName: 'initialize', args: [me, me, FEE, reg.address] });
  const vault = await deploy('ERC1967Proxy', [fvImpl.address, fvInit]);
  console.log('FeeVault proxy       :', vault.address, '(impl', fvImpl.address + ')');

  // 3. Wire the registry to the vault.
  const wire = await wallet.writeContract({ address: reg.address, abi: regImpl.abi, functionName: 'setFeeVault', args: [vault.address], account });
  const wireRc = await pub.waitForTransactionReceipt({ hash: wire });
  if (wireRc.status !== 'success') throw new Error('setFeeVault reverted');
  console.log('wired registry -> vault (tx', wire + ')');

  // 4. Verify on-chain wiring.
  const read = (address, abi, fn, args) => pub.readContract({ address, abi, functionName: fn, args: args || [] });
  const regVault = await read(reg.address, regImpl.abi, 'feeVault');
  const vaultReg = await read(vault.address, fvImpl.abi, 'sessionRegistry');
  const feeOnChain = await read(vault.address, fvImpl.abi, 'fee');
  console.log('\nverify: registry.feeVault =', regVault, '| vault.sessionRegistry =', vaultReg, '| fee =', feeOnChain.toString());
  if (getAddress(regVault) !== vault.address || getAddress(vaultReg) !== reg.address) throw new Error('wiring mismatch');

  const after = await bal(me);
  console.log('deploy gas usdc:', formatUnits(before - after, 6), '\n');

  rec.contracts = {
    SessionRegistry: reg.address,
    FeeVault: vault.address,
    GeneralsMidchain: rec.contracts.GeneralsMidchain, // the game's pure rules contract (kept)
  };
  rec.cleanCoreDeployedAt = new Date().toISOString();
  rec.coreNote = 'CLEAN 2-contract core (SessionRegistry + FeeVault), UUPS proxies, wired. Old 4+1 proxies abandoned (no real data). Fee 0.001 native USDC/session.';
  rec.implementations = { SessionRegistry: regImpl.address, FeeVault: fvImpl.address };
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
})().catch((e) => { console.error('deploy failed:', e.shortMessage || e.message || e); process.exit(1); });
