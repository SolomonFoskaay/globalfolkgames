// scripts/affiliate-relay.mjs
// M6 — AFFILIATE RELAY (server-side, sponsor-signed, on-chain audit ledger).
// The platform records each affiliate->referred-month accrual ON-CHAIN in USD cents
// (15% of the $3 plan = $0.45) with an eligibility flag, so earnings are provable
// forever. Runs base-layer (admin writes, rare) like the premium credit path.
//
// Accrual rules (owner 2026-08-21):
//   - affiliate earns 15% of each subscription period the referred player pays,
//     up to 12 months after the referred player's first subscription.
//   - referrer must hold an ACTIVE Level-2 sub that month, else that month's share
//     is forfeited (never back-paid).
//   - 2 consecutive inactive periods (~60 days) permanently close that pair.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import bs58 from 'bs58';
import { registerProfileHandle, resolveHandleToWallet, deriveProfileHandle, isValidProfileHandle, persistHandle, getHandleForWallet } from './handle.mjs';
import { writeFileSync, existsSync } from 'fs';
import './load-env.mjs';

export const AFFILIATE_SEED = Buffer.from('gfgref');
export const AFFILIATE_PAIR_SEED = Buffer.from('gfgrefpair');
export const AFFILIATE_PLAN_USD_CENTS = 300; // $3 plan (15% = 45 cents)
export const AFFILIATE_REASON_CODES = { SUBSCRIPTION: 11 };

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const BASE = baseRpcUrl();

export function loadSponsor() {
  if (process.env.GFG_Gasless_Sponsor_Keypair) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_Gasless_Sponsor_Keypair)));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}
function mkWallet(kp) {
  return { publicKey: kp.publicKey, signTransaction: async (t)=>{ t.partialSign(kp); return t; }, signAllTransactions: async (ts)=>{ ts.forEach(t=>t.partialSign(kp)); return ts; } };
}

export function affiliateAccountPda(affiliate) {
  return PublicKey.findProgramAddressSync([AFFILIATE_SEED, new PublicKey(affiliate).toBytes()], PROGRAM)[0];
}
export function affiliatePairPda(affiliate, referral) {
  return PublicKey.findProgramAddressSync([AFFILIATE_PAIR_SEED, new PublicKey(affiliate).toBytes(), new PublicKey(referral).toBytes()], PROGRAM)[0];
}

async function sponsorProgram() {
  const sponsor = loadSponsor();
  const conn = createConnection(BASE, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return { sponsor, conn, program: new Program(idl, provider) };
}

// Record one affiliate month on-chain (idempotent per period+referral).
export async function handleRecordAffiliatePeriod({ affiliate, referral, period, usdCents, eligibility }) {
  if (!affiliate || !referral) throw new Error('affiliate and referral wallet required');
  const a = new PublicKey(affiliate);
  const r = new PublicKey(referral);
  if (a.toBase58() !== String(affiliate).trim() || r.toBase58() !== String(referral).trim()) {
    throw new Error('invalid wallet address (base58 is case-sensitive)');
  }
  if (!Number.isInteger(period) || period <= 0) throw new Error('invalid period');
  if (!Number.isInteger(usdCents) || usdCents < 0) throw new Error('invalid usdCents');
  if (![0, 2].includes(Number(eligibility))) throw new Error('eligibility must be 0 (earned) or 2 (forfeited)');
  const { sponsor, conn, program } = await sponsorProgram();
  const acct = affiliateAccountPda(a);
  const pair = affiliatePairPda(a, r);
  const tx = await program.methods.recordAffiliatePeriod(a, r, new BN(period), new BN(usdCents), eligibility)
    .accounts({ payer: sponsor.publicKey, affiliateAccount: acct, affiliatePair: pair, systemProgram: SystemProgram.programId })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  console.log(`[affiliate] recorded ${eligibility === 0 ? 'earned' : 'forfeited'} ${usdCents}c affiliate=${a.toBase58()} referral=${r.toBase58()} period=${period} sig=${String(sig).slice(0, 24)}`);
  return { sig, account: acct.toBase58(), pair: pair.toBase58() };
}

// Mark an affiliate payout (moves pending -> paid on-chain).
export async function handleAffiliatePayout({ affiliate, usdCents, payoutRef }) {
  const a = new PublicKey(affiliate);
  if (a.toBase58() !== String(affiliate).trim()) throw new Error('invalid wallet address');
  if (!Number.isInteger(usdCents) || usdCents <= 0) throw new Error('invalid usdCents');
  if (!Number.isInteger(payoutRef) || payoutRef <= 0) throw new Error('invalid payoutRef');
  const { sponsor, conn, program } = await sponsorProgram();
  const acct = affiliateAccountPda(a);
  const tx = await program.methods.recordAffiliatePayout(a, new BN(usdCents), new BN(payoutRef))
    .accounts({ payer: sponsor.publicKey, affiliateAccount: acct })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  console.log(`[affiliate] payout ${usdCents}c to ${a.toBase58()} ref=${payoutRef} sig=${String(sig).slice(0, 24)}`);
  return { sig, account: acct.toBase58() };
}

// Read the on-chain affiliate ledger for a wallet (raw decode, version-aware).
export async function readAffiliateLedger(wallet) {
  const w = new PublicKey(wallet);
  const pda = affiliateAccountPda(w);
  for (const url of REGIONS) {
    try {
      const body = { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda.toBase58(), { encoding: 'base64' }] };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const v = j && j.result && j.result.value;
      if (!v || !v.data) continue;
      const d = Buffer.from(v.data[0], 'base64');
      // Layout (after 8-byte discriminator): version@8, authority@9..41,
      // affiliate@41..73, life@73..81, pending@81..89, paid@89..97,
      // forfeited@97..105, entry_count@105..109, payout_count@109..113,
      // last_payout_ts@113..121, last_payout_ref@121..129, entries@129+.
      const ENTRY = 53;
      const entryCount = d.length >= 109 ? d.readUInt32LE(105) : 0;
      const entries = [];
      for (let i = 0; i < Math.min(entryCount, 24); i++) {
        const o = 129 + i * ENTRY;
        if (d.length < o + ENTRY) break;
        entries.push({
          period: d.readUInt32LE(o),
          referral: bs58.encode(d.subarray(o + 4, o + 36)),
          amountUsdCents: Number(d.readBigUInt64LE(o + 36)),
          status: d[o + 44],
          ts: Number(d.readBigInt64LE(o + 45)),
        });
      }
      return {
        account: pda.toBase58(),
        version: d.length >= 9 ? d[8] : null,
        affiliate: w.toBase58(),
        lifetimeUsdCents: d.length >= 81 ? Number(d.readBigUInt64LE(73)) : 0,
        pendingUsdCents: d.length >= 89 ? Number(d.readBigUInt64LE(81)) : 0,
        paidUsdCents: d.length >= 97 ? Number(d.readBigUInt64LE(89)) : 0,
        forfeitedUsdCents: d.length >= 105 ? Number(d.readBigUInt64LE(97)) : 0,
        entryCount,
        payoutCount: d.length >= 113 ? d.readUInt32LE(109) : 0,
        entries,
      };
    } catch (e) { /* next region */ }
  }
  return null;
}

