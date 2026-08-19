// Points auto-viewer (points-check2): the SAME raw on-chain M3/M4 read as
// points-check (mirrors dashboard/recovery.html byte-for-byte), but with NO
// search box and NO button. On load it waits for a signed-in wallet and runs
// the read automatically; a wallet that appears later (async session restore
// or a fresh sign-in) triggers a re-run. If no wallet is ever available it
// shows a "sign in to see your points" prompt.
//
// Region order matches the client + recovery: AS, EU, then US LAST (legacy
// fallback; devnet-us is the banned/throttled one), then base RPC.

import * as sol from '@solana/web3.js';

const IDL_URL = '/gfg-dice-idl.json';
const ER_REGIONS = [
  'https://devnet-as.magicblock.app/',
  'https://devnet-eu.magicblock.app/',
  'https://devnet-us.magicblock.app/',
];
const BASE_RPC = 'https://api.devnet.solana.com';
const KNOWN_GAMES = ['ludo'];
const POINTS_SEED = Buffer.from('gfgpoints', 'utf8');
const GLOBAL_SEED = Buffer.from('global', 'utf8');

let programId = null;

async function loadProgramId() {
  if (programId) return programId;
  const resp = await fetch(IDL_URL);
  if (!resp.ok) throw new Error('IDL fetch failed: HTTP ' + resp.status);
  const idl = await resp.json();
  programId = new sol.PublicKey(idl.address || idl.metadata?.address);
  return programId;
}

function pda(gameTag, playerPubkey) {
  return sol.PublicKey.findProgramAddressSync(
    [POINTS_SEED, Buffer.from(gameTag, 'utf8'), playerPubkey.toBytes()],
    programId,
  )[0];
}
function globalPda(playerPubkey) {
  return sol.PublicKey.findProgramAddressSync(
    [POINTS_SEED, GLOBAL_SEED, playerPubkey.toBytes()],
    programId,
  )[0];
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms)),
  ]);
}
const RPC_TIMEOUT = 10000;

// Read one PDA across ER regions (AS, EU, US last) then base. Returns an
// object carrying the found bytes OR the full trace of what each region
// answered, so the caller can PINPOINT why a read came up empty.
async function readAccountData(addr, label) {
  console.log(`[points-reader] STEP 2/3 sending ${label} PDA ${addr.toBase58()} to ER RPCs: ${ER_REGIONS.join(', ')} then ${BASE_RPC}`);
  const errors = [];
  const answered = [];
  for (const url of ER_REGIONS) {
    try {
      const conn = new sol.Connection(url, 'confirmed');
      const info = await withTimeout(conn.getAccountInfo(addr), RPC_TIMEOUT, label + '-' + url);
      if (info && info.data && info.data.length > 0) {
        console.log(`[points-reader] STEP 3/3 ${label} response received on ${url} -> ${info.data.length} bytes (SUCCESS)`);
        return { found: true, data: info.data, url };
      }
      answered.push(url);
      console.log(`[points-reader] ${label} answered-empty on ${url} (RPC healthy, but no account bytes)`);
    } catch (e) {
      errors.push(url);
      console.warn(`[points-reader] ${label} RPC error on ${url}: ${e.message}`);
    }
  }
  try {
    const baseConn = new sol.Connection(BASE_RPC, 'confirmed');
    const info = await withTimeout(baseConn.getAccountInfo(addr), RPC_TIMEOUT, label + '-base');
    if (info && info.data && info.data.length > 0) {
      console.log(`[points-reader] STEP 3/3 ${label} response received on base ${BASE_RPC} -> ${info.data.length} bytes (SUCCESS)`);
      return { found: true, data: info.data, url: BASE_RPC };
    }
    answered.push(BASE_RPC);
    console.log(`[points-reader] ${label} answered-empty on base (RPC healthy, but no account bytes)`);
  } catch (e) {
    errors.push(BASE_RPC);
    console.warn(`[points-reader] ${label} RPC error on base: ${e.message}`);
  }
  console.log(`[points-reader] ${label} STEP 3/3 NOT FOUND. errors=[${errors.join(', ')}] answered-empty=[${answered.join(', ')}]`);
  return { found: false, errors, answered };
}

