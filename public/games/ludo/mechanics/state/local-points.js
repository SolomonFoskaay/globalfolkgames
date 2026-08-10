// local-points.js
// Lifetime Local points for the Ludo game (never resets on match reset)
// Source of truth = point_transactions where game_id = 'ludo'

(function () {

    // Update the number shown in the Ludo header
    function updateLocalPointsUI(points) {
        const el = document.getElementById('local-points-display');
        if (el) {
            el.textContent = points.toLocaleString();
        }
    }

    // Load the player's lifetime Ludo points from the database
    async function loadLifetimeLudoPoints() {
        if (!window.currentUser) {
            updateLocalPointsUI(0);
            return 0;
        }

        try {
            const { data, error } = await window.supabaseClient
                .from('point_transactions')
                .select('points')
                .eq('user_id', window.currentUser.id)
                .eq('game_id', 'ludo')
                .gt('points', 0);   // only positive points

            if (error) {
                console.error('Failed to load local Ludo points:', error);
                updateLocalPointsUI(0);
                return 0;
            }

            const total = (data || []).reduce((sum, row) => sum + row.points, 0);
            updateLocalPointsUI(total);
            return total;
        } catch (err) {
            console.error(err);
            updateLocalPointsUI(0);
            return 0;
        }
    }

    // Called when a human wins a match
    window.awardLocalLudoPoints = async function (points) {
        if (points <= 0) return false;
        if (!window.currentUser) {
            if (window.showAuthBanner) {
                window.showAuthBanner('Sign in to earn points', true);
            }
            return false;
        }

        // Add to Global spendable points + write audit record
        // (awardGlobalPoints already inserts into point_transactions with game_id)
        const success = await window.awardGlobalPoints(points, 'ludo', 'human_match_win');

        if (success) {
            // Refresh the Local points display from the database
            await loadLifetimeLudoPoints();
        }

        return success;
    };

    // This is now a no-op (Local points are lifetime and must not reset)
    window.resetLocalLudoPoints = function () {
        // Intentionally empty – Local points are permanent
        console.log('Local Ludo points are lifetime – not reset');
    };

    // Public helper
    window.getLocalLudoPoints = function () {
        const el = document.getElementById('local-points-display');
        return el ? parseInt(el.textContent.replace(/,/g, '')) || 0 : 0;
    };

    // Load points when the page is ready and when user logs in
    document.addEventListener('DOMContentLoaded', function () {
        // Small delay to make sure auth + profile are ready
        setTimeout(loadLifetimeLudoPoints, 800);
    });

    // Also reload when the auth state changes
    if (window.supabaseClient) {
        window.supabaseClient.auth.onAuthStateChange(function () {
            setTimeout(loadLifetimeLudoPoints, 500);
        });
    }

})();