// public/games/ludo-lab/mechanics/state/multiplayer-adapter.js
// M1 arc2m1d — Ludo reference ADAPTER for the universal multiplayer rail.
// The rail handles the chain; THIS file maps Ludo's own move/turn/finish onto
// it. Other games write their own adapter against the SAME rail API.
//
// Lives with the game (it knows Ludo internals). SAFETY: soft-fail like the
// rail - if multiplayer isn't active or the chain is unreachable, the game
// plays exactly as before (Solo unchanged).
(function () {
    var active = false;
    var matchRef = 0;
    var session = null; // {unsub, gameId}
    var turnCount = 0;

    function log() { try { console.log.apply(console, ['[MP/LUDO]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
    function rail() { return window.gfgMultiplayer; }

    function seatOf(color) {
        var order = ['green', 'yellow', 'blue', 'red'];
        var i = order.indexOf(color || 'green');
        return i >= 0 ? i : 0;
    }
    function currentColor() {
        return (window.currentTurn) ? window.currentTurn : 'green';
    }

    function hashMove() {
        // a deterministic marker of this turn's decision (roll + move made)
        var c = currentColor();
        var roll = (window.lastDiceRoll1 || 0) + 'x' + (window.lastDiceRoll2 || 0);
        var made = (window.currentTurnMoves && window.currentTurnMoves.length) || 0;
        return String(c + '|' + turnCount + '|' + roll + '|' + made).slice(0, 64);
    }

    // ---- start the multiplayer session (called by the game's MP entry) ----
    function start(gameId, players, seats, turnSecs, maxSecs) {
        if (!rail()) { log('rail not loaded'); return null; }
        turnCount = 0;
        return rail().create({ gameId: gameId, players: players || [], seats: seats || 2, turnSecs: turnSecs || 60, maxMatchSecs: maxSecs || 3600 }).then(function (r) {
            if (!r.okay) { log('create failed:', r.error); return null; }
            active = true;
            matchRef = r.matchRef;
            log('match created code=' + r.code + ' ref=' + matchRef);
            // subscribe to opponent moves: on change, re-render the board
            session = { unsub: rail().subscribe(matchRef, function (s) {
                try {
                    if (typeof window.drawLudoLayout === 'function') window.drawLudoLayout();
                    if (typeof window.updateTurnIndicator === 'function') window.updateTurnIndicator();
                } catch (e) {}
            }) };
            return r;
        });
    }

    function isActive() { return active; }
    function ref() { return matchRef; }
    function stop() { active = false; if (session && session.unsub) session.unsub(); session = null; }

    // called by the game after each real move - commits a hash gasless
    function onMove() {
        if (!active || !matchRef) return;
        turnCount++;
        var railRef = { gameId: 1, matchRef: matchRef, seat: seatOf(currentColor()) };
        // soft-fail: gameplay never blocks on this
        rail().commitMove(railRef, hashMove()).then(function (r) {
            if (!(r && r.ok)) log('move commit skipped: ' + ((r && r.error) || ''));
        });
    }

    // called by win-detection at match end - finish with real winner
    function onFinish(winnerSeat) {
        if (!active || !matchRef) { return; }
        active = false;
        var ws = (typeof winnerSeat === 'number') ? winnerSeat : seatOf(window.finishOrder && window.finishOrder[0]);
        var railRef = { gameId: 1, matchRef: matchRef, winnerSeat: ws };
        rail().finish(railRef, ws).then(function (r) {
            if (!(r && r.okay)) log('finish skipped: ' + ((r && r.error) || ''));
        });
        if (session && session.unsub) session.unsub();
        session = null;
    }

    window.gfgLudoAdapter = { start: start, onMove: onMove, onFinish: onFinish, isActive: isActive, ref: ref, stop: stop };

    // ---- hook the game's existing seams (soft, unchanged behavior) ----
    var _origMove = window.afterMoveCommitted;
    if (typeof _origMove === 'function') {
        window.afterMoveCommitted = function () {
            var res = _origMove.apply(this, arguments);
            onMove();
            return res;
        };
    }
    // win-detection already calls window.gfgBoardFinish; route it to onFinish too
    var _origFinish = window.gfgBoardFinish;
    window.gfgBoardFinish = function (finishOrder) {
        onFinish(typeof finishOrder === 'number' ? finishOrder : undefined);
        if (typeof _origFinish === 'function') _origFinish(finishOrder);
    };

    log('ludo multiplayer adapter loaded (arc2m1d)');
})();