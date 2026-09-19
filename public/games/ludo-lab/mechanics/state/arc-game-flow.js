// public/games/ludo-lab/mechanics/state/arc-game-flow.js
// arcv2m1 / GFG-BS bridge: makes the LIVE Ludo game drive the Arc on-chain game
// flow. Loaded LAST on the page, and a NO-OP unless window.gfgChain.isArc() is
// true, so the live Solana game is completely untouched.
//
// What it does, all soft-fail (never throws into game code):
//   - match start  -> openGame + seatUp(each seat) + beginGame (on-chain clock)
//   - turn pass    -> commitMove(prevSeat -> nextSeat) on the on-chain clock
//   - match finish -> settleGameOrder(full 1st..Nth finish order)
//   - deadline     -> permissionless expireTurn ONLY as a stall fallback (the
//                     local solo timer stays authoritative: on-chain turnSecs is
//                     kept slightly LONGER than the local 45s window)
//
// The chain is the source of truth; the browser is a thin display + driver.
(function () {
    var LOCAL_TURN_SECS = 45;    // the game's local human turn window
    var CHAIN_TURN_SECS = 50;    // on-chain window, longer so the local pass wins
    var POLL_MS = 1000;

    var cfg = null;
    var st = { gameId: null, seatColors: [], started: false, settled: false, lastTurn: null, expiring: false };
    var gateInFlight = false; // re-entrancy guard for the async lives gate

    function isArc() { try { return !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { return false; } }
    function wallet() { try { return (window.gfgChainAdapter && window.gfgChainAdapter.walletAddress && window.gfgChainAdapter.walletAddress()) || null; } catch (e) { return null; } }
    function seatColors() { try { var a = window.getActiveSeats ? window.getActiveSeats() : null; if (a && a.length) return a.slice(0, 4); } catch (e) {} return ['green', 'yellow', 'blue', 'red']; }
    function curTurn() { try { return (window.getGameCurrentTurn && window.getGameCurrentTurn()) || null; } catch (e) { return null; } }
    function bytes32FromNum(n) { try { return '0x' + BigInt(n).toString(16).padStart(64, '0'); } catch (e) { return '0x' + String(n).padStart(64, '0'); } }
    function orderHash(orderIdx) {
        var h = '';
        for (var i = 0; i < orderIdx.length; i++) h += (orderIdx[i] & 0xff).toString(16).padStart(2, '0');
        return '0x' + h.padEnd(64, '0');
    }
    async function loadCfg() {
        if (cfg) return cfg;
        try { cfg = await (await fetch('/arc-config.json', { cache: 'no-store' })).json(); } catch (e) { cfg = null; }
        return cfg;
    }
    function sponsor() { try { return cfg.rails.evm.sponsor; } catch (e) { return null; } }
    function ownerFor(color) {
        var isUser = !!(window.playerProfiles && window.playerProfiles[color] && window.playerProfiles[color].isUser === true);
        return isUser ? wallet() : sponsor();
    }
    function matchActive() {
        try { return !!(window.__soloTurnArmed && window.__soloTurnArmed()); } catch (e) { return false; }
    }

    // 1) MATCH START: open + seat + begin the on-chain clock.
    async function ensureStarted() {
        if (st.gameId || !matchActive()) return;
        var w = wallet(); if (!w) return;
        await loadCfg(); if (!sponsor()) return;
        var colors = seatColors();
        var gid = bytes32FromNum(window.gfgGameMatchRef || Date.now());
        st.gameId = gid; st.seatColors = colors;
        try { window.__gfgGameId = gid; } catch (e) {} // share one id with the dice seed
        try { await window.gfgChain.openGame(gid, sponsor(), 1800); } catch (e) {}
        for (var i = 0; i < colors.length; i++) {
            try { await window.gfgChain.seatUp(gid, sponsor(), i, ownerFor(colors[i])); } catch (e) {}
        }
        try { await window.gfgChain.beginGame(gid, sponsor(), colors.length, CHAIN_TURN_SECS); } catch (e) {}
        st.started = true;
        st.lastTurn = curTurn();
        console.log('[arc-flow] on-chain game opened', gid, colors.join(','));
    }

    // 2) TURN PASS: commit the move that handed the turn from prev -> now.
    async function syncTurn() {
        if (!st.started || st.settled) return;
        var turn = curTurn();
        if (!turn || turn === st.lastTurn) return;
        var colors = st.seatColors.length ? st.seatColors : seatColors();
        var prevIdx = colors.indexOf(st.lastTurn);
        var nextIdx = colors.indexOf(turn);
        st.lastTurn = turn;
        if (prevIdx < 0 || nextIdx < 0 || prevIdx === nextIdx) return;
        var mover = ownerFor(colors[prevIdx]);
        if (!mover) return;
        var commit = orderHash([prevIdx, nextIdx]);
        try { await window.gfgChain.commitMove(st.gameId, mover, prevIdx, nextIdx, commit); }
        catch (e) { console.warn('[arc-flow] commitMove soft-fail', e && e.message); }
    }

    // 3) FINISH: settle with the full finish order (called by the ceremony wrapper).
    async function finishOnchain() {
        if (!st.started || st.settled || !st.gameId) return;
        var colors = st.seatColors.length ? st.seatColors : seatColors();
        var orderColors = (window.getFinishOrder && window.getFinishOrder()) || [];
        var orderIdx = [];
        for (var i = 0; i < orderColors.length; i++) {
            var idx = colors.indexOf(orderColors[i]);
            if (idx >= 0) orderIdx.push(idx);
        }
        if (!orderIdx.length) return;
        await loadCfg(); if (!sponsor()) return;
        try {
            await window.gfgChain.settleGameOrder(st.gameId, sponsor(), orderHash(orderIdx), orderIdx);
            st.settled = true;
            console.log('[arc-flow] on-chain result settled', st.gameId, orderIdx.join(','));
        } catch (e) { console.warn('[arc-flow] settleGameOrder soft-fail', e && e.message); }
    }

    // 4) STALL FALLBACK: only if the local turn has NOT advanced past the chain
    // deadline (the local timer normally passes first and re-stamps the clock).
    async function watchDeadline() {
        if (!st.started || st.settled || st.expiring) return;
        try {
            var ts = await window.gfgChain.turnState(st.gameId);
            if (!ts || !ts.begun) return;
            var now = Math.floor(Date.now() / 1000);
            var colors = st.seatColors.length ? st.seatColors : seatColors();
            var turn = curTurn();
            if (now > ts.turnDeadline && colors[ts.activeSeat] === turn) {
                st.expiring = true;
                try { await window.gfgChain.expireTurn(st.gameId); } catch (e) {}
                setTimeout(function () { st.expiring = false; }, 8000);
            }
        } catch (e) { /* soft */ }
    }

    function wrapCeremony() {
        var orig = window.showResultCeremony;
        if (typeof orig !== 'function' || orig.__arcWrapped) return;
        window.showResultCeremony = function () {
            try { finishOnchain(); } catch (e) {}
            return orig.apply(this, arguments);
        };
        window.showResultCeremony.__arcWrapped = true;
    }

    function reset() { st = { gameId: null, seatColors: [], started: false, settled: false, lastTurn: null, expiring: false }; }

    // 5) LIVES GATE: the CHAIN is the authority. Before the local board starts,
    // await chargeLife. If the contract reverts (NoLives) the match is blocked
    // with the lives overlay; a modified client cannot skip it, because the
    // charge is what lets the game proceed. A transient network error does NOT
    // hard-block play (the local meter still gates), matching the soft-fail
    // contract everywhere else in the Arc rail.
    function blockNoLives() {
        try {
            if (typeof window.showLivesBlocked === 'function') window.showLivesBlocked(true);
            else if (typeof window.showAuthBanner === 'function') {
                window.showAuthBanner('No lives left today. Your meter refills at midnight (GMT).\n\nGo Premium for more lives.', true);
            }
        } catch (e) { /* soft */ }
    }
    function gateThenStart(orig, args) {
        // Re-entrancy guard: the gate is async, so a rapid double-tap before
        // setupConfigurationLocked is set must NOT charge twice.
        if (gateInFlight) return null;
        // Multiplayer exemption: an invited device (not the host seat 0) starts
        // its board to mirror the shared game; the HOST already consumed the
        // entry life on-chain, so the joiner must never be charged or blocked.
        try {
            var a = window.gfgLudoAdapter;
            var isMp = !!(a && typeof a.isActive === 'function' && a.isActive());
            var isHost = !!(a && typeof a.seat === 'function' && a.seat() === 0);
            if (isMp && !isHost) return orig.apply(window, args);
        } catch (e) { /* soft: fall through to the gate */ }
        var ref = window.gfgGameMatchRef || Date.now();
        window.gfgGameMatchRef = ref;
        gateInFlight = true;
        return Promise.resolve()
            .then(function () { return window.gfgChain.chargeLife(ref); })
            .then(function () {
                // Charged (or unlimited): let the normal start proceed, and tell
                // the game core the gate already charged so it never double-charges.
                window.__gfgArcLifeGateHandled = ref;
                gateInFlight = false;
                return orig.apply(window, args);
            })
            .catch(function (e) {
                gateInFlight = false;
                var msg = (e && (e.message || e.shortMessage)) || String(e);
                if (/nolives|no lives|lives/i.test(msg)) {
                    console.warn('[arc-flow] lives gate blocked the match:', msg);
                    blockNoLives();
                    return null;
                }
                // Network/transient: do not break play; the local meter still gates.
                console.warn('[arc-flow] lives gate soft-fail (proceeding):', msg);
                return orig.apply(window, args);
            });
    }
    var startWrapped = false;
    function wrapStart() {
        if (startWrapped) return;
        var orig = window.initiateArenaMatch;
        if (typeof orig !== 'function') return; // not defined yet; retry later
        window.initiateArenaMatch = function () {
            if (!isArc()) return orig.apply(this, arguments);
            return gateThenStart(orig, arguments);
        };
        startWrapped = true;
    }

    function tick() {
        if (!isArc()) return;
        try { ensureStarted().then(syncTurn).then(watchDeadline); } catch (e) {}
    }

    // The page ends a match with Play Again -> reset the local bridge state.
    try {
        var origPlayAgain = window.playAgainAfterCeremony;
        if (typeof origPlayAgain === 'function' && !origPlayAgain.__arcWrapped) {
            window.playAgainAfterCeremony = function () { try { reset(); } catch (e) {} return origPlayAgain.apply(this, arguments); };
            window.playAgainAfterCeremony.__arcWrapped = true;
        }
    } catch (e) { /* soft */ }

    try { wrapCeremony(); } catch (e) {}
    try { wrapStart(); } catch (e) {}
    // The page may define initiateArenaMatch after this file loads; re-wrap
    // until it is present and still unguarded.
    try { setInterval(function () { if (!window.initiateArenaMatch || !window.initiateArenaMatch.__arcGated) wrapStart(); }, 2000); } catch (e) {}
    try { setInterval(function () { if (window.playAgainAfterCeremony !== undefined) wrapCeremony(); }, 2000); } catch (e) {}
    try { setInterval(tick, POLL_MS); } catch (e) {}
})();
