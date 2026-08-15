// win-detection.js (M1 — game core only)
// Detects winners, tracks finishing order for crowns, and emits a match-result
// SEAM when the match completes. M1 knows NOTHING about points, tiers,
// competitions or rewards: when the match ends it simply publishes the result
// (finish order + the on-chain proof-roll signature) on
// window.gfgMatchResultHandlers so an M2/M3 module can consume it later.

(function () {

    let finishOrder = [];   // e.g. ['green', 'red', 'yellow', 'blue']

    // M2/M3 modules subscribe here to consume match results (finish order +
    // proof-of-play signature). The game itself never touches points.
    const matchResultHandlers = [];

    window.onGfgMatchResult = function (handler) {
        if (typeof handler === 'function') matchResultHandlers.push(handler);
        return () => {
            const i = matchResultHandlers.indexOf(handler);
            if (i >= 0) matchResultHandlers.splice(i, 1);
        };
    };

    function countFinishedTokens(color) {
        if (!window.tokens || !window.tokens[color]) return 0;
        return window.tokens[color].filter(t => t.stepsWalked >= 57).length;
    }

    window.checkForMatchWinner = function (color) {
        if (!color || !window.playerProfiles) return;

        const finished = countFinishedTokens(color);
        if (finished < 4) return;

        // Already recorded this colour?
        if (finishOrder.includes(color)) return;

        // Record finishing position
        finishOrder.push(color);
        const position = finishOrder.length; // 1, 2, 3 or 4

        console.log(`Position ${position}: ${color.toUpperCase()}`);

        // Persist immediately so a page reload keeps the crowns (finish order)
        // for in-progress matches.
        if (typeof saveGameStateToStorage === 'function') {
            saveGameStateToStorage();
        }

        // Force a redraw so the crown appears immediately
        if (typeof drawLudoLayout === 'function') {
            drawLudoLayout();
        }

        // Match complete (all 4 seats finished): publish the result seam. The
        // proof-roll signature (when present) is M1's proof-of-play — M2/M3
        // decide what to do with it. No points logic lives here.
        if (finishOrder.length === 4) {
            const proofSig = typeof window.getLastProofRollSignature === 'function'
                ? window.getLastProofRollSignature() : null;
            const result = {
                game: 'ludo',
                finishOrder: finishOrder.slice(),
                proofSignature: proofSig || null,
                finishedAt: Date.now(),
            };
            console.log('[M1] Match complete — emitting result seam', result);
            matchResultHandlers.slice().forEach(h => {
                try { h(result); } catch (e) { console.warn('[M1] match-result handler failed:', e); }
            });
            const evt = new CustomEvent('gfg:match-result', { detail: result });
            window.dispatchEvent(evt);
        }
    };

    // Used by board.js to know who finished where
    window.getFinishOrder = function () {
        return finishOrder;
    };

    window.getPlayerRank = function (color) {
        const index = finishOrder.indexOf(color);
        return index === -1 ? 0 : index + 1; // 0 = not finished, 1 = 1st, etc.
    };

    // Used by persistence.js to restore crowns after a reload.
    window.serializeWinState = function () {
        return {
            finishOrder: finishOrder.slice(),
        };
    };

    // Used by persistence.js to restore crowns after a reload.
    window.hydrateWinState = function (state) {
        if (!state) return;
        if (Array.isArray(state.finishOrder)) {
            finishOrder = state.finishOrder.filter(c => typeof c === 'string');
        }
    };

    // Reset only the match flags (Local points stay permanent)
    window.resetWinDetection = function () {
        finishOrder = [];
    };

})();
