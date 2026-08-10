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

        // Award points only to the FIRST human
        const isHuman = window.playerProfiles[color]?.mode === 'human';

        if (isHuman && !pointsAwardedThisMatch) {
            pointsAwardedThisMatch = true;

            if (typeof window.awardLocalLudoPoints === 'function') {
                window.awardLocalLudoPoints(100);
            }

            if (typeof window.showAuthBanner === 'function') {
                window.showAuthBanner(`🎉 ${color.toUpperCase()} finished 1st! +100 points`);
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

    // Reset only the match flags (Local points stay permanent)
    window.resetWinDetection = function () {
        pointsAwardedThisMatch = false;
        finishOrder = [];
    };

})();