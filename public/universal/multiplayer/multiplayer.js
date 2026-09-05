// public/universal/multiplayer/multiplayer.js
// M1 arc2m1d — standalone game-agnostic multiplayer RAIL.
//
// The game owns everything (turn order, move meaning, rules, UI). This rail
// only: creates+delegates the match board on the ER, commits move-hash
// checkpoints gasless, listens for opponent moves, and finishes the match.
// A separate AGM (money) plug attaches LATER without changing this rail.
//
// SAFETY: every on-chain call is soft-fail. If the rail can't reach the chain
// the GAME keeps working standalone (Solo unaffected). The rail never throws
// into game code; it reports {okay, error} and logs.
//
// API (window.gfgMultiplayer):
//   create({gameId, players, seats, turnSecs, maxMatchSecs}) -> {okay, code, matchRef, pda}
//   join(gameId, code) -> {okay, matchRef, pda}
//   commitMove({gameId, matchRef, seat}, moveHash) -> Promise<{okay, sig}>
//   subscribe(matchRef, onUpdate) -> unsubscribe
//   finish({gameId, matchRef, winnerSeat}) -> Promise<{okay, sig}>
//   state(matchRef) -> Promise<board facts>
//
// Per-game ADAPTER (inside the game, NOT here):
//   window.gfgMultiplayerAdapter(gameId) = {
//     encodeMove(state) -> hash[32],
//     applyOpponent(moveHash) -> void,
//     currentSeat() -> seatIndex,
//     isFinished() -> winnerSeat|null,
//   }

(function () {
    if (window.gfgMultiplayer) return; // already loaded

    const GAME = 1; // M1 source_code default; games pass gameId for their own

    function log() { try { console.log.apply(console, ['[MP]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }

    function api(action, body) {
        return fetch('/api/multiplayer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, body || {})),
        }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: e.message }; });
    }

    // ---- helpers ----
    function hash32(s) {
        var out = new Uint8Array(32);
        var src = String(s || '') + '|' + Date.now();
        for (var i = 0; i < 32; i++) { out[i] = (i < src.length) ? (src.charCodeAt(i) % 256) : 0; }
        return Array.from(out);
    }

    // ---- create / join ----
    async function create(opts) {
        opts = opts || {};
        var matchRef = Date.now();
        var r = await api('create', {
            game: GAME,
            matchRef: matchRef,
            players: opts.players || [],
            seats: opts.seats || 2,
            stakeUsdCents: 0,               // free standalone; AGM raises this later
            turnSecs: opts.turnSecs || 60,
            maxMatchSecs: opts.maxMatchSecs || 3600,
        });
        if (!r.ok) return { okay: false, error: r.error };
        // The code IS the matchRef in base36 (round-trips exactly; 9-10 chars).
        var code = (matchRef).toString(36).toUpperCase();
        return { okay: true, code: code, matchRef: matchRef, pda: r.pda };
    }

    // code -> matchRef (exact inverse of create's encode)
    function codeToRef(code) {
        try {
            var v = parseInt(String(code || '').toLowerCase(), 36);
            return (v && v > 0) ? v : 0;
        } catch (e) { return 0; }
    }

    async function join(gameId, code) {
        var ref = codeToRef(code);
        if (!ref) return { okay: false, error: 'invalid code (expected base36 match ref)' };
        var s = await state(ref);
        if (!s || !s.ok) return { okay: false, error: 'no open match with that code' };
        return { okay: true, matchRef: ref, pda: s.pda };
    }

    // ---- moves (gasless ER via relay) ----
    function commitMove(move, moveHash) {
        var gameId = (move && move.gameId) || GAME;
        var ref = move && move.matchRef;
        var seat = (move && typeof move.seat === 'number') ? move.seat : 0;
        if (!ref) return Promise.resolve({ okay: false, error: 'no matchRef' });
        return api('commit', { game: gameId, matchRef: ref, seat: seat, moveCommit: Array.isArray(moveHash) ? moveHash : hash32(moveHash) });
    }

    // ---- subscribe: poll the board on the ER for opponent moves ----
    function subscribe(matchRef, onUpdate, onError, pollMs) {
        pollMs = pollMs || 1200;
        var seen = -1;
        var stop = false;
        (function loop() {
            if (stop) return;
            api('state', { game: GAME, matchRef: matchRef }).then(function (s) {
                if (stop) return;
                if (s && s.ok) {
                    if (s.move_count !== seen) {
                        seen = s.move_count;
                        onUpdate(s);
                    }
                } else if (onError) { onError(s && s.error || 'board state unavailable'); }
                setTimeout(loop, pollMs);
            }).catch(function () { if (!stop) setTimeout(loop, pollMs); });
        })();
        return function () { stop = true; };
    }

    // ---- finish ----
    async function finish(move, winnerSeat) {
        var gameId = (move && move.gameId) || GAME;
        var ref = move && move.matchRef;
        if (!ref) return { okay: false, error: 'no matchRef' };
        var r = await api('finish', { game: gameId, matchRef: ref, winnerSeat: winnerSeat });
        return r && r.ok ? { okay: true, sig: r.sig } : { okay: false, error: r.error };
    }

    async function state(matchRef) {
        var r = await api('state', { game: GAME, matchRef: matchRef });
        return r && r.ok ? r : null;
    }

    // ---- begin (host starts the live match; status 0 -> 1, no more joins) ----
    async function begin(move) {
        var gameId = (move && move.gameId) || GAME;
        var ref = move && move.matchRef;
        if (!ref) return { okay: false, error: 'no matchRef' };
        var r = await api('begin', { game: gameId, matchRef: ref });
        return r && r.ok ? { okay: true, started: !!r.started } : { okay: false, error: r.error };
    }

    window.gfgMultiplayer = {
        create: create,
        join: join,
        begin: begin,
        commitMove: commitMove,
        subscribe: subscribe,
        finish: finish,
        state: state,
        hash32: hash32,
        GAME: GAME,
    };

    log('multiplayer rail loaded (arc2m1d, standalone, game-agnostic)');
})();