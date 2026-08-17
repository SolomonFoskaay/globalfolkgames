// scripts/er-global-points-harness.mjs
// M4 Track A — on-chain harness proving initialize_global_points,
// delegate_global_points, record_global_points (kind 0 + kind 1), and
// spend_global run gasless on the MagicBlock ER for a 0-SOL player and
// land on the correct three-track global ledger.
//
// Flow:
//   1. Generate a fresh player keypair (holds 0 SOL).
//   2. handleDelegate (idempotent) creates + delegates the GLOBAL points PDA
//      alongside the other 3 PDAs.
//   3. record_global_points kind=0 (game win) +200  -> pure=200, lifetime=200, spendable=200
//   4. record_global_points kind=1 (other/referral) +50 -> pure=200 (unchanged), lifetime=250, spendable=250
//   5. spend_global -80 -> pure=200, lifetime=250, spendable=170
//   6. Read back + assert every field.
//
// Run: node scripts/er-global-points-harness.mjs   (exit 0 = pass)

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_URL = 'https://devnet-us.magicblock.app/';
const GLOBAL_SEED = Buffer.from('global', 'utf8');
const POINTS_SEED = Buffer.from('gfgpoints', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erProgram(sponsor) {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return { program: new Program(idl, provider), conn };
}

const decodeGlobalLedger = (data) => {
  if (!data || data.length < 32) return null;
  // layout: version(1) + bump(1) + global_pure_lifetime(8) + global_lifetime(8) + global_spendable_balance(8) = 26 bytes header
  // + last_recorded_ts(8) = 34 + last_reason(1) = 35 + last_points(8) = 43 + award_count(8) = 51
  // + other_credit_count(8) = 59 + game_credit_count(8) = 67
  // + last_spend_ts(8) = 75 + last_spend_reason(1) = 76 + last_spend_points(8) = 84 + last_spend_ref(8) = 92 + spend_count(8) = 100
  return {
    version: data[0],
    globalPureLifetime: data.length >= 10 ? Number(data.readBigUInt64LE(2)) : 0,
    globalLifetime: data.length >= 18 ? Number(data.readBigUInt64LE(10)) : 0,
    globalSpendableBalance: data.length >= 26 ? Number(data.readBigUInt64LE(18)) : 0,
    lastRecordedTs: data.length >= 34 ? Number(data.readBigUInt64LE(26)) : 0,
    lastReason: data.length >= 35 ? data[34] : 0,
    lastPoints: data.length >= 43 ? Number(data.readBigUInt64LE(35)) : 0,
    awardCount: data.length >= 51 ? Number(data.readBigUInt64LE(43)) : 0,
    otherCreditCount: data.length >= 59 ? Number(data.readBigUInt64LE(51)) : 0,
    gameCreditCount: data.length >= 67 ? Number(data.readBigUInt64LE(59)) : 0,
    spendCount: data.length >= 100 ? Number(data.readBigUInt64LE(92)) : 0,
  };
};

function globalPda(playerPubkey) {
  return PublicKey.findProgramAddressSync(
    [POINTS_SEED, GLOBAL_SEED, playerPubkey.toBytes()],
    new PublicKey(idl.metadata.address),
  );
}

async function waitErPickup(pda, tries = 20, delay = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pda);
      if (info) return info;
    } catch (_) { /* warming up */ }
    await sleep(delay);
  }
  throw new Error('ER pickup timeout for global PDA');
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
  console.log(`player: ${player.publicKey.toBase58()}`);

  // Delegate creates the global points PDA alongside dice/points/result
  const { globalPointsPda } = await handleDelegate(player.publicKey.toBase58(), 'ludo');
  console.log(`globalPointsPda: ${globalPointsPda}`);

  const { program } = erProgram(sponsor);
  await waitErPickup(new PublicKey(globalPointsPda));

  const [pdaPub] = globalPda(player.publicKey);
  const read = async () => {
    const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pdaPub);
    return info ? decodeGlobalLedger(info.data) : null;
  };

  const A = await read();
  console.log('after delegate:', JSON.stringify(A));

  // Step 3: record_global kind=0 (game win) +200
  const s1 = await write(program, sponsor,
    program.methods.recordGlobalPoints(new BN(200), 0, 1, new BN(1)).accounts({
      globalPoints: pdaPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const B = await read();
  console.log(`record_global(kind=0, +200) ${s1.slice(0, 12)} -> ${JSON.stringify(B)}`);

  // Step 4: record_global kind=1 (other) +50
  const s2 = await write(program, sponsor,
    program.methods.recordGlobalPoints(new BN(50), 1, 1, new BN(2)).accounts({
      globalPoints: pdaPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const C = await read();
  console.log(`record_global(kind=1, +50)  ${s2.slice(0, 12)} -> ${JSON.stringify(C)}`);

  // Step 5: spend_global -80
  const s3 = await write(program, sponsor,
    program.methods.spendGlobal(new BN(80), 1, new BN(3)).accounts({
      globalPoints: pdaPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const D = await read();
  console.log(`spend_global(-80)           ${s3.slice(0, 12)} -> ${JSON.stringify(D)}`);

  // Step 6: assertions
  const ok =
    B !== null &&
    B.globalPureLifetime === 200 && B.globalLifetime === 200 && B.globalSpendableBalance === 200 &&
    B.gameCreditCount === 1 &&
    C.globalPureLifetime === 200 && C.globalLifetime === 250 && C.globalSpendableBalance === 250 &&
    C.otherCreditCount === 1 &&
    D.globalPureLifetime === 200 && D.globalLifetime === 250 && D.globalSpendableBalance === 170 &&
    D.spendCount === 1;
  console.log(ok ? '\nHARNESS PASS' : '\nHARNESS FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
