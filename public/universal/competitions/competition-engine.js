// public/universal/competitions/competition-engine.js
// M7 — EARN COMPETITION ENGINE (universal, game-agnostic, R17/R18).
//
// Listens on the SAME M2 seam (window.onGameResult) the rewards use, and for
// every OPEN competition whose games[] includes the finished game and whose
// window is live ([starts_at, ends_at]) it records the verified win to the
// server-side window-fresh ledger (proof sig kept, so every row is checkable).
// Final Points (Total x live plan boost: L3 1.5 / L2 1.0, L1 hidden-not-removed)
// are computed server-side at board time — the admin settles from that board.
//
// Emits window.gfgCompetitions:
//   refresh()/list() -> all on-chain competition instances
//   active()        -> open though not started/ended
//   live()          -> currently-open windows
//   enter(comp)     -> gate (any-of tier_bits) + spendable entry + ledger entry
//   board(creator,seq) -> {board:[{position,wallet,totalPoints,finalPoints,...}], hidden:[...]}
//   subscribe(cb)
(function () {
    'use strict';
    if (window.gfgCompetitions) return;
    window.gfgCompetitions = {};

    var TAG_TO_SOURCE = { ludo: 1, ayo_olopon: 2 }; // M1 source-code registry (add games here as they ship)
    var SOURCE_TO_TAG = { 1: 'ludo', 2: 'ayo_olopon' };
    var subs = [];
    var cache = null; // { competitions: [] }

    function wallet() {
        try {
            var w = window.getDynamicSolanaWallet ? window.getDynamicSolanaWallet() : null;
            if (!w && window.currentProfile && window.currentProfile.solana_wallet) w = window.currentProfile.solana_wallet;
            if (!w) return null;
            return (typeof w === 'string') ? w : (w.address || String(w));
        } catch (e) { return null; }
    }
    function currentLevel() {
        try {
            var a = (window.activeTier && typeof window.activeTier.get === 'function') ? window.activeTier.get() : null;
            if (a && a.level) return a.level;
            var p = (window.premiumPoints && typeof window.premiumPoints.get === 'function') ? window.premiumPoints.get() : null;
            var lvl = Number(p && p.subscriptionLevel ? p.subscriptionLevel : 0);
            return (lvl > 0 && Number(p.subscriptionActiveUntil || 0) > Date.now()) ? lvl : 0;
        } catch (e) { return 0; }
    }
    function tierOk(comp) {
        var lvl = currentLevel();
        return lvl > 0 && !!(comp.tierBits & (1 << lvl));
    }

    async function refresh() {
        try {
            const r = await fetch('/api/competitions', { cache: 'no-store' });
            const j = await r.json();
            if (j && Array.isArray(j.competitions)) cache = j.competitions;
        } catch (e) { /* cached */ }
        notify();
        return cache || [];
    }
    async function list() { if (!cache) await refresh(); return cache || []; }
    function active() { return (cache || []).filter(c => c.status === 0); }
    function live() {
        var now = Date.now();
        return active().filter(c => now >= c.startsAt * 1000 && now <= c.endsAt * 1000);
    }

    async function board(creator, seq) {
        const r = await fetch('/api/competitions?seq=' + seq + '&board=1' + (creator ? '&creator=' + encodeURIComponent(creator) : ''), { cache: 'no-store' });
        return (await r.json()) || null;
    }

    async function enter(comp) {
        var w = wallet();
        if (!w) return { ok: false, error: 'signin' };
        if (!tierOk(comp)) return { ok: false, error: 'tier' };
        var ref = 'comp|' + (comp.creator || '') + '|' + comp.seq + '|' + w;
        var fam = comp.entryFamilies || 0;
        sortFamily: {
            if (fam & 1 && window.globalLedger && typeof window.globalLedger.spend === 'function') {
                var s1 = await window.globalLedger.spend(comp.entryCost, 30, ref);
                if (s1) break sortFamily;
            }
            if (fam & 4 && window.premiumPoints && typeof window.premiumPoints.spend === 'function') {
                var s2 = await window.premiumPoints.spend(comp.entryCost, 30, ref);
                if (s2) break sortFamily;
            }
            if (fam & 2 && window.localPoints && typeof window.localPoints.spend === 'function') {
                var s3 = await window.localPoints.spend(comp.entryCost, 30, ref);
                if (s3) break sortFamily;
            }
            return { ok: false, error: 'no eligible spendable family' };
        }
        try {
            const r = await fetch('/api/competitions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'enter', creator: comp.creator || null, seq: comp.seq, wallet: w }) });
            const j = await r.json();
            return { ok: !!(j && (j.entered || j.already)), already: !!(j && j.already) };
        } catch (e) { return { ok: true, already: false }; }
    }

    // Record a finished match to live windows (M2 seam, once).
    function onFinish(env) {
        try {
            if (!env || env.schema !== 'gfg:game-result@1') return;
            var w = wallet();
            if (!w) return;
            var gameCode = TAG_TO_SOURCE[env.gameId];
            if (!gameCode) return;
            var proofSig = env.proof && env.proof.signature;
            if (!proofSig) return;
            var ts = Math.floor((env.finishedAt || Date.now()) / 1000);
            var windows = (cache || []).filter(function (c) {
                return c.status === 0 && (c.games || []).indexOf(gameCode) !== -1 && ts >= c.startsAt && ts <= c.endsAt;
            });
            windows.forEach(function (c) {
                fetch('/api/competitions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'win', creator: c.creator || null, seq: c.seq, wallet: w, ts: ts, proofSig: proofSig, game: env.gameId }) }).catch(function () {});
            });
        } catch (e) { /* ignore */ }
    }

    function subscribe(cb) { if (typeof cb === 'function') subs.push(cb); return function () { subs = subs.filter(x => x !== cb); }; }
    function notify() { subs.slice().forEach(function (cb) { try { cb(cache); } catch (e) {} }); }

    window.gfgCompetitions = {
        refresh, list, active, live, board, enter, subscribe,
        tierOk, currentLevel, wallet,
        sourceCodeFor: function (tag) { return TAG_TO_SOURCE[tag]; },
        sourceTagFor: function (code) { return SOURCE_TO_TAG[code]; },
    };

    if (window.onGameResult) window.onGameResult(onFinish);
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:game-result', function (e) { onFinish(e && e.detail); });
        window.addEventListener('gfg:auth-changed', function () { cache = null; refresh(); });
    }
    refresh();
})();