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
// cluster. Devnet reuses the project's devnet base endpoints; mainnet uses
// public mainnet RPCs (swap here for an API-key'd one if you prefer).
export function payRpcEndpoints() {
  return [
    'https://devnet-router.magicblock.app',
    'https://solana-devnet.api.onfinality.io/public',
    'https://api.devnet.solana.com',
  ];
}

// USDC base units for a price in USD cents ($1 = 1_000_000 base).
export function usdcBaseForCents(usdCents) {
  return Math.round(usdCents * 10000);
}