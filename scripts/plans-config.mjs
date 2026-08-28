// scripts/plans-config.mjs — CONFIG-DRIVEN PLAN LADDER (M5).
// Single source of truth for the premium plan attributes used by the relay
// (affiliate share, pricing) and later served to the client at /api/plans.
// More levels = more rows HERE, never code. Owner-approved values 2026-08-22.
// Prices are USD CENTS only (crypto-first, international). No local currency.
export const PLAN_LADDER = {
  1: {
    level: 1,
    name: 'Level 1',
    mult: 1,
    livesPerDay: 5,
    dailyReward: 25,
    compFinalBoost: 1000,       // basis points: 1000 = 1.00x (no boost)
    adFree: false,              // Level 1 sees the light ads
    activationPremiumCost: 0,
    usdRegularCents: 0,
    usdDiscountCents: 0,
    activeDays: 0,
  },
  2: {
    level: 2,
    name: 'Level 2 (2x)',
    mult: 2,
    livesPerDay: 10,
    dailyReward: 200,
    compFinalBoost: 1000,       // 1.0x in earn competitions
    adFree: false,              // still sees the light ads (upgrade to L3 to drop them)
    activationPremiumCost: 5000,
    usdRegularCents: 1000,      // $10 strike
    usdDiscountCents: 500,      // $5 payable (launch discount)
    activeDays: 30,
  },
  3: {
    level: 3,
    name: 'Level 3 (3x)',
    mult: 3,
    livesPerDay: 15,
    dailyReward: 300,
    compFinalBoost: 1500,       // 1.5x final-points boost in earn competitions
    adFree: true,               // ACTIVE Level-3 = no ads
    activationPremiumCost: 10000,
    usdRegularCents: 2000,      // $20 actual
    usdDiscountCents: 1000,     // $10 payable (launch discount)
    activeDays: 30,
  },
};

export const AFFILIATE_RATE = 0.20; // 20% of the referred plan's PAYABLE USD price (owner 2026-08-22)

export function planPayableUsdCents(level) {
  const p = PLAN_LADDER[level];
  return p ? p.usdDiscountCents : 0;
}

export function affiliateShareUsdCentsFor(level) {
  return Math.floor(planPayableUsdCents(level) * AFFILIATE_RATE);
}

export function planFor(level) {
  return PLAN_LADDER[level] || null;
}