// scripts/endpoints-probe.mjs
// Server-side health probe for the admin operations dashboard.
//
// Runs in TWO places (same code):
//   - the Vercel function      api/endpoints.mjs
//   - the local dev relay      scripts/relay-server.mjs (Vite proxies /api)
//
// Returns:
//   - watchlist : one row per monitored dependency (RPC chain, on-chain
//     accounts, ER RPC, Supabase) with status / latency / accessibility
//     (user-accessible, staff-only, infra).
//   - ops       : sponsor devnet balance, spend ledger totals + caps,
//     version + roadmap counts, git ref, and the ER/on-chain account
//     inventory (addresses resolved live).
//   - generatedAt / environment : when + where this probe ran.
//
// SECURITY (read the AGENTS.md rules before editing):
//   The response payload must NEVER describe an unfixed weakness. Leak-scan
//   verdicts and accepted gaps (e.g. the client-gated admin pages, the fact
//   that this endpoint answers anonymous callers today) are computed by
//   logLeakSinks() and written ONLY to the server-side log:
//     - console (Vercel function logs / the local relay terminal)
//     - a JSONL file when the server has a writable filesystem
//   Nothing about them ships to the browser.

import { readFileSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { PublicKey, Keypair } from '@solana/web3.js';
import './load-env.mjs';
import { routerUrl } from '../src/gfg-rpc.js';
import { createConnection } from '../src/gfg-rpc.js';
import { spendCaps, loadLedger, spendTotals } from './spend-ledger.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- On-chain inventory (public, stable addresses on devnet) ----
const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_RPC = 'https://devnet-us.magicblock.app/';
const INVENTORY = {
  gfgDiceProgram: idl.address,
  delegationProgram: 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh',
  erValidator: 'MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd',
  erVrfQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc',
  baseVrfQueue: 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh',
  erRpc: ER_RPC,
};

// ---- Sponsor key resolution (mirrors delegate-relay) ----
function loadSponsorPubkey() {
  if (process.env.GFG_SPONSOR_KEYPAIR) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_SPONSOR_KEYPAIR))).publicKey.toBase58();
  }
  const path = join(homedir(), '.config', 'solana', 'id.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))).publicKey.toBase58();
}

// ---- git ref: Vercel injects VERCEL_GIT_COMMIT_SHA; local uses git; last
//      resort = latest changelog entry's committed ref. ----
function gitRef() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (sha) return sha;
  } catch (e) { /* not a git checkout on the server */ }
  try {
    const d = JSON.parse(readFileSync(join(root, 'public/changelog/changelog.json'), 'utf8'));
    if (d.entries && d.entries[0] && d.entries[0].git) return d.entries[0].git;
  } catch (e) { /* ignore */ }
  return 'unknown';
}

// ---- Changelog: version + roadmap counts ----
function changelogStats() {
  try {
    const d = JSON.parse(readFileSync(join(root, 'public/changelog/changelog.json'), 'utf8'));
    const roadmap = d.roadmap || [];
    return {
      version: d.current || '0.0.0',
      roadmapCounts: {
        planned: roadmap.filter(r => r.status === 'planned').length,
        inProgress: roadmap.filter(r => r.status === 'in-progress').length,
        shipped: (d.entries || []).length,
        pendingApprovals: roadmap.filter(r => r.approved !== true).length,
      },
    };
  } catch (e) {
    return { version: '0.0.0', roadmapCounts: null, error: e.message };
  }
}