// Decode a PlayerPoints PDA (M3). Anchor 8-byte discriminator, then:
//   8: pure u64, 16: spendable u64, 24: last_points u64, 32: reason u8,
//  33: match_ref u64, 41: recorded_ts i64, 49: award_count u64,
//  57: spend_ts i64, 65: spend_ref u64, 73: spend_reason u8, 74: spend_count u64
function decodeM3(d) {
  return {
    pure: d.length >= 16 ? Number(d.readBigUInt64LE(8)) : 0,
    spendable: d.length >= 24 ? Number(d.readBigUInt64LE(16)) : 0,
    lastPoints: d.length >= 32 ? Number(d.readBigUInt64LE(24)) : 0,
    lastReason: d.length >= 33 ? d[32] : 0,
    lastMatchRef: d.length >= 41 ? String(d.readBigUInt64LE(33)) : '0',
    lastRecordedTs: d.length >= 49 ? Number(d.readBigInt64LE(41)) : 0,
    awardCount: d.length >= 57 ? Number(d.readBigUInt64LE(49)) : 0,
  };
}

// Decode a GlobalPoints PDA (M4). Anchor 8-byte discriminator, then:
//   8: pure u64, 16: lifetime u64, 24: spendable u64, 32: source u8,
//  33: last_points u64, 41: reason u8, 42: match_ref u64, 50: recorded_ts i64,
//  58: award_count u64, 66: spend_ts i64, 74: spend_ref u64, 82: reason u8,
//  83: spend_count u64
function decodeM4(d) {
  return {
    pure: d.length >= 16 ? Number(d.readBigUInt64LE(8)) : 0,
    lifetime: d.length >= 24 ? Number(d.readBigUInt64LE(16)) : 0,
    spendable: d.length >= 32 ? Number(d.readBigUInt64LE(24)) : 0,
    lastSource: d.length >= 33 ? d[32] : 0,
    lastPoints: d.length >= 41 ? Number(d.readBigUInt64LE(33)) : 0,
    lastReason: d.length >= 42 ? d[41] : 0,
    lastMatchRef: d.length >= 50 ? String(d.readBigUInt64LE(42)) : '0',
    lastRecordedTs: d.length >= 58 ? Number(d.readBigInt64LE(50)) : 0,
    awardCount: d.length >= 66 ? Number(d.readBigUInt64LE(58)) : 0,
    lastSpendTs: d.length >= 74 ? Number(d.readBigInt64LE(66)) : 0,
    lastSpendRef: d.length >= 82 ? String(d.readBigUInt64LE(74)) : '0',
    lastSpendReason: d.length >= 83 ? d[82] : 0,
    spendCount: d.length >= 91 ? Number(d.readBigUInt64LE(83)) : 0,
  };
}

function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTs(ts) { return ts ? new Date(ts * 1000).toLocaleString() : 'never'; }
function fmtNum(n) { return (n || 0).toLocaleString(); }
function reasonLabel(code) {
  const labels = { 1: '1st place win', 2: 'signup bonus', 3: 'referral', 4: 'giveaway', 5: 'tier boost' };
  return labels[code] || ('reason ' + code);
}
function sourceLabel(code) {
  const sources = { 1: 'Ludo', 2: 'Ayo Olopon', 10: 'Signup bonus', 11: 'Referral', 12: 'Giveaway', 13: 'Tier boost' };
  return sources[code] || (code ? ('source ' + code) : 'unknown');
}

const $results = document.getElementById('pv-results');

function signedInWallet() {
  try {
    if (window.getDynamicSolanaWallet) {
      const w = window.getDynamicSolanaWallet();
      if (w) {
        console.log('[points-reader] signed-in wallet source = window.getDynamicSolanaWallet() -> ' + w);
        return w;
      }
    }
  } catch (e) { console.warn('[points-reader] getDynamicSolanaWallet threw: ' + e.message); }
  try {
    if (window.currentProfile && window.currentProfile.solana_wallet) {
      console.log('[points-reader] signed-in wallet source = window.currentProfile.solana_wallet -> ' + window.currentProfile.solana_wallet);
      return window.currentProfile.solana_wallet;
    }
  } catch (e) {}
  return null;
}

