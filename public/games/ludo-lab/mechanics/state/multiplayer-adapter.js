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
    var movedThisTurn = false; // set when a real move committed this turn
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

    // ---- BOARD SNAPSHOT COMMIT (the single shared board) ----
// The commit is a full BOARD STATE, not a single move. byte0 seat, byte1 die1,
// byte2 die2, bytes3..18 = each token's stepsWalked (0..57) in the fixed
// order green[0..3], yellow[0..3], blue[0..3], red[0..3], byte19 = whose turn
// (colorOf index). Both devices therefore reconstruct the ENTIRE board from the
// same 32 bytes - identical positions, dice, and turn by construction. The
// game's own rendering (pathIndex/c/r) is derived from stepsWalked exactly like
// movement.js does, so the board always matches.
var SNAPSHOT_COLORS = ['green', 'yellow', 'blue', 'red'];

// ---- BOARD SNAPSHOT COMMIT encoding: PATHINDEX (real board cell), not steps ----
// Encode each token as its ACTUAL position the game uses:
//   pathIndex -2 (home lane) -> 64 + (stepsWalked - 52)  => 64..69 (lane/win)
//   pathIndex -1 (yard)       -> 80
//   otherwise (track)         -> pathIndex              => 0..51
// This removes TWO bugs of encoding stepsWalked:
//   1) a token released from the yard has stepsWalked 0 (same as a yard token),
//      so receivers re-yarded it -> GREEN tokens vanished / wiped by B's snapshot.
//   2) on-track position is START_INDEX + stepsWalked, so COMMON_PATH[stepsWalked]
//      teleported RED to GREEN's opposite box.
var SNAPSHOT_YARD = 80;      // yard marker
var SNAPSHOT_LANE_BASE = 64; // 64..69 = home-lane stepsWalked 52..57

function tokenEncode(tok) {
    if (!tok) return SNAPSHOT_YARD;
    var p = (typeof tok.pathIndex === 'number') ? tok.pathIndex : -1;
    if (p === -1) return SNAPSHOT_YARD;
    if (p === -2) {
        var sw = (typeof tok.stepsWalked === 'number') ? tok.stepsWalked : 55;
        return SNAPSHOT_LANE_BASE + (sw - 52);
    }
    return (p & 0xff);
}

function snapshotFromTokens() {
    var sw = [];
    for (var c = 0; c < 4; c++) {
        var col = SNAPSHOT_COLORS[c];
        var toks = (window.tokens && window.tokens[col]) || [];
        for (var t = 0; t < 4; t++) {
            sw.push(tokenEncode(toks[t]));
        }
    }
    return sw;
}

// encode the WHOLE board into a 32-byte commit. byte0 seat, byte1-2 dice,
// bytes3..18 = tokenEncode positions (real board cells), byte19 = next turn.
// `advance`: true only on the turn-pass commit (real move commits stay on the
// current seat so a mid-turn snapshot NEVER flips the turn to the opponent).
function encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked, advance) {
    var m = [];
    for (var i = 0; i < 32; i++) m[i] = 0;
    m[0] = seatOf(window.getGameCurrentTurn ? window.getGameCurrentTurn() : (window.currentTurn || 'green'));
    m[1] = (typeof die1 === 'number' ? die1 : 0) & 0xff;
    m[2] = (typeof die2 === 'number' ? die2 : 0) & 0xff;
    var sw = snapshotFromTokens();
    for (var s = 0; s < 16 && s < sw.length; s++) m[3 + s] = (sw[s] & 0xff);
    var me = m[0];
    if (!advance) {
        m[19] = me; // mid-turn (dice + move snapshots): turn does NOT move yet
        return m;
    }
    var d6 = (m[1] === 6 && m[2] === 6);
    m[19] = d6 ? me : ((me + 1) % (seatCount === 4 ? 4 : 2));
    return m;
}

// decode a 32-byte commit into a full board snapshot
function decodeMove(bytes) {
    if (!bytes || bytes.length < 3) return null;
    try {
        var sw = [];
        for (var i = 0; i < 16; i++) sw.push(bytes[3 + i] || 0);
        return {
            seat: bytes[0],
            die1: bytes[1],
            die2: bytes[2],
            steps: sw,
            turnSeat: (bytes[19] !== undefined) ? bytes[19] : bytes[0],
        };
    } catch (e) { return null; }
}

