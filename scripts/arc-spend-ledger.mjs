// scripts/arc-spend-ledger.mjs — raw Arc gas spend log for the dashboard.
//
// The relayer records every write it sponsors (action, gas, USDC, player,
// gameId). The dashboard reads period totals from it: 24h / 7d / 14d / 30d / 90d
// plus games and averages. This is real project data, not an estimate.
//
// Durable locally in .gfg-arc-spend.json (gitignored). On Vercel the file is
// per-instance (same known limitation as the Solana spend ledger); moving it to
// a durable store is a mainnet item.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const FILE = join(process.cwd(), '.gfg-arc-spend.json');
const PERIODS = [
  { key: '24h', hours: 24 },
  { key: '7d', hours: 24 * 7 },
  { key: '14d', hours: 24 * 14 },
  { key: '30d', hours: 24 * 30 },
  { key: '90d', hours: 24 * 90 },
];

function load() {
  try {
    if (!existsSync(FILE)) return { events: [] };
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!Array.isArray(j.events)) j.events = [];
    return j;
  } catch (e) { return { events: [] }; }
}
function save(j) {
  try { writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n'); } catch (e) { /* read-only fs on Vercel */ }
}

/// Record one sponsored Arc write. gas = gas used, usdc = formatted USDC string.
export function recordArcSpend({ action, gas, usdc, player, gameId }) {
  const j = load();
  j.events.push({
    ts: Date.now(),
    action: String(action || 'unknown'),
    gas: Number(gas || 0),
    usdc: Number(usdc || 0),
    player: player ? String(player) : null,
    gameId: gameId ? String(gameId) : null,
  });
  const MAX = 5000;
  if (j.events.length > MAX) j.events = j.events.slice(-MAX);
  save(j);
}

/// Period totals for the dashboard: transactions, USDC, games and averages.
export function arcUsageSummary() {
  const j = load();
  const now = Date.now();
  const GAME_ACTIONS = new Set(['chargeLife', 'settleGame']);
  const out = { generatedAt: now, periods: [] };
  for (const p of PERIODS) {
    const since = now - p.hours * 3600 * 1000;
    const evs = j.events.filter(e => e.ts >= since);
    const usdc = evs.reduce((s, e) => s + (Number(e.usdc) || 0), 0);
    const gas = evs.reduce((s, e) => s + (Number(e.gas) || 0), 0);
    const games = new Set(evs.filter(e => GAME_ACTIONS.has(e.action) && e.gameId).map(e => e.gameId)).size;
    const days = p.hours / 24;
    out.periods.push({
      window: p.key,
      txs: evs.length,
      gas,
      usdc: Number(usdc.toFixed(8)),
      games,
      usdcPerDay: Number((usdc / days).toFixed(8)),
      gamesPerDay: Number((games / days).toFixed(2)),
      usdcPerGame: games > 0 ? Number((usdc / games).toFixed(8)) : null,
    });
  }
  return out;
}