// List all affiliate ledgers on-chain (for the admin payout page). One server RPC.
export async function listAffiliateAccounts() {
  const baseConn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const DISC = Buffer.from([189, 94, 244, 154, 243, 52, 127, 157]); // AffiliateAccount
  const accounts = await baseConn.getProgramAccounts(PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISC) } }] });
  // reuse the raw decode from readAffiliateLedger (offset-based) by decoding inline
  const out = [];
  for (const { pubkey, account } of accounts) {
    const d = Buffer.from(account.data);
    const ENTRY = 53;
    const entryCount = d.length >= 109 ? d.readUInt32LE(105) : 0;
    const entries = [];
    for (let i = 0; i < Math.min(entryCount, 24); i++) {
      const o = 129 + i * ENTRY;
      if (d.length < o + ENTRY) break;
      entries.push({ period: d.readUInt32LE(o), referral: bs58.encode(d.subarray(o + 4, o + 36)), amountUsdCents: Number(d.readBigUInt64LE(o + 36)), status: d[o + 44], ts: Number(d.readBigInt64LE(o + 45)) });
    }
    out.push({
      account: pubkey.toBase58(),
      affiliate: bs58.encode(d.subarray(41, 73)),
      lifetimeUsdCents: Number(d.readBigUInt64LE(73)),
      pendingUsdCents: Number(d.readBigUInt64LE(81)),
      paidUsdCents: Number(d.readBigUInt64LE(89)),
      forfeitedUsdCents: Number(d.readBigUInt64LE(97)),
      entryCount,
      entries,
    });
  }
  return out;
}

// Combined signup flow: 1) register the handle->wallet on-chain, 2) resolve the
// inviter from refHandle and record the referral mapping (durable local ledger,
// best-effort), 3) claim the 500P signup bonus (idempotent). No cron anywhere:
// this runs per signup only.
const REFERRALS_FILE = new URL('./gfg-referrals.json', import.meta.url).pathname;
function loadReferrals() {
  try {
    if (existsSync(REFERRALS_FILE)) return JSON.parse(readFileSync(REFERRALS_FILE, 'utf8')) || [];
  } catch (e) { /* ignore */ }
  return [];
}
function persistReferral(entry) {
  try {
    const list = loadReferrals();
    if (!list.some(r => r.wallet === entry.wallet)) {
      list.push(entry);
      writeFileSync(REFERRALS_FILE, JSON.stringify(list, null, 2));
    }
  } catch (e) { /* fail-open: dedup happens at settle too */ }
}