// Reconstruct a token from the committed ENCODED position (tokenEncode scheme).
// Mirrors movement.js: 80=yard; 64..69=home-lane(stepsWalked 52..57) via pathIndex
// -2 + lane offsets; 0..51=track where stepsWalked = pathIndex - START_INDEX.
function positionToken(token, enc, color, tIdx) {
    var HY = (typeof HOME_YARDS !== 'undefined') ? HOME_YARDS : null;
    var CP = (typeof COMMON_PATH !== 'undefined') ? COMMON_PATH : null;
    var SI = (typeof START_INDEX !== 'undefined') ? START_INDEX : null;

    if (enc === SNAPSHOT_YARD) {
        token.pathIndex = -1;
        token.stepsWalked = 0;
        if (HY && HY[color] && HY[color][tIdx]) { token.c = HY[color][tIdx].c; token.r = HY[color][tIdx].r; }
        return;
    }
    if (enc >= SNAPSHOT_LANE_BASE && enc <= SNAPSHOT_LANE_BASE + 5) {
        var sw = 52 + (enc - SNAPSHOT_LANE_BASE);
        token.stepsWalked = sw;
        token.pathIndex = -2;
        var laneOffset = sw - 51;
        if (color === 'green') { token.c = laneOffset; token.r = 7; }
        else if (color === 'yellow') { token.c = 7; token.r = laneOffset; }
        else if (color === 'blue') { token.c = 14 - laneOffset; token.r = 7; }
        else if (color === 'red') { token.c = 7; token.r = 14 - laneOffset; }
        return;
    }
    if (enc >= 0 && enc < 52 && CP && SI) {
        token.pathIndex = enc;
        // Game track position = pathIndex, stepsWalked = distance from the
        // color's start tile (STARTS_INDEX offsets the path).
        token.stepsWalked = (enc - (SI[color] || 0) + 52) % 52;
        if (CP[enc]) { token.c = CP[enc].c; token.r = CP[enc].r; }
        return;
    }
    // Fallback: keep as-is (unknown encoding) - never touch an existing token.
}

