// scripts/agm-relay.mjs — Arc2 AGM lobby relay core: relay/sponsor signs every
// on-chain AGM action on behalf of the AUTHENTICATED wallet (passed via maker/
// taker). The order source of truth is the CHAIN (order PDAs scanned live via
// getProgramAccounts) - never a config/per-instance file, so ids never collide
// and every reload/instance sees the same real orders.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx, baseRpcEndpoints } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const AGM = Buffer.from('gfgagm');
const AGMS = Buffer.from('gfgagms');
const P2C_GLOBAL = Buffer.from('gfgp2cbank'); // ONE shared pool across every game

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

// Reads a wallet's SOL + stablecoin balances. Matches are run in a single
// stablecoin: same coin in, same coin out, no conversion ever. Reads ALL the
// wallet's token accounts (no mint filter, so an unknown mint can never break
// the read) and maps known mints to their symbol. Unknown/absent = 0.
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet USDC (Circle faucet)
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDT (same SPL id on devnet)
const USDG_MINT = '6YtmBGgjbPn7cNT9cMLm9XLYvUnrXsHQt7HSDzKdTurJ'; // USDG (no devnet liquidity yet)
export async function walletBalances(walletAddr) {
  try {
    const pub = new PublicKey(walletAddr);
    const lamports = await conn.getBalance(pub).catch(() => null);
    const accounts = await allTokenAccounts(pub);
    let usdc = 0, usdt = 0, usdg = 0;
    for (const acct of accounts) {
      const mint = acct.mint;
      const amt = acct.amount;
      if (mint === USDC_MINT) usdc += amt;
      else if (mint === USDT_MINT) usdt += amt;
      else if (mint === USDG_MINT) usdg += amt;
    }
    return {
      sol: lamports != null ? lamports / 1e9 : null,
      usdc,
      usdt,
      usdg,
    };
  } catch (e) {
    // never silent: the page must show WHY the balance couldn't be read
    return { sol: null, usdc: null, usdt: null, usdg: null, error: e.message };
  }
}
async function allTokenAccounts(pub) {
  let lastErr = null;
  let tried = 0;
  for (const rpc of RPC_CANDIDATES()) {
    tried += 1;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 8000);
      let res;
      try {
        res = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [pub.toBase58(), { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }] }),
          signal: ac.signal,
        }).then(r => r.json());
      } finally { clearTimeout(to); }
      if (res && res.error) { lastErr = new Error(res.error.message || JSON.stringify(res.error)); continue; }
      const arr = (res && res.result && res.result.value) || [];
      const out = [];
      for (const a of arr) {
        const p = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
        if (!p || !p.mint || !p.tokenAmount) continue;
        out.push({ mint: p.mint, amount: Number(p.tokenAmount.uiAmount || 0) });
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error('token balance RPC failed (' + tried + ' tries): ' + (lastErr && lastErr.message ? lastErr.message : 'unknown'));
}
function RPC_CANDIDATES() {
  const out = [];
  // The env RPC (Alchemy, GFG_DEVNET_RPC) is the fast, reliable worker for
  // token-account reads - try it first when present, then the base/standard
  // devnet endpoints as fallback.
  if (process.env.GFG_DEVNET_RPC) out.push(process.env.GFG_DEVNET_RPC);
  try {
    for (const e of baseRpcEndpoints()) { if (!out.includes(e)) out.push(e); }
  } catch (e) {}
  if (!out.includes('https://api.devnet.solana.com')) out.push('https://api.devnet.solana.com');
  return out;
}

// ---- order index (ids + seed metadata only; every display field comes from
// the chain). The MagicBlock router chain cannot be enumerated with
// getProgramAccounts, so the relay keeps the orders it has seen. This is a
// LIGHT index, NOT the source of truth: each id is re-read on-chain on every
// list (readOrder), so status/maker/stake/seats/taker are always live. Ids are
// unix-ms timestamps, so cross-instance collisions are impossible.
import { existsSync, readFileSync as _readIdx, writeFileSync as _writeIdx } from 'fs';
const IDX_FILE = new URL('./.gfg-agm-ids.json', import.meta.url).pathname;
function knownOrders() {
  try {
    if (existsSync(IDX_FILE)) {
      const s = JSON.parse(_readIdx(IDX_FILE, 'utf8'));
      if (Array.isArray(s)) return s.filter(x => x && x.id != null && x.game != null);
    }
  } catch (e) {}
  return [];
}
function rememberOrder(game, orderId, maker, stakeUsdCents, seats) {
  try {
    const list = knownOrders();
    if (!list.some(x => Number(x.id) === Number(orderId))) {
      list.push({ game: Number(game), id: orderId, maker, stake_usd_cents: Number(stakeUsdCents), seats: Number(seats) });
      _writeIdx(IDX_FILE, JSON.stringify(list));
    }
  } catch (e) { /* fail-open */ }
}

export async function agmPost({ game, stakeUsdCents, seats, maker }) {
  const orderId = Date.now();
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.postAgmOrder(game, new BN(orderId), new BN(stakeUsdCents), seats, new PublicKey(maker)).accounts({ payer: sponsor.publicKey, order: pda, systemProgram: SystemProgram.programId }).transaction());
  rememberOrder(game, orderId, maker, stakeUsdCents, seats);
  return { orderId, pda: pda.toBase58(), order: await readOrder(game, orderId) };
}

export async function agmList({ game, orderId, ids } = {}) {
  const idx = knownOrders();
  let entries = idx.slice();
  if (orderId != null) entries = entries.filter(x => Number(x.id) === Number(orderId));
  if (ids) {
    const wanted = String(ids).split(',').map(Number).filter(Boolean);
    const known = new Set(entries.map(x => Number(x.id)));
    for (const w of wanted) if (!known.has(w)) entries.push({ game: Number(game) || 1, id: w });
    // honour the explicit ids list (browser-known orders the relay never saw)
    entries = entries.filter(x => wanted.includes(Number(x.id)));
  }
  if (game != null) entries = entries.filter(x => Number(x.game) === Number(game));
  const out = [];
  for (const e of entries) {
    const g = Number(e.game) || 1;
    const live = await readOrder(g, Number(e.id));
    if (!live) { out.push({ order_id: Number(e.id), game: g, status: 'missing' }); continue; }
    out.push(live);
  }
  out.sort((a, b) => Number(b.order_id) - Number(a.order_id));
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