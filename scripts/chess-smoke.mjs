// scripts/chess-smoke.mjs
// End-to-end smoke test for the on-chain chess single-player path.
// Uses the sponsor key as the host so it can be run by the operator:
//   onboard (all PDAs incl. lives) -> create+delegate board -> start ->
//   white move -> house AI reply -> read state -> commit+undelegate.
//
// Run: node scripts/chess-smoke.mjs

import './load-env.mjs';
import { PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor, handleDelegate } from './delegate-relay.mjs';
import { chessCreate, chessAiMove, chessState, chessPda } from './chess-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function erUrl(pda) {
  try {
    const st = await getDelegationStatus(conn, pda);
    if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; }
  } catch (e) { /* fall through */ }
  return pickErRpcUrl();
}

async function waitDelegated(pda, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await getDelegationStatus(conn, pda);
      if (st && st.isDelegated) return true;
    } catch (e) { /* keep */ }
    await sleep(700);
  }
  return false;
}

async function erSend(buildTx) {
  const pda = chessPda(lastRef);
  const url = await erUrl(pda);
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

let lastRef = 0;

async function main() {
  const host = sponsor.publicKey;
  lastRef = Date.now();
  console.log('[chess-smoke] host =', host.toBase58(), 'matchRef =', lastRef);

  console.log('[1/6] onboarding host PDAs (dice/points/result/global/premium/lives)...');
  const onboard = await handleDelegate(host.toBase58(), 'ludo');
  console.log('      onboarding steps:', (onboard.steps || []).map(s => s.step).join(', ') || 'already delegated');

  console.log('[2/6] create + delegate chess board (relay pays)...');
  const created = await chessCreate({ matchRef: lastRef, host: host.toBase58(), timeMs: 600000, incrementMs: 0 });
  console.log('      create:', JSON.stringify(created));
  if (!created.ok) throw new Error(created.error || 'create failed');

  const pda = chessPda(lastRef);
  const ok = await waitDelegated(pda, 20000);
  console.log('      delegated:', ok);
  if (!ok) throw new Error('board did not delegate');

  console.log('[3/6] start chess match (host signs on ER)...');
  const startSig = await erSend(() => prog.methods.startChessMatch(new BN(lastRef))
    .accounts({ signer: host, board: pda }).transaction());
  console.log('      start sig:', startSig);

  let s = await chessState({ matchRef: lastRef });
  console.log('      status:', s.status, 'sideToMove:', s.sideToMove);

  console.log('[4/6] white move e2-e4 (host signs on ER)...');
  const moveSig = await erSend(() => prog.methods.makeChessMove(new BN(lastRef), 12, 28, 0)
    .accounts({ signer: host, board: pda }).transaction());
  console.log('      move sig:', moveSig);

  console.log('[5/6] house AI reply (black)...');
  const ai = await chessAiMove({ matchRef: lastRef, level: 1 });
  console.log('      ai:', JSON.stringify(ai));

  s = await chessState({ matchRef: lastRef });
  console.log('      after: sideToMove:', s.sideToMove, 'moveCount:', s.moveCount, 'whiteClockMs:', s.clockMs[0], 'aiClockMs:', s.clockMs[1]);
  console.log('      e4 pawn at 28?', s.position[28], 'black reply moved something:', s.moveCount >= 2);

  console.log('[6/6] commit + undelegate board (relay)...');
  const und = await erSend(() => prog.methods.undelegateChessBoard(new BN(lastRef))
    .accounts({ payer: sponsor.publicKey, board: pda, magicProgram: new PublicKey('Magic11111111111111111111111111111111111111'), magicContext: new PublicKey('MagicContext1111111111111111111111111111111') }).transaction());
  console.log('      undelegate sig:', und);

  const after = await chessState({ matchRef: lastRef });
  console.log('[done] final status:', after.status, 'moveCount:', after.moveCount);
  console.log('[chess-smoke] PASS');
}

main().catch(e => { console.error('[chess-smoke] FAIL:', e.message); process.exit(1); });
