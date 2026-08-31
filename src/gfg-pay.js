// src/gfg-pay.js — AUTOMATED USDC PAYMENT (browser side, owner 2026-08-31).
//
// After the player funds their embedded Dynamic wallet (SOL + USDC per the
// crypto guide), this module lets them pay from THAT wallet on the site: it
// builds a USDC SPL transfer from the player's ATA to the platform treasury,
// signs it with the Dynamic session key, sends it to the pay cluster (base
// devnet now / mainnet after the one-line swap in scripts/pay-config.mjs), and
// returns the transaction signature. The player pays the tiny network fee for
// this transfer (it's a payment, not a sponsored game move).
//
// The signature is then submitted to /api/verify-and-credit, which
// independently re-reads the tx, checks amount/mint/sender/freshness, and only
// then credits the premium points (sponsor-signed, gasless ER). Paying from
// the embedded wallet means only the paying wallet gets the points.
//
// Exposes window.gfgPay = { pay(planKey), verify(planKey, txSignature),
//                           plans(), connectedWallet() }.

import { Connection, PublicKey, Transaction, SystemProgram, Keypair } from '@solana/web3.js';
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
import { baseRpcEndpoints } from './gfg-rpc.js';

const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet (swap with mainnet mint next to config swap)
const USDC_DECIMALS = 6;
const TREASURY = '5ec9bYwVJVSfM3xnrzpg9jkoepX58pY1tWoGDsMdhdTQ'; // platform USDC receiver (devnet sponsor; mainnet env treasury)

// Plan price mapper (mirrors scripts/pay-config.mjs PAY_PLANS). Kept in sync
// with the ladder; the SERVER is the authority on points, this is only used to
// build the transfer amount and show the price.
const PAY_PLANS = {
  l1: { points: 5000,  usdCents: 500,  kind: 'plan',    label: 'Level 1' },
  l2: { points: 10000, usdCents: 1000, kind: 'plan',    label: 'Level 2' },
  l3: { points: 15000, usdCents: 1500, kind: 'plan',    label: 'Level 3' },
  b24: { points: 500,   usdCents: 100,  kind: 'booster', label: '24h Unlimited Lives' },
  b72: { points: 1500,  usdCents: 200,  kind: 'booster', label: '72h Unlimited Lives' },
};

let connCache = null;
function payConnection() {
  if (!connCache) connCache = new Connection(baseRpcEndpoints()[0], 'confirmed');
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

async function playerAtaInfo(wallet) {
  const conn = payConnection();
  const mint = new PublicKey(USDC_MINT);
  const ata = await getAssociatedTokenAddress(
    mint,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  let account = null;
  try { account = await getAccount(conn, ata, 'confirmed', TOKEN_PROGRAM_ID); } catch (e) { account = null; }
  return { ata, exists: !!account };
}

async function signWithDynamic(tx) {
  const w = walletAccount();
  if (!w) throw new Error('no embedded wallet connected');
  const { signedTransaction } = await signTransaction({ transaction: tx, walletAccount: w.walletAccount });
  return signedTransaction;
}

// Build + sign + send the USDC transfer. Returns { signature, amountBase }.
// The player's ATA is created on-demand if missing (tiny rent, paid by them).
// Sends on the PAY cluster (base devnet), NOT the ER (payments aren't gasless).
export async function pay(planKey) {
  const plan = PAY_PLANS[planKey];
  if (!plan) throw new Error('unknown plan "' + planKey + '"');
  const wallet = walletAccount();
  if (!wallet) throw new Error('no embedded wallet connected - sign in first');
  const conn = payConnection();

  const { ata, exists } = await playerAtaInfo(wallet);
  const treasury = new PublicKey(TREASURY);
  const treasuryAta = await getAssociatedTokenAddress(
    new PublicKey(USDC_MINT),
    treasury,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const amountBase = BigInt(Math.round(plan.usdCents * 10000));
  const tx = new Transaction();

  if (!exists) {
    // Create the player's USDC ATA (payer = player, pays the tiny rent).
    tx.add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, // payer
        ata,              // ata
        wallet.publicKey, // owner
        new PublicKey(USDC_MINT),
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  tx.add(
    createTransferCheckedInstruction(
      ata,
      new PublicKey(USDC_MINT),
      treasuryAta,
      wallet.publicKey,
      amountBase,
      USDC_DECIMALS
    )
  );
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

  const signed = await signWithDynamic(tx);
  const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(signature, 'confirmed');
  return { signature, amountBase: amountBase.toString(), plan: planKey, points: plan.points };
}

// Submit a payment signature to the server for verification + credit.
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

export function plans() {
  return Object.keys(PAY_PLANS).map((k) => ({ key: k, ...PAY_PLANS[k] }));
}

// One-shot shim for the UI.
export async function payAndVerify(planKey) {
  const { signature } = await pay(planKey);
  return verify(planKey, signature);
}

export function initGfgPay() {
  window.gfgPay = { pay, verify, payAndVerify, plans, connectedWallet };
}