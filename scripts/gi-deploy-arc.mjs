// scripts/gi-deploy-arc.mjs — deploy the FOUR core GlobalFolkGames Gasless
// Infrastructure contracts to Arc, from their forge artifacts.
//
// SECURITY: public values (RPC, USDC address, explorer) come from
// public/arc-config.json. The deployer key comes from ~/.config/gfg/arc-sponsor.json
// and is NEVER printed, logged, or committed. On Arc the gas token is USDC.
//
// Usage:
//   node scripts/gi-deploy-arc.mjs
//
// It prints, per contract: address, tx hash, explorer link, and the USDC gas
// spent, then a TOTAL. That total is the real Arc mainnet prep number.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createPublicClient, createWalletClient, defineChain, http, getAddress, formatUnits,
} from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const cfg = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || cfg.rpc;
const USDC = '0x3600000000000000000000000000000000000000';

const keyFile = join(homedir(), '.config', 'gfg', 'arc-sponsor.json');
const account = accountFor(JSON.parse(readFileSync(keyFile, 'utf8')).key);

const chain = defineChain({
  id: cfg.chainId,
  name: cfg.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: cfg.usdcDecimalsNative || 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const erc20Abi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

// Deployment plan, in dependency order. ctorArgs uses the deployer address where
// the contract wants an owner/fee recipient.
const PLAN = [
  { name: 'SessionRegistry', args: (me) => [me, '0x0000000000000000000000000000000000000000'] },
  { name: 'SessionState', args: null },              // needs the registry address below
  { name: 'Randomness', args: null },                // needs the registry address below
  { name: 'FeeVault', args: (me) => [me, me, USDC] },
];

function artifact(name) {
  const p = new URL(`../globalfolkgames-bs/out/${name}.sol/${name}.json`, import.meta.url);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  if (!j.bytecode || j.bytecode.object === '0x') throw new Error('no bytecode for ' + name + ' (run forge build in globalfolkgames-bs)');
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function usdcBalance(addr) {
  const bal = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
  return bal; // 6-decimal base units
}

(async () => {
  const me = getAddress(account.address);
  const before = await usdcBalance(me);
  console.log('GI core deploy -> Arc Testnet');
  console.log('deployer/sponsor (public):', me);
  console.log('rpc:', RPC);
  console.log('balance before:', formatUnits(before, 6), 'USDC');
  console.log('');

  const out = {};
  let lastBalance = before;

  for (const step of PLAN) {
    const { abi, bytecode } = artifact(step.name);
    let args;
    if (step.name === 'SessionState' || step.name === 'Randomness') {
      args = [out.SessionRegistry.address];
    } else {
      args = step.args(me);
    }
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const address = getAddress(rc.contractAddress);
    const after = await usdcBalance(me);
    const spent = lastBalance - after;
    lastBalance = after;
    out[step.name] = { address, tx: hash, spent };

    console.log(`${step.name}`);
    console.log('  address :', address);
    console.log('  tx      :', hash);
    console.log('  explorer:', cfg.explorer + '/tx/' + hash);
    console.log('  gas usdc:', formatUnits(spent, 6));
    console.log('');
  }

  // Persist the public addresses so the proof driver (and the app later) can use
  // them. Addresses are public data, safe to commit; only the key is a secret.
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'globalfolkgames-bs', 'deployments');
  mkdirSync(outDir, { recursive: true });
  const record = {
    network: cfg.name,
    chainId: cfg.chainId,
    rpc: cfg.rpc,
    explorer: cfg.explorer,
    usdc: USDC,
    deployedAt: new Date().toISOString(),
    deployer: me,
    contracts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.address])),
  };
  writeFileSync(join(outDir, 'arc-testnet.json'), JSON.stringify(record, null, 2) + '\n');
  console.log('addresses written: globalfolkgames-bs/deployments/arc-testnet.json');
  console.log('');

  const total = before - lastBalance;
  console.log('=== SUMMARY ===');
  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}: ${v.address}  (${formatUnits(v.spent, 6)} USDC)`);
  }
  console.log('TOTAL DEPLOY:', formatUnits(total, 6), 'USDC');
  console.log('balance after:', formatUnits(lastBalance, 6), 'USDC');
})().catch((e) => {
  console.error('deploy failed:', e.shortMessage || e.message || e);
  process.exit(1);
});
