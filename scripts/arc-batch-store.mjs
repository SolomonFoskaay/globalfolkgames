// scripts/arc-batch-store.mjs — pending batch state for GFG-BS.
//
// A window holds game leaves until it flushes on N games OR T seconds,
// whichever comes first. Durable locally in .gfg-arc-batch.json (gitignored);
// per-instance on Vercel until a durable store is added for mainnet.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const FILE = join(process.cwd(), '.gfg-arc-batch.json');
const DEFAULTS = { windowMs: 24 * 3600 * 1000, maxGames: 100 };

function load() {
  try {
    if (!existsSync(FILE)) return { batches: {} };
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!j.batches) j.batches = {};
    return j;
  } catch (e) { return { batches: {} }; }
}
function save(j) { try { writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n'); } catch (e) { /* ro fs */ } }

function keyKind(kind) { return kind === 'settle' ? 'settle' : 'open'; }

export function enqueue(kind, leaf, meta) {
  const j = load();
  const k = keyKind(kind);
  if (!j.batches[k]) j.batches[k] = { startedAt: Date.now(), leaves: [] };
  const b = j.batches[k];
  b.leaves.push({ leaf, ...meta });
  save(j);
  return { count: b.leaves.length, startedAt: b.startedAt };
}

export function pending(kind) {
  const j = load();
  return j.batches[keyKind(kind)] || { startedAt: null, leaves: [] };
}

export function due(kind, opts) {
  const b = pending(kind);
  const windowMs = (opts && opts.windowMs) || DEFAULTS.windowMs;
  const maxGames = (opts && opts.maxGames) || DEFAULTS.maxGames;
  if (!b.leaves.length) return false;
  if (b.leaves.length >= maxGames) return true;
  return (Date.now() - b.startedAt) >= windowMs;
}

export function markFlushed(kind, root, items) {
  const j = load();
  const k = keyKind(kind);
  const b = j.batches[k] || { leaves: [] };
  const at = Date.now();
  const prev = (j.batches[k] && j.batches[k].flushed) ? j.batches[k].flushed : [];
  j.batches[k] = {
    startedAt: Date.now(),
    leaves: [],
    lastRoot: root,
    lastCount: b.leaves.length,
    lastFlushedAt: at,
    lastItems: items || [],           // [{ gameId, leaf, proof }] for /batchProof
    flushed: prev.concat([{ root, count: b.leaves.length, at }]).slice(-50),
  };
  save(j);
}

/// Proof for a game in the LAST flushed batch (or null).
export function proofFor(kind, gameId) {
  const j = load();
  const b = j.batches[keyKind(kind)] || {};
  const items = b.lastItems || [];
  const hit = items.find(x => x.gameId === gameId);
  return hit ? { root: b.lastRoot, proof: hit.proof, leaf: hit.leaf, flushedAt: b.lastFlushedAt } : null;
}

export function findLeaf(kind, gameId) {
  for (const k of ['settle', 'open']) {
    const b = pending(k);
    const hit = b.leaves.find(l => l.gameId === gameId);
    if (hit) return { kind: k, ...hit, startedAt: b.startedAt };
  }
  return null;
}

export function lastFlush(kind) {
  const j = load();
  const b = j.batches[keyKind(kind)] || {};
  return { root: b.lastRoot || null, count: b.lastCount || 0, at: b.lastFlushedAt || null };
}
