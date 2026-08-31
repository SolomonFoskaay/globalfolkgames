// scripts/pay-config.mjs — PAYMENT AUTOMATION config (M5/M6, owner 2026-08-31).
//
// Single swap point for devnet <-> mainnet, decoupled from the game cluster
// (the game/ER/program stay on devnet; PAYMENTS may be mainnet real USDC):
//   - The player pays USDC from their OWN embedded Dynamic wallet to the
//     platform treasury (TA) on the cluster below.
//   - /api/verify-and-credit reads that transaction on `payCluster`, checks
//     amount / mint / sender / freshness, then credits premium points on the
//     existing devnet program path (sponsor signs, gasless ER).
//
// SWAP TO MAINNET: change PAY_CLUSTER to 'mainnet' and set PAY_TREASURY_PUBKEY
// to the mainnet wallet you control. Nothing else in the app changes (the
// client and verifier both read /api/pay-config). Devnet USDC is test money;
// mainnet USDC is real — the credit amount is always the plan's points.
export const PAY_TREASURY_PUBKEY =
  process.env.GFG_PAY_TREASURY || '5ec9bYwVJVSfM3xnrzpg9jkoepX58pY1tWoGDsMdhdTQ'; // sponsor (devnet); set env for mainnet

export const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet USDC (Circle faucet)
export const USDC_DECIMALS = 6;

// Points credited per paid plan/booster (mirrors the on-chain ladder at
// 500 pts = $1, based on the ACTUAL price, never the discount).
export const PAY_PLANS = {
  l1: { points: 5000,  usdCents: 500,  kind: 'plan',  reason: 1 }, // $5 payable / $10 actual -> 5,000P
  l2: { points: 10000, usdCents: 1000, kind: 'plan',  reason: 1 }, // $10 payable / $20 actual -> 10,000P
  l3: { points: 15000, usdCents: 1500, kind: 'plan',  reason: 1 }, // $15 payable / $30 actual -> 15,000P
  b24: { points: 500,   usdCents: 100,  kind: 'booster', reason: 4 }, // 24h unlimited -> 500P
  b72: { points: 1500,  usdCents: 200,  kind: 'booster', reason: 4 }, // 72h unlimited -> 1,500P
};

export function payPlan(key) {
  return PAY_PLANS[key] || null;
}

// RPC endpoints the VERIFIER uses to read the payment transaction on the pay
// cluster. IMPORTANT: the MagicBlock devnet ROUTER cannot serve getTransaction
// (it answers ER ops + getBalance only, not archive tx reads), so the verifier
// must hit a real BASE devnet RPC first. `GFG_DEVNET_RPC` (Alchemy) is used
// when present (server env), then public devnet. SWAP TO MAINNET: replace this
// list with mainnet RPCs (e.g. your Alchemy/Helius mainnet endpoint first).
export function payRpcEndpoints() {
  const out = [];
  try {
    if (typeof process !== 'undefined' && process.env?.GFG_DEVNET_RPC) out.push(process.env.GFG_DEVNET_RPC);
  } catch (e) { /* not a node env */ }
  out.push(
    'https://api.devnet.solana.com',
    'https://solana-devnet.api.onfinality.io/public'
  );
  return out;
}

// USDC base units for a price in USD cents ($1 = 1_000_000 base).
export function usdcBaseForCents(usdCents) {
  return Math.round(usdCents * 10000);
}