// profiles.js
// Handles profile loading, 500 signup points, and header display

(function () {

    function getPill() {
        return document.getElementById('gfg-user-pill') || document.querySelector('.gfg-user-pill');
    }

    // Create or load profile. New users get 500 points.
    async function ensureProfile(user) {
        if (!user) return null;

        // Try to load existing profile
        let { data: profile, error } = await window.supabaseClient
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();

        if (error) {
            console.error('Profile fetch error:', error);
            return null;
        }

        // Profile does not exist yet → create it with signup bonus
        if (!profile) {
            // Read current signup bonus from config (default 500)
            let bonus = 500;
            const { data: config } = await window.supabaseClient
                .from('point_config')
                .select('value')
                .eq('key', 'signup_bonus')
                .maybeSingle();

            if (config && config.value) bonus = config.value;

            // Generate a simple referral code
            const code = 'GF' + Math.random().toString(36).substring(2, 8).toUpperCase();

            const username = (user.email || 'player').split('@')[0].slice(0, 20);

            const { data: created, error: insertError } = await window.supabaseClient
                .from('profiles')
                .insert({
                    id: user.id,
                    username: username,
                    display_name: username,
                    global_points: bonus,
                    lifetime_points: bonus,
                    level: 1,
                    referral_code: code
                })
                .select()
                .single();

            if (insertError) {
                console.error('Profile create error:', insertError);
                return null;
            }

            // Record the bonus in the audit table
            await window.supabaseClient.from('point_transactions').insert({
                user_id: user.id,
                game_id: 'system',
                points: bonus,
                reason: 'signup_bonus'
            });

            profile = created;

            if (window.showAuthBanner) {
                window.showAuthBanner('Welcome! +' + bonus + ' signup points added');
            }
        }

        return profile;
    }

    // Update the header with real points + Sign in / Sign out button
    async function updateHeader(session) {
        const pill = getPill();
        if (!pill) return;

        if (session && session.user) {
            const profile = await ensureProfile(session.user);
            const points = profile ? profile.global_points : 0;
            const name = (profile?.display_name || profile?.username || 'Player').slice(0, 12);

            pill.innerHTML = `
                <span id="display-points">⭐ ${points.toLocaleString()} Pts</span>
                <span class="auth-user">· ${name}</span>
                <button id="btn-signout" class="auth-btn-small">Sign out</button>
            `;

            const btn = document.getElementById('btn-signout');
            if (btn) {
                btn.onclick = function () {
                    if (window.handleSignOut) window.handleSignOut();
                };
            }

            window.currentUser = session.user;
            window.currentProfile = profile;

        } else {
            pill.innerHTML = `
                <span id="display-points">⭐ 0 Pts</span>
                <button id="btn-open-auth" class="auth-btn-small">Sign in</button>
            `;

            const btn = document.getElementById('btn-open-auth');
            if (btn) {
                btn.onclick = function () {
                    if (window.openAuthModal) window.openAuthModal();
                };
            }

            window.currentUser = null;
            window.currentProfile = null;
        }
    }

    // Called by header.js after the header is created
    window.refreshAuthHeader = async function () {
        if (!window.supabaseClient) return;
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        updateHeader(session);
    };

    // Public function for games to award points later
    window.awardGlobalPoints = async function (points, gameId, reason, matchId = null) {
        if (!window.currentUser || !window.currentProfile) {
            if (window.showAuthBanner) window.showAuthBanner('Sign in to earn points', true);
            return false;
        }
        if (points <= 0) return false;

        // 1. Write audit record
        await window.supabaseClient.from('point_transactions').insert({
            user_id: window.currentUser.id,
            game_id: gameId,
            points: points,
            reason: reason,
            match_id: matchId
        });

        // 2. Update both global and lifetime points
        const newGlobal = window.currentProfile.global_points + points;
        const newLifetime = window.currentProfile.lifetime_points + points;

        let newLevel = 1;
        if (newLifetime >= 5000) newLevel = 5;
        else if (newLifetime >= 3000) newLevel = 4;
        else if (newLifetime >= 1000) newLevel = 3;
        else if (newLifetime >= 500) newLevel = 2;

        const { data } = await window.supabaseClient
            .from('profiles')
            .update({
                global_points: newGlobal,
                lifetime_points: newLifetime,
                level: newLevel
            })
            .eq('id', window.currentUser.id)
            .select()
            .single();

        if (data) {
            window.currentProfile = data;
            const el = document.getElementById('display-points');
            if (el) el.textContent = `⭐ ${data.global_points.toLocaleString()} Pts`;
            if (window.showAuthBanner) {
                window.showAuthBanner(`+${points} pts! Total: ${data.global_points}`);
            }
            return true;
        }
        return false;
    };

    // Listen for login / logout
    document.addEventListener('DOMContentLoaded', function () {
        if (!window.supabaseClient) return;

        window.supabaseClient.auth.onAuthStateChange(function (event, session) {
            updateHeader(session);
        });

        window.supabaseClient.auth.getSession().then(function (result) {
            updateHeader(result.data.session);
        });
    });
})();