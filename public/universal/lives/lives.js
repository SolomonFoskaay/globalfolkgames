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
        return !!(v && v.active === true && (v.level || 0) >= 2);
    }

    function totalForLevel() {
        return isPremiumActive() ? PREMIUM_LIVES : FREE_LIVES;
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
        var total = totalForLevel();
        var used = usedToday();
        return {
            livesLeft: Math.max(0, total - used),
            totalForLevel: total,
            resetsInMs: msUntilUtcMidnight(),
        };
    }

    // Consume one life (called on a completed match — the module wires this to
    // the seam below). Returns true if a life was actually consumed.
    function consume() {
        var s = slice();
        var day = utcDayKey();
        if (s.day !== day) { s.day = day; s.used = 0; }
        var total = totalForLevel();
        if (s.used >= total) { persist(); notify(); return false; }
        s.used = (s.used || 0) + 1;
        persist();
        notify();
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
        for (var i = 0; i < leftEls.length; i++) leftEls[i].textContent = view.livesLeft;
        for (var j = 0; j < totalEls.length; j++) totalEls[j].textContent = view.totalForLevel;
        for (var k = 0; k < resetEls.length; k++) resetEls[k].textContent = view.resetsInMs;
    }

    function render() {
        fillSlots();
        notify();
    }

    // ---- M2 seam (the one plug) --------------------------------------------
    // A completed match consumes one life. Dedupe guards against the seam's
    // onGameResult handlers AND the gfg:game-result DOM event both landing for
    // the same finish (they fire together in publishGameResult).
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
        consume();
    }

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

    // ---- public API ---------------------------------------------------------
    window.gfgLives = {
        // PURE cache read of the lives pool for the current UTC day.
        get: get,
        // Manually consume a life. The module auto-consumes on completed matches
        // via the seam; a game can call this directly only for a match it knows
        // finished (it is idempotent per UTC day by the used counter).
        consume: consume,
        subscribe: subscribe,
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