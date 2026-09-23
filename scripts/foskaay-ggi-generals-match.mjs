// scripts/foskaay-ggi-generals-match.mjs — play the ported Generals game on Arc testnet
// through the Foskaay GGI sponsor relay, in BOTH settlement modes, and measure the REAL
// USDC cost of each (never estimated).
//
// This is the outsider path: it only speaks HTTP to the sponsor relay, exactly
// like the browser demo does. It proves the whole rail works for a real game:
// session open -> board on-chain gated by canSign -> moves -> settle, with the
// player paying nothing.
//
// Usage:
//   node scripts/foskaay-ggi-generals-match.mjs            # both modes
//   node scripts/foskaay-ggi-generals-match.mjs unbatched
//   node scripts/foskaay-ggi-generals-match.mjs batched
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { keccak256, toBytes } from 'viem';

const RELAY = process.env.GGI_RELAY || 'http://localhost:8787';
const here = dirname(fileURLToPath(import.meta.url));

async function post(action, body = {}) {
  const res = await fetch(RELAY + '/api/foskaay-ggi-sponsor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(action + ' failed: ' + (json.error || res.status));
  return json;
}

const usdc = (x) => Number(x || 0) / 1e6;

// The scripted match both modes play: P1 pokes at the field next to its capital,
// P2 reinforces, a tick fires, then P1 finishes (last-one-standing check runs).
function scriptedMoves() {
  return [
    { op: 'command', playerIndex: 0, sourceX: 1, sourceY: 1, targetX: 2, targetY: 1, strengthPercent: 50 },
    { op: 'command', playerIndex: 1, sourceX: 14, sourceY: 6, targetX: 13, targetY: 6, strengthPercent: 50 },
    { op: 'command', playerIndex: 0, sourceX: 2, sourceY: 1, targetX: 2, targetY: 2, strengthPercent: 100 },
    { op: 'command', playerIndex: 1, sourceX: 13, sourceY: 6, targetX: 12, targetY: 6, strengthPercent: 100 },
    { op: 'tick' },
    { op: 'command', playerIndex: 0, sourceX: 1, sourceY: 1, targetX: 1, targetY: 2, strengthPercent: 50 },
    { op: 'command', playerIndex: 1, sourceX: 12, sourceY: 6, targetX: 11, targetY: 6, strengthPercent: 50 },
  ];
}

function digestOf(rows) {
  return keccak256(toBytes(JSON.stringify(rows)));
}

async function setupBoard(sessionId, rows) {
  const boardId = Math.floor(Date.now() / 1000); // unique per run
  const steps = [
    { op: 'createBoard', boardId, sessionId, sizeX: 16, sizeY: 8 },
    { op: 'generate', boardId },
    { op: 'join', boardId, playerIndex: 0 },
    { op: 'join', boardId, playerIndex: 1 },
    { op: 'setReady', boardId, playerIndex: 0, ready: true },
    { op: 'setReady', boardId, playerIndex: 1, ready: true },
    { op: 'start', boardId },
  ];
  let cost = 0;
  for (const s of steps) {
    const r = await post('game', s);
    rows.push({ label: 'game.' + s.op, usdc: usdc(r.costUsdc6), tx: r.tx });
    cost += usdc(r.costUsdc6);
  }
  return { boardId, cost };
}

async function playMoves(boardId, rows) {
  let cost = 0;
  for (const m of scriptedMoves()) {
    const r = await post('game', { boardId, ...m });
    rows.push({ label: 'game.' + m.op + (m.playerIndex != null ? ' p' + m.playerIndex : ''), usdc: usdc(r.costUsdc6), tx: r.tx });
    cost += usdc(r.costUsdc6);
  }
  const f = await post('game', { boardId, op: 'finish', playerIndex: 0 });
  rows.push({ label: 'game.finish', usdc: usdc(f.costUsdc6), tx: f.tx });
  cost += usdc(f.costUsdc6);
  return cost;
}

async function runUnbatched() {
  console.log('\n=== MODE: UNBATCHED (settle each match on-chain as it ends) ===');
  const rows = [];
  const seed = '0x' + randomBytes(32).toString('hex');
  const open = await post('open', { participants: 2, ttlSecs: 3600, seeds: [seed] });
  rows.push({ label: 'rail.open', usdc: usdc(open.costUsdc6), tx: open.tx });
  const gs = await post('setGameState', { sessionId: open.sessionId });
  rows.push({ label: 'rail.setGameState', usdc: usdc(gs.costUsdc6), tx: gs.tx });

  const { boardId } = await setupBoard(open.sessionId, rows);
  await playMoves(boardId, rows);

  const board = await post('gameBoard', { boardId });
  const digest = digestOf(rows.map((r) => r.label));
  const settle = await post('settle', { sessionId: open.sessionId, seeds: [seed], digest });
  rows.push({ label: 'rail.settle (close+reveal+seal+fee)', usdc: usdc(settle.costUsdc6), txs: settle.txs });

  const total = rows.reduce((a, r) => a + r.usdc, 0);
  printRows(rows, total, 'UNBATCHED');
  return { mode: 'unbatched', sessionId: open.sessionId, boardId, boardStatus: board.status, totalUsdc: total, rows };
}

async function runBatched() {
  console.log('\n=== MODE: BATCHED (many matches roll into ONE Merkle root) ===');
  const rows = [];
  const seed = '0x' + randomBytes(32).toString('hex');
  const open = await post('open', { participants: 2, ttlSecs: 3600, seeds: [seed] });
  rows.push({ label: 'rail.open', usdc: usdc(open.costUsdc6), tx: open.tx });
  const gs = await post('setGameState', { sessionId: open.sessionId });
  rows.push({ label: 'rail.setGameState', usdc: usdc(gs.costUsdc6), tx: gs.tx });

  const { boardId } = await setupBoard(open.sessionId, rows);
  await playMoves(boardId, rows);

  const board = await post('gameBoard', { boardId });
  const digest = digestOf(rows.map((r) => r.label));
  // maxSize 1 => the window fills on this submit, so a flush is allowed right away.
  const sub = await post('batchSubmit', { sessionId: open.sessionId, digest, maxSize: 1, windowSecs: 60, setConfig: true });
  rows.push({ label: 'rail.batchSubmit (this match)', usdc: usdc(sub.costUsdc6), tx: sub.tx });
  const flush = await post('batchFlush', {});
  rows.push({ label: 'rail.batchFlush (whole window)', usdc: usdc(flush.costUsdc6), tx: flush.tx });

  const total = rows.reduce((a, r) => a + r.usdc, 0);
  printRows(rows, total, 'BATCHED');
  return { mode: 'batched', sessionId: open.sessionId, boardId, boardStatus: board.status, totalUsdc: total, windowId: flush.windowId, rows };
}

function printRows(rows, total, title) {
  const pad = 40;
  for (const r of rows) console.log('  ' + r.label.padEnd(pad) + r.usdc.toFixed(6) + ' USDC');
  console.log('  ' + '-'.repeat(pad + 12));
  console.log('  ' + ('TOTAL ' + title).padEnd(pad) + total.toFixed(6) + ' USDC');
  console.log('  games per $1: ' + (total > 0 ? Math.floor(1 / total) : 'inf'));
}

(async () => {
  const which = (process.argv[2] || 'both').toLowerCase();
  const me = await post('sponsorAddress');
  console.log('Foskaay GGI Generals live match -> Arc testnet');
  console.log('relay:', RELAY);
  console.log('sponsor (public):', me.address);
  console.log('GeneralsGame:', me.generalsGame);

  const out = { measuredAt: new Date().toISOString(), relay: RELAY, sponsor: me.address, generalsGame: me.generalsGame, runs: [] };
  if (which === 'both' || which === 'unbatched') out.runs.push(await runUnbatched());
  if (which === 'both' || which === 'batched') out.runs.push(await runBatched());

  writeFileSync(join(here, '..', 'foskaay-ggi', 'deployments', 'generals-cost.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('\nwritten: foskaay-ggi/deployments/generals-cost.json');
})().catch((e) => {
  console.error('match failed:', e.shortMessage || e.message || e);
  process.exit(1);
});