async function readWallet(wallet) {
  console.log(`[points-reader] ===== READ START wallet = ${wallet} (${wallet.length} chars)`);
  $results.innerHTML = '<div class="pv-loading">Reading on-chain points for ' + esc(wallet) + '...</div>';
  // STEP 1/3 = the wallet has been grabbed and handed to the reader.
  console.log(`[points-reader] STEP 1/3 wallet grabbed = ${wallet} (sent to the ER RPC for its M3/M4 PDAs)`);
  try {
    await loadProgramId();
  } catch (e) {
    console.error('[points-reader] FAIL at program ID: ' + e.message);
    $results.innerHTML = '<div class="pv-empty">Could not load program ID: ' + esc(e.message) + '</div>';
    return;
  }
  let playerPub;
  try {
    playerPub = new sol.PublicKey(wallet);
  } catch (e) {
    console.error('[points-reader] FAIL: wallet is not a valid Solana public key: ' + e.message);
    $results.innerHTML = '<div class="pv-empty">That address is not a valid Solana public key.</div>';
    return;
  }
  const startedAt = Date.now();

  // M3 local points, per known game.
  const m3Rows = [];
  for (const game of KNOWN_GAMES) {
    const addr = pda(game, playerPub);
    console.log(`[points-reader] M3 ${game} PDA = ${addr.toBase58()}`);
    const res = await readAccountData(addr, `M3-${game}`);
    if (res.found) {
      const decoded = decodeM3(res.data);
      console.log(`[points-reader] M3 ${game} RECEIVED back from ER: pure=${decoded.pure} spendable=${decoded.spendable} awards=${decoded.awardCount} (from ${res.url})`);
      m3Rows.push({ game, address: addr.toBase58(), ...decoded, from: res.url });
    } else {
      console.log(`[points-reader] M3 ${game} NOTHING received back (absent=${res.absent} errors=[${res.errors.join(', ')}])`);
      m3Rows.push({ game, address: addr.toBase58(), from: res });
    }
  }

  // M4 global ledgers.
  const gaddr = globalPda(playerPub);
  console.log(`[points-reader] M4 global PDA = ${gaddr.toBase58()}`);
  const gres = await readAccountData(gaddr, 'M4-global');
  let m4 = null;
  if (gres.found) {
    m4 = { address: gaddr.toBase58(), ...decodeM4(gres.data), from: gres.url };
    console.log(`[points-reader] M4 RECEIVED back from ER: pure=${m4.pure} lifetime=${m4.lifetime} spendable=${m4.spendable} awards=${m4.awardCount} spends=${m4.spendCount} (from ${m4.from})`);
  } else {
    console.log(`[points-reader] M4 NOTHING received back (absent=${gres.absent} errors=[${gres.errors.join(', ')}])`);
  }

  const elapsedMs = Date.now() - startedAt;
  const diagnosis = diagnose(wallet, m3Rows, gres.found);
  console.log('[points-reader] ===== DIAGNOSIS =====');
  console.log('[points-reader] ' + diagnosis.text);
  console.log('[points-reader] ADVICE: ' + diagnosis.advice);
  console.log('[points-reader] =========================');

  render({
    wallet,
    m3Rows,
    m4,
    gaddr: gaddr.toBase58(),
    gres,
    diagnosis,
    elapsedMs,
  });
}