// apply a committed snapshot to the local board (deterministic).
// Returns true when the move finished the opponent; 'not-ready' if board is up.
function applyMove(move) {
    var won = false;
    try {
        if (!window.tokens) return 'not-ready';
        // Reconstruct EVERY token from the snapshot - no move replay needed.
        var anyMissing = false;
        for (var c = 0; c < 4; c++) {
            var col = SNAPSHOT_COLORS[c];
            var toks = window.tokens[col] || [];
            for (var t = 0; t < 4; t++) {
                if (!toks[t]) { anyMissing = true; continue; }
                var swv = move.steps ? move.steps[c * 4 + t] : 0;
                positionToken(toks[t], swv, col, t);
            }
        }
        if (anyMissing) return 'not-ready';
        // Shared dice: mirror the committed roll onto this device so both
        // screens show the same dice the remote player rolled.
        if (move.die1 > 0 && move.die2 > 0 && typeof window.showRemoteDice === 'function') {
            try { window.showRemoteDice(move.die1, move.die2); } catch (e) { /* soft */ }
        }
        // Fire wins deterministically: any token at 57 after the snapshot is a
        // finished seat (the snapshot is the truth, so we can see it directly).
        var finishedAny = false;
        for (var c2 = 0; c2 < 4; c2++) {
            var col2 = SNAPSHOT_COLORS[c2];
            var toks2 = window.tokens[col2] || [];
            var allHome = true;
            for (var t2 = 0; t2 < 4; t2++) {
                if (!(toks2[t2] && toks2[t2].stepsWalked >= 57)) allHome = false;
            }
            if (allHome && typeof window.checkForMatchWinner === 'function') {
                try { window.checkForMatchWinner(col2); } catch (e) { /* soft */ }
                finishedAny = true;
            }
        }
        if (typeof window.drawLudoLayout === 'function') window.drawLudoLayout();
        if (typeof window.saveGameStateToStorage === 'function') window.saveGameStateToStorage();
        log('applied snapshot seat=' + move.seat + ' die=' + move.die1 + '+' + move.die2 + (finishedAny ? ' (finish detected)' : ''));
    } catch (e) { log('apply err ' + e.message); }
    return won || finishedAny;
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
                    if (s.move_count === 0) { lastCount = 0; return; } // no real move yet - skip the all-zero initial commit to avoid a phantom board
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
                    if (s.move_count === 0) { lastCount = 0; return; } // no real move yet - skip the all-zero initial commit to avoid a phantom board
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
            // The commit carries the committing device's AUTHORITATIVE next turn
            // (byte19) + the full board snapshot. Prefer it - no derivation on
            // the receiving phone. Fall back to the d6 rule from the dice.
            var mv = decodeMove(s.last_move_commit);
            if (mv && typeof mv.turnSeat === 'number' && mv.turnSeat < order.length) {
                return order[mv.turnSeat % order.length];
            }
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
        // A new turn began -> the per-turn 'did we move?' flag resets so the
        // next turn-ending pass commit works even after a zero-move turn.
        movedThisTurn = false;
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

    // Called after each REAL local token move - records progress only. The actual
// on-chain COMMIT is bundled to ONE per turn in onPassTurn (below), so a
// double-roll turn with two token moves produces a single commit carrying the
// final board. This fixes: too many tiny commits, and the old race where the
// first rolled value committed alone and the player lost their second move.
function commitSnapshot(bytes, label) {
    if (!active || !matchRef) return;
    if (!bytes || !bytes.length) return;
    var refObj = { gameId: 1, matchRef: matchRef, seat: bytes[0] & 0xff };
    var attempts = 0;
    var commitLoop = function () {
        attempts++;
        var settled = false;
        var settleSuccess = function (sig) {
            if (settled) return; settled = true;
            log(label + ' committed on-chain seat=' + refObj.seat + ' sig=' + (sig || ''));
        };
        var settleFail = function (err) {
            if (settled) return; settled = true;
            log(label + ' commit attempt ' + attempts + ' FAILED: ' + err);
            if (attempts < 3) { setTimeout(commitLoop, 1200); return; }
            try { window.dispatchEvent(new CustomEvent('gfg:mp-error', { detail: { action: 'commitMove', error: 'on-chain commit failed: ' + err } })); } catch (e) {}
        };
        rail().commitMove(refObj, bytes).then(function (r) {
            if (r && r.okay) settleSuccess(r.sig);
            else settleFail((r && r.error) || 'no result');
        }).catch(function (e) {
            settleFail((e && e.message) || String(e));
        });
        setTimeout(function () { settleFail('timed out (no response after 14s)'); }, 14000);
    };
    commitLoop();
}

// LIVE dice commit: when the local player rolls, immediately push a snapshot
// (byte19 = current seat, advance=false) so the opponent sees the dice + board
// in real time, BEFORE any token moves. The turn is NOT advanced.
function onDiceRoll(die1, die2) {
    if (!active || !matchRef) return;
    if (!die1 || !die2) return;
    if (!window.tokens) return;
    var bytes = encodeMove(die1, die2, 0, 0, 0, 0, false);
    try { window._mpLatestDice = bytes; } catch (e) {}
    commitSnapshot(bytes, 'dice');
}

// Called after each REAL local token move. Each move is committed live with
// advance=false so the opponent sees THIS token move on their board right now,
// but the turn does NOT flip until onPassTurn. (Old bug fixed: committing never
// ends the turn early / steals the second dice value.)
function onMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked) {
    if (!active || !matchRef) return;
    movedThisTurn = true;
    var bytes;
    try {
        bytes = encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked, false);
    } catch (e) {
        log('encodeMove THREW: ' + (e && e.message));
        return;
    }
    try { window._mpLatestCommit = bytes; } catch (e) {}
    commitSnapshot(bytes, 'move');
}

// The ONE advance=true commit per turn-end: after ALL this turn's token moves
// (or zero moves on a non-6 roll), send the final board + byte19 = next seat so
// the opponent's turn flips. Single tx per turn; never ends the turn early.
function onPassTurn() {
    if (!active || !matchRef) return;
    if (!window.tokens) return;
    var bytes;
    try {
        // Re-encode the CURRENT board with advance=true (turn passes now).
        bytes = encodeMove(0, 0, 0, 0, 0, 0, true);
    } catch (e) {
        log('pass encode THREW: ' + (e && e.message));
        return;
    }
    movedThisTurn = false;
    try { window._mpPassCommit = bytes; } catch (e) {}
    commitSnapshot(bytes, 'turn');
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

    window.gfgLudoAdapter = { start: start, join: join, begin: begin, onMove: onMove, onDiceRoll: onDiceRoll, onPassTurn: onPassTurn, onFinish: onFinish, isActive: isActive, ref: ref, seat: seat, color: color, players: players, handles: handles, activeOrder: activeOrder, rememberSeats: rememberSeats, setMySeat: setMySeat, stop: stop };

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