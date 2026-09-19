// scripts/arc-migrate-points.mjs — move every player's Solana balances to Arc.
//
// Reads each player's Solana Player Core (the authoritative on-chain ledger),
// maps the player to their EVM address (Dynamic user list), and credits their
// Arc Player Core with migratePlayer. Idempotent by a reference derived from the
// Solana wallet, so a re-run is a clean no-op.
//
// Usage:
//   node scripts/arc-migrate-points.mjs --dry     # plan only (no writes)
//   node scripts/arc-migrate-points.mjs --run     # execute
import './load-env.mjs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import arcRelay from '../api_handlers/arc-relay.mjs';

const DRY = !process.argv.includes('--run');
const SOL_IDL = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(SOL_IDL.address);
const coreConn = createConnection(baseRpcUrl(), 'confirmed');
const solana = new Program(SOL_IDL, new AnchorProvider(coreConn, { publicKey: Keypair.generate().publicKey, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, { commitment: 'confirmed' }));

const DYNAMIC_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
const DYNAMIC_ENV = process.env.DYNAMIC_ENV_ID || process.env.DYNAMIC_ENVIRONMENT_ID || '';
const OP_TOKEN = process.env.GFG_OPERATOR_TOKEN || '';

function corePda(player) { return PublicKey.findProgramAddressSync([Buffer.from('gfgcore'), player.toBytes()], PROGRAM_ID)[0]; }

async function readSolanaCore(playerStr) {
  let pk; try { pk = new PublicKey(playerStr); } catch (e) { return null; }
  const pda = corePda(pk);
  // read from the hosting ER region first, then base
  let acc = null;
  try {
    const st = await getDelegationStatus(coreConn, pda);
    if (st && st.isDelegated) {
      const url = regionUrlForFqdn(st.fqdn) || pickErRpcUrl();
      const c = createConnection(url, 'confirmed', 8000);
      acc = await solana.account.playerCore.fetch(pda).catch(async () => {
        const info = await c.getAccountInfo(pda).catch(() => null);
        return info ? solana.account.playerCore.fetch(pda) : null;
      });
    }
  } catch (e) { /* fall through */ }
  if (!acc) acc = await solana.account.playerCore.fetch(pda).catch(() => null);
  return acc;
}

async function dynamicUsers() {
  if (!DYNAMIC_TOKEN || !DYNAMIC_ENV) return [];
  const url = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV}/users?limit=100`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${DYNAMIC_TOKEN}` } });
  if (!r.ok) throw new Error('Dynamic API ' + r.status);
  const j = await r.json();
  return (j.users || []).map((u) => {
    let sol = null, evm = null;
    const creds = u.verifiedCredentials || [];
    const pick = (chain) => creds.find(c => c.chain === chain);
    const sc = pick('SOL'); if (sc) sol = sc.address;
    const ec = pick('EVM'); if (ec) evm = ec.address;
    if (u.wallets) {
      const sw = u.wallets.find(w => w.chain === 'SOL'); if (!sol && sw) sol = sw.publicKey || sw.address;
      const ew = u.wallets.find(w => w.chain === 'EVM'); if (!evm && ew) evm = ew.publicKey || ew.address;
    }
    return { id: u.id, email: u.email || '', sol, evm };
  }).filter(u => u.sol || u.evm);
}

function call(action, params, token) {
  return new Promise((resolve) => {
    const req = { method: 'POST', body: JSON.stringify({ action, params, token }), headers: {} };
    let done = false;
    const res = { _c: 200, setHeader(){return this;}, status(c){this._c=c;return this;}, json(o){ if(!done){done=true;resolve({status:this._c,body:o});} }, end(){ if(!done){done=true;resolve({status:this._c,body:null});} } };
    arcRelay(req, res).catch(e => resolve({ status: 500, body: { error: e.message } }));
  });
}

const n = (v) => { if (v == null) return 0; try { return Number(v.toString()); } catch (e) { return 0; } };
function bucketOf(core, tag) {
  const list = core.buckets || [];
  for (let i = 0; i < n(core.bucketCount); i++) {
    const t = Buffer.from(list[i].gameTag).toString('utf8').replace(/\0+$/, '');
    if (t === tag) return { pure: n(list[i].localPure), spendable: n(list[i].localSpendable) };
  }
  return { pure: 0, spendable: 0 };
}

const users = await dynamicUsers();
console.log((DRY ? 'DRY RUN' : 'MIGRATE') + ' | dynamic users with a wallet:', users.length);
let planned = 0, migrated = 0, skipped = 0, totalPoints = 0;
for (const u of users) {
  if (!u.sol || !u.evm) { skipped++; continue; }
  const core = await readSolanaCore(u.sol).catch(() => null);
  if (!core) { skipped++; continue; }
  const b = bucketOf(core, 'ludo');
  const gp = n(core.globalPure), gl = n(core.globalLifetime), gs = n(core.globalSpendable);
  const pl = n(core.premiumLifetime), ps = n(core.premiumSpendable);
  const lvl = n(core.subscriptionLevel), until = n(core.subscriptionActiveUntil);
  const has = b.pure || b.spendable || gp || gl || gs || pl || ps || lvl;
  if (!has) { skipped++; continue; }
  planned++;
  totalPoints += b.pure;
  const refHex = createHash('sha256').update('arc-migrate:' + u.sol).digest('hex').slice(0, 15);
  const migrationRef = parseInt(refHex, 16);
  console.log(`  ${u.sol.slice(0, 8)}… -> ${u.evm.slice(0, 10)}… | ludo ${b.pure}/${b.spendable} global ${gp}/${gl}/${gs} premium ${pl}/${ps} lvl ${lvl}`);
  if (DRY) continue;
  const r = await call('migratePlayer', {
    player: u.evm,
    data: { tag: 'ludo', localPure: b.pure, localSpendable: b.spendable, globalPure: gp, globalLifetime: gl, globalSpendable: gs, premiumLifetime: pl, premiumSpendable: ps, level: lvl, activeUntil: until, migrationRef },
  }, OP_TOKEN);
  if (r.status === 200 && r.body && r.body.ok) { migrated++; console.log('     migrated', r.body.txHash); }
  else console.log('     FAILED', (r.body && r.body.error) || r.status);
}
console.log(`\nplanned ${planned} | migrated ${migrated} | skipped ${skipped} | total ludo pure points ${totalPoints}`);
