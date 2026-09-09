// public/universal/lives/lives.js
// M10 — LIVES MODULE (universal, game-agnostic half of M10).
//
// The free-play meter. Consumes the universal result seam (M2):
// subscribes to window.onGameResult ONCE and consumes exactly one life when a
// match COMPLETES (a finished game). Abandon, reset, and mid-game network
// disconnect never emit a completed result, so they never cost a life.
// A game never ships a lives plug — ANY M1 game (Ludo, Ayo Olopon, ...) gates
// its start against window.gfgLives.get() and this module does the rest.
//
// Boosts with an active subscription: free = 5 lives/day, Level-2 subscriber =
// 10 lives/day (5 base + 5 premium). Daily reset at GMT+00 (midnight UTC).
//
// Consumes: M2 seam (match completion), M5 window.activeTier.get() (pool size).
// Emits: window.gfgLives = { get(), consume(), subscribe(cb) }.
// DOM slots (any page): [data-lives-left], [data-lives-total],
// [data-lives-resets-ms] (used by the game UI countdown).
//
// PURITY: pure local UTF-day bookkeeping in localStorage, wallet-keyed. No RPC.
// The pool size follows the LIVE subscription view (M5 owns that read); storage
// only ever counts how many lives were consumed this UTC day.
(function () {
    var CACHE_KEY = 'gfg_lives_cache_v2';

    var FREE_LIVES = 5;
    var PREMIUM_LIVES = 10;
    var LEVEL3_LIVES = 15; // Level 2 lives pool
    var LEVEL4_LIVES = 20; // Level 3 lives pool (M5 ladder 2026-08-31)

    var store = {};
    try {
        store = JSON.parse(window.localStorage.getItem(CACHE_KEY) || '{}') || {};
    } catch (e) { store = {}; }

    var subscribers = [];
    var lastHandled = null; // dedupe seam handlers vs the DOM event (same finish)

    // ---- identity --------------------------------------------------------
    function readAddress() {
        var addr = null;
        try {
            if (window.getDynamicSolanaWallet) {
                var w = window.getDynamicSolanaWallet();
                if (w && typeof w === 'string') addr = w;
                else if (w && w.address) addr = String(w.address);
            }
        } catch (e) { /* ignore */ }
        if (!addr) {
            try {
                if (window.currentProfile && window.currentProfile.solana_wallet) addr = String(window.currentProfile.solana_wallet);
            } catch (e) { /* ignore */ }
        }
        return addr;
    }

    function walletKey() {
        try {
            if (window.getDynamicSolanaWallet) {
                var w = window.getDynamicSolanaWallet();
                if (w && typeof w === 'string') return w.toLowerCase();
                if (w && w.address) return String(w.address).toLowerCase();
            }
            if (window.currentProfile && window.currentProfile.solana_wallet) {
                return String(window.currentProfile.solana_wallet).toLowerCase();
            }
        } catch (e) { /* ignore */ }
        return 'anon';
    }

    // ---- time helpers (all UTC / GMT+00) ---------------------------------
    function utcDayKey() {
        var d = new Date();
        return d.getUTCFullYear() + '-' +
            String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
            String(d.getUTCDate()).padStart(2, '0');
    }

    // Milliseconds until the next UTC midnight (GMT+00 reset).
    function msUntilUtcMidnight() {
        var n = new Date();
        var next = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1, 0, 0, 0, 0));
        return next.getTime() - n.getTime();
    }

    // ---- subscription pool -------------------------------------------------
    function activeView() {
        try {
            if (window.activeTier && typeof window.activeTier.get === 'function') {
                return window.activeTier.get() || null;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function isPremiumActive() {
        var v = activeView();
        return !!(v && v.active === true && (v.level || 0) >= 1);
    }

    function totalForLevel() {
        // Plan-ladder (M5, config-driven): L0 5 / L1 10 / L2 15 / L3 20.
        var v = activeView();
        var lvl = v ? (v.level || 0) : 0;
        if (lvl >= 3) return LEVEL4_LIVES;
        if (lvl >= 2) return LEVEL3_LIVES;
        if (lvl >= 1) return PREMIUM_LIVES;
        return FREE_LIVES;
    }

    // ---- M5 v3 booster (72h unlimited lives) -------------------------------
    // While now < booster_active_until the lives pool is unlimited and nothing
    // is consumed. The value is the player's own premium PDA field, read by the
    // premium-ledger module (window.premiumPoints) which refreshes on auth and
    // on any premium change (credit, activate, boost).
    function boosterUntilMs() {
        try {
            var p = (window.premiumPoints && typeof window.premiumPoints.get === 'function') ? window.premiumPoints.get() : null;
            var until = Number(p && p.boosterActiveUntil ? p.boosterActiveUntil : 0);
            return until > 0 ? until : 0;
        } catch (e) { return 0; }
    }

    function isBoosterActive() {
        var until = boosterUntilMs();
        return until > 0 && until > Date.now();
    }

    // ---- storage (wallet + day scoped) ------------------------------------
    function slice() {
        var wk = walletKey();
        if (!store[wk] || typeof store[wk] !== 'object') store[wk] = { day: utcDayKey(), used: 0 };
        return store[wk];
    }

    function persist() {
        try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
    }

    function usedToday() {
        var s = slice();
        if (s.day !== utcDayKey()) {
            s.day = utcDayKey();
            s.used = 0;
            persist();
        }
        return s.used || 0;
    }

    // ---- core api -----------------------------------------------------------
    function get() {
        // M5 v3: booster active => unlimited lives until booster_active_until.
        if (isBoosterActive()) {
            var until = boosterUntilMs();
            return {
                livesLeft: 999999,
                totalForLevel: 999999,
                boosterActive: true,
                resetsInMs: Math.max(0, until - Date.now()),
                boosterUntilMs: until,
            };
        }
        var total = totalForLevel();
        var used = usedToday();
        return {
            livesLeft: Math.max(0, total - used),
            totalForLevel: total,
            resetsInMs: msUntilUtcMidnight(),
            boosterActive: false,
            boosterUntilMs: 0,
        };
    }

    // Consume one life (called on a completed match — the module wires this to
    // the seam below). Returns true if a life was actually consumed.
    function consume() {
        // M5 v3: a booster makes lives unlimited, so a completed match never
        // draws the meter while the booster runs.
        if (isBoosterActive()) { render(); return true; }
        var s = slice();
        var day = utcDayKey();
        if (s.day !== day) { s.day = day; s.used = 0; }
        var total = totalForLevel();
        if (s.used >= total) { persist(); render(); return false; }
        s.used = (s.used || 0) + 1;
        persist();
        // Re-render the [data-lives-*] slots immediately so the board bar updates
        // the instant a match completes — without a page refresh. This closes the
        // 'Play Again' exploit where a stale meter let users play unlimited games.
        render();
        return true;
    }

    function notify() {
        var view = get();
        subscribers.slice().forEach(function (cb) {
            try { cb(view); } catch (e) { /* ignore */ }
        });
    }

    function subscribe(cb) {
        if (typeof cb === 'function') subscribers.push(cb);
        return function () {
            var i = subscribers.indexOf(cb);
            if (i >= 0) subscribers.splice(i, 1);
        };
    }

    // ---- slot rendering -----------------------------------------------------
    function fillSlots() {
        var view = get();
        var leftEls = document.querySelectorAll('[data-lives-left]');
        var totalEls = document.querySelectorAll('[data-lives-total]');
        var resetEls = document.querySelectorAll('[data-lives-resets-ms]');
        var boostEls = document.querySelectorAll('[data-lives-booster-until]');
        var leftTxt = view.boosterActive ? '∞' : String(view.livesLeft);
        var totalTxt = view.boosterActive ? '∞' : String(view.totalForLevel);
        for (var i = 0; i < leftEls.length; i++) leftEls[i].textContent = leftTxt;
        for (var j = 0; j < totalEls.length; j++) totalEls[j].textContent = totalTxt;
        for (var k = 0; k < resetEls.length; k++) resetEls[k].textContent = view.resetsInMs;
        for (var q = 0; q < boostEls.length; q++) boostEls[q].textContent = view.boosterUntilMs || '';
    }

    function render() {
        fillSlots();
        notify();
    }

    // ---- M2 seam (the one plug) --------------------------------------------
    // A completed match consumes one life. Dedupe guards against the seam's
    // onGameResult handlers AND the gfg:game-result DOM event both landing for
    // the same finish (they fire together in publishGameResult).
    // M10 ON-CHAIN: the authoritative consume happens on-chain via consumeLife;
    // the local meter is then re-synced to the on-chain ledger so a) a third-
    // party frontend using the public program still pays lives, and b) our own
    // display never drifts from the chain. Soft-fail: if the chain write fails,
    // the local meter still draws (a completed game always costs a life).
    function consumeRefFor(env) {
        try {
            if (window.magicblockDice && typeof window.magicblockDice.matchRefFromSignature === 'function' &&
                env.proof && env.proof.signature) {
                var r = window.magicblockDice.matchRefFromSignature(env.proof.signature);
                if (r) return String(r);
            }
        } catch (e) { /* fall through */ }
        // Stable fallback so the same completion is always the same idempotency key.
        var src = String(env.gameId || '') + '@' + String(env.finishedAt || '');
        var h = 0x811c9dc5;
        for (var i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
        return String(h >>> 0);
    }
    function onFinish(env) {
        if (!env || env.schema !== 'gfg:game-result@1') return;
        var key = String(env.gameId || '') + '@' + String(env.finishedAt || '');
        if (lastHandled === key) return;
        lastHandled = key;
        // Only consume when the signed-in user actually played the match.
        var userPlayed = (env.players || []).some(function (p) {
            return p && p.actor === 'user';
        });
        if (!userPlayed) return;
        // On-chain authoritative consume (gasless; prevents on-chain loops).
        var md = window.magicblockDice;
        if (md && typeof md.consumeLife === 'function') {
            var refNum = consumeRefFor(env);
            md.consumeLife(String(env.gameId || ''), refNum).then(function () {
                // Sync the local meter to the on-chain ledger after the write.
                syncFromChain();
            }).catch(function () { consume(); });
        } else {
            consume();
        }
    }

    // Re-read the on-chain lives ledger and mirror it into the local meter so the
    // displayed livesLeft always matches the chain (the PROGRAM is the source of
    // truth for lives, exactly like the turn timer).
    function syncFromChain() {
        try {
            var md = window.magicblockDice;
            var addr = readAddress();
            if (!addr || !md || typeof md.readLivesFor !== 'function') return;
            md.readLivesFor(addr).then(function (r) {
                if (!r || !r.ok) return;
                var s = slice();
                s.day = r.day;
                s.used = Math.min(r.used, r.pool); // clamp to pool (could exceed after refill edge)
                persist();
                render();
            }).catch(function () { /* soft */ });
        } catch (e) { /* soft */ }
    }
    window.__gfgLivesSyncFromChain = syncFromChain;

    if (window.onGameResult) {
        window.onGameResult(onFinish);
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:game-result', function (e) { onFinish(e && e.detail); });
    }

    // ---- auto-render on wallet/auth/cross-tab changes (mirror local-points) --
    function handleDomReady() {
        render();
        refreshWhenWalletReady();
    }

    var pollActive = false;
    var lastReadWallet = null;
    function refreshWhenWalletReady(timeoutMs) {
        if (pollActive) return;
        pollActive = true;
        var deadline = Date.now() + (timeoutMs || 30000);
        (function poll() {
            var addr = readAddress();
            if (addr) {
                if (addr !== lastReadWallet) {
                    lastReadWallet = addr;
                    render();
                }
                pollActive = false;
                return;
            }
            if (Date.now() < deadline) setTimeout(poll, 700);
            else pollActive = false;
        })();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', handleDomReady);
    } else {
        handleDomReady();
    }
    if (typeof window.addEventListener === 'function') {
        ['pageshow', 'focus'].forEach(function (ev) {
            window.addEventListener(ev, function () { handleDomReady(); });
        });
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', function () {
            lastReadWallet = readAddress();
            render();
        });
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
            if (e.key !== CACHE_KEY) return;
            try { store = JSON.parse(window.localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (err) { store = {}; }
            render();
        });
    }
    // Level 2 (or a change in the sub state) changes the pool size live: re-render
    // whenever the premium ledger refreshes (activate/fetch) and when its wallet
    // cache changes in another tab.
    try {
        if (window.premiumPoints && typeof window.premiumPoints.subscribe === 'function') {
            window.premiumPoints.subscribe(function () { render(); });
        }
    } catch (e) { /* ignore */ }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
            if (e.key && e.key.indexOf('gfg_premium_ledger') >= 0) render();
        });
    }

    // ---- public API ---------------------------------------------------------
    window.gfgLives = {
        // PURE cache read of the lives pool for the current UTC day.
        get: get,
        // Manually consume a life. The module auto-consumes on completed matches
        // via the seam; a game can call this directly only for a match it knows
        // finished (it is idempotent per UTC day by the used counter).
        consume: consume,
        subscribe: subscribe,
        // Milliseconds until the next lives reset (GMT+00 midnight). Lets any
        // game show a live reset countdown in its lives bar.
        msUntilReset: msUntilUtcMidnight,
        reset: function () {
            var s = slice();
            s.day = utcDayKey();
            s.used = 0;
            persist();
            render();
            return true;
        },
    };
})();