// scripts/spend-ledger.mjs
// Sponsor spend ledger + caps for the delegate relay.
//
// The app pays for every player's onboarding (initialize + delegate, ~0.0013
// SOL). Without limits, a bad actor who can mint fresh wallet keys could drain
// the sponsor wallet (each key costs the sponsor ~1 onboarding). This module
// keeps a durable record of how much the sponsor has spent per player and in
// total, and REFUSES to sponsor work that would exceed the configured caps.
//
// SERVER-SIDE ONLY. Never import from client code. On Vercel this runs per
// serverless instance; the default JSON-file store is scoped to the instance,
// which is fine on devnet. Locking this to a real durable store (Supabase KV
// / Postgres) is listed in the security queue before mainnet.
//
// Env config (all optional):
//   GFG_SPEND_CAP_PER_PLAYER_SOL  max sponsor spend per player pubkey  (default 0.005)
//   GFG_SPEND_CAP_GLOBAL_SOL      max sponsor spend across all players (default 1.0)
//   GFG_SPEND_RESERVE_SOL         sponsor balance floor to keep         (default 0.3)
//   SPEND_LEDGER_PATH             ledger file path                       (default .gfg-spend-ledger.json)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export const DEFAULT_LEDGER_PATH = '.gfg-spend-ledger.json';

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class SpendCapExceeded extends Error {
  constructor(message, kind, limitLamports, usedLamports) {
    super(message);
    this.name = 'SpendCapExceeded';
    this.kind = kind;
    this.limitLamports = limitLamports;
    this.usedLamports = usedLamports;
  }
}

export function spendCaps() {
  return {
    perPlayerLamports: Math.round(envNumber('GFG_SPEND_CAP_PER_PLAYER_SOL', 0.005) * LAMPORTS_PER_SOL),
    globalLamports: Math.round(envNumber('GFG_SPEND_CAP_GLOBAL_SOL', 1.0) * LAMPORTS_PER_SOL),
    reserveLamports: Math.round(envNumber('GFG_SPEND_RESERVE_SOL', 0.3) * LAMPORTS_PER_SOL),
  };
}

export function ledgerPath() {
  return process.env.SPEND_LEDGER_PATH || DEFAULT_LEDGER_PATH;
}

function emptyLedger() {
  return { players: {}, globalSpent: 0, updatedAt: null };
}

export function loadLedger(path = ledgerPath()) {
  if (!existsSync(path)) return emptyLedger();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      players: raw.players || {},
      globalSpent: typeof raw.globalSpent === 'number' ? raw.globalSpent : 0,
      updatedAt: raw.updatedAt || null,
    };
  } catch (e) {
    throw new Error(`spend ledger unreadable at ${path}: ${e.message}`);
  }
}

function persistLedger(ledger, path = ledgerPath()) {
  writeFileSync(path, JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }, null, 2));
}

// Per-player + global totals (the player may have re-delegated in the past).
function usage(ledger, player) {
  return {
    perPlayer: ledger.players[player]?.spent || 0,
    global: ledger.globalSpent || 0,
  };
}

// Throw SpendCapExceeded if running `spendLamports` more would breach a cap. A
// spend must FIRST be authorized (with the same value) before the relay acts.
export function authorizeSpend(player, spendLamports, path = ledgerPath()) {
  const caps = spendCaps();
  const ledger = loadLedger(path);
  const { perPlayer, global } = usage(ledger, player);

  const playerNext = perPlayer + spendLamports;
  if (playerNext > caps.perPlayerLamports) {
    throw new SpendCapExceeded(
      `per-player sponsor cap exceeded for ${player}: would spend ${(playerNext / LAMPORTS_PER_SOL).toFixed(5)} SOL (cap ${(caps.perPlayerLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`,
      'perPlayer', caps.perPlayerLamports, perPlayer
    );
  }
  const globalNext = global + spendLamports;
  if (globalNext > caps.globalLamports) {
    throw new SpendCapExceeded(
      `global sponsor cap exceeded: would spend ${(globalNext / LAMPORTS_PER_SOL).toFixed(5)} SOL total (cap ${(caps.globalLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`,
      'global', caps.globalLamports, global
    );
  }
  return caps;
}

// Reserve check: never let a spend push the sponsor balance below the reserve
// floor (protects the wallet itself even if caps are misconfigured).
export function assertSponsorReserve(balanceLamports, spendLamports, path = ledgerPath()) {
  const caps = spendCaps();
  if (balanceLamports - spendLamports < caps.reserveLamports) {
    throw new SpendCapExceeded(
      `sponsor reserve would be breached: balance ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL`,
      'reserve', caps.reserveLamports, balanceLamports
    );
  }
  return caps;
}

// Successful spend lands into the ledger. Idempotent enough for our purposes:
// the relay never spends for a player twice in one happy path, and duplicate
// records are bounded by the per-player cap.
export function recordSpend(player, spendLamports, path = ledgerPath()) {
  if (spendLamports <= 0) return;
  const ledger = loadLedger(path);
  const prior = ledger.players[player]?.spent || 0;
  ledger.players[player] = { spent: prior + spendLamports, lastSpentAt: new Date().toISOString() };
  ledger.globalSpent = (ledger.globalSpent || 0) + spendLamports;
  persistLedger(ledger, path);
}

export function spendTotals(path = ledgerPath()) {
  const ledger = loadLedger(path);
  return {
    players: Object.keys(ledger.players).length,
    globalSpentLamports: ledger.globalSpent,
    globalSpentSol: +(ledger.globalSpent / LAMPORTS_PER_SOL).toFixed(5),
  };
}