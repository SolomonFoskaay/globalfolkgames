// scripts/agm-relay.mjs — Arc2 AGM lobby relay core: relay/sponsor signs every
// on-chain AGM action on behalf of the AUTHENTICATED wallet (passed via maker/
// taker). An order registry file keeps the lobby listable (order PDAs are not
// enumerable); statuses are always read live from chain.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const AGM = Buffer.from('gfgagm');
const AGMS = Buffer.from('gfgagms');
const P2C_GLOBAL = Buffer.from('gfgp2cbank'); // ONE shared pool across every game
const REG_FILE = new URL('./.gfg-agm-registry.json', import.meta.url).pathname;

const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));

export function orderPda(game, orderId) {
  return PublicKey.findProgramAddressSync([AGM, Buffer.from([game]), new BN(orderId).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}
export function settlementPda(orderId) {
  return PublicKey.findProgramAddressSync([AGMS, new BN(orderId).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}
export function bankPda(_gameIgnored) {
  return PublicKey.findProgramAddressSync([P2C_GLOBAL], PROGRAM)[0]; // shared: all games use the same pool
}

// Durable registry so the lobby can list open orders across reloads. On Vercel
// the fs is per-instance; devnet accepted (same as the spend ledger).
function readRegistry() {
  try { if (existsSync(REG_FILE)) return JSON.parse(readFileSync(REG_FILE, 'utf8')) || []; } catch (e) {}
  return [];
}
function writeRegistry(list) {
  try { writeFileSync(REG_FILE, JSON.stringify(list, null, 2)); } catch (e) { /* fail-open */ }
}
function nextOrderId() {
  let n = 900000;
  for (const o of readRegistry()) n = Math.max(n, Number(o.order_id) || 0);
  return n + 1;
}

async function sendTx(tx, extraSigners = []) {
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor, ...extraSigners], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

async function readOrder(game, orderId) {
  const pda = orderPda(game, orderId);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  const d = info.data;
  const version = d[8];
  const order_id = Number(d.readBigUInt64LE(9));
  const game_ = d[17];
  const maker = d.subarray(18, 50);
  const stake = Number(d.readBigUInt64LE(50));
  const seats = d[58];
  const status = d[59];
  const taker = d.subarray(60, 92);
  const created_at = Number(d.readBigInt64LE(92));
  return { version, order_id, game: game_, maker: new PublicKey(maker).toBase58(), stake_usd_cents: stake, seats, status, taker: new PublicKey(taker).toBase58(), created_at };
}

async function readBank(game) {
  const pda = bankPda(game);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  try { return await prog.account.p2cBank.fetch(pda); } catch (e) { return null; }
}

function sign(extra) { return { publicKey: extra.publicKey, signTransaction: async (t) => { t.partialSign(extra); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(extra)); return ts; } }; }

// ---- actions (relay sponsor signs; maker/taker = the authenticated wallet) ----
export async function agmPost({ game, stakeUsdCents, seats, maker }) {
  const orderId = nextOrderId();
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.postAgmOrder(game, new BN(orderId), new BN(stakeUsdCents), seats, new PublicKey(maker)).accounts({ payer: sponsor.publicKey, order: pda, systemProgram: SystemProgram.programId }).transaction());
  const list = readRegistry();
  list.push({ order_id: orderId, game, maker, stake_usd_cents: stakeUsdCents, seats, status: 0, created_at: Date.now() });
  writeRegistry(list);
  return { orderId, pda: pda.toBase58(), order: await readOrder(game, orderId) };
}

export async function agmList({ game, orderId } = {}) {
  const orders = readRegistry().filter((o) => (game == null || Number(o.game) === Number(game)) && (orderId == null || Number(o.order_id) === Number(orderId)));
  const out = [];
  for (const o of orders) {
    const live = await readOrder(Number(o.game), Number(o.order_id));
    out.push({ ...o, ...(live || {}), status: live ? live.status : 'missing' });
  }
  out.sort((a, b) => b.order_id - a.order_id);
  return { count: out.length, orders: out };
}

export async function agmMatch({ game, orderId, taker }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  if (order.status !== 0) throw new Error('order is no longer open (status ' + order.status + ')');
  if (taker === 'guest' || !taker) taker = Keypair.generate().publicKey.toBase58(); // relay generates a real next-wallet
  if (taker === order.maker) throw new Error('a wallet cannot match its own order');
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.matchAgmOrder(game, new BN(orderId), new PublicKey(taker)).accounts({ signer: sponsor.publicKey, order: pda }).transaction());
  const list = readRegistry();
  const o = list.find((x) => Number(x.order_id) === Number(orderId));
  if (o) { o.status = 2; o.taker = taker; writeRegistry(list); }
  return { order: await readOrder(game, orderId) };
}

export async function agmLock({ game, orderId, winnerSeat }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  if (order.status !== 2) throw new Error('order must be matched before lock (status ' + order.status + ')');
  const pda = orderPda(game, orderId);
  const stl = settlementPda(orderId);
  await sendTx(await prog.methods.lockAgmMatch(game, new BN(orderId), winnerSeat).accounts({ signer: sponsor.publicKey, order: pda, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
  return { order: await readOrder(game, orderId), pot_usd_cents: Number(order.stake_usd_cents) * Number(order.seats) };
}

export async function agmSettle({ game, orderId }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.settleAgmMatch(game, new BN(orderId)).accounts({ signer: sponsor.publicKey, order: pda }).transaction());
  return { order: await readOrder(game, orderId) };
}

export async function agmCancel({ game, orderId, maker }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  if (order.maker !== maker) throw new Error('only the maker can cancel');
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.cancelAgmOrder(game, new BN(orderId)).accounts({ signer: sponsor.publicKey, order: pda }).transaction());
  return { order: await readOrder(game, orderId) };
}

export async function agmP2cFund({ game, amountUsdCents }) {
  const pda = bankPda(game);
  const bank = await readBank(game);
  if (!bank) await sendTx(await prog.methods.p2cFund(game, new BN(amountUsdCents)).accounts({ signer: sponsor.publicKey, bank: pda, systemProgram: SystemProgram.programId }).transaction());
  else await sendTx(await prog.methods.p2cFund(game, new BN(amountUsdCents)).accounts({ signer: sponsor.publicKey, bank: pda, systemProgram: SystemProgram.programId }).transaction());
  return { bank: await readBank(game) };
}

export async function agmP2cSettle({ game, orderId, computerSeat, computerWon }) {
  const stl = settlementPda(orderId);
  const pda = bankPda(game);
  await sendTx(await prog.methods.p2cSettle(game, new BN(orderId), computerSeat, !!computerWon).accounts({ signer: sponsor.publicKey, bank: pda, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
  return { bank: await readBank(game) };
}

export async function agmBank({ game }) {
  return { bank: await readBank(game) };
}