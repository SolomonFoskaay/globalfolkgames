// win-detection.js (M1 — game core only)
// Detects winners, tracks the 1st..4th finish order, holds the match outcome
// status (in-progress / finished / abandoned), and emits the universal GAME
// RESULT envelope when the match completes (see /game-result.js). M1 knows
// NOTHING about points, tiers, competitions or rewards: it publishes a
// canonical result and the platform bus fans it out to M3/M4/M7 consumers.
//
// ENDGAME (locked spec):
//   - once a seat has all 4 tokens DISAPPEARED OFF THE BOARD (stepsWalked>=57),
//     it is "finished"; its turns auto-pass (~1.5s log, no dice roll, no tap)
//     for human AND computer seats (see turn.js).
//   - when ALL active seats are finished the loop STOPS (no infinite cycling),
//     status=finished, the seam is emitted and the result ceremony 1st..4th +
//     "Play Again" is shown. No reset-only ending, no skip-remaining toggle.

(function () {

    let finishOrder = [];   // e.g. ['green', 'red', 'yellow', 'blue']
    // Match outcome: 'in-progress' | 'finished' | 'abandoned'. Rewards gate on
    // status===finished (done by M3/M4 consumers, never here).
    let matchStatus = 'in-progress';

    function countFinishedTokens(color) {
        if (!window.tokens || !window.tokens[color]) return 0;
        return window.tokens[color].filter(t => t.stepsWalked >= 57).length;
    }

    // A seat is "finished" when ALL 4 of its tokens are off the board.
    window.isSeatFinished = function (color) {
        return countFinishedTokens(color) === 4;
    };

    // Every seat in the active turn sequence must finish (2P: both seats;
    // 4P: all 4). No "leader wins and match ends" shortcut.
    window.allSeatsFinished = function () {
        const active = (typeof window.getActiveSeats === 'function')
            ? window.getActiveSeats()
            : (typeof turnSequence !== 'undefined' ? turnSequence : ['green', 'yellow', 'blue', 'red']);
        return active.every(c => window.isSeatFinished(c));
    };

    window.getMatchStatus = function () {
        return matchStatus;
    };

    window.setMatchStatus = function (s) {
        if (s === 'in-progress' || s === 'finished' || s === 'abandoned') {
            matchStatus = s;
        }
    };

    window.checkForMatchWinner = function (color) {
        if (!color || !window.playerProfiles) return;
        if (matchStatus !== 'in-progress') return;

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

        // Match complete (ALL active seats finished): stop the loop, mark the
        // outcome, publish the universal game result envelope and show the
        // 1st..4th ceremony. M1 only reports facts:
        //   - who played each seat (actor: user / house / local)
        //   - the finish order (position)
        //   - the on-chain proof of play (VRF roll signature) when present
        // The platform bus (window.publishGameResult) attaches identity to the
        // 'user' seat and fans the result out to M3/M4/M7. No points logic
        // lives here, and M1 never calls reward-bound instructions.
        if (window.allSeatsFinished()) {
            matchStatus = 'finished';
            if (typeof saveGameStateToStorage === 'function') {
                saveGameStateToStorage();
            }

            publishSeamResult();

            // Stop the turn loop + ceremony (implemented in turn.js).
            if (typeof window.markMatchOver === 'function') {
                window.markMatchOver();
            }
            if (typeof window.showResultCeremony === 'function') {
                window.showResultCeremony();
            }
        }
    };

    function publishSeamResult() {
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

    // Used by board.js to know who finished where
    window.getFinishOrder = function () {
        return finishOrder.slice();
    };

    window.getPlayerRank = function (color) {
        const index = finishOrder.indexOf(color);
        return index === -1 ? 0 : index + 1; // 0 = not finished, 1 = 1st, etc.
    };

    // Used by persistence.js to restore crowns + outcome after a reload.
    window.serializeWinState = function () {
        return {
            finishOrder: finishOrder.slice(),
            matchStatus: matchStatus,
        };
    };

    // Used by persistence.js to restore crowns + outcome after a reload.
    window.hydrateWinState = function (state) {
        if (!state) return;
        if (Array.isArray(state.finishOrder)) {
            finishOrder = state.finishOrder.filter(c => typeof c === 'string');
        }
        if (state.matchStatus === 'finished' || state.matchStatus === 'abandoned') {
            matchStatus = state.matchStatus;
        }
    };

    // Reset only the match flags (Local points stay permanent, elsewhere)
    window.resetWinDetection = function () {
        finishOrder = [];
        matchStatus = 'in-progress';
    };

})();
