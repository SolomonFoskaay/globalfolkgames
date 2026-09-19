// public/chain-gateway.js — one game-facing gateway, two chains (arcv2m16).
//
// Games call window.gfgChain instead of a chain directly. It dispatches:
//   svm: the Solana MagicBlock ER path (unchanged, just bypassed for Arc).
//   evm: the Arc path, GlobalFolkGames Batched Settlement (GFG-BS): rolls from
//        the committed dice seed, lives and points through the self-hosted
//        relayer, result settled on Arc.
//
// The active chain is window.GFG_CHAIN, set by the page bootstrap from the
// build-time VITE_GFG_CHAIN (default svm, so the live flow is untouched).
(function () {
  function chain() { return String(window.GFG_CHAIN || 'svm').toLowerCase(); }
  function adapter() { return window.gfgChainAdapter || null; }
  function mb() { return window.magicblockDice || null; }

  async function relay(action, params, token) {
    const res = await fetch('/api/arc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params: params || {}, token }),
    });
    let j = null; try { j = await res.json(); } catch (e) { j = { ok: false, error: 'bad response' }; }
    if (!res.ok || !j.ok) throw new Error(j.error || ('relay ' + res.status));
    return j;
  }

  window.gfgChain = {
    chain,
    isArc: function () { return chain() === 'evm'; },
    label: function () {
      return chain() === 'evm'
        ? 'GlobalFolkGames Batched Settlement randomness on Arc Blockchain'
        : 'MagicBlock ER VRF on Solana Blockchain';
    },
    shortLabel: function () {
      return chain() === 'evm' ? 'on-chain (Arc)' : 'on-chain (MagicBlock ER VRF)';
    },

    available: function () {
      if (chain() === 'evm') return !!adapter() || true; // relayer is a plain fetch
      return !!(mb() && mb().available && mb().available());
    },

    ping: async function () {
      if (chain() === 'evm') {
        try { await relay('readPlayer', { player: '0x000000000000000000000000000000000000dEaD', tag: 'ludo' }); return true; }
        catch (e) { return false; }
      }
      return (mb() && mb().ping) ? mb().ping() : false;
    },

    // Returns [roll1, roll2] on both chains (the game expects an array).
    roll: async function () {
      if (chain() === 'evm') {
        const a = adapter();
        const player = (a && a.walletAddress && a.walletAddress()) || null;
        const counter = (window.__gfgRollCounter = (window.__gfgRollCounter || 0) + 1);
        const gameId = (window.__gfgGameId = window.__gfgGameId || ('0x' + Date.now().toString(16).padStart(64, '0')));
        const j = await relay('rollDice', { gameId: gameId, counter: counter, player: player });
        window.__gfgLastArcRoll = j;
        return [j.roll1, j.roll2];
      }
      return mb().roll();
    },

    getLastProofRollSignature: function () {
      if (chain() === 'evm') return null; // the proof is the seed reveal at window close
      return (mb() && mb().getLastProofRollSignature) ? mb().getLastProofRollSignature() : null;
    },
    getLastDiceDelegationSignature: function () {
      if (chain() === 'evm') return null;
      return (mb() && mb().getLastDiceDelegationSignature) ? mb().getLastDiceDelegationSignature() : null;
    },

    // Lazy migration: when a player who was on Solana logs in and gets an EVM
    // wallet, ask the relayer to copy their Solana points to Arc. The relayer
    // verifies the wallet mapping itself; the client sends only the address.
    migrateMe: async function () {
      if (chain() !== 'evm') return { ok: false, reason: 'not arc' };
      var a = adapter();
      var addr = (a && a.walletAddress && a.walletAddress()) || null;
      if (!addr) return { ok: false, reason: 'no evm wallet' };
      try { return await relay('migrateMe', { evmAddress: addr }); }
      catch (e) { console.warn('[gfgChain] migrateMe failed (soft):', e && e.message); return { ok: false, error: String(e && e.message) }; }
    },

    chargeLife: async function (matchRef) {
      if (chain() === 'evm') { const a = adapter(); if (a) return a.chargeLife(matchRef); return null; }
      return null; // Solana charges the life on-chain at begin/join
    },
    recordPoints: async function (gameTag, points, reason, matchRef, playerPubkey) {
      if (chain() === 'evm') { const a = adapter(); if (a) return a.recordPoints(gameTag, points, reason, matchRef, playerPubkey); return null; }
      return (mb() && mb().recordPoints) ? mb().recordPoints(gameTag, points, reason, matchRef, playerPubkey) : null;
    },
    recordGlobal: async function (kind, sourceCode, points, reason, matchRef, playerPubkey) {
      if (chain() === 'evm') { const a = adapter(); if (a) return a.recordGlobal(kind, points, matchRef, playerPubkey); return null; }
      return (mb() && mb().recordGlobalPoints) ? mb().recordGlobalPoints(kind, sourceCode, points, reason, matchRef, playerPubkey) : null;
    },
    matchRefFromSignature: function (sig) {
      if (chain() === 'evm') return Date.now();
      return (mb() && mb().matchRefFromSignature) ? mb().matchRefFromSignature(sig) : 0;
    },
    recordResult: async function (finishOrder, points, reason, matchRef) {
      if (chain() === 'evm') {
        // BATCHED: add this game as a leaf to the settle window instead of its
        // own transaction. One wallet address per game, verified by Merkle proof
        // when the window flushes (on N games or T time).
        const a = adapter();
        const player = (a && a.walletAddress && a.walletAddress()) || null;
        const gameId = '0x' + String(matchRef).padStart(64, '0');
        const resultHash = '0x' + String(points).padStart(64, '0');
        if (!player) return null;
        try {
          const r = await relay('enqueueResult', { kind: 'settle', gameId, resultHash, points: points || 0, player, windowMs: 24 * 3600 * 1000, maxGames: 100 });
          window.__gfgLastBatch = r;
          return r;
        } catch (e) { console.warn('[gfgChain] enqueueResult failed (soft):', e && e.message); return null; }
      }
      return (mb() && mb().recordResult) ? mb().recordResult(finishOrder, points, reason, matchRef) : null;
    },

    // On-chain proof for a game in the last flushed window (verify card).
    batchProof: async function (matchRef) {
      if (chain() !== 'evm') return null;
      const gameId = '0x' + String(matchRef).padStart(64, '0');
      try { return await relay('batchProof', { kind: 'settle', gameId }); } catch (e) { return null; }
    },
  };
  // Fire the lazy migration once per session when on Arc and a wallet exists.
  try {
    var ran = false;
    function maybeMigrate() {
      if (ran) return;
      if (!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc())) return;
      var a = window.gfgChainAdapter;
      if (!a || !a.walletAddress || !a.walletAddress()) return;
      ran = true;
      window.gfgChain.migrateMe().then(function (r) { if (r && r.migrated) console.log('[gfgChain] points migrated to Arc:', r.points); });
    }
    window.addEventListener('load', function () { setTimeout(maybeMigrate, 1500); });
    window.addEventListener('gfg:auth-changed', function () { setTimeout(maybeMigrate, 1200); });
  } catch (e) { /* soft */ }
})();
