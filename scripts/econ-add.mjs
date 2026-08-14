#!/usr/bin/env node
// scripts/econ-add.mjs
// Capture an economics idea in the admin Game Economics workspace.
//
// Usage:
//   node scripts/econ-add.mjs "<title>" --stage raw
//   node scripts/econ-add.mjs "<title>" --summary "one line" --stage fine-tuned
//     --notes "line one. line two. line three." --tags "ledgers,points"
//   node scripts/econ-promote.mjs "<title>" ready   (move stage forward)
//
// Stages: raw -> fine-tuned -> ready. raw = unfiltered owner thoughts;
// fine-tuned = discussed/shaped design; ready = finalized, ready to promote
// into the normal changelog roadmap (scripts/add-roadmap.mjs).
//
// Security note: economics.json is client-served (admin-gated). Unfixed
// security/anti-exploit work must NEVER go here — keep it in
// docs/changelog/security-queue.md only (see add-roadmap.mjs rules).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ECON = join(ROOT, 'public', 'changelog', 'economics.json');

const title = process.argv[2] || '';
const argv = process.argv.slice(3);
const arg = flag => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : '';
};
const stage = (arg('--stage') || 'raw').toLowerCase();
const summary = arg('--summary');
const notesRaw = arg('--notes');
const tags = arg('--tags');

if (!title) {
  console.error('Usage: node scripts/econ-add.mjs "<title>" [--stage raw|fine-tuned] [--summary "..."] [--notes "a. b. c."] [--tags "a,b"]');
  process.exit(1);
}
if (!['raw', 'fine-tuned', 'ready'].includes(stage)) {
  console.error('--stage must be raw | fine-tuned | ready');
  process.exit(1);
}
if (!existsSync(ECON)) {
  console.error('economics.json not found');
  process.exit(1);
}

const data = JSON.parse(readFileSync(ECON, 'utf8'));
if (!Array.isArray(data.items)) data.items = [];

const norm = s => String(s).toLowerCase().trim();
if (data.items.some(i => norm(i.title) === norm(title))) {
  console.error(`Economics workspace already has "${title}". Promote it with econ-promote, or edit economics.json directly.`);
  process.exit(1);
}

const id = String(data.items.length + 1).padStart(3, '0');
const today = new Date().toISOString().slice(0, 10);
const notes = notesRaw ? notesRaw.split(/\s*\.\s+/).filter(Boolean).map(s => s.replace(/\.$/, '')) : [];

data.items.push({
  id,
  title,
  stage,
  ...(summary ? { summary } : {}),
  ...(notes.length ? { notes } : {}),
  ...(tags ? { tags: tags.split(',').map(t => t.trim()).filter(Boolean) } : {}),
  added: today,
  updated: today
});
data.updated = today;
writeFileSync(ECON, JSON.stringify(data, null, 2) + '\n');

console.log(`\necon added (id econ-${id}, stage: ${stage}): "${title}"`);
console.log(`summary : ${summary || '(none)'}`);
console.log(`notes   : ${notes.length} line(s)`);
console.log(`tags    : ${tags || '(none)'}`);
console.log(`\nRaw on     : /changelog/economics.html\n`);
console.log(`Promote it: node scripts/econ-promote.mjs "${title}" fine-tuned|ready`);