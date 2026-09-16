// scripts/lives-charge-smoke.mjs
// Verify M10 lives are charged AT GAME START: read the host's lives ledger,
// create + START a chess match, then read again and confirm `used` went up by 1
// (and that finishing/abandoning is no longer what charges it).
//
// Run: node scripts/lives-charge-smoke.mjs

import './load-env.mjs';
import { PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { chessCreate, chessPda } from './chess-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const LIVES_SEED = Buffer.from('gfglives');
const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastRef = 0;

function livesPda(k) { return PublicKey.findProgramAddressSync([LIVES_SEED, k.toBytes()], PROGRAM)[0]; }
async function regionUrl(pda) {
  try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {}
  return pickErRpcUrl();
}
async function readUsed(pubkey) {
  const pda = livesPda(pubkey);
  const url = await regionUrl(pda);
  const c = createConnection(url, 'confirmed', 8000);
  let info = await c.getAccountInfo(pda).catch(() => null);
  if (!info) info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  const d = info.data;
  return { day: Number(d.readBigInt64LE(8 + 1 + 32)), used: d.readUInt16LE(8 + 1 + 32 + 8), pool: d.readUInt16LE(8 + 1 + 32 + 8 + 2), awardCount: Number(d.readBigUInt64LE(8 + 1 + 32 + 8 + 2 + 2 + 8 + 8)) };
}
async function waitDelegated(pda, t) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {} await sleep(700); }
  return false;
}
async function erSend(buildTx) {
  const pda = chessPda(lastRef);
  const url = await regionUrl(pda);
  const c = createConnection(url, 'confirmed', 9000);
  const bh = await c.getLatestBlockhash('confirmed');
  const tx = await buildTx();
  tx.feePayer = sponsor.publicKey;
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.partialSign(sponsor);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await c.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

async function main() {
  const host = sponsor.publicKey;
  lastRef = Date.now();
  console.log('[lives] host =', host.toBase58());

  const before = await readUsed(host);
  console.log('[1/4] lives BEFORE start:', JSON.stringify(before));
  if (!before) throw new Error('no lives ledger for host');

  console.log('[2/4] create + delegate chess board...');
  const c = await chessCreate({ matchRef: lastRef, host: host.toBase58(), timeMs: 600000, incrementMs: 0, solo: 1 });
  if (!c.ok) throw new Error(c.error);
  const pda = chessPda(lastRef);
  if (!await waitDelegated(pda, 20000)) throw new Error('board did not delegate');

  const mid = await readUsed(host);
  console.log('[3/4] lives BEFORE start:', JSON.stringify(mid), '(should equal BEFORE: create does not charge)');

  console.log('[4/4] START the match (should charge 1 life)...');
  await erSend(() => prog.methods.startChessMatch(new BN(lastRef)).accounts({ signer: host, board: pda, lives: livesPda(host) }).transaction());

  const after = await readUsed(host);
  console.log('      lives AFTER start:', JSON.stringify(after));

  const charged = after && before && after.used === before.used + 1;
  const createFree = mid && before && mid.used === before.used;
  if (charged && createFree) console.log('[lives-charge-smoke] PASS: life charged at START, not at create');
  else { console.log('[lives-charge-smoke] FAIL charged=' + charged + ' createFree=' + createFree); process.exit(1); }
}
main().catch(e => { console.error('[lives-charge-smoke] FAIL:', e.message); process.exit(1); });
