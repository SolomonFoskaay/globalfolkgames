// local-points.js
// Tracks Local Ludo points for the current match only.

(function () {
    let localPoints = 0;
    let pointsAwardedThisMatch = false;

    function updateLocalPointsUI() {
        const el = document.getElementById('local-points-display');
        if (el) el.textContent = localPoints;
    }

    // Called when a human wins the match
    window.awardLocalLudoPoints = function (points) {
        if (pointsAwardedThisMatch) return false;
        if (points <= 0) return false;

        localPoints += points;
        pointsAwardedThisMatch = true;
        updateLocalPointsUI();

        // Also add the same amount to Global spendable points
        if (typeof window.awardGlobalPoints === 'function') {
            window.awardGlobalPoints(points, 'ludo', 'human_match_win');
        }
        return true;
    };

    window.resetLocalLudoPoints = function () {
        localPoints = 0;
        pointsAwardedThisMatch = false;
        updateLocalPointsUI();
    };

    window.getLocalLudoPoints = function () {
        return localPoints;
    };

    document.addEventListener('DOMContentLoaded', updateLocalPointsUI);
})();