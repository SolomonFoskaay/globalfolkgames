// public/games/ludo-lab/mechanics/state/board-hooks.js
// arc2m1d: on-chain MatchBoard integration for ludo-lab SOLO (game-agnostic
// board, reward-neutral: this module only RECORDS facts - participants, move
// hashes, finish order. It NEVER computes points, money, or fees).
//
// HARD SAFETY: this is a SOFT-FAIL observer. Every on-chain call is guarded so
// a flaky board write can NEVER throw into or block the game loop. If the
// board is down, gameplay continues exactly as before and a console line notes
// the skip. Solo play must keep working 100% the same with this file present.
//
// Wiring (three seams, no game-logic edits):
//   1. Match start  -> hook after initiateArenaMatch succeeds
//   2. Turn pass    -> hook after each real turn (passTurnSequence)
//   3. Match finish -> hooked by win-detection's publishSeamResult (the
//                      canonical finish moment) via window.gfgBoardFinish
//
// The board PDA seed is [gfgboard, game, match_ref]; the relay creates it,
// delegates it once (sponsor), then board writes run GASLESS on the ER.

(function () {
    // Match-ref must be stable for a whole match AND unique across matches.
    // Use Date.now() at match start (only stored in memory per session).
    let matchRef = 0;
    let boardActive = false;
    let turnCount = 0;
    const GAME = 1; // M1 source_code: 1 = ludo

    function log() {
        try { console.log.apply(console, ['[GFG BOARD]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
    }

    function api(action, body) {
        return fetch('/api/agm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, body || {})),
        }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
    }

    // 32-byte hash commit for a turn (deterministic snapshot marker).
    // Reward-neutral: it is a proof marker, not a move payload the program
    // interprets. Uses the current turn state to make it unique.
    function hashCommit() {
        const c = window.currentTurn || 'green';
        const roll = (window.lastDiceRoll1 || 0) + 'x' + (window.lastDiceRoll2 || 0);
        const s = (c + '|' + turnCount + '|' + roll + '|' + (window.currentTurnMoves ? window.currentTurnMoves.length : 0)).slice(0, 64);
        const out = [];
        for (let i = 0; i < 32; i++) { let v = 0; if (i < s.length) v = s.charCodeAt(i) % 256; out.push(v); }
        return out;
    }

    // -------- start: create + delegate the board, then begin --------
    function start(game, players, seats, stakeUsdCents, turnSecs, maxMatchSecs) {
        if (boardActive) return;
        matchRef = Date.now();
        turnCount = 0;
        boardActive = true;
        api('board-start', {
            game: GAME, matchRef: matchRef,
            players: players || [], seats: seats || 2,
            stakeUsdCents: stakeUsdCents || 0,
            turnSecs: turnSecs || 60, maxMatchSecs: maxMatchSecs || 3600,
        }).then(r => {
            if (r && r.ok) { log('board started matchRef=' + matchRef + ' pda=' + (r.pda || '').slice(0, 10) + '...'); }
            else { log('start skipped: ' + (r && r.error)); }
        });
        return matchRef;
    }

    function isActive() { return boardActive; }
    function ref() { return matchRef; }

    // -------- per turn: commit a move-hash (soft-fail) --------
    function commitTurn() {
        if (!boardActive || !matchRef) return;
        turnCount++;
        api('board-commit', { game: GAME, matchRef: matchRef, seat: seatIndex(), moveCommit: hashCommit() })
            .then(r => { if (!(r && r.ok)) log('commit skipped (turn ' + turnCount + '): ' + (r && r.error)); });
    }

    function seatIndex() {
        const c = window.currentTurn || 'green';
        const order = ['green', 'yellow', 'blue', 'red'];
        return order.indexOf(c) >= 0 ? order.indexOf(c) : 0;
    }

    // -------- finish: report the real finish order -> winner seat --------
    function finish(winnerSeat) {
        if (!boardActive || !matchRef) return;
        boardActive = false;
        api('board-finish', { game: GAME, matchRef: matchRef, winnerSeat: winnerSeat })
            .then(r => { if (!(r && r.ok)) log('finish skipped: ' + (r && r.error)); });
    }

    // Expose a minimal API for the game's three hooks.
    window.gfgBoard = { start, commitTurn, finish, isActive, ref };

    // ---- Hook 1: match start. We hook AFTER the user pressed Start Arena
    // Match and setup locked (grandparent access: these flags are globals). ----
    var _origInitiate = window.initiateArenaMatch;
    if (typeof _origInitiate === 'function') {
        window.initiateArenaMatch = function () {
            var res = _origInitiate.apply(this, arguments);
            // After start, if the game actually started (setup locked), open a board.
            try {
                setTimeout(function () {
                    if (window.setupConfigurationLocked === true) {
                        var seats = (window.getActiveSeats && typeof window.getActiveSeats === 'function') ? window.getActiveSeats() : ['green', 'yellow', 'blue', 'red'];
                        var players = [];
                        seats.forEach(function (c) {
                            var p = (window.playerProfiles && window.playerProfiles[c]) || {};
                            players.push((p.isUser === true) ? (window.gfgProfileWallet || 'user') : ('seat-' + c));
                        });
                        start(GAME, players, seats.length, 0, 60, 3600);
                    }
                }, 50);
            } catch (e) { log('start hook error: ' + e.message); }
            return res;
        };
    }

    // ---- Hook 2: turn pass (commit hash after each real turn). We wrap
    // passTurnSequence; the game calls it after every turn advance. ----
    var _origPass = window.passTurnSequence;
    if (typeof _origPass === 'function') {
        window.passTurnSequence = function () {
            var res = _origPass.apply(this, arguments);
            try {
                if (boardActive && matchRef && !window.matchOver) commitTurn();
            } catch (e) { log('turn hook error: ' + e.message); }
            return res;
        };
    }

    // ---- Hook 3: finish. win-detection calls window.gfgBoardFinish if present
    // right before/after publishing the seam result. We do NOT touch the seam. ----
    window.gfgBoardFinish = function (winnerSeatOrOrder) {
        try {
            var ws = 0;
            if (typeof winnerSeatOrOrder === 'number') ws = winnerSeatOrOrder;
            else if (Array.isArray(winnerSeatOrOrder)) {
                var first = (window.finishOrder && window.finishOrder[0]) || (winnerSeatOrOrder[0]);
                var order = ['green', 'yellow', 'blue', 'red'];
                ws = order.indexOf(first) >= 0 ? order.indexOf(first) : 0;
            }
            finish(ws);
        } catch (e) { log('finish hook error: ' + e.message); }
    };

    log('board-hooks loaded (arc2m1d, soft-fail)');
})();