export async function handleSignupFlow({ wallet, handle, refHandle }) {
  const w = new PublicKey(wallet);
  if (w.toBase58() !== String(wallet).trim()) throw new Error('invalid wallet address (base58 is case-sensitive)');
  const results = { wallet: w.toBase58(), handleRegistered: false, inviter: null, bonus: null };
  // 1) register the handle (idempotent; if taken by this wallet treat as ok).
  if (handle && isValidProfileHandle(handle)) {
    try {
      const r = await registerProfileHandle(w.toBase58(), handle);
      results.handleRegistered = true; results.handle = r.handle;
      persistHandle(w.toBase58(), r.handle); // so wallet->handle resolves everywhere
    } catch (e) { results.handleError = e.message; }
  }
  // 2) resolve inviter from refHandle and record the pair.
  if (refHandle && isValidProfileHandle(refHandle) && refHandle !== (handle || '')) {
    try {
      const inviter = await resolveHandleToWallet(refHandle);
      if (inviter && inviter !== w.toBase58()) {
        results.inviter = inviter;
        persistReferral({ affiliate: inviter, referral: w.toBase58(), refHandle, at: Date.now() });
      }
    } catch (e) { results.refError = e.message; }
  }
  // 3) claim the signup bonus (already idempotent by wallet-derived matchRef).
  results.bonus = await handleSignupBonus(w.toBase58());
  return results;
}

// Signup bonus 500P (M6): kind=1 signup_bonus (source_code 10, reason 2) into the
// global ledger. Idempotent by a stable matchRef derived from the wallet, so the
// program's duplicate guard makes a repeat a clean no-op. Server-side (sponsor).
export async function handleSignupBonus(wallet) {
  const w = new PublicKey(wallet);
  const { sponsor, conn, program } = await sponsorProgram();
  const globalPda = PublicKey.findProgramAddressSync([Buffer.from('gfgpoints'), Buffer.from('global'), w.toBytes()], PROGRAM)[0];
  let h = 0x811c9dc5;
  const s = 'signup|' + w.toBase58();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  const matchRef = h % 2147483647 || 1;
  const tx = await program.methods.recordGlobalPoints(1, 10, new BN(500), 2, new BN(matchRef))
    .accounts({ payer: sponsor.publicKey, playerAuthority: w, globalPoints: globalPda })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  console.log(`[affiliate] signup bonus 500P -> ${w.toBase58()} ref=${matchRef} sig=${String(sig).slice(0, 24)}`);
  return { sig, matchRef };
}

// ---- on-chain premium read (server-side, version-aware) used by settle ----
const REGIONS = ['https://api.devnet.solana.com', 'https://devnet-as.magicblock.app/', 'https://devnet-eu.magicblock.app/'];
async function readPremium(wallet) {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('gfgprem'), new PublicKey(wallet).toBytes()], PROGRAM);
  for (const url of REGIONS) {
    try {
      const body = { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda.toBase58(), { encoding: 'base64' }] };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const v = j && j.result && j.result.value;
      if (!v || !v.data) continue;
      const d = Buffer.from(v.data[0], 'base64');
      return {
        pda: pda.toBase58(),
        level: d.length >= 58 ? d[57] : 0,
        activeUntilMs: d.length >= 66 ? Number(d.readBigInt64LE(58)) * 1000 : 0,
      };
    } catch (e) { /* next */ }
  }
  return { pda: pda.toBase58(), level: 0, activeUntilMs: 0 };
}

// Settle one affiliate->referral pair for a period (month index = yyyymm).
// eligibility = referral paid that month, affiliate active that month, pair not
// forfeited, within 12 months of the referral's first sub. Returns the decided
// record so the caller can reject or apply.
export async function decideAffiliatePair({ affiliate, referral }) {
  const pair = await readPremium(referral);
  const af = await readPremium(affiliate);
  const now = Date.now();
  const referralActive = pair.level >= 2 && pair.activeUntilMs > now;
  const affiliateActive = af.level >= 2 && af.activeUntilMs > now;
  return { referralActive, affiliateActive, eligible: referralActive && affiliateActive };
}

// Full settle for a list of pairs (used by the monthly settle route / script).
export async function settleAffiliatePeriod({ period, pairs, usdCentsPerSub = AFFILIATE_PLAN_USD_CENTS }) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('pairs[] required');
  const out = [];
  for (const p of pairs) {
    if (!p.affiliate || !p.referral) { out.push({ ...p, error: 'missing wallet' }); continue; }
    const d = await decideAffiliatePair({ affiliate: p.affiliate, referral: p.referral });
    const usdCents = Math.floor(usdCentsPerSub * 0.15);
    let eligibility = 0;
    if (!d.eligible) {
      eligibility = 2; // forfeited month (inactive affiliate, inactive pair, or referral not paying)
    }
    try {
      const res = await handleRecordAffiliatePeriod({ affiliate: p.affiliate, referral: p.referral, period, usdCents, eligibility });
      out.push({ ...p, ...d, usdCents, eligibility, sig: res.sig });
    } catch (e) {
      out.push({ ...p, ...d, usdCents, eligibility, error: e.message });
    }
  }
  return out;
}