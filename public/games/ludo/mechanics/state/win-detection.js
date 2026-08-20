// win-detection.js
// Detects winners, awards points (Human only), and tracks finishing order for crowns

(function () {

    let pointsAwardedThisMatch = false;
    let lifeConsumedThisMatch = false; // M10: one life per completed match
    let finishOrder = [];   // e.g. ['green', 'red', 'yellow', 'blue']
    // Scope C: the on-chain result commit (full 1st..4th finish order) mirrors
    // the award that was banked, tying the committed order to the winning roll.
    let lastAwardCommit = { points: 0, multiplier: 1, matchRef: 0 };

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

        // M10: consume one life when the match fully completes (all seats
        // finished). The classic ludo build predates the M2 seam, so it consumes
        // directly here instead of via window.onGameResult; exactly once per
        // match. Abandon/reset/disconnect never reach this point.
        if (finishOrder.length === 4 && !lifeConsumedThisMatch && window.gfgLives && typeof window.gfgLives.consume === 'function') {
            lifeConsumedThisMatch = true;
            window.gfgLives.consume();
        }

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

                // S1: Active Tier multiplier applies to the base match win
                // reward (100 -> 200/300/400 at 2x/3x/4x), capped at +1,000
                // boosted points/day. The boosted total is what gets banked.
                const reward = (typeof window.computeWinReward === 'function')
                    ? window.computeWinReward(100)
                    : { base: 100, total: 100, mult: 1, boosted: 0 };
                const awarded = reward.total;
                lastAwardCommit = {
                    points: awarded,
                    multiplier: reward.mult || 1,
                    matchRef: (typeof window.getLastProofRollSignature === 'function')
                        ? window.getLastProofRollSignature() : null,
                };

                if (typeof window.awardLocalLudoPoints === 'function') {
                    // The proof-roll signature becomes the match_id in Supabase,
                    // tying the reward to the verifiable on-chain roll.
                    window.awardLocalLudoPoints(awarded, proofSig);
                }

                // Scope B: write the award to the player's ON-CHAIN points
                // PDA, gasless on the ER (session key signs, no SOL). The
                // receipt signature is the authoritative on-chain proof of the
                // reward. Fails soft: Supabase already has the record and the
                // on-chain record is a mirror, not the source of truth.
                const magic = window.magicblockDice;
                if (magic && typeof magic.recordPoints === 'function') {
                    const reasonCode = (window.POINT_REASONS && window.POINT_REASONS.WIN_1ST)
                        ? window.POINT_REASONS.WIN_1ST : 1;
                    const matchRef = (magic.matchRefFromSignature && proofSig)
                        ? magic.matchRefFromSignature(proofSig) : 0;
                    magic.recordPoints(awarded, reasonCode, matchRef)
                        .then((onchainReceipt) => {
                            console.log(`[REWARD] On-chain points recorded — receipt: ${onchainReceipt}`);
                            const txUrl = onchainReceipt && window.gfgExplorer
                                ? window.gfgExplorer.txUrl(onchainReceipt) : null;
                            if (txUrl) console.log(`[REWARD] Verify on-chain → ${txUrl}`);
                        })
                        .catch((err) => {
                            // Never fail the win UX on a mirror write.
                            console.warn('[REWARD] On-chain points record failed (mirror only):', err.message || err);
                        });
                }

                console.log(`[REWARD] 1st place (you) +${awarded} — proof roll: ${proofSig}`);
                if (proofSig) {
                    console.log(`[REWARD] Proof roll TX: ${proofSig}`);
                }
                if (typeof showVerifyLink === 'function') {
                    // The ER rollup tx sigs 404 on every public explorer, so no
                    // fake per-roll link. The winning roll IS on-chain (ER VRF);
                    // the on-chain account proof is shown as a real link when
                    // the base-layer delegation tx is available.
                    let verifyLine = 'Your winning roll resolved on-chain (MagicBlock ER VRF)';
                    const diceDelegateSig = (window.magicblockDice && typeof window.magicblockDice.getLastDiceDelegationSignature === 'function')
                        ? window.magicblockDice.getLastDiceDelegationSignature() : null;
                    if (diceDelegateSig && window.gfgExplorer && typeof window.gfgExplorer.txLink === 'function') {
                        verifyLine += ` - dice account delegated on devnet: ${window.gfgExplorer.txLink(diceDelegateSig, 'view tx')}`;
                    }
                    showVerifyLink(verifyLine);
                }

                if (typeof window.showAuthBanner === 'function') {
                    const boostNote = (reward.mult > 1)
                        ? ` (${reward.mult}x Active Tier${reward.boosted > 0 ? ' — +' + reward.boosted + ' boost' : ''})`
                        : '';
                    window.showAuthBanner(`🎉 You finished 1st! +${awarded} points${boostNote}`);
                }
            }
        }

        // Scope C: when the FULL 1st..4th finish order is known (match over),
        // commit it on-chain. Gasless ER write (session key signs, no SOL),
        // soft-fail like the points mirror. Only commits when at least one
        // valid on-chain proof roll ran this match (the trustworthy play proof).
        if (proofRollUsed && finishOrder.length === 4) {
            const magic = window.magicblockDice;
            if (magic && typeof magic.recordResult === 'function') {
                const matchRefSig = lastAwardCommit.matchRef
                    || (typeof window.getLastProofRollSignature === 'function'
                        ? window.getLastProofRollSignature() : null);
                const matchRef = (magic.matchRefFromSignature && matchRefSig)
                    ? magic.matchRefFromSignature(matchRefSig) : 0;
                magic.recordResult(
                    finishOrder.slice(),
                    lastAwardCommit.points || 100,
                    lastAwardCommit.multiplier || 1,
                    matchRef,
                )
                    .then((receipt) => {
                        console.log(`[RESULT] On-chain finish order committed — receipt: ${receipt}`);
                        const txUrl = receipt && window.gfgExplorer
                            ? window.gfgExplorer.txUrl(receipt) : null;
                        if (txUrl) console.log(`[RESULT] Verify on-chain → ${txUrl}`);
                    })
                    .catch((err) => {
                        // Never fail the match UX on a mirror write.
                        console.warn('[RESULT] On-chain finish-order commit failed (mirror only):', err.message || err);
                    });
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
        lifeConsumedThisMatch = false;
        finishOrder = [];
    };

})();