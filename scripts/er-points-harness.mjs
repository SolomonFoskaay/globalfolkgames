// scripts/er-points-harness.mjs
// M3 — on-chain harness proving record_points + spend_local run gasless on the
// MagicBlock ER for a 0-SOL player (sponsor signs, mirroring the client's
// session-key write path) and land on the correct two-track ledger.
//
// Flow:
//   1. Generate a fresh player keypair (holds 0 SOL, like every real player).
//   2. handleDelegate (idempotent) creates + delegates the tagged points PDA.
//   3. record_points +150 twice  -> pure=300, spendable=300, award_count=2.
//   4. spend_local 40            -> spendable=260, pure=300 (unchanged).
//   5. Read back + assert every field from the ER-hosted copy.

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, pickErRpcUrl } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_URL = pickErRpcUrl();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erProgram(sponsor) {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return { program: new Program(idl, provider), conn };
}

const decodeLedger = (data) => ({
  pure: data.length >= 16 ? Number(data.readBigUInt64LE(8)) : 0,
  spendable: data.length >= 24 ? Number(data.readBigUInt64LE(16)) : 0,
  last_points: data.length >= 32 ? Number(data.readBigUInt64LE(24)) : 0,
  reason: data.length >= 33 ? data[32] : 0,
  award_count: data.length >= 57 ? Number(data.readBigUInt64LE(49)) : 0,
});

async function waitErPickup(pda, tries = 20, delay = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pda);
      if (info) return info;
    } catch (_) { /* warming up */ }
    await sleep(delay);
  }
  throw new Error('ER pickup timeout');
}

async function write(program, sponsor, build) {
  const tx = await build;
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(program.provider.connection, tx, [sponsor], { skipPreflight: true });
  await program.provider.connection.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

async function main() {
  const sponsor = loadSponsor();
  const player = Keypair.generate();
  console.log(`player: ${player.publicKey.toBase58()} (balance: ${await createConnection(baseRpcUrl()).getBalance(player.publicKey)} lamports — expect 0)`);

  const { pointsPda } = await handleDelegate(player.publicKey.toBase58(), 'ludo');
  console.log(`pointsPda: ${pointsPda}`);

  const { program } = erProgram(sponsor);
  await waitErPickup(new PublicKey(pointsPda));

  const read = async () => decodeLedger((await new Connection(ER_URL, 'confirmed').getAccountInfo(new PublicKey(pointsPda))).data);

  const A = await read();
  console.log('after delegate:', JSON.stringify(A));

  const s1 = await write(program, sponsor,
    program.methods.recordPoints('ludo', new BN(150), 1, new BN(1)).accounts({
      points: new PublicKey(pointsPda), payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const B = await read();
  console.log(`record_points(+150) ${s1.slice(0, 12)} -> ${JSON.stringify(B)}`);

  const s2 = await write(program, sponsor,
    program.methods.recordPoints('ludo', new BN(150), 1, new BN(2)).accounts({
      points: new PublicKey(pointsPda), payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const C = await read();
  console.log(`record_points(+150) ${s2.slice(0, 12)} -> ${JSON.stringify(C)}`);

  const s3 = await write(program, sponsor,
    program.methods.spendLocal('ludo', new BN(40), 5, new BN(7)).accounts({
      points: new PublicKey(pointsPda), payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const D = await read();
  console.log(`spend_local(-40)   ${s3.slice(0, 12)} -> ${JSON.stringify(D)}`);

  const ok =
    B.pure === 150 && B.spendable === 150 && B.award_count === 1 &&
    C.pure === 300 && C.spendable === 300 && C.award_count === 2 &&
    D.pure === 300 && D.spendable === 260 && D.award_count === 2;
  console.log(ok ? '\nHARNESS PASS' : '\nHARNESS FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
