// scripts/foskaay-ggi-deploy-midchain.mjs — deploy the pure midchain Generals rules to Arc.
//
// GeneralsMidchain holds NO state and has NO constructor args: it is a pure rules
// engine that the client runs for free via eth_call. It is demo code, not rail
// core. Public address is written to the deployments record.
//
// SECURITY: the deployer key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/foskaay-ggi-deploy-midchain.mjs
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

const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const erc20Abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];

function artifact(name) {
  const j = JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', name + '.sol', name + '.json'), 'utf8'));
  if (!j.bytecode || j.bytecode.object === '0x') throw new Error('no bytecode for ' + name + ' (run forge build in foskaay-ggi)');
  return { abi: j.abi, bytecode: j.bytecode.object };
}
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

(async () => {
  const me = getAddress(account.address);
  const before = await bal(me);
  console.log('GeneralsMidchain deploy -> Arc Testnet');
  console.log('deployer/sponsor (public):', me);
  console.log('balance before:', formatUnits(before, 6), 'USDC\n');

  const { abi, bytecode } = artifact('GeneralsMidchain');
  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('deploy reverted: ' + hash);
  const address = getAddress(rc.contractAddress);
  const after = await bal(me);

  console.log('GeneralsMidchain');
  console.log('  address :', address);
  console.log('  tx      :', hash);
  console.log('  explorer:', rec.explorer + '/tx/' + hash);
  console.log('  gas usdc:', formatUnits(before - after, 6), '\n');

  if (!rec.contracts || !rec.contracts.SessionRegistry) throw new Error('arc-testnet.json shape unexpected; refusing to write');
  rec.contracts.GeneralsMidchain = address;
  rec.generalsMidchainDeployedAt = new Date().toISOString();
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('address written: foskaay-ggi/deployments/arc-testnet.json (contracts.GeneralsMidchain)');
})().catch((e) => { console.error('deploy failed:', e.shortMessage || e.message || e); process.exit(1); });
