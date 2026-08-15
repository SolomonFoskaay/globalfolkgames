// win-detection.js (M1 — game core only)
// Detects winners, tracks finishing order for crowns, and emits the universal
// GAME RESULT envelope when the match completes (see /game-result.js). M1 knows
// NOTHING about points, tiers, competitions or rewards: it publishes a
// canonical result and the platform bus fans it out to M2/M3/M4.

(function () {

    let finishOrder = [];   // e.g. ['green', 'red', 'yellow', 'blue']

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

        // Match complete (all 4 seats finished): publish the UNIVERSAL game
        // result envelope. M1 only reports facts:
        //   - who played each seat (actor: user / house / local)
        //   - the finish order (position)
        //   - the on-chain proof of play (VRF roll signature) when present
        // The platform bus (window.publishGameResult) attaches identity to the
        // 'user' seat and fans the result out to M2/M3/M4. No points logic
        // lives here.
        if (finishOrder.length === 4) {
            const proofSig = typeof window.getLastProofRollSignature === 'function'
                ? window.getLastProofRollSignature() : null;

            const players = finishOrder.map(color => ({
                seat: color,
                actor: (window.playerProfiles[color] && window.playerProfiles[color].isUser === true)
                    ? 'user'
                    : (window.playerProfiles[color] && window.playerProfiles[color].mode === 'human')
                        ? 'local'
                        : 'house',
                position: finishOrder.indexOf(color) + 1,
            }));

            const result = {
                gameId: 'ludo',
                mode: 'human_vs_computer',
                finishedAt: Date.now(),
                players,
                proof: proofSig
                    ? {
                        method: 'magicblock-vrf',
                        chain: 'solana-devnet',
                        signature: proofSig,
                    }
                    : null,
            };

            if (typeof window.publishGameResult === 'function') {
                window.publishGameResult(result);
            } else {
                // Bus not loaded (shouldn't happen on the real page) — fall
                // back to a plain log so the game still works standalone.
                console.log('[M1] Match complete — result:', result);
            }
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
