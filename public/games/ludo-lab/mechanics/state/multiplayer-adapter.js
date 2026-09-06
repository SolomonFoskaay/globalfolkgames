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
    var seatCount = 2;        // multiplayer seat count (2 = green,red; 4 = all)
    var unsub = null;
    var lastCount = -1;
    var dimmed = false;       // true to ignore opponent turns until they move

    function log() { try { console.log.apply(console, ['[MP/LUDO]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
    function rail() { return window.gfgMultiplayer; }
    // Seat index -> Ludo color: the game's ACTIVE colour order is the source of
    // truth (the board the game actually plays). When the game is configured
    // (activeSeats set via the colour picker), seat i == activeSeats[i], so the
    // on-chain seat and the colour picker are the SAME thing. Before the game
    // locks, fall back to a deterministic order from the seat count (2P:
    // green,red; 4P: all four) so both devices agree on the committed byte.
    function activeOrder() {
        try {
            if (typeof window.getActiveSeats === 'function') {
                var a = window.getActiveSeats();
                if (a && a.length >= 2) return a.slice(0, Math.min(a.length, 4));
            }
        } catch (e) { /* soft */ }
        if (seatCount === 4) return ['green', 'yellow', 'blue', 'red'];
        return ['green', 'red'];
    }
    function seatOf(color) { var o = activeOrder(); var i = o.indexOf(color || 'green'); return i >= 0 ? i : 0; }
    function colorOf(i) { var o = activeOrder(); return o[i] || 'green'; }

    // encode a move into a 32-byte array (positional; opponent replays it).
    // byte0 seat, byte1 die1, byte2 die2, byte3 tokenIndex, byte4 fromPath,
    // byte5 toPath, byte6 final stepsWalked (authoritative; lets the remote
    // device replay the home lane + finish exactly like the local move did).
    function encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked) {
        var m = [0, 0, 0, 0, 0, 0, 0, 0];
        for (var i = 0; i < 32; i++) m[i] = 0;
        m[0] = seatOf(window.getGameCurrentTurn ? window.getGameCurrentTurn() : (window.currentTurn || 'green'));
        m[1] = (typeof die1 === 'number' ? die1 : 0) & 0xff; m[2] = (typeof die2 === 'number' ? die2 : 0) & 0xff;
        m[3] = tokenIndex & 0xff;
        m[4] = (fromPathIndex & 0xff);
        m[5] = (typeof toPathIndex === 'number' ? toPathIndex : fromPathIndex) & 0xff;
        m[6] = (typeof toStepsWalked === 'number' && toStepsWalked > 0 ? toStepsWalked : 0) & 0xff;
        return m;
    }

    // decode a 32-byte commit into a move object
    function decodeMove(bytes) {
        if (!bytes || bytes.length < 7) return null;
        try {
            return {
                seat: bytes[0],
                die1: bytes[1],
                die2: bytes[2],
                tokenIndex: bytes[3],
                fromPathIndex: bytes[4],
                toPathIndex: bytes[5],
                toStepsWalked: bytes[6] || 0,
            };
        } catch (e) { return null; }
    }

    // apply an opponent's decoded move to the local board (deterministic).
    // Mirrors movement.js: home lane (stepsWalked>=52) renders via pathIndex
    // -2 + per-color lane offsets, and 57 fires checkForMatchWinner so the
    // LOSING device also sees the ceremony + finish, exactly like the local
    // win path. Returns true when this move finished the opponent.
    function applyMove(move) {
        var won = false;
        try {
            var col = colorOf(move.seat);
            var toks = (window.tokens && window.tokens[col]) || [];
            var token = toks[move.tokenIndex];
            // Board not initialized yet (the local game hasn't started). Return
            // "not-ready" so the subscriber does NOT advance lastCount, letting
            // the same commit be re-applied once the board is up.
            if (!token || !window.tokens) return 'not-ready';
            // Shared dice: mirror the committed roll onto this device so both
            // screens show the same dice the remote player rolled.
            if (typeof window.lastDiceRoll1 === 'number' && move.die1 > 0) window.lastDiceRoll1 = move.die1;
            if (typeof window.lastDiceRoll2 === 'number' && move.die2 > 0) window.lastDiceRoll2 = move.die2;
            var box1 = document.getElementById('val-d1');
            var box2 = document.getElementById('val-d2');
            var tot = document.getElementById('val-total');
            if (box1) box1.innerText = move.die1 > 0 ? move.die1 : '—';
            if (box2) box2.innerText = move.die2 > 0 ? move.die2 : '—';
            if (tot && move.die1 > 0 && move.die2 > 0) tot.innerText = '= Total: ' + (move.die1 + move.die2);
            // Mirror the remote dice as PHYSICAL cubes too (not just the text
            // boxes) so both screens show the same dice the remote rolled.
            if (move.die1 > 0 && move.die2 > 0 && typeof window.showRemoteDice === 'function') {
                try { window.showRemoteDice(move.die1, move.die2); } catch (e) { /* soft */ }
            }

            var sw = move.toStepsWalked > 0 ? move.toStepsWalked : (token.stepsWalked || 0);
            token.stepsWalked = sw;
            if (sw >= 52) {
                // Home lane: identical layout rules to movement.js.
                token.pathIndex = -2;
                var laneOffset = sw - 51;
                if (col === 'green') { token.c = laneOffset; token.r = 7; }
                else if (col === 'yellow') { token.c = 7; token.r = laneOffset; }
                else if (col === 'blue') { token.c = 14 - laneOffset; token.r = 7; }
                else if (col === 'red') { token.c = 7; token.r = 14 - laneOffset; }
                if (sw === 57) {
                    won = true;
                    if (typeof window.checkForMatchWinner === 'function') {
                        try { window.checkForMatchWinner(col); } catch (e) { /* soft */ }
                    }
                }
            } else {
                var path = (window.COMMON_PATH || []);
                var idx = move.toPathIndex;
                if (path[idx]) { token.pathIndex = idx; token.c = path[idx].c; token.r = path[idx].r; }
            }
            // Replicate captures deterministically: the landing square decides
            // whether an opponent token is sent home, and both devices share the
            // same pre-move board, so the same mechanic reproduces the capture
            // (including the capture-completes-circuit 57 fast-track + win).
            if (typeof checkCaptureMechanic === 'function') {
                try { checkCaptureMechanic(token, move.tokenIndex, toks); } catch (e) { /* soft */ }
            }
            if (typeof window.drawLudoLayout === 'function') window.drawLudoLayout();
            if (typeof window.saveGameStateToStorage === 'function') window.saveGameStateToStorage();
            log('applied opponent move seat=' + move.seat + ' tokens=' + move.tokenIndex + ' die=' + move.die1 + '+' + move.die2 + ' steps=' + sw + (won ? ' WINNER' : ''));
        } catch (e) { log('apply err ' + e.message); }
        return won || (token.stepsWalked >= 57);
    }

    // ---- multiplayer session ----
    function resolveHost() {
        // getDynamicSolanaWallet() returns the wallet ADDRESS as a plain string
        // (src/dynamic-auth.js), so accept string/object + profile fallbacks.
        try {
            if (window.getDynamicSolanaWallet && typeof window.getDynamicSolanaWallet === 'function') {
                var w = window.getDynamicSolanaWallet();
                if (typeof w === 'string' && w) return w;
                if (w && w.publicKey) return String(w.publicKey);
                if (w && w.address) return String(w.address);
            }
        } catch (e) { /* soft */ }
        try {
            if (window.currentProfile && window.currentProfile.solana_wallet) return String(window.currentProfile.solana_wallet);
        } catch (e) { /* soft */ }
        return null;
    }

    function start(gameId, players, seats, turnSecs, maxSecs, chosenSeat) {
        if (!rail()) { log('rail not loaded'); return Promise.resolve(null); }
        // A live multiplayer match is shared - a stale SOLO save on this device
        // must never resurrect divergent local turn/token state.
        if (typeof window.clearPersistedState === 'function') { try { window.clearPersistedState(); } catch (e) {} }
        mySeat = (typeof chosenSeat === 'number') ? chosenSeat : 0;
        seatCount = (typeof seats === 'number' && seats === 4) ? 4 : 2;
        return rail().create({ gameId: gameId || 1, host: resolveHost(), seats: seats || 2, turnSecs: turnSecs || 60, maxMatchSecs: maxSecs || 3600 }).then(function (r) {
            if (!r.okay) { log('create failed', r.error); if (r.error && typeof window.mpSetStatus === 'function') window.mpSetStatus('Create failed: ' + r.error); return null; }
            active = true;
            matchRef = r.matchRef;
            lastCount = -1;
            dimmed = false;
            unsub = rail().subscribe(matchRef, function (s) {
                try {
                    if (!s || typeof s.move_count !== 'number') return;
                    rememberSeats(s);
                    syncTurnFromBoard(s);
                    // Begin/finish transitions are surfaced (status/winner fire
                    // too now), but we only act on NEW moves for the opponent.
                    if (s.status === 1 && window.__mpRoom && window.__mpRoom.started !== true) {
                        try { if (window.__mpRoom) window.__mpRoom.started = true; } catch (e) {}
                        if (!window.__mpJoinedStarted) {
                            window.__mpJoinedStarted = true;
                            try { if (typeof window.__mpSyncSeats === "function" && typeof s.seats === "number") window.__mpSyncSeats(s.seats); var _js = (window.__mpOrigStart && typeof window.__mpOrigStart === "function") ? window.__mpOrigStart : window.initiateArenaMatch; if (typeof _js === "function") _js(); } catch (e) {}
                        }
                    }
                    if (s.move_count === lastCount) return;
                    var mv = decodeMove(s.last_move_commit);
                    if (mv && mv.seat !== mySeat) {
                        var applied = applyMove(mv);
                        if (applied === 'not-ready') {
                            // Board not up yet: don't advance lastCount - the
                            // next poll retries this same commit.
                            dimmed = false;
                            return;
                        }
                        lastCount = s.move_count;
                        dimmed = false;
                        // The board-synced turn was already set by
                        // syncTurnFromBoard (same seat on double-six, else next
                        // seat). Do NOT call passTurnSequence here - that would
                        // advance AGAIN off a device-local guess and skip RED.
                        // Just reset the roll flags so the new turn can roll.
                        try {
                            if (window.resetTurnForRoll && typeof window.resetTurnForRoll === 'function') window.resetTurnForRoll();
                        } catch (e) { /* soft */ }
                    } else {
                        lastCount = s.move_count;
                    }
                } catch (e) { log('listen err ' + e.message); }
            });
            log('match created code=' + r.code + ' ref=' + matchRef + ' mySeat=' + mySeat);
            bindSeats();
            return r;
        });
    }

    function join(gameId, code, chosenSeat) {
        if (!rail()) return Promise.resolve(null);
        // A live multiplayer match is shared - a stale SOLO save on this device
        // must never resurrect divergent local turn/token state.
        if (typeof window.clearPersistedState === 'function') { try { window.clearPersistedState(); } catch (e) {} }
        // Joiner seat count: match the lobby room's seat count when available.
        try { if (window.__mpRoom && window.__mpRoom.seats === 4) seatCount = 4; } catch (e) {}
        var handle = '';
        try { if (window.__mpHandle && typeof window.__mpHandle === 'function') handle = window.__mpHandle() || ''; } catch (e) {}
        return rail().join(gameId || 1, code, (typeof chosenSeat === 'number') ? chosenSeat : undefined, handle).then(function (r) {
            if (!r.okay) { log('join failed', r.error); if (r.error && typeof window.mpSetStatus === 'function') window.mpSetStatus('Join failed: ' + r.error); return null; }
            active = true;
            matchRef = r.matchRef;
            // mySeat comes from the on-chain join result (the free seat chosen).
            mySeat = (typeof r.seat === 'number') ? r.seat : ((typeof chosenSeat === 'number') ? chosenSeat : 1);
            lastCount = -1;
            unsub = rail().subscribe(matchRef, function (s) {
                try {
                    if (!s || typeof s.move_count !== 'number') return;
                    rememberSeats(s);
                    syncTurnFromBoard(s);
                    if (s.status === 1 && window.__mpRoom && window.__mpRoom.started !== true) {
                        try { if (window.__mpRoom) window.__mpRoom.started = true; } catch (e) {}
                        if (!window.__mpJoinedStarted) {
                            window.__mpJoinedStarted = true;
                            try { if (typeof window.__mpSyncSeats === "function" && typeof s.seats === "number") window.__mpSyncSeats(s.seats); var _js = (window.__mpOrigStart && typeof window.__mpOrigStart === "function") ? window.__mpOrigStart : window.initiateArenaMatch; if (typeof _js === "function") _js(); } catch (e) {}
                        }
                    }
                    if (s.move_count === lastCount) return;
                    var mv = decodeMove(s.last_move_commit);
                    if (mv && mv.seat !== mySeat) {
                        var applied = applyMove(mv);
                        if (applied === 'not-ready') {
                            dimmed = false;
                            return;
                        }
                        lastCount = s.move_count;
                        dimmed = false;
                        // Board-synced turn already set by syncTurnFromBoard; do
                        // NOT passTurnSequence again (avoids the double-advance
                        // that skipped RED). Reset roll flags for the new turn.
                        try {
                            if (window.resetTurnForRoll && typeof window.resetTurnForRoll === 'function') window.resetTurnForRoll();
                        } catch (e) { /* soft */ }
                    } else {
                        lastCount = s.move_count;
                    }
                } catch (e) { /* soft */ }
            });
            log('joined ref=' + matchRef + ' mySeat=' + mySeat);
            bindSeats();
            return r;
        });
    }

    function isActive() { return active; }
    function ref() { return matchRef; }
    function seat() { return mySeat; }
    function color() { return colorOf(mySeat); }
    // On-chain identity (wallet + handle) per seat, populated from the board
    // state so the UI + M2 seam can display "You - <handle>" vs "<handle>".
    var seatWallets = [];  // index -> wallet base58 (or empty)
    var seatHandles = [];  // index -> sitewide handle
    function rememberSeats(s) {
        try {
            if (s && Array.isArray(s.players)) seatWallets = s.players.slice();
            if (s && Array.isArray(s.handles)) seatHandles = s.handles.slice();
        } catch (e) { /* soft */ }
    }
    function players() { return seatWallets.slice(); }
    function handles() { return seatHandles.slice(); }

    // BOARD-SYNCED TURN + MOVE: the on-chain board is the single source of
    // truth. Commit writes store: seat that moved, its dice, and the board's
    // current_turn (= the seat that last moved). BOTH devices derive the next
    // turn from the SAME committed data - never a local guess:
    //   - double-six roll (up to 3 in a row) -> the SAME seat rolls again;
    //   - anything else -> the NEXT seat in the active order.
    // This makes the display turn, the dice values, and whose roll it is
    // identical on every phone, because they all come from the same bytes.
    function turnFromBoard(s) {
        try {
            if (!s || typeof s.current_turn !== 'number') return null;
            if (s.current_turn === 255) return null; // none yet -> host rolls first
            var order = activeOrder();
            if (!order || order.length < 2) return null;
            // Replicate the commit: which seat moved + what it rolled.
            var mv = decodeMove(s.last_move_commit);
            var seatThatMoved = (mv && typeof mv.seat === 'number') ? mv.seat : s.current_turn;
            var d6 = !!(mv && ((mv.die1 > 0 && mv.die1 === 6) && (mv.die2 > 0 && mv.die2 === 6)));
            if (d6) return order[seatThatMoved % order.length]; // same seat again
            return order[(seatThatMoved + 1) % order.length];
        } catch (e) { return null; }
    }
    // Force the local game onto the board-synced turn (display indicator + the
    // lexical `currentTurn` the rolls read). No-op when already on it.
    function syncTurnFromBoard(s) {
        var c = turnFromBoard(s);
        if (!c) return false;
        var got = (window.getGameCurrentTurn && window.getGameCurrentTurn()) || '';
        if (got === c) return true;
        if (window.setGameCurrentTurn) { try { window.setGameCurrentTurn(c); } catch (e) {} }
        var ti = document.getElementById('turn-indicator');
        if (ti) {
            var cm = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };
            ti.innerText = c.charAt(0).toUpperCase() + c.slice(1) + "'s Turn";
            ti.style.color = cm[c] || '#2ecc71';
        }
        return true;
    }

    // MULTIPLAYER SEAT BINDING: this device controls `mySeat` (mode 'human' +
    // isUser so the "You" seat is the local player). Every OTHER active seat is
    // set to remote-human (mode 'human', isUser false): it is controlled by its
    // own device, never by local AI, and gfgRemoteTurn blocks local rolls for
    // it. Solo is untouched because this only runs when the rail is active.
    // The game objects (ping turn/seat pickers) are not rewritten - we only
    // nudge the runtime seat modes the AI engine consults.
    function bindSeats(activeColors) {
        try {
            if (!window.playerProfiles) return;
            var me = color();
            var act = (activeColors && activeColors.length) ? activeColors : activeOrder();
            act.forEach(function (c) {
                if (!window.playerProfiles[c]) return;
                if (c === me) {
                    window.playerProfiles[c].mode = 'human';
                    window.playerProfiles[c].isUser = true;
                } else {
                    // Remote seats show as human (never computer/AI), but are
                    // marked NOT the signed-in user so they never earn as 'user'
                    // on THIS device (their own device earns for them).
                    window.playerProfiles[c].mode = 'human';
                    window.playerProfiles[c].isUser = false;
                }
            });
        } catch (e) { /* soft */ }
    }

    // HOST-ONLY: begin the live match (status 0 -> 1), locking out new joins.
    // The host MUST be players[0] (resolved at create); the rail signs the
    // begin with THIS device's session key (program enforces seat 0 authority).
    function begin() {
        if (!active || !matchRef) return Promise.resolve({ okay: false, error: 'not in a match' });
        if (mySeat !== 0) return Promise.resolve({ okay: false, error: 'only the host can start' });
        return rail().begin({ gameId: 1, matchRef: matchRef }).then(function (r) {
            if (r && r.okay) log('match begun');
            else if (r && r.error) { log('begin failed', r.error); if (typeof window.mpSetStatus === 'function') window.mpSetStatus('Start failed: ' + r.error); }
            return r;
        });
    }

    // called by the game after a real LOCAL move: commit the move gasless
    function onMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked) {
        if (!active || !matchRef) return;
        var bytes = encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked);
        try { window._mpLatestCommit = bytes; } catch (e) {}
        var refObj = { gameId: 1, matchRef: matchRef, seat: seatOf(window.getGameCurrentTurn ? window.getGameCurrentTurn() : (window.currentTurn || 'green')) };
        rail().commitMove(refObj, bytes).then(function (r) {
            if (!(r && r.ok)) log('move commit skipped', (r && r.error) || '');
        });
    }

    function onFinish(winnerSeat) {
        if (!active || !matchRef) return;
        active = false;
        var refObj = { gameId: 1, matchRef: matchRef };
        var ws = (typeof winnerSeat === 'number') ? winnerSeat : seatOf(window.finishOrder && window.finishOrder[0]);
        rail().finish(refObj, ws).then(function (r) {
            if (!(r && r.okay)) log('finish skipped', (r && r.error) || '');
            if (unsub) { unsub(); unsub = null; }
        });
    }

    function stop() { active = false; if (unsub) unsub(); unsub = null; }
    // After a pre-start seat switch the rail already re-joined on-chain; this
    // updates this device's seat index so the turn gate + colour mapping match
    // the new seat, and re-binds the game seats ('You' moves to the new colour).
    // No re-subscribe (the existing one keeps polling).
    function setMySeat(seat) {
        if (typeof seat === 'number' && seat >= 0) mySeat = seat;
        bindSeats();
        if (typeof window.mpRenderLobby === 'function') {
            try { window.__mpPollLobby(); } catch (e) { /* soft */ }
        }
    }

    window.gfgLudoAdapter = { start: start, join: join, begin: begin, onMove: onMove, onFinish: onFinish, isActive: isActive, ref: ref, seat: seat, color: color, players: players, handles: handles, activeOrder: activeOrder, rememberSeats: rememberSeats, setMySeat: setMySeat, stop: stop };

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