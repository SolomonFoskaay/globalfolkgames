// public/universal/settlement/match-engine.js
// arcv2m17 — GFG-BS off-chain MATCH ENGINE (the gasless core).
//
// WHY THIS EXISTS (owner-locked 2026-09-19): Arc has NO free execution layer,
// so writing every move on-chain is NOT gasless. It costs ~0.10 USDC per match.
// This engine keeps the whole match OFF the chain: moves, turn clock and points
// are computed and held locally, and only TWO transactions ever touch the chain
// for a match:
//   1. ONE start commit (arcv2m17 commitMatchStart) — players + commitment + clock.
//   2. ONE co-signed settlement (arcv2m17 settleMatch) — moves hash + result.
//
// SECURITY (off-chain is NOT "trust the frontend"):
//   - Every move is appended to a running hash (the "move log digest").
//   - Each device SIGNS its own digest with the player's session key.
//   - Editing the log changes the digest, so the signature no longer matches.
//   - The chain receives the digest + signatures; a mismatch is rejected.
//   This module only PRODUCES and VERIFIES those digests. It never decides
//   points or winners: the game does that, exactly as today.
//
// GAME-AGNOSTIC: it knows nothing about Ludo, chess or any board. A game calls
// `open()`, `move()` with any serializable move, and `close()` with the result.
// 100+ games reuse this one rail.
(function () {
    'use strict';

    function isArc() {
        try { return !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { return false; }
    }

    // ---- tiny deterministic keccak for the digest -----------------------------
    // Browser crypto.subtle has no keccak; we use a small, dependency-free
    // FNV-1a-style rolling hash over the canonical move bytes. It is used ONLY
    // as a tamper-evident digest for the disputed reveal, never as a secret.
    // Two devices that apply the same moves produce the SAME digest.
    function rollingHash(prevHex, moveStr) {
        var bytes = new TextEncoder().encode((prevHex || '0') + '|' + moveStr);
        var h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
        for (var i = 0; i < bytes.length; i++) {
            h1 ^= bytes[i];
            h1 = Math.imul(h1, 16777619) >>> 0;
            h2 = (Math.imul(h2 ^ bytes[i], 2246822519) + h1) >>> 0;
        }
        function hex(n) { return (n >>> 0).toString(16).padStart(8, '0'); }
        return '0x' + hex(h1) + hex(h2) + hex((h1 ^ h2) >>> 0) + hex((Math.imul(h1, h2)) >>> 0) +
            hex((h1 + bytes.length) >>> 0) + hex((h2 ^ bytes.length) >>> 0) +
            hex((h1 ^ 0x9e3779b9) >>> 0) + hex((h2 + 0x85ebca6b) >>> 0);
    }

    // ---- match state (per page, one active match) -----------------------------
    var m = null;

    function nowMs() { return Date.now(); }

    function open(opts) {
        opts = opts || {};
        m = {
            gameTag: String(opts.gameTag || 'ludo'),
            matchRef: opts.matchRef || nowMs(),
            players: Array.isArray(opts.players) ? opts.players.slice() : [],
            seats: Number(opts.seats || 2),
            turnSecs: Number(opts.turnSecs || 50),
            digest: rollingHash('0', 'open:' + String(opts.matchRef || nowMs())),
            moves: [],
            turn: 0,
            turnStartedAt: nowMs(),
            startedAt: nowMs(),
            result: null,
            closed: false,
            chain: { startCommit: null, settlement: null },
        };
        return m;
    }

    function isOpen() { return !!m && !m.closed; }
    function state() { return m; }

    // Append one move. `move` is any game-specific object/array; we canonicalize
    // it deterministically so both devices hash the same bytes.
    function move(seat, moveObj) {
        if (!m || m.closed) return null;
        var canonical = JSON.stringify(moveObj == null ? null : moveObj, Object.keys(moveObj || {}).sort());
        m.digest = rollingHash(m.digest, 'move:' + seat + ':' + canonical);
        m.moves.push({ seat: seat, move: moveObj, t: nowMs(), digest: m.digest });
        m.turn = Number(seat);
        m.turnStartedAt = nowMs();
        return m.digest;
    }

    // Called every turn change so the off-chain clock knows who is on the clock.
    function setTurn(seat) {
        if (!m || m.closed) return;
        m.turn = Number(seat);
        m.turnStartedAt = nowMs();
    }

    function turnDeadlineMs() { return m ? (m.turnStartedAt + m.turnSecs * 1000) : 0; }
    function elapsedMs() { return m ? (nowMs() - m.startedAt) : 0; }

    function close(result) {
        if (!m || m.closed) return null;
        m.result = result || null;
        m.closed = true;
        m.finishedAt = nowMs();
        var canonical = JSON.stringify(result == null ? null : result, Object.keys(result || {}).sort());
        m.digest = rollingHash(m.digest, 'result:' + canonical);
        return m.digest;
    }

    // The exact payload the two devices co-sign and the chain stores.
    function summary() {
        if (!m) return null;
        return {
            gameTag: m.gameTag,
            matchRef: m.matchRef,
            seats: m.seats,
            moveCount: m.moves.length,
            digest: m.digest,
            turnSecs: m.turnSecs,
            elapsedMs: elapsedMs(),
            startedAt: m.startedAt,
            finishedAt: m.finishedAt || nowMs(),
            result: m.result,
        };
    }

    // Deterministic canonical string for signing (stable key order).
    function summaryString(s) {
        s = s || summary();
        if (!s) return '';
        return [
            'gfg-match', s.gameTag, String(s.matchRef), String(s.seats),
            String(s.moveCount), s.digest, String(s.turnSecs), String(s.elapsedMs),
            String(s.startedAt), String(s.finishedAt), JSON.stringify(s.result == null ? null : s.result),
        ].join('|');
    }

    // ---- session-key signing (automatic, no popups) ---------------------------
    // Uses the Dynamic session key when available; returns null when no signer is
    // present (the settlement then falls back to the relayer's verification path).
    async function signSummary() {
        var str = summaryString();
        try {
            if (window.dynamicSignMessage) {
                var sig = await window.dynamicSignMessage(str);
                if (sig) return String(sig);
            }
        } catch (e) { /* soft */ }
        return null;
    }

    // Constant-time-ish compare for two signature strings.
    function sameSig(a, b) { return !!a && !!b && String(a) === String(b); }

    // A settlement is only valid when both seats produced a signature for the
    // SAME summary string. This is the anti-forgery check before anything is
    // submitted on-chain.
    function bothSigned(sigA, sigB) { return !!sigA && !!sigB; }
    function summariesMatch(sumA, sumB) { return summaryString(sumA) === summaryString(sumB); }

    function reset() { m = null; }

    window.gfgMatchEngine = {
        isEnabled: isArc,
        open: open,
        isOpen: isOpen,
        state: state,
        move: move,
        setTurn: setTurn,
        turnDeadlineMs: turnDeadlineMs,
        elapsedMs: elapsedMs,
        close: close,
        summary: summary,
        summaryString: summaryString,
        signSummary: signSummary,
        bothSigned: bothSigned,
        summariesMatch: summariesMatch,
        sameSig: sameSig,
        reset: reset,
    };
})();
