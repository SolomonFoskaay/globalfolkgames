// Foskaay GGI Ludo demo bridge.
//
// Connects the ludo-lab board/dice skin to the Foskaay GGI Midchain relay and
// the on-chain contract. The CONTRACT is the only rules engine: the make-believe
// "board state" here is always the contract's own replay of the move log
// (previewLog). The move log lives in MEMORY ONLY (never localStorage), travels
// with each request, and is re-verified on-chain at settle. Nothing is trusted
// on this page; it only draws what the contract returns.
(function () {
    'use strict';

    var RELAY = '/api/foskaay-ggi-sponsor';
    var COLOR_OF = ['green', 'yellow', 'blue', 'red'];
    var SEAT_OF = { green: 0, yellow: 1, blue: 2, red: 3 };

    // ---- demo state (in memory; the contract is the truth) ----
    var LOG = [];
    var REF = null, SID = null, USER = null, USERSEAT = 0, SEATS = 2;
    var BOARD = null;
    var pendingDice = [];
    var busy = false;

    // ---- globals board.js / paths.js read ----
    window.currentTurn = 'green';
    window.playerProfiles = {
        green: { mode: 'computer', isUser: false },
        yellow: { mode: 'computer', isUser: false },
        blue: { mode: 'computer', isUser: false },
        red: { mode: 'computer', isUser: false }
    };
    window.displayDiceOnBoard = false;
    window.isDiceRolled = false;
    window.currentTurnMoves = [];
    window.setupConfigurationLocked = false;
    window.matchOver = false;
    window.isGamePaused = false;
    window.isChainDown = false;
    window.gfgRemoteTurn = function () { return false; };
    window.getActiveSeats = function () { return COLOR_OF.slice(0, SEATS); };
    window.getPlayerRank = function (color) {
        if (!BOARD || !BOARD.finishOrder) return 0;
        var i = BOARD.finishOrder.indexOf(SEAT_OF[color]);
        return i >= 0 ? i + 1 : 0;
    };
    // physics.js calls this when the tumble settles; the dice values are already
    // the contract's, so there is nothing left to score here.
    window.finalizeDiceScores = function () {};

    // ---- UI hook (the page defines window.gfgLudoUI before loading this) ----
    function ui() { return window.gfgLudoUI || {}; }
    function setStatus(s) { if (ui().status) ui().status(s); }
    function setPrompt(s) { if (ui().prompt) ui().prompt(s); }

    function relay(action, extra) {
        var body = Object.assign({ action: action }, extra || {});
        return fetch(RELAY, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) {
            return r.json().then(function (j) {
                if (!j.ok) throw new Error(j.error || ('relay ' + r.status));
                return j;
            });
        });
    }

    function tokenCR(seat, stepsWalked) {
        var color = COLOR_OF[seat];
        if (stepsWalked >= 52) {
            var lane = stepsWalked - 51;
            if (color === 'green') return { c: lane, r: 7 };
            if (color === 'yellow') return { c: 7, r: lane };
            if (color === 'blue') return { c: 14 - lane, r: 7 };
            return { c: 7, r: 14 - lane };
        }
        var abs = (START_INDEX[color] + stepsWalked) % 52;
        return COMMON_PATH[abs];
    }

    // Paint the contract board into the skin's token model, then redraw.
    function applyBoard(board) {
        BOARD = board;
        var t = window.tokens;
        for (var s = 0; s < 4; s++) {
            var color = COLOR_OF[s];
            for (var i = 0; i < 4; i++) {
                var steps = board.stepsWalked[s * 4 + i];
                var tok = t[color][i];
                if (steps < 0) {
                    tok.stepsWalked = 0;
                    tok.pathIndex = -1;
                    tok.c = HOME_YARDS[color][i].c;
                    tok.r = HOME_YARDS[color][i].r;
                } else {
                    tok.stepsWalked = steps;
                    tok.pathIndex = steps >= 57 ? -2 : board.pathIndex[s * 4 + i];
                    var cr = tokenCR(s, steps);
                    tok.c = cr.c;
                    tok.r = cr.r;
                }
            }
        }
        window.currentTurn = COLOR_OF[board.turn] || 'green';
        window.matchOver = isMatchDone(board);
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
    }

    function isMatchDone(board) {
        if (!board) return false;
        var need = SEATS === 2 ? 1 : 3;
        return board.finishCount >= need;
    }

    function hasLegalMove(seat, dice) {
        for (var i = 0; i < 4; i++) {
            var steps = BOARD.stepsWalked[seat * 4 + i];
            for (var d = 0; d < dice.length; d++) {
                var val = dice[d];
                if (steps < 0) { if (val === 6) return true; }
                else if (steps < 57 && steps + val <= 57) return true;
            }
        }
        return false;
    }

    function chooseToken(seat, val) {
        for (var i = 0; i < 4; i++) {
            var steps = BOARD.stepsWalked[seat * 4 + i];
            if (steps < 0) { if (val === 6) return i; }
            else if (steps < 57 && steps + val <= 57) return i;
        }
        return -1;
    }

    // ---- the turn flow ----

    function beginTurn() {
        if (!BOARD) return;
        if (isMatchDone(BOARD)) { settle(); return; }
        window.setupConfigurationLocked = true;
        window.isDiceRolled = false;
        window.currentTurnMoves = [];
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (BOARD.turn === USERSEAT) {
            setPrompt('Your turn: tap the centre of the board to roll.');
        } else {
            setPrompt(COLOR_OF[BOARD.turn] + ' is playing...');
            setTimeout(rollCurrent, 800);
        }
    }

    async function rollCurrent() {
        if (busy || !BOARD) return;
        busy = true;
        try {
            var r = await relay('demoRoll', { matchRef: REF, log: LOG });
            LOG = r.log;
            pendingDice = [r.dice1, r.dice2];
            window.currentTurnMoves = [r.dice1, r.dice2];
            window.isDiceRolled = true;
            applyBoard(r.board);
            if (ui().log) ui().log('Rolled <b>' + r.dice1 + '</b> and <b>' + r.dice2 + '</b> (on-chain dice)', 0);
            if (typeof window.showDiceTumble === 'function') window.showDiceTumble(r.dice1, r.dice2);
            else if (typeof window.showRemoteDice === 'function') window.showRemoteDice(r.dice1, r.dice2);
            setPrompt(COLOR_OF[r.board.turn] + ' rolled ' + r.dice1 + ' and ' + r.dice2 + '.');
            setTimeout(afterDiceWindow, 3600);
        } catch (e) {
            setPrompt('Roll failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    function afterDiceWindow() {
        window.displayDiceOnBoard = false;
        window.currentTurnMoves = pendingDice.slice();
        window.isDiceRolled = true;
        if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (BOARD.turn !== USERSEAT) {
            setTimeout(computerPlay, 700);
        } else if (!hasLegalMove(USERSEAT, pendingDice)) {
            setTimeout(passTurn, 900);
        } else {
            setPrompt('Your turn: tap a blinking token to move it.');
        }
    }

    async function userMove(tokenIndex) {
        if (busy || !BOARD || BOARD.turn !== USERSEAT) return;
        var seat = USERSEAT;
        var steps = BOARD.stepsWalked[seat * 4 + tokenIndex];
        var pick = -1;
        for (var d = 0; d < pendingDice.length; d++) {
            var val = pendingDice[d];
            if (steps < 0) { if (val === 6) { pick = d; break; } }
            else if (steps < 57 && steps + val <= 57) { pick = d; break; }
        }
        if (pick < 0) return;
        var die = pendingDice[pick];
        busy = true;
        try {
            var r = await relay('demoMove', { matchRef: REF, log: LOG, seat: seat, tokenIndex: tokenIndex, steps: die });
            LOG = r.log;
            pendingDice.splice(pick, 1);
            window.currentTurnMoves = pendingDice.slice();
            applyBoard(r.board);
            if (ui().log) ui().log('You moved token ' + (tokenIndex + 1) + ' by ' + die, 0);
            if (pendingDice.length && hasLegalMove(seat, pendingDice)) {
                setPrompt('Tap another token to use your second dice, or press Pass.');
            } else {
                setTimeout(passTurn, 500);
            }
        } catch (e) {
            setPrompt('Move rejected by the contract: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function computerPlay() {
        if (busy || !BOARD) return;
        busy = true;
        try {
            var seat = BOARD.turn;
            for (var d = 0; d < pendingDice.length; d++) {
                var val = pendingDice[d];
                var t = chooseToken(seat, val);
                if (t < 0) continue;
                var r = await relay('demoMove', { matchRef: REF, log: LOG, seat: seat, tokenIndex: t, steps: val });
                LOG = r.log;
                pendingDice.splice(d, 1); d--;
                applyBoard(r.board);
            }
            setTimeout(passTurn, 500);
        } catch (e) {
            setPrompt('Computer move failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function passTurn() {
        if (busy || !BOARD) return;
        busy = true;
        try {
            var r = await relay('demoPass', { matchRef: REF, log: LOG });
            LOG = r.log;
            pendingDice = [];
            window.currentTurnMoves = [];
            window.isDiceRolled = false;
            applyBoard(r.board);
            beginTurn();
        } catch (e) {
            setPrompt('Pass failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function settle() {
        if (busy || !REF) return;
        busy = true;
        setPrompt('Match finished. Sealing the result on-chain...');
        try {
            var r = await relay('demoSettle', { matchRef: REF, log: LOG, sessionId: SID });
            if (ui().log) ui().log('Settled on-chain: result sealed, tampering rejected', r.costUsdc6);
            if (ui().gas) ui().gas(r.costUsdc6, 'settled');
            var b = await relay('demoBoard', { matchRef: REF, log: LOG, user: USER });
            applyBoard(b.board);
            var won = b.board.finishOrder && b.board.finishOrder[0] === USERSEAT;
            setPrompt(won ? 'Sealed. You won the crown.' : 'Sealed. The match is over.');
            if (ui().onSettled) ui().onSettled(won);
        } catch (e) {
            setPrompt('Settle failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    // board.js's centre tap calls this for the roll control.
    window.rollDiceEngine = function () {
        if (!BOARD || BOARD.turn !== USERSEAT || window.isDiceRolled) return;
        rollCurrent();
    };

    function onCanvasClick(ev) {
        if (!BOARD || BOARD.turn !== USERSEAT || window.displayDiceOnBoard || busy) return;
        var canvas = document.getElementById('ludoCanvas');
        if (!canvas) return;
        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        var x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
        var y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
        var cell = canvas.width / 15;
        var col = Math.floor(x / cell), row = Math.floor(y / cell);
        for (var i = 0; i < 4; i++) {
            var steps = BOARD.stepsWalked[USERSEAT * 4 + i];
            var pos = steps < 0 ? HOME_YARDS[COLOR_OF[USERSEAT]][i] : tokenCR(USERSEAT, steps);
            if (!pos) continue;
            if (pos.c === col && pos.r === row) { userMove(i); return; }
        }
    }

    // Start a fresh match: connect on the rail + create the match (one step).
    async function start(seatCount, userSeat) {
        if (busy) return null;
        busy = true;
        LOG = []; pendingDice = []; BOARD = null;
        SEATS = seatCount; USERSEAT = userSeat;
        for (var s = 0; s < 4; s++) {
            var c = COLOR_OF[s];
            window.playerProfiles[c] = { mode: s === userSeat ? 'human' : 'computer', isUser: s === userSeat };
        }
        window.matchOver = false;
        window.displayDiceOnBoard = false;
        window.isDiceRolled = false;
        window.currentTurnMoves = [];
        try {
            var info = await relay('sponsorAddress');
            USER = info.address;
            var created = await relay('demoCreate', { seatCount: seatCount, userSeat: userSeat, user: USER, verifyMode: 1 });
            REF = created.matchRef;
            SID = created.sessionId;
            applyBoard(created.board);
            if (ui().log) ui().log('Session connected on-chain (fee paid) + match created', created.costUsdc6);
            if (ui().gas) ui().gas(created.costUsdc6, 'connected');
            if (ui().ids) ui().ids(SID, REF);
            beginTurn();
            return created;
        } catch (e) {
            setPrompt('Start failed: ' + e.message);
            return null;
        } finally {
            busy = false;
        }
    }

    // Wrap the board draw so the CSS-3D dice stay in sync every redraw.
    function wrapDraw() {
        if (typeof window.drawLudoLayout !== 'function') return;
        var orig = window.drawLudoLayout;
        window.drawLudoLayout = function () {
            try { orig(); } catch (e) {}
            if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
        };
    }

    window.GFG_LUDO = {
        start: start,
        pass: passTurn,
        settle: settle,
        userSeat: function () { return USERSEAT; },
        board: function () { return BOARD; }
    };

    document.addEventListener('DOMContentLoaded', function () {
        wrapDraw();
        var canvas = document.getElementById('ludoCanvas');
        if (canvas) canvas.addEventListener('click', onCanvasClick);
    });
})();
