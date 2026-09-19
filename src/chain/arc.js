// src/chain/arc.js — the Arc rail adapter (arcv2m16).
//
// The browser never holds a key and never pays gas. Writes and reads go to the
// self-hosted relayer endpoint (/api/arc), which signs with the app sponsor key
// and pays the tiny USDC gas. Reads are decoded server-side so the browser stays
// thin (no viem in the client bundle).
//
// Naming note (owner 2026-09-18): the settlement layer is GlobalFolkGames
// Batched Settlement (GFG-BS): Merkle-root batch settlement plus commit-reveal
// randomness. It is NOT a rollup, and it settles more than gameplay.
//
// Everything here is behind VITE_GFG_CHAIN=evm. The default is svm, so the live
// Solana flow is untouched while we build and test the Arc path.

let _cfg = null;

export async function arcPublicConfig() {
  if (_cfg) return _cfg;
  const res = await fetch('/arc-config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('arc-config.json ' + res.status);
  _cfg = await res.json();
  return _cfg;
}

async function relay(action, params, token) {
  const res = await fetch('/api/arc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params: params || {}, token }),
  });
  let j = null;
  try { j = await res.json(); } catch (e) { j = { ok: false, error: 'bad response' }; }
  if (!res.ok || !j.ok) throw new Error(j.error || ('relay ' + res.status));
  return j;
}

function evmAddress() {
  try { return (window.getDynamicEvmWallet && window.getDynamicEvmWallet()) || null; } catch (e) { return null; }
}

export const arcAdapter = {
  name: 'arc',

  async isReady() {
    try { await arcPublicConfig(); return true; } catch (e) { return false; }
  },

  walletAddress() { return evmAddress(); },

  // Full player snapshot (lives, globals, premium, one game bucket).
  async readPlayer(gameTag = 'ludo') {
    const player = evmAddress();
    if (!player) return null;
    return relay('readPlayer', { player, tag: gameTag });
  },

  // Ledger shape the modules expect (same fields as the Solana path).
  async fetchLedger(gameTag = 'ludo') {
    const r = await this.readPlayer(gameTag);
    if (!r) return null;
    const b = r.bucket || {};
    const g = r.globals || {};
    return {
      pureLifetime: Number(b.pure || 0),
      spendableBalance: Number(b.spendable || 0),
      globalPure: Number(g.pure || 0),
      globalLifetime: Number(g.lifetime || 0),
      globalSpendable: Number(g.spendable || 0),
      lives: r.lives || null,
      premium: r.premium || null,
      raw: r,
    };
  },

  async recordPoints(gameTag, points, reason, matchRef, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('recordPoints', { player, tag: gameTag || 'ludo', points, reason: reason || 1, matchRef });
  },

  async recordGlobal(kind, points, matchRef, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('recordGlobal', { player, kind: kind || 0, points, matchRef });
  },

  async chargeLife(matchRef, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('chargeLife', { player, matchRef });
  },

  // Spendable draw-downs (gasless; the relayer signs). The contract's own
  // Insufficient check is the guard, so a spend can never overdraw.
  async spendLocal(gameTag, amount, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('spendLocal', { player, tag: gameTag || 'ludo', amount });
  },
  async spendGlobal(amount, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('spendGlobal', { player, amount });
  },

  async openGame(gameId, p2, ttl) { return relay('openGame', { gameId, p2, ttl: ttl || 1800 }); },
  async settleGame(gameId, resultHash) { return relay('settleGame', { gameId, resultHash }); },
  async expireGame(gameId) { return relay('expireGame', { gameId }); },
  // Full finish order (1st..Nth seat indexes) recorded with the result.
  async settleGameOrder(gameId, actor, resultHash, order) { return relay('settleGameOrder', { gameId, actor, resultHash, order }); },
  async resultOrder(gameId) { return relay('resultOrder', { gameId }); },
  // On-chain turn clock (arcv2m1/2ii). The game reads the ABSOLUTE deadline from
  // the chain and counts down to it; a lapsed seat is advanced by anyone.
  async seatUp(gameId, host, seat, player) { return relay('seatUp', { gameId, host, seat, player }); },
  async beginGame(gameId, host, seats, turnSecs) { return relay('beginGame', { gameId, host, seats, turnSecs }); },
  async commitMove(gameId, mover, seat, nextSeat, moveCommit) { return relay('commitMove', { gameId, mover, seat, nextSeat, moveCommit }); },
  async expireTurn(gameId) { return relay('expireTurn', { gameId }); },
  async turnState(gameId) { return relay('turnState', { gameId }); },
  async commitBatch(kind, root, count) { return relay('commitBatch', { kind: kind || 0, root, count }); },
  async commitSeed(batchId, seedHash) { return relay('commitSeed', { batchId, seedHash }); },
  async revealSeed(batchId, seed) { return relay('revealSeed', { batchId, seed }); },

  // Permissionless upkeep: expires a stale plan on-chain and heals the lives
  // pool to the approved ladder (L0 5 / L1 10 / L2 15 / L3 20).
  async upkeep(playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) return null;
    return relay('upkeep', { player });
  },

  // Money actions require the operator token (fail-closed on the server).
  async creditPremium(player, points, creditRef, token) { return relay('creditPremium', { player, points, creditRef }, token); },
  async activatePlan(player, level, planDays, token) { return relay('activatePlan', { player, level, planDays: planDays || 30 }, token); },
  async activateBooster(player, planHours, token) { return relay('activateBooster', { player, planHours: planHours || 72 }, token); },
};
