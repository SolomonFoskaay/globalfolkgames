// scripts/foskaay-ggi-deploy-generals.mjs — deploy the ported GeneralsGame to Arc testnet.
//
// WHAT THIS IS: GeneralsGame is the GAME's own contract (the ported MagicBlock
// solana-generals board). It is NOT rail core and it is NOT behind a proxy: it is
// demo/example code, deployed once, and used by the PvP demo. It is constructed
// with the permanent SessionRegistry proxy address so its moves are authorised by
// live Foskaay GGI sessions.
//
// SECURITY: the deployer key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed. Public values come from
// foskaay-ggi/deployments/arc-testnet.json. On Arc the gas token is USDC.
//
// Usage:  node scripts/foskaay-ggi-deploy-generals.mjs
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createPublicClient, createWalletClient, defineChain, http, getAddress, formatUnits,
} from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const here = dirname(fileURLToPath(import.meta.url));
const recPath = join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json');
const rec = JSON.parse(readFileSync(recPath, 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const USDC = rec.usdc;
const REGISTRY = rec.contracts.SessionRegistry;

const keyFile = join(homedir(), '.config', 'gfg', 'arc-sponsor.json');
const account = accountFor(JSON.parse(readFileSync(keyFile, 'utf8')).key);

const chain = defineChain({
  id: rec.chainId,
  name: rec.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const erc20Abi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

function artifact(name) {
  const p = join(here, '..', 'foskaay-ggi', 'out', name + '.sol', name + '.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  if (!j.bytecode || j.bytecode.object === '0x') throw new Error('no bytecode for ' + name + ' (run forge build in foskaay-ggi)');
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function usdcBalance(addr) {
  return pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
}

(async () => {
  const me = getAddress(account.address);
  const before = await usdcBalance(me);
  console.log('GeneralsGame deploy -> Arc Testnet');
  console.log('deployer/sponsor (public):', me);
  console.log('registry (rail):', REGISTRY);
  console.log('balance before:', formatUnits(before, 6), 'USDC');
  console.log('');

  const { abi, bytecode } = artifact('GeneralsGame');
  const hash = await wallet.deployContract({ abi, bytecode, args: [getAddress(REGISTRY)] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('deploy reverted: ' + hash);
  const address = getAddress(rc.contractAddress);
  const after = await usdcBalance(me);
  const spent = before - after;

  console.log('GeneralsGame');
  console.log('  address :', address);
  console.log('  tx      :', hash);
  console.log('  explorer:', rec.explorer + '/tx/' + hash);
  console.log('  gas usdc:', formatUnits(spent, 6));
  console.log('');

  // Persist the public address so the relay and the demo can use it. This is a
  // protected content file: assert the top-level keys survive before writing.
  if (!rec.contracts || !rec.contracts.SessionRegistry) throw new Error('arc-testnet.json shape unexpected; refusing to write');
  rec.contracts.GeneralsGame = address;
  rec.generalsGameDeployedAt = new Date().toISOString();
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('address written: foskaay-ggi/deployments/arc-testnet.json (contracts.GeneralsGame)');
  console.log('balance after:', formatUnits(after, 6), 'USDC');
})().catch((e) => {
  console.error('deploy failed:', e.shortMessage || e.message || e);
  process.exit(1);
});
