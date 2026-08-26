// scripts/p2c-smoke.mjs — arc2m7c: P2C bank fund + computer-loss + computer-win net math.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const AGM = Buffer.from('gfgagm');
const AGMS = Buffer.from('gfgagms');
const P2C = Buffer.from('gfgp2c');
const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(p) { p.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, await p.transaction(), [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

const GAME = 1;
const bankPda = PublicKey.findProgramAddressSync([P2C, Buffer.from([GAME])], PROGRAM)[0];
const order = async (oid) => PublicKey.findProgramAddressSync([AGM, Buffer.from([GAME]), new BN(oid).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
const settle = (oid) => PublicKey.findProgramAddressSync([AGMS, new BN(oid).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];

// fund the bank with $1,000
await send(prog.methods.p2cFund(GAME, new BN(100_000)).accounts({ signer: sponsor.publicKey, bank: bankPda, systemProgram: SystemProgram.programId }).transaction());
console.log('bank funded $1000');

async function runCase(oid, winnerSeat) {
  const ord = await order(oid), stl = await settle(oid);
  await send(prog.methods.postAgmOrder(GAME, new BN(oid), new BN(500), 2).accounts({ payer: sponsor.publicKey, order: ord, systemProgram: SystemProgram.programId }).transaction());
  const taker = Keypair.generate();
  const tw = { publicKey: taker.publicKey, signTransaction: async (t) => { t.partialSign(taker); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(taker)); return ts; } };
  const progT = new Program(idl, new AnchorProvider(conn, tw, { commitment: 'confirmed', skipPreflight: true }));
  const t1 = await progT.methods.matchAgmOrder(GAME, new BN(oid)).accounts({ signer: taker.publicKey, order: ord }).transaction();
  t1.feePayer = sponsor.publicKey;
  const s1 = await sendMagicTx(conn, t1, [sponsor, taker], { skipPreflight: true });
  await conn.confirmTransaction({ signature: s1 }, 'confirmed');
  await send(prog.methods.lockAgmMatch(GAME, new BN(oid), winnerSeat).accounts({ signer: sponsor.publicKey, order: ord, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
  await send(prog.methods.settleAgmMatch(GAME, new BN(oid)).accounts({ signer: sponsor.publicKey, order: ord }).transaction());
  // computer seat = 0 loses (winner was seat 1, human) unless winnerSeat===0
  const computerWon = winnerSeat === 0;
  await send(prog.methods.p2cSettle(GAME, new BN(oid), 0, computerWon).accounts({ signer: sponsor.publicKey, bank: bankPda, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
}

await runCase(920011, 1); // computer seat 0 loses -> bank net -500
await runCase(920012, 0); // computer seat 0 wins  -> bank net +400 (payout 900 - stake 500)
await sleep(2500);

const bd = (await conn.getAccountInfo(bankPda)).data;
const bank = {
  game: bd[9],
  balanceUsdCents: Number(bd.readBigUInt64LE(10)),
  dayNet: Number(bd.readBigInt64LE(18)),
  dayLossCap: Number(bd.readBigUInt64LE(26)),
  dayWins: bd.readUInt32LE(34),
  dayLosses: bd.readUInt32LE(38),
  totalWins: Number(bd.readBigUInt64LE(42)),
  totalLosses: Number(bd.readBigUInt64LE(50)),
  trades: Number(bd.readBigUInt64LE(58)),
  status: bd[66],
};
console.log('P2C BANK:', JSON.stringify(bank));
const pass = bank.balanceUsdCents === 100_000 - 500 + 400 && bank.dayNet === -100 && bank.dayWins === 1 && bank.dayLosses === 1 && bank.trades === 2 && bank.status === 0;
console.log('P2C BANK PASS (fund $1000, -500 loss, +400 win, dayNet -100):', pass ? 'YES' : 'NO');
process.exit(0);