function diagnose(wallet, m3Rows, m4Found) {
  const rpcErrors = [];
  let m3Absent = false;
  let m3Present = false;
  for (const g of m3Rows) {
    if (typeof g.from === 'string') {
      m3Present = true;
    } else {
      m3Absent = true;
      if (g.from && g.from.errors && g.from.errors.length) rpcErrors.push(...g.from.errors);
    }
  }
  const rpcErrSet = Array.from(new Set(rpcErrors));
  const verdicts = [];
  if (rpcErrSet.length) verdicts.push('Some RPC calls ERRORED (network/ban), so a live account could be hidden on those regions: ' + rpcErrSet.join(', '));
  if (m3Absent && !m3Present && !rpcErrSet.length) verdicts.push('M3 ledgers ABSENT on every healthy region (account never created on-chain for this wallet).');
  if (!m4Found && !rpcErrSet.length) verdicts.push('M4 global ledger ABSENT on every healthy region (never banked on-chain).');
  const text = verdicts.length ? verdicts.join(' ') : 'All PDAs read OK from a region; every value decoded is displayed above.';
  const advice = rpcErrSet.length
    ? 'The RPC regions in the error list were not consulted successfully. This looks like a transient RPC issue, not a data issue. Re-run in a few seconds; if it persists, the region needs re-pinning.'
    : (m3Absent || !m4Found)
      ? 'The on-chain account for this wallet does not exist yet (or this wallet address differs from the wallet that banked the points). An absent account is NOT a bug: it means no roll has ever banked points to this wallet on the ER.'
      : '';
  return { text, advice, logLevel: rpcErrSet.length ? 'warn' : (m3Absent || !m4Found ? 'info' : 'ok') };
}

function render({ wallet, m3Rows, m4, gaddr, gres, diagnosis, elapsedMs }) {
  let html = '';

  // Diagnosis card always first: pinpoints the failing step (if any).
  const diagClass = diagnosis.logLevel === 'warn' ? 'badge-warn' : (diagnosis.logLevel === 'info' ? 'badge-purple' : 'badge-ok');
  html += `<div class="pv-card">
      <h3>Diagnosis</h3>
      <div class="pv-row"><span class="label">Verdict</span><span class="badge ${diagClass}">${esc(diagnosis.logLevel === 'warn' ? 'possible failure' : (diagnosis.logLevel === 'info' ? 'no data (expected for unbanked wallet)' : 'all good'))}</span></div>
      <div class="pv-row"><span class="label">Detail</span><span class="value" style="font-size:0.82rem;font-weight:400;">${esc(diagnosis.text)}</span></div>
      <div class="pv-row"><span class="label">Next step</span><span class="value" style="font-size:0.82rem;font-weight:400;color:#999;">${esc(diagnosis.advice)}</span></div>
    </div>`;

  // Wallet card
  html += `<div class="pv-card">
      <h3>Read from the chain</h3>
      <div class="pv-row"><span class="label">Wallet</span><span class="mono">${esc(wallet)}</span></div>
      <div class="pv-row"><span class="label">Program</span><span class="mono">${esc(programId.toBase58())}</span></div>
      <div class="pv-row"><span class="label">Read time</span><span class="value">${(elapsedMs / 1000).toFixed(1)}s</span></div>
    </div>`;

  // M3 card
  html += `<div class="pv-card">
      <h3>M3 local points (per game ledger)</h3>`;
  for (const g of m3Rows) {
    if (!g.from) {
      const badge = (g.from && g.from.errors && g.from.errors.length)
        ? '<span class="badge badge-warn">RPC error on some regions</span>'
        : '<span class="badge badge-none">No on-chain account yet (never banked)</span>';
      html += `<div class="pv-row">
          <span class="value" style="text-transform:capitalize;">${esc(g.game)}</span>
          ${badge}
        </div>
        <div class="pv-row"><span class="label">PDA</span><span class="mono">${esc(g.address)}</span></div>`;
      continue;
    }
    html += `<div class="pv-row">
        <span class="value" style="text-transform:capitalize;">${esc(g.game)}</span>
        <span class="badge badge-ok">${esc(g.from)}</span>
      </div>
      <div class="pv-row"><span class="label">pure (unspendable)</span><span class="value" style="color:#f39c12;">${fmtNum(g.pure)}</span></div>
      <div class="pv-row"><span class="label">spendable</span><span class="value" style="color:#9b59b6;">${fmtNum(g.spendable)}</span></div>
      <div class="pv-row"><span class="label">last award</span><span class="value">+${fmtNum(g.lastPoints)} (${reasonLabel(g.lastReason)}) @ ${fmtTs(g.lastRecordedTs)}</span></div>
      <div class="pv-row"><span class="label">awards</span><span class="value">${g.awardCount}</span></div>
      <div class="pv-row"><span class="label">PDA</span><span class="mono">${esc(g.address)}</span></div>`;
  }
  html += `</div>`;

  // M4 card
  html += `<div class="pv-card">
      <h3>M4 global ledgers (site-wide)</h3>`;
  if (!m4) {
    const m4Badge = (gres.errors && gres.errors.length)
      ? '<span class="badge badge-warn">RPC error on some regions</span>'
      : '<span class="badge badge-none">No on-chain account yet (never banked)</span>';
    html += `<div class="pv-row"><span class="label">Global ledger</span>${m4Badge}</div>
      <div class="pv-row"><span class="label">PDA</span><span class="mono">${esc(gaddr)}</span></div>`;
  } else {
    html += `<div class="pv-row"><span class="label">pure (unspendable)</span><span class="value" style="color:#f39c12;">${fmtNum(m4.pure)}</span></div>
      <div class="pv-row"><span class="label">lifetime (unspendable)</span><span class="value" style="color:#9b59b6;">${fmtNum(m4.lifetime)}</span></div>
      <div class="pv-row"><span class="label">spendable</span><span class="value" style="color:#2ecc71;">${fmtNum(m4.spendable)}</span></div>
      <div class="pv-row"><span class="label">last points</span><span class="value">+${fmtNum(m4.lastPoints)} from ${sourceLabel(m4.lastSource)} (${reasonLabel(m4.lastReason)}) @ ${fmtTs(m4.lastRecordedTs)}</span></div>
      <div class="pv-row"><span class="label">awards / spends</span><span class="value">${m4.awardCount} awards, ${m4.spendCount} spends</span></div>
      <div class="pv-row"><span class="label">source</span><span class="value" style="color:#2ecc71;">${esc(m4.from)}</span></div>
      <div class="pv-row"><span class="label">PDA</span><span class="mono">${esc(m4.address)}</span></div>`;
  }
  html += `</div>`;

  html += `<div class="pv-ts">Raw on-chain read completed at ${new Date().toLocaleString()}. No cache, no sign-in math: these bytes are straight from the ledger.</div>`;

  $results.innerHTML = html;
}

