// src/gfg-pay.js — AUTOMATED USDC PAYMENT + BALANCE PRE-CHECK (browser).
//
// HOW IT WORKS (plain words):
//   The player pays USDC from their own embedded wallet to the platform's
//   USDC address. This is a REAL payment on the base Solana network - it is
//   NOT the gasless MagicBlock ER (the roll that free game moves use). That is
//   deliberate: a payment must be provable on the base chain so nobody can
//   claim a refund or fake a payment, and so the server can independently
//   verify it before crediting points. The player signs it with their Dynamic
//   session key (may prompt an email) and pays a tiny network fee from their
//   SOL - only a fraction of a cent on devnet/mainnet.
//
//   Because the whole point is anti-abuse, the app PRE-CHECKS the wallet
//   balance before enabling the Pay button: it needs enough SOL (for the fee)
//   AND enough USDC (for the plan). If either is missing the button stays off
//   and says why - so most taps that do happen succeed cleanly.
//
//   After the transfer, the signature goes to /api/verify-and-credit, which
//   re-reads the tx on-chain, checks sender = this wallet, destination = the
//   treasury, USDC mint, amount, and freshness - and ONLY then credits the
//   premium points (sponsor-signed, gasless on the ER). Failures never credit.
//
// Exposes window.gfgPay = {
//   connectedWallet(), balances(), enoughFor(planKey), pay(planKey),
//   payAndVerify(planKey), verify(planKey, txSignature), plans(), lastTx(), saveTx()
// }.

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getWalletAccounts } from '@dynamic-labs-sdk/client';
import { signTransaction } from '@dynamic-labs-sdk/solana';

// PAY cluster RPC = the REAL base devnet (not the MagicBlock router, which
// can't serve getTokenAccountsByOwner/getTransaction). Swap to a mainnet RPC
// next to the config swap.
const PAY_RPC = 'https://api.devnet.solana.com';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet (swap with mainnet USDC)
const USDC_DECIMALS = 6;
const TREASURY = '5ec9bYwVJVSfM3xnrzpg9jkoepX58pY1tWoGDsMdhdTQ'; // platform USDC receiver
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SOL_FEE_LAMPORTS = 10000; // ~0.00001 SOL reserve for the transfer fee (devnet/mainnet tiny)

// Plan price mapper (mirrors scripts/pay-config.mjs PAY_PLANS).
const PAY_PLANS = {
  l1: { points: 5000,  usdCents: 500,  kind: 'plan',    label: 'Level 1' },
  l2: { points: 10000, usdCents: 1000, kind: 'plan',    label: 'Level 2' },
  l3: { points: 15000, usdCents: 1500, kind: 'plan',    label: 'Level 3' },
  b24: { points: 500,   usdCents: 100,  kind: 'booster', label: '24h Unlimited Lives' },
  b72: { points: 1500,  usdCents: 200,  kind: 'booster', label: '72h Unlimited Lives' },
};

let connCache = null;
function payConnection() {
  if (!connCache) connCache = new Connection(PAY_RPC, 'confirmed');
  return connCache;
}

function walletAccount() {
  try {
    const client = window.dynamicClient;
    if (!client) return null;
    const accounts = getWalletAccounts(client);
    const sol = accounts.find((w) => w.chain === 'SOL' && w.address);
    return sol ? { walletAccount: sol, publicKey: new PublicKey(sol.address) } : null;
  } catch (e) {
    console.warn('[gfg-pay] could not read wallet account', e);
    return null;
  }
}

function connectedWallet() {
  const w = walletAccount();
  return w ? w.publicKey.toBase58() : null;
}

function usdcAta(ownerKey) {
  return PublicKey.findProgramAddressSync(
    [ownerKey.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID.toBase58()).toBuffer(), new PublicKey(USDC_MINT).toBuffer()],
    new PublicKey(ATA_PROGRAM)
  )[0];
}

// Read SOL + USDC balances of the embedded wallet. Pure reads, no signing.
export async function balances() {
  const  wallet = walletAccount();
  if (!wallet) return { sol: null, usdc: null, ata: null };
  const conn = payConnection();
  let sol = null, usdc = null, ataAddr = null;
  try {
    const bal = await conn.getBalance(wallet.publicKey, 'confirmed');
    sol = bal; // lamports
  } catch (e) { sol = null; }
  const ata = usdcAta(wallet.publicKey);
  ataAddr = ata.toBase58();
  try {
    const acct = await getAccount(conn, ata, 'confirmed', TOKEN_PROGRAM_ID);
    usdc = Number(acct.amount);
  } catch (e) { usdc = 0; } // no USDC ATA yet => 0
  return { sol, usdc, ata: ataAddr, solLamports: sol };
}

