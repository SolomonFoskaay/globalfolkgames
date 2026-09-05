// public/games/ludo-lab/mechanics/state/multiplayer-adapter.js
// M12 arc2m12b — Ludo ADAPTER for the universal multiplayer rail.
//
// The rail stays game-agnostic (it only commits 32-byte move checkpoints to
// the delegated board). THIS adapter knows Ludo: it serializes a move into the
// 32 bytes so the OPPONENT can decode and replay it, and it drives the
// local game when an opponent's move arrives. Other games write their own
// adapter against the same rail + this shape.
//
// Encoding (32 bytes):
//   byte0 seat(0-3), byte1 die1, byte2 die2, byte3 tokenIndex,
//   byte4 fromPathIndex, byte5 toPathIndex, byte6 moveNumberCooldown(<=120),
//   rest zeros. The opponent replays: tokenIndex at fromPathIndex ->
//   toPathIndex (a position on the common path), which is deterministic.
//
// SAFETY: soft-fail. If multiplayer is off or the chain is unreachable, the
// game plays exactly as before (Solo unchanged). Never throws into game code.
(function () {
    var active = false;
    var matchRef = 0;
    var mySeat = -1;          // which seat index this device controls
    var unsub = null;
    var lastCount = -1;
    var dimmed = false;       // true to ignore opponent turns until they move

    function log() { try { console.log.apply(console, ['[MP/LUDO]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
    function rail() { return window.gfgMultiplayer; }
    function seatOf(color) { var o = ['green','yellow','blue','red']; var i = o.indexOf(color || 'green'); return i >= 0 ? i : 0; }
    function colorOf(i) { return ['green','yellow','blue','red'][i] || 'green'; }

    // encode a move into a 32-byte array (positional; opponent replays it)
    function encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex) {
        var m = [0, 0, 0, 0, 0, 0, 0, 0];
        for (var i = 0; i < 32; i++) m[i] = 0;
        m[0] = seatOf(window.currentTurn || 'green');
        m[1] = die1 & 0xff; m[2] = die2 & 0xff;
        m[3] = tokenIndex & 0xff;
        m[4] = (fromPathIndex & 0xff); m[5] = (toPathIndex & 0xff);
        m[6] = Math.min(120, (window.moveCount || 0)) & 0xff;
        return m;
    }

    // decode a 32-byte commit into a move object
    function decodeMove(bytes) {
        if (!bytes || bytes.length < 7) return null;
        try {
            return { seat: bytes[0], die1: bytes[1], die2: bytes[2], tokenIndex: bytes[3], fromPathIndex: bytes[4], toPathIndex: bytes[5] };
        } catch (e) { return null; }
    }

    // apply an opponent's decoded move to the local board (deterministic)
    function applyMove(move) {
        try {
            var col = colorOf(move.seat);
            var toks = (window.tokens && window.tokens[col]) || [];
            var path = (window.COMMON_PATH || []);
            var token = toks[move.tokenIndex];
            if (!token) return;
            var idx = move.toPathIndex;
            if (path[idx]) { token.pathIndex = idx; token.c = path[idx].c; token.r = path[idx].r; token.stepsWalked = idx; }
            if (typeof window.drawLudoLayout === 'function') window.drawLudoLayout();
            if (typeof window.saveGameStateToStorage === 'function') window.saveGameStateToStorage();
            log('applied opponent move seat=' + move.seat + ' token=' + move.tokenIndex + ' -> path ' + move.toPathIndex);
        } catch (e) { log('apply err ' + e.message); }
    }

    // ---- multiplayer session ----
    function start(gameId, players, seats, turnSecs, maxSecs, chosenSeat) {
        if (!rail()) { log('rail not loaded'); return Promise.resolve(null); }
        mySeat = (typeof chosenSeat === 'number') ? chosenSeat : 0;
        return rail().create({ gameId: gameId || 1, players: players || [], seats: seats || 2, turnSecs: turnSecs || 60, maxMatchSecs: maxSecs || 3600 }).then(function (r) {
            if (!r.okay) { log('create failed', r.error); return null; }
            active = true;
            matchRef = r.matchRef;
            lastCount = -1;
            dimmed = false;
            unsub = rail().subscribe(matchRef, function (s) {
                try {
                    if (s.move_count !== lastCount) {
                        lastCount = s.move_count;
                        // decode the LATEST commit (opponent's move) if it's not ours
                        var mv = decodeMove(window._mpLatestCommit);
                        if (mv && mv.seat !== mySeat && typeof window.currentTurn === 'string' && seatOf(window.currentTurn) === mv.seat) {
                            applyMove(mv);
                            dimmed = false;
                            if (typeof window.passTurnSequence === 'function') setTimeout(function(){ try { window.passTurnSequence(); } catch(e){} }, 600);
                        }
                    }
                } catch (e) { log('listen err ' + e.message); }
            });
            log('match created code=' + r.code + ' ref=' + matchRef + ' mySeat=' + mySeat);
            return r;
        });
    }

    function join(gameId, code, chosenSeat) {
        if (!rail()) return Promise.resolve(null);
        return rail().join(gameId || 1, code).then(function (r) {
            if (!r.okay) { log('join failed', r.error); return null; }
            active = true;
            matchRef = r.matchRef;
            mySeat = (typeof chosenSeat === 'number') ? chosenSeat : 1;
            lastCount = -1;
            unsub = rail().subscribe(matchRef, function (s) {
                try {
                    if (s.move_count !== lastCount) {
                        lastCount = s.move_count;
                        var mv = decodeMove(window._mpLatestCommit);
                        if (mv && mv.seat !== mySeat) {
                            applyMove(mv);
                            dimmed = false;
                            if (typeof window.passTurnSequence === 'function') setTimeout(function(){ try { window.passTurnSequence(); } catch(e){} }, 600);
                        }
                    }
                } catch (e) {}
            });
            log('joined ref=' + matchRef + ' mySeat=' + mySeat);
            return r;
        });
    }

    function isActive() { return active; }
    function ref() { return matchRef; }
    function seat() { return mySeat; }

    // HOST-ONLY: begin the live match (status 0 -> 1), locking out new joins.
    function begin() {
        if (!active || !matchRef) return Promise.resolve({ okay: false, error: 'not in a match' });
        if (mySeat !== 0) return Promise.resolve({ okay: false, error: 'only the host can start' });
        return rail().begin({ gameId: 1, matchRef: matchRef }).then(function (r) {
            if (r && r.okay) log('match begun');
            return r;
        });
    }

    // called by the game after a real LOCAL move: commit the move gasless
    function onMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex) {
        if (!active || !matchRef) return;
        var bytes = encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex);
        try { window._mpLatestCommit = bytes; } catch (e) {}
        var refObj = { gameId: 1, matchRef: matchRef, seat: seatOf(window.currentTurn || 'green') };
        rail().commitMove(refObj, bytes).then(function (r) {
            if (!(r && r.ok)) log('move commit skipped', (r && r.error) || '');
        });
    }

    function onFinish(winnerSeat) {
        if (!active || !matchRef) return;
        active = false;
        var refObj = { gameId: 1, matchRef: matchRef };
        rail().finish(refObj, (typeof winnerSeat === 'number') ? winnerSeat : seatOf(window.finishOrder && window.finishOrder[0])).then(function (r) {
            if (!(r && r.okay)) log('finish skipped', (r && r.error) || '');
        });
        if (unsub) unsub();
        unsub = null;
    }

    function stop() { active = false; if (unsub) unsub(); unsub = null; }

    window.gfgLudoAdapter = { start: start, join: join, begin: begin, onMove: onMove, onFinish: onFinish, isActive: isActive, ref: ref, seat: seat, stop: stop };

    // ---- hook the game's existing seams (soft, no behavior change when idle) ----
    var _origMove = window.onMoveCommitted;
    if (typeof _origMove === 'function') {
        window.onMoveCommitted = function () {
            var res = _origMove.apply(this, arguments);
            onMove();
            return res;
        };
    }
    // win-detection's finish already calls window.gfgBoardFinish
    var _origFinish = window.gfgBoardFinish;
    window.gfgBoardFinish = function (finishOrder) {
        onFinish(typeof finishOrder === 'number' ? finishOrder : undefined);
        if (typeof _origFinish === 'function') _origFinish(finishOrder);
    };

    log('ludo multiplayer adapter loaded (M12 arc2m12b)');
})();