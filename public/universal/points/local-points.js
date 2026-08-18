// public/universal/points/local-points.js
// M3 — LOCAL POINTS MODULE (universal, game-agnostic).
//
// Consumes the universal result seam (M2): subscribes to window.onGameResult
// ONCE and banks local points for the 'user' seat from verified finishes.
// A game never ships reward code — ANY M1 game (Ludo, Ayo Olopon, ...) plugs in
// here by emitting the same envelope; this module owns the per-game scoring
// table, the two-track on-chain ledger and the DOM slots.
//
// On-chain: per-game PlayerPoints PDA (seed [gfgpoints, game_tag, player])
// holding BOTH tracks gasless on the MagicBlock ER:
//   - local_pure_lifetime     (unspendable lifetime wins in that game)
//   - local_spendable_balance (the spendable split, drawn only by that game's
//                              own in-game spends via localPoints.spend)
//
// Gating: a finish only banks when the envelope carries a valid on-chain
// proof signature (proof-of-play). match_ref = first 8 bytes of that signature
// binds the award to the exact winning roll and makes the bank idempotent.
//
// Exposes window.localPoints = { get(gameTag), spend(gameTag, amount, reason,
// ref), subscribe(cb) } and fills any DOM slot marked data-local-points-pure /
// data-local-points-spendable on any game page.
(function () {

    var DEFAULT_TAG = 'ludo';

    // Per-game scoring table (M3 module config — the GAME never knows points
    // rules; adding a game = add its table here, the game only emits the seam).
    // key = gameId from the M2 envelope. gameTag = the on-chain seed tag.
    var GAMES = {
        ludo: {
            gameTag: 'ludo',
            // Ranked rewards by position, 1-indexed, per mode (players length).
            // 4P graduated: 1st=100 / 2nd=50 / 3rd=10 / 4th=0. The game auto-ends
            // once 3 winners emerge, so the last seat earns nothing. 2P: the
            // game auto-ends the moment 1st emerges, so 2nd earns nothing too.
            positions: {
                4: { 1: 100, 2: 50, 3: 10, 4: 0 },
                2: { 1: 100, 2: 0 },
            },
            reasons: { win1st: 1, win2nd: 2, win3rd: 3 },
        },
    };

    // Track which match_refs were already banked (in-memory + localStorage) so
    // a reload or duplicate seam event never double-banks. The program also
    // guards via last_match_ref on-chain; this is the cheap client-side layer.
    var PROCESSED_KEY = 'gfg_local_points_processed_v1';
    var processed = {};
    try {
        processed = JSON.parse(window.localStorage.getItem(PROCESSED_KEY) || '{}') || {};
    } catch (e) { processed = {}; }

    function persistProcessed() {
        try { window.localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed)); } catch (e) { /* ignore */ }
    }

    // Ledger cache, keyed by WALLET so a shared browser never shows one signed-in
    // user's numbers to another. cacheStore = { <wallet> : { gameTag: ledger } }.
    var CACHE_KEY = 'gfg_local_points_cache_v2';
    var cacheStore = {};
    var cached = {};        // current wallet's gameTag -> ledger snapshot
    var subscribers = [];   // callbacks invoked after a bank / spend / refresh
    var lastAward = null;   // last successfully banked award (shown by ceremonies)
    var lastSeenAward = null; // award computed for the most recent finish (shown as "banking..." before it lands)
    var lastError = null;   // last bank failure reason (ceremony shows it when the write hiccups)

    // Best-known caller identity for cache isolation: the Dynamic Solana wallet
    // address when available, else the profile wallet, else 'anon'.
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

    function loadCache() {
        try {
            var raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
            if (typeof raw === 'object') cacheStore = raw;
        } catch (e) { cacheStore = {}; }
    }

    // Point `cached` at the current wallet's slice (empty until that wallet's
    // ledger has been fetched).
    function syncCacheToWallet() {
        var wk = walletKey();
        cached = (cacheStore[wk] && typeof cacheStore[wk] === 'object') ? cacheStore[wk] : {};
    }

    loadCache();
    syncCacheToWallet();

    function persistCache() {
        try {
            var wk = walletKey();
            if (!cacheStore[wk]) cacheStore[wk] = {};
            cacheStore[wk] = cached;
            localStorage.setItem(CACHE_KEY, JSON.stringify(cacheStore));
        } catch (e) { /* ignore */ }
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Resolve the points module config for an envelope's gameId. Unknown games
    // are ignored (no scoring table yet = no points).
    function configFor(gameId) {
        return GAMES[gameId] || null;
    }

    // The 'user' seat earns AT ITS OWN finishing position, and only the user
    // seat ever earns (house/local seats earn nothing regardless of position).
    function computeAward(env) {
        var cfg = configFor(env.gameId);
        if (!cfg) return null;
        var user = null;
        for (var i = 0; i < env.players.length; i++) {
            if (env.players[i].actor === 'user') { user = env.players[i]; break; }
        }
        if (!user) return null;                      // no signed-in 'You' seat
        if (typeof user.position !== 'number') return null;
        var n = env.players.length;
        var mode = n <= 2 ? 2 : 4;
        var table = cfg.positions[mode] || cfg.positions[4] || {};
        var points = table[user.position] || 0;
        if (points <= 0) return null;                // nothing to bank
        // Position-aware reason: 1st=WIN_1ST, 2nd=WIN_2ND, 3rd=WIN_3RD (the
        // program stores any u8; the old code labelled every placed finish
        // WIN_1ST, which mislabelled 2nd/3rd awards).
        var reason = cfg.reasons.win1st;
        if (cfg.reasons.win2nd && user.position === 2) reason = cfg.reasons.win2nd;
        if (cfg.reasons.win3rd && user.position === 3) reason = cfg.reasons.win3rd;
        return {
            gameTag: cfg.gameTag,
            points: points,
            reason: reason,
            position: user.position,
            at: Date.now(),
        };
    }

    // Match-ref from the proof signature (first 8 bytes as u64) — matches the
    // client's matchRefFromSignature used by the game's own reward wiring.
    function matchRefFor(proofSig) {
        if (!proofSig) return '0';
        try {
            if (window.magicblockDice && typeof window.magicblockDice.matchRefFromSignature === 'function') {
                return String(window.magicblockDice.matchRefFromSignature(proofSig));
            }
        } catch (e) { /* fall through to base58 math */ }
        try {
            // bs58-free fallback: decode the first 8 bytes into a u64 string.
            var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
            var bytes = [];
            for (var i = 0; i < proofSig.length; i++) {
                var c = ALPHABET.indexOf(proofSig[i]);
                if (c < 0) return '0';
                for (var j = 0; j < bytes.length; j++) bytes[j] = bytes[j] * 58 + c;
                bytes.unshift(c);
            }
            while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
            var out = 0n;
            var order = 1n;
            for (var k = 0; k < bytes.length && k < 8; k++) {
                out += BigInt(bytes[k]) * order;
                order *= 256n;
            }
            return out.toString();
        } catch (e) { return '0'; }
    }

    function magicReady() {
        return !!(window.magicblockDice && typeof window.magicblockDice.recordPoints === 'function');
    }

    async function refreshLedger(gameTag) {
        try {
            if (window.magicblockDice && typeof window.magicblockDice.fetchPointsPda === 'function') {
                var ledger = await window.magicblockDice.fetchPointsPda(gameTag);
                if (ledger) {
                    cached[gameTag] = ledger;
                    persistCache();
                    fillSlots(gameTag, ledger);
                    notify(gameTag, ledger);
                    return ledger;
                }
            }
        } catch (e) { /* ledger not readable yet (not onboarded / wallet busy) */ }
        // Not readable this instant (wallet not restored, ER down): still render
        // the last-known value so the DOM never sits on static 0 / em-dash while
        // the player waits for the fetch to become possible.
        var fallback = cached[gameTag] || null;
        if (fallback) fillSlots(gameTag, fallback);
        return fallback;
    }

    // Bank a verified finish. Never throws to the game — M3 banking is a
    // soft-fail best-effort gasless write that must never block the win UX.
    // Resilient: retries the write (the on-chain DuplicateMatchRef guard keeps
    // retries idempotent) and, if every attempt errored, re-reads the ledger in
    // case the write actually landed (e.g. a confirm-timeout false failure).
    async function bank(env) {
        var award = computeAward(env);
        if (!award) return null;
        lastSeenAward = award;
        var proofSig = env.proof && env.proof.signature;
        if (!proofSig) {
            lastError = 'finish has no on-chain proof signature';
            console.warn('[local-points] finish has no on-chain proof signature — not banking', env.gameId);
            return null;
        }
        var matchRef = matchRefFor(proofSig);
        if (processed[matchRef]) {
            // Already banked this match_ref (e.g. the same finish fired the seam
            // twice, or a reload). Surface the earlier success to the UI anyway.
            lastError = null;
            lastAward = {
                gameTag: award.gameTag,
                points: award.points,
                position: award.position,
                reason: award.reason,
                matchRef: matchRef,
                at: Date.now(),
            };
            notify(award.gameTag, cached[award.gameTag] || null, lastAward);
            return null;
        }
        if (!magicReady()) {
            // magicblockDice not initialized yet (module script loads before
            // main.js). Retry a few times, then give up for this event.
            for (var attempt = 0; attempt < 5; attempt++) {
                await new Promise(function (r) { setTimeout(r, 800); });
                if (magicReady()) break;
            }
            if (!magicReady()) {
                lastError = 'magicblockDice not ready';
                console.warn('[local-points] magicblockDice not ready — skipping bank', env.gameId);
                return null;
            }
        }

        // Tell the win ceremony the award is being written (it opens right
        // after the seam fires, so this shows the in-flight state).
        notify(award.gameTag, null, {
            gameTag: award.gameTag, points: award.points, position: award.position,
            reason: award.reason, matchRef: matchRef, status: 'banking', at: Date.now(),
        });

        var attempts = 0;
        var lastErr = null;
        while (attempts < 3) {
            attempts++;
            try {
                var sig = await window.magicblockDice.recordPoints(
                    award.gameTag, award.points, award.reason, matchRef,
                );
                processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
                persistProcessed();
                lastError = null;
                lastAward = {
                    gameTag: award.gameTag,
                    points: award.points,
                    position: award.position,
                    reason: award.reason,
                    matchRef: matchRef,
                    at: Date.now(),
                };
                console.log('[local-points] banked ' + award.points + 'pt (ludo ' + award.position + 'st place, user seat) — ' + (sig || 'no sig'));
                var ledger = await refreshLedger(award.gameTag);
                notify(award.gameTag, ledger, lastAward);
                return sig || null;
            } catch (e) {
                lastErr = (e && (e.message || e)) || String(e);
                console.warn('[local-points] bank attempt ' + attempts + '/3 failed (soft-fail):', lastErr);
                if (attempts < 3) await new Promise(function (r) { setTimeout(r, 1200); });
            }
        }

        // Every attempt errored, but the write may have landed anyway (ER
        // confirm-timeout false failure). Re-read the ledger: if this match_ref
        // is now on-chain, treat the bank as successful.
        var reLedger = await refreshLedger(award.gameTag);
        if (reLedger && String(reLedger.lastMatchRef || '') === String(matchRef)) {
            lastError = null;
            lastAward = {
                gameTag: award.gameTag,
                points: award.points,
                position: award.position,
                reason: award.reason,
                matchRef: matchRef,
                at: Date.now(),
            };
            processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
            persistProcessed();
            notify(award.gameTag, reLedger, lastAward);
            return null;
        }
        lastError = lastErr || 'on-chain write failed after retries';
        console.warn('[local-points] bank failed after retries:', lastError);
        notify(award.gameTag, reLedger, {
            gameTag: award.gameTag, points: award.points, position: award.position,
            reason: award.reason, matchRef: matchRef, status: 'failed', error: lastError, at: Date.now(),
        });
        return null;
    }

    function fillSlots(gameTag, ledger) {
        var pureEls = document.querySelectorAll('[data-local-points-pure]');
        var spendEls = document.querySelectorAll('[data-local-points-spendable]');
        var tagEls = document.querySelectorAll('[data-local-points-game]');
        var lastEls = document.querySelectorAll('[data-local-points-last]');
        for (var i = 0; i < pureEls.length; i++) pureEls[i].textContent = ledger.pureLifetime || 0;
        for (var j = 0; j < spendEls.length; j++) spendEls[j].textContent = ledger.spendableBalance || 0;
        for (var k = 0; k < tagEls.length; k++) tagEls[k].textContent = gameTag;
        for (var m = 0; m < lastEls.length; m++) {
            lastEls[m].textContent = ledger.lastPoints ? ('+ ' + ledger.lastPoints + ' pts') : '—';
        }
    }

    function notify(gameTag, ledger, award) {
        subscribers.slice().forEach(function (cb) {
            try { cb(gameTag, ledger, award || null); } catch (e) { /* ignore */ }
        });
    }

    // ---- public API -----------------------------------------------------
    window.localPoints = {
        // Latest known ledger for a game (or null). ALWAYS triggers a
        // background refresh (stability contract: a cold page returns the cached
        // snapshot if any, and the fetch fills it in the moment the wallet is up).
        get: function (gameTag) {
            var tag = gameTag || DEFAULT_TAG;
            refreshLedger(tag);
            return cached[tag] || null;
        },
        // Blocking fetch of the ledger for a game (own account, gasless).
        fetch: function (gameTag) {
            return refreshLedger(gameTag || DEFAULT_TAG);
        },
        // Spendable draw-down for that game's own in-game spends. `ref` is the
        // purchase reference that makes the spend replayable. Soft-fail.
        spend: async function (gameTag, amount, reason, ref) {
            var tag = gameTag || DEFAULT_TAG;
            if (!magicReady()) return null;
            try {
                var sig = await window.magicblockDice.spendLocal(tag, amount, reason, ref);
                await refreshLedger(tag);
                return sig || null;
            } catch (e) {
                console.warn('[local-points] spend failed (soft-fail):', e.message || e);
                return null;
            }
        },
        // Subscribe to ledger updates. Returns an unsubscribe function.
        subscribe: function (cb) {
            if (typeof cb === 'function') subscribers.push(cb);
            return function () {
                var i = subscribers.indexOf(cb);
                if (i >= 0) subscribers.splice(i, 1);
            };
        },
        // Last successfully banked award (shown by ceremonies), or null.
        get lastAward() { return lastAward; },
        // Award computed for the most recent finish (may still be banking or
        // failed — the ceremony uses it to show the in-flight state), or null.
        get lastSeenAward() { return lastSeenAward; },
        // Last bank failure reason (null when the last bank succeeded). Useful
        // for the ceremony to explain a pending state honestly.
        get lastError() { return lastError; },
        // Forget the transient award/error state. Games call this when a new
        // match starts so a previous finish's "banked/failed" line can never
        // leak into the next ceremony.
        clearTransient: function () {
            lastAward = null;
            lastSeenAward = null;
            lastError = null;
        },
    };

    // ---- seam subscription (the one plug) -------------------------------
    if (window.onGameResult) {
        window.onGameResult(function (env) {
            if (env && env.schema === 'gfg:game-result@1') bank(env);
        });
    }

    // The game tag to display/fetch on this page (defaults to 'ludo').
    function pickGameTag() {
        var tag = DEFAULT_TAG;
        var auto = document.querySelector('[data-local-points-game]');
        if (auto) tag = auto.getAttribute('data-local-points-game') || tag;
        return tag;
    }

    // Render the current wallet's cached ledger into the DOM slots so a page
    // shows the last-known numbers even before the first fresh fetch lands.
    function renderCached(tag) {
        if (cached[tag]) fillSlots(tag, cached[tag]);
    }

    // Refresh once the module is usable AND the Dynamic session/wallet has been
    // restored. On a plain page load the wallet arrives AFTER DOMContentLoaded
    // (async session restore), and gfg:auth-changed only fires on interactive
    // sign-in/out — so without this poll the display could stay stuck on the
    // pre-sign-in value/zero forever.
    function refreshWhenWalletReady(tag, timeoutMs) {
        var deadline = Date.now() + (timeoutMs || 12000);
        (function poll() {
            if (window.magicblockDice &&
                typeof window.magicblockDice.available === 'function' &&
                window.magicblockDice.available()) {
                // The wallet just became known — re-anchor the cache to it so a
                // silently restored session swaps in the right user's numbers.
                syncCacheToWallet();
                renderCached(tag);
                refreshLedger(tag);
                return;
            }
            if (Date.now() < deadline) setTimeout(poll, 700);
        })();
    }

    function handleDomReady() {
        var tag = pickGameTag();
        renderCached(tag);
        refreshWhenWalletReady(tag);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', handleDomReady);
    } else {
        handleDomReady();
    }

    // Re-fetch when auth changes (sign-in / sign-out on the same page): the
    // ledger only becomes readable once the Dynamic wallet is available, and
    // the wallet identity change must swap the cached slice too.
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', function () {
            syncCacheToWallet();
            var tag = pickGameTag();
            renderCached(tag);
            refreshLedger(tag);
        });
    }

})();