// ---- AUTO-RUN bootstrap (no search box, no button) ----
// Polls for a signed-in wallet (covers async session restore) and also
// re-runs on gfg:auth-changed / gfg:wallet-ready so a fresh sign-in triggers
// the read immediately. Runs once per wallet; ignores repeat polls.

let lastReadWallet = null;
let polling = false;

function showLoginPrompt() {
  $results.innerHTML = `<div class="pv-login">
      <div class="h">Sign in to see your points</div>
      <div class="s">Your on-chain M3 and M4 points appear here automatically once you are signed in.<br>Use the sign-in above, and this page will run on its own.</div>
    </div>`;
  console.log('[points-reader] No signed-in wallet yet: showing login prompt. Will auto-run on sign-in.');
}

async function tryRun() {
  const w = signedInWallet();
  if (w && w !== lastReadWallet) {
    lastReadWallet = w;
    await readWallet(w);
  } else if (!w && !lastReadWallet) {
    showLoginPrompt();
  }
}

async function walletReadyPoll() {
  if (polling) return;
  polling = true;
  // Bounded poll (~20s) for a silently-restored session, then keep only the
  // auth-changed / wallet-ready listeners as the trigger for late sign-ins.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !signedInWallet()) {
    await new Promise(r => setTimeout(r, 700));
  }
  polling = false;
  if (signedInWallet() && signedInWallet() !== lastReadWallet) await readWallet(signedInWallet());
}

tryRun();
try { window.addEventListener('gfg:auth-changed', () => { tryRun(); }); } catch (e) {}
try { window.addEventListener('gfg:wallet-ready', () => { tryRun(); }); } catch (e) {}
document.addEventListener('DOMContentLoaded', () => { tryRun(); walletReadyPoll(); });
walletReadyPoll();