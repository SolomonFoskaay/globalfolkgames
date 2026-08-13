// win-detection.js
// Detects winners, awards points (Human only), and tracks finishing order for crowns

(function () {

    let pointsAwardedThisMatch = false;
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

        // Reward policy (first place only, and only the signed-in user's seat):
        // - A non-user seat finishing 1st gets NO reward (it's a local/AI seat).
        // - The user finishing 1st gets +100 ONLY if the match had a valid
        //   on-chain proof roll (the untamperable proof of play). Otherwise the
        //   run still counts but earns no points, so users can't farm rewards
        //   off-chain.
        const isUserSeat = window.playerProfiles[color]?.isUser === true;
        const proofRollUsed = typeof window.getOnchainProofUsedThisMatch === 'function'
            && window.getOnchainProofUsedThisMatch();

        if (position === 1) {
            if (!isUserSeat) {
                if (typeof window.showAuthBanner === 'function') {
                    window.showAuthBanner(`${color.toUpperCase()} finished 1st — no reward (only the signed-in player earns rewards).`);
                }
            } else if (!proofRollUsed) {
                if (typeof window.showAuthBanner === 'function') {
                    window.showAuthBanner(`You finished 1st! But no on-chain proof roll ran this match — no reward.`);
                }
                console.warn('[REWARD] 1st place (you) skipped: no valid on-chain proof roll this match.');
            } else if (!pointsAwardedThisMatch) {
                pointsAwardedThisMatch = true;

                const proofSig = typeof window.getLastProofRollSignature === 'function'
                    ? window.getLastProofRollSignature() : null;

                if (typeof window.awardLocalLudoPoints === 'function') {
                    // The proof-roll signature becomes the match_id in Supabase,
                    // tying the reward to the verifiable on-chain roll.
                    window.awardLocalLudoPoints(100, proofSig);
                }

                // Scope B: write the +100 award to the player's ON-CHAIN points
                // PDA, gasless on the ER (session key signs, no SOL). Fails soft.
                const magic = window.magicblockDice;
                if (magic && typeof magic.recordPoints === 'function') {
                    const reasonCode = (window.POINT_REASONS && window.POINT_REASONS.WIN_1ST)
                        ? window.POINT_REASONS.WIN_1ST : 1;
                    const matchRef = (magic.matchRefFromSignature && proofSig)
                        ? magic.matchRefFromSignature(proofSig) : 0;
                    magic.recordPoints(100, reasonCode, matchRef)
                        .then((onchainReceipt) => {
                            console.log(`[REWARD] On-chain points recorded — receipt: ${onchainReceipt}`);
                            const txUrl = onchainReceipt && window.gfgExplorer
                                ? window.gfgExplorer.txUrl(onchainReceipt) : null;
                            if (txUrl) console.log(`[REWARD] Verify on-chain → ${txUrl}`);
                        })
                        .catch((err) => {
                            console.warn('[REWARD] On-chain points record failed (mirror only):', err.message || err);
                        });
                }

                const explorerUrl = proofSig
                    ? `https://explorer.solana.com/tx/${proofSig}?cluster=devnet`
                    : null;
                console.log(`[REWARD] 1st place (you) +100 — proof roll: ${proofSig}`);
                if (explorerUrl) {
                    console.log(`[REWARD] Verify on-chain → ${explorerUrl}`);
                }

                if (typeof window.showAuthBanner === 'function') {
                    window.showAuthBanner(`🎉 You finished 1st! +100 points`);
                }
            }
        }

        // Force a redraw so the crown appears immediately
        if (typeof drawLudoLayout === 'function') {
            drawLudoLayout();
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
            pointsAwardedThisMatch: pointsAwardedThisMatch
        };
    };

    // Used by persistence.js to restore crowns after a reload.
    window.hydrateWinState = function (state) {
        if (!state) return;
        if (Array.isArray(state.finishOrder)) {
            finishOrder = state.finishOrder.filter(c => typeof c === 'string');
        }
        pointsAwardedThisMatch = !!state.pointsAwardedThisMatch;
    };

    // Reset only the match flags (Local points stay permanent)
    window.resetWinDetection = function () {
        pointsAwardedThisMatch = false;
        finishOrder = [];
    };

})();