// ---- HTTP probe with timeout ----
async function probeHttp(url, timeoutMs = 8000) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    // Any HTTP response means the server answered; a 4xx/5xx with a body is
    // still "reachable" from an operations standpoint (caught further up).
    return { ok: res.status >= 200 && res.status < 500, status: res.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ---- RPC probe: one JSON-RPC call through the configured connection ----
async function probeRpc(conn, method, params = []) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(conn.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message, latencyMs: Date.now() - start };
    return { ok: !!data.result, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ---- The probe ----
export async function runProbe() {
  const started = Date.now();
  const ROUTER = routerUrl();
  const conn = createConnection(ROUTER, 'confirmed');
  const watchlist = [];
  const seen = new Set();
  const note = (name, category, access, result) => {
    watchlist.push({
      name, category, access,
      ok: result.ok,
      latencyMs: result.latencyMs != null ? result.latencyMs : null,
      detail: result.ok ? (result.detail || (result.status ? `HTTP ${result.status}` : 'ok')) : (result.error || 'down'),
    });
  };
  const probe = async (name, category, access, fn) => {
    if (seen.has(name)) return;
    seen.add(name);
    try { note(name, category, access, await fn()); }
    catch (e) { note(name, category, access, { ok: false, error: e.message }); }
  };

  // 1. RPC chain (infra)
  await probe('Magic Router devnet RPC', 'rpc', 'infra', () => probeRpc(conn, 'getIdentity'));

  // 2. On-chain account inventory (infra) — each resolves an address creation
  const accountProbe = (label, address) => async () => {
    const start = Date.now();
    try {
      const info = await conn.getAccountInfo(new PublicKey(address));
      return { ok: !!info, latencyMs: Date.now() - start, detail: info ? `${info.lamports / 1e9} SOL rent` : 'account not found' };
    } catch (e) {
      // A delegated ER account answers getAccountInfo with
      // "account has been delegated to unknown ER node" — that IS the healthy
      // state for an account living on the rollup, not a failure.
      if (/delegated to unknown ER node/i.test(e.message || '')) {
        return { ok: true, latencyMs: Date.now() - start, detail: 'delegated to ER (expected)' };
      }
      throw e;
    }
  };
  await probe('gfg-dice program deployed', 'accounts', 'infra', accountProbe('gfg', INVENTORY.gfgDiceProgram));
  await probe('Delegation program deployed', 'accounts', 'infra', accountProbe('delegation', INVENTORY.delegationProgram));
  await probe('ER VRF queue (free)', 'accounts', 'infra', accountProbe('er-vrf', INVENTORY.erVrfQueue));
  await probe('Base VRF queue (paid)', 'accounts', 'infra', accountProbe('base-vrf', INVENTORY.baseVrfQueue));
  await probe('ER validator (US)', 'accounts', 'infra', accountProbe('er-validator', INVENTORY.erValidator));

  // 3. ER RPC (infra)
  await probe('ER RPC (devnet-us.magicblock.app)', 'http', 'infra', () => probeHttp(ER_RPC.replace(/\/+$/, '') + '/'));

  // 4. Supabase (infra)
  await probe('Supabase (profiles store)', 'db', 'infra', () => probeHttp('https://ywrgxynjjgdicdzizpue.supabase.co'));

  // ---- Ops panel ----
  let sponsor = null;
  try {
    const pubkey = loadSponsorPubkey();
    const start = Date.now();
    const balance = await conn.getBalance(new PublicKey(pubkey));
    sponsor = { pubkey, balanceSol: +(balance / 1e9).toFixed(4), latencyMs: Date.now() - start };
  } catch (e) {
    sponsor = { pubkey: null, balanceSol: null, error: e.message };
  }

  let ledger = null;
  try {
    const caps = spendCaps();
    const totals = spendTotals();
    const all = loadLedger();
    const players = Object.entries(all.players || {})
      .map(([pubkey, v]) => ({ pubkey, spentSol: +((v.spent || 0) / 1e9).toFixed(5), lastSpentAt: v.lastSpentAt || null }))
      .sort((a, b) => b.spentSol - a.spentSol);
    ledger = {
      playersCount: totals.players,
      globalSpentSol: totals.globalSpentSol,
      perPlayerCapSol: +(caps.perPlayerLamports / 1e9).toFixed(3),
      globalCapSol: +(caps.globalLamports / 1e9).toFixed(3),
      reserveSol: +(caps.reserveLamports / 1e9).toFixed(3),
      players,
    };
  } catch (e) {
    ledger = { error: e.message };
  }

  const changelog = changelogStats();

  // ---- Leak scan: findings go to the server log ONLY (never the payload) ----
  logLeakSinks(sponsor, ledger, changelog);

  return {
    generatedAt: new Date().toISOString(),
    environment: process.env.VERCEL ? 'vercel' : 'local',
    watchlist,
    ops: {
      sponsor,
      ledger,
      version: changelog.version,
      roadmapCounts: changelog.roadmapCounts,
      gitRef: gitRef(),
      inventory: INVENTORY,
    },
    probeMs: Date.now() - started,
  };
}

// Server-side-only sink for accepted-gap / leak observations. Nothing written
// here may appear in the api/endpoints response payload.
function logLeakSinks(sponsor, ledger, changelog) {
  const lines = [];
  const line = (kind, msg) => lines.push(`${kind}\t${new Date().toISOString()}\t${msg}`);
  line('gap', 'api/endpoints answers anonymous callers (no server-side auth yet; client-side wallet gate only)');
  line('gap', 'admin pages (/dashboard, /changelog/admin.html) are client-gated only — readable via devtools');
  if (sponsor && sponsor.balanceSol != null) {
    line('ops', `sponsor balance ${sponsor.balanceSol} SOL`);
    if (sponsor.balanceSol < 0.5) line('warn', 'sponsor balance LOW (below 0.5 SOL)');
  }
  if (ledger && !ledger.error) {
    line('ops', `ledger: ${ledger.playersCount} player(s), ${ledger.globalSpentSol} SOL spent, caps ${ledger.perPlayerCapSol}/${ledger.globalCapSol}/${ledger.reserveSol}`);
  }
  if (changelog.roadmapCounts && changelog.roadmapCounts.pendingApprovals > 0) {
    line('ops', `${changelog.roadmapCounts.pendingApprovals} roadmap item(s) pending owner approval`);
  }
  try {
    const logFile = join(root, '.gfg-probe-log.jsonl');
    appendFileSync(logFile, lines.map(l => JSON.stringify({ t: new Date().toISOString(), msg: l })).join('\n') + '\n');
  } catch (e) { /* Vercel has no writable fs — skip file sink */ }
  for (const l of lines) console.log(`[probe] ${l}`);
}

// Allow running the probe directly for debugging: `node scripts/endpoints-probe.mjs`
if (process.argv[1] && process.argv[1].endsWith('endpoints-probe.mjs')) {
  runProbe().then((r) => { console.log(JSON.stringify(r, null, 2)); }).catch((e) => { console.error(e); process.exit(1); });
}