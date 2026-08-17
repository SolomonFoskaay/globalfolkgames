// public/universal/ledgers/global-ledger.js
// M4 — GLOBAL LEDGERS MODULE (universal, game-agnostic).
//
// Consumes the universal result seam (M2): subscribes to window.onGameResult
// ONCE and credits the player's GLOBAL POINTS PDA for verified user-seat wins.
// A game never ships reward code — ANY M1 game plugs in here by emitting the
// same envelope; this module owns the global scoring logic and the 3-ledger
// on-chain API.
//
// On-chain: GlobalPoints PDA (seed [gfgpoints, 'global', player]) holding
// THREE tracks gasless on the MagicBlock ER:
//   - global_pure_lifetime      (M4a: sum of verified game wins across all games,
//                                no multiplier, no bonus — honest skill total)
//   - global_lifetime           (M4b: every point earned from any source, unspendable
//                                permanent reputation number)
//   - global_spendable_balance  (M4c: spendable track, goes up and down)
//
// Flow-up contract (multiplier-blind):
//   - kind 0 (GAME WIN): credits M4a pure + M4b lifetime + M4c spendable.
//   - kind 1 (OTHER — signup/referral/giveaway/tier_boost): credits M4b + M4c
//     only. M4a pure is never multiplied or bonus-inflated.
//   The Active Tier multiplier (M5) applies as a SEPARATE kind-1 credit, so
//   M4a pure can NEVER be multiplied by construction.
//
// Exposes window.globalLedger = { get(), credit({...}), spend(amount, reason,
// ref), subscribe(cb), lastCredit, lastSeenCredit, lastError, clearTransient() }
// and fills any DOM slot marked data-global-pure / data-global-lifetime /
// data-global-spendable on any page.
(function () {

    // Per-game scoring table — mirrors M3's config so M4a pure = sum of M3
    // local wins. Adding a game = add its table here; the game only emits
    // the seam. Source tag = the on-chain source_tag string.
    var GAMES = {
        ludo: {
            sourceTag: 'Ludo',
            positions: {
                4: { 1: 100, 2: 50, 3: 10, 4: 0 },
                2: { 1: 100, 2: 0 },
            },
            reasons: { win1st: 1 },
        },
    };

    // Client-side dedup (in-memory + localStorage) so a reload or duplicate
    // seam event never double-credits. The program also guards via
    // last_match_ref on-chain; this is the cheap client layer.
    var PROCESSED_KEY = 'gfg_global_ledger_processed_v1';
    var processed = {};
    try {
        processed = JSON.parse(window.localStorage.getItem(PROCESSED_KEY) || '{}') || {};
    } catch (e) { processed = {}; }

    function persistProcessed() {
        try { window.localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed)); } catch (e) { /* ignore */ }
    }

    var cached = null;        // latest known ledger snapshot
    var subscribers = [];     // callbacks invoked after a credit / spend / refresh
    var lastCredit = null;    // last successfully credited (shown by ceremonies)
    var lastSeenCredit = null; // credit computed for the most recent finish
    var lastError = null;     // last credit failure reason

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function configFor(gameId) {
        return GAMES[gameId] || null;
    }

    // The 'user' seat earns AT ITS OWN finishing position, same as M3.
    function computeAward(env) {
        var cfg = configFor(env.gameId);
        if (!cfg) return null;
        var user = null;
        for (var i = 0; i < env.players.length; i++) {
            if (env.players[i].actor === 'user') { user = env.players[i]; break; }
        }
        if (!user) return null;
        if (typeof user.position !== 'number') return null;
        var n = env.players.length;
        var mode = n <= 2 ? 2 : 4;
        var table = cfg.positions[mode] || cfg.positions[4] || {};
        var points = table[user.position] || 0;
        if (points <= 0) return null;
        return {
            sourceTag: cfg.sourceTag,
            points: points,
            reason: cfg.reasons.win1st,
            position: user.position,
        };
    }

    function matchRefFor(proofSig) {
        if (!proofSig) return '0';
        try {
            if (window.magicblockDice && typeof window.magicblockDice.matchRefFromSignature === 'function') {
                return String(window.magicblockDice.matchRefFromSignature(proofSig));
            }
        } catch (e) { /* fall through to base58 math */ }
        try {
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
        return !!(window.magicblockDice && typeof window.magicblockDice.recordGlobalPoints === 'function');
    }

    async function refreshLedger() {
        try {
            if (window.magicblockDice && typeof window.magicblockDice.fetchGlobalPointsPda === 'function') {
                var ledger = await window.magicblockDice.fetchGlobalPointsPda();
                if (ledger) {
                    cached = ledger;
                    fillSlots(ledger);
                    notify(ledger);
                    return ledger;
                }
            }
        } catch (e) { /* ledger not readable yet */ }
        return cached || null;
    }

    // Bank a verified finish into the GLOBAL ledger. Soft-fail: never throws
    // to the game. Uses kind=0 (GAME WIN) to credit all 3 ledgers.
    // Resilient: 3x retry (idempotent via DuplicateMatchRef), confirm-timeout
    // read-back recovery.
    async function bank(env) {
        var award = computeAward(env);
        if (!award) return null;
        lastSeenCredit = award;
        var proofSig = env.proof && env.proof.signature;
        if (!proofSig) {
            lastError = 'finish has no on-chain proof signature';
            console.warn('[global-ledger] finish has no on-chain proof signature — not crediting', env.gameId);
            return null;
        }
        var matchRef = matchRefFor(proofSig);
        if (processed[matchRef]) {
            lastError = null;
            lastCredit = {
                sourceTag: award.sourceTag,
                points: award.points,
                position: award.position,
                reason: award.reason,
                kind: 0,
                matchRef: matchRef,
                at: Date.now(),
            };
            notify(cached, lastCredit);
            return null;
        }
        if (!magicReady()) {
            for (var attempt = 0; attempt < 5; attempt++) {
                await new Promise(function (r) { setTimeout(r, 800); });
                if (magicReady()) break;
            }
            if (!magicReady()) {
                lastError = 'magicblockDice not ready';
                console.warn('[global-ledger] magicblockDice not ready — skipping credit', env.gameId);
                return null;
            }
        }

        // Notify subscribers the credit is in-flight.
        notify(null, {
            sourceTag: award.sourceTag,
            points: award.points,
            position: award.position,
            reason: award.reason,
            kind: 0,
            matchRef: matchRef,
            status: 'banking',
            at: Date.now(),
        });

        var attempts = 0;
        var lastErr = null;
        while (attempts < 3) {
            attempts++;
            try {
                // kind=0: GAME WIN — credits M4a pure + M4b lifetime + M4c spendable
                var sig = await window.magicblockDice.recordGlobalPoints(
                    0, award.sourceTag, award.points, award.reason, matchRef,
                );
                processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
                persistProcessed();
                lastError = null;
                lastCredit = {
                    sourceTag: award.sourceTag,
                    points: award.points,
                    position: award.position,
                    reason: award.reason,
                    kind: 0,
                    matchRef: matchRef,
                    at: Date.now(),
                };
                console.log('[global-ledger] credited ' + award.points + 'pt (' + award.sourceTag + ' ' + award.position + 'st place, kind=0 game win) — ' + (sig || 'no sig'));
                var ledger = await refreshLedger();
                notify(ledger, lastCredit);
                return sig || null;
            } catch (e) {
                lastErr = (e && (e.message || e)) || String(e);
                console.warn('[global-ledger] credit attempt ' + attempts + '/3 failed (soft-fail):', lastErr);
                if (attempts < 3) await new Promise(function (r) { setTimeout(r, 1200); });
            }
        }

        // Every attempt errored — re-read to check if the write landed anyway.
        var reLedger = await refreshLedger();
        if (reLedger && String(reLedger.lastMatchRef || '') === String(matchRef)) {
            lastError = null;
            lastCredit = {
                sourceTag: award.sourceTag,
                points: award.points,
                position: award.position,
                reason: award.reason,
                kind: 0,
                matchRef: matchRef,
                at: Date.now(),
            };
            processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
            persistProcessed();
            notify(reLedger, lastCredit);
            return null;
        }
        lastError = lastErr || 'on-chain write failed after retries';
        console.warn('[global-ledger] credit failed after retries:', lastError);
        notify(reLedger, {
            sourceTag: award.sourceTag,
            points: award.points,
            position: award.position,
            reason: award.reason,
            kind: 0,
            matchRef: matchRef,
            status: 'failed',
            error: lastError,
            at: Date.now(),
        });
        return null;
    }

    function fillSlots(ledger) {
        var pureEls = document.querySelectorAll('[data-global-pure]');
        var lifeEls = document.querySelectorAll('[data-global-lifetime]');
        var spendEls = document.querySelectorAll('[data-global-spendable]');
        var lastEls = document.querySelectorAll('[data-global-last]');
        for (var i = 0; i < pureEls.length; i++) pureEls[i].textContent = ledger.pureLifetime || 0;
        for (var j = 0; j < lifeEls.length; j++) lifeEls[j].textContent = ledger.lifetime || 0;
        for (var k = 0; k < spendEls.length; k++) spendEls[k].textContent = ledger.spendableBalance || 0;
        for (var m = 0; m < lastEls.length; m++) {
            lastEls[m].textContent = ledger.lastPoints ? ('+ ' + ledger.lastPoints + ' pts') : '\u2014';
        }
    }

    function notify(ledger, credit) {
        subscribers.slice().forEach(function (cb) {
            try { cb(ledger || cached, credit || null); } catch (e) { /* ignore */ }
        });
    }

    // ---- public API -----------------------------------------------------
    window.globalLedger = {
        // Latest known ledger snapshot (or null). Refreshes on-chain in background.
        get: function () {
            if (cached) refreshLedger();
            return cached || null;
        },
        // Blocking fetch of the global ledger (own account, gasless).
        fetch: function () {
            return refreshLedger();
        },
        // Programmatic credit (for M5 tier boost, M6 signup/referral/giveaway).
        // kind: 0 = game win, 1 = other. source: human-readable source tag.
        // Points, reason, matchRef: same as the on-chain instruction.
        credit: async function (opts) {
            if (!magicReady()) return null;
            var kind = opts.kind != null ? opts.kind : 1;
            var source = opts.source || 'platform';
            var points = opts.points || 0;
            var reason = opts.reason || 0;
            var matchRef = opts.matchRef || '0';
            try {
                var sig = await window.magicblockDice.recordGlobalPoints(
                    kind, source, points, reason, matchRef,
                );
                await refreshLedger();
                return sig || null;
            } catch (e) {
                console.warn('[global-ledger] credit failed (soft-fail):', e.message || e);
                return null;
            }
        },
        // Global spendable draw-down. Soft-fail.
        spend: async function (amount, reason, ref) {
            if (!magicReady()) return null;
            try {
                var sig = await window.magicblockDice.spendGlobal(amount, reason, ref);
                await refreshLedger();
                return sig || null;
            } catch (e) {
                console.warn('[global-ledger] spend failed (soft-fail):', e.message || e);
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
        get lastCredit() { return lastCredit; },
        get lastSeenCredit() { return lastSeenCredit; },
        get lastError() { return lastError; },
        clearTransient: function () {
            lastCredit = null;
            lastSeenCredit = null;
            lastError = null;
        },
    };

    // ---- seam subscription (the one plug) -------------------------------
    if (window.onGameResult) {
        window.onGameResult(function (env) {
            if (env && env.schema === 'gfg:game-result@1') bank(env);
        });
    }

    // Fill static DOM slots once the page settles.
    document.addEventListener('DOMContentLoaded', function () {
        refreshLedger();
    });

    // Re-fetch when auth changes (sign-in / sign-out on the same page).
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', function () {
            refreshLedger();
        });
    }

})();
