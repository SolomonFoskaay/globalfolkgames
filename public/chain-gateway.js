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
      if (chain() === 'evm') { const a = adapter(); if (a) return a.settleGame('0x' + String(matchRef).padStart(64, '0'), '0x' + String(points).padStart(64, '0')); return null; }
      return (mb() && mb().recordResult) ? mb().recordResult(finishOrder, points, reason, matchRef) : null;
    },
  };
})();