// Does the wallet have enough for a given plan? Returns { ok, missing }.
export async function enoughFor(planKey) {
  const plan = PAY_PLANS[planKey];
  if (!plan) return { ok: false, missing: [], reason: 'unknown plan' };
  const b = await balances();
  const issues = [];
  if (b.sol != null && b.sol < SOL_FEE_LAMPORTS) issues.push('sol');
  const needUsdc = Math.round(plan.usdCents * 10000);
  if (b.usdc != null && b.usdc < needUsdc) issues.push('usdc');
  return {
    ok: issues.length === 0,
    missing: issues,
    sol: b.sol, usdc: b.usdc,
    needUsdc, feeLamports: SOL_FEE_LAMPORTS,
    planLabel: plan.label,
  };
}

async function signWithDynamic(tx) {
  const w = walletAccount();
  if (!w) throw new Error('no embedded wallet connected');
  const { signedTransaction } = await signTransaction({ transaction: tx, walletAccount: w.walletAccount });
  return signedTransaction;
}

export async function pay(planKey) {
  const plan = PAY_PLANS[planKey];
  if (!plan) throw new Error('unknown plan "' + planKey + '"');
  const wallet = walletAccount();
  if (!wallet) throw new Error('no embedded wallet connected - sign in first');
  const conn = payConnection();

  const ata = usdcAta(wallet.publicKey);
  const treasuryAta = usdcAta(new PublicKey(TREASURY));

  // Confirm the ATA exists; if not, create it in the same tx.
  let ataExists = false;
  try { await getAccount(conn, ata, 'confirmed', TOKEN_PROGRAM_ID); ataExists = true; } catch (e) { ataExists = false; }

  // The treasury (platform) ATA must exist for the transfer to land. It is
  // created by the platform sponsor; if it is somehow missing (fresh cluster
  // swap before warm-up), fail clearly instead of an opaque InvalidAccountData.
  let treasuryExists = false;
  try { await getAccount(conn, treasuryAta, 'confirmed', TOKEN_PROGRAM_ID); treasuryExists = true; } catch (e) { treasuryExists = false; }
  if (!treasuryExists) {
    throw new Error('the platform payment wallet is still being prepared. Try again in a minute, or use the manual form so support can credit you.');
  }

  const amountBase = BigInt(Math.round(plan.usdCents * 10000));
  const tx = new Transaction();

  if (!ataExists) {
    tx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, // payer
      ata,              // associated token account
      wallet.publicKey, // owner
      new PublicKey(USDC_MINT),
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }
  tx.add(
    createTransferCheckedInstruction(
      ata, new PublicKey(USDC_MINT), treasuryAta, wallet.publicKey,
      amountBase, USDC_DECIMALS
    )
  );
  tx.feePayer = wallet.publicKey;
  const bh = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = bh.blockhash;

  const signed = await signWithDynamic(tx);
  const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  let failedOnChain = false;
  try {
    const conf = await conn.confirmTransaction(signature, 'confirmed');
    if (conf && conf.value && conf.value.err) failedOnChain = true;
  } catch (e) {
    failedOnChain = true;
  }
  // ALWAYS record the signature so the user can find/report it later, even if
  // the transfer failed on-chain (support can read it on the explorer).
  saveTx({ plan: planKey, signature, at: Date.now(), points: plan.points, kind: plan.kind, failed: failedOnChain });
  if (failedOnChain) {
    throw new Error('the transfer was sent but failed on-chain. Your signature: ' + signature + '. Use the manual form (or Verify payment + credit) with this signature so support can help.');
  }
  return { signature, amountBase: amountBase.toString(), plan: planKey, points: plan.points };
}

export async function verify(planKey, txSignature) {
  const wallet = connectedWallet();
  const res = await fetch('/api/verify-and-credit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: wallet, plan: planKey, txSignature }),
  });
  const data = await res.json().catch(() => ({ error: 'bad response' }));
  if (!res.ok || !data.ok) throw new Error(data.error || 'verification failed');
  return data;
}

export async function payAndVerify(planKey) {
  const { signature } = await pay(planKey);
  return verify(planKey, signature);
}

export function plans() {
  return Object.keys(PAY_PLANS).map((k) => ({ key: k, ...PAY_PLANS[k] }));
}

// Keep the last ~10 payment signatures locally so a user can find their tx
// later (support reach-out, explorer lookup) without scrolling history.
const LAST_TX_KEY = 'gfg_pay_last_tx_v1';
export function saveTx(entry) {
  try {
    const key = connectedWallet() || 'anon';
    const store = JSON.parse(localStorage.getItem(LAST_TX_KEY) || '{}') || {};
    const arr = Array.isArray(store[key]) ? store[key] : [];
    arr.unshift(entry);
    store[key] = arr.slice(0, 10);
    localStorage.setItem(LAST_TX_KEY, JSON.stringify(store));
  } catch (e) { /* ignore */ }
}
export function lastTx() {
  try {
    const key = connectedWallet() || 'anon';
    const store = JSON.parse(localStorage.getItem(LAST_TX_KEY) || '{}') || {};
    return Array.isArray(store[key]) ? store[key] : [];
  } catch (e) { return []; }
}

export function initGfgPay() {
  window.gfgPay = { pay, verify, payAndVerify, plans, connectedWallet, balances, enoughFor, lastTx, saveTx };
}