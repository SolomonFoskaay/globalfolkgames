// profiles.js
// Responsible for: loading profile, showing points in header, awarding points

(function () {
    async function ensureProfile(user) {
        if (!user) return null;

        let { data: profile } = await window.supabaseClient
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();

        if (!profile) {
            const username = (user.email || 'player').split('@')[0].slice(0, 20);
            const { data: created } = await window.supabaseClient
                .from('profiles')
                .insert({
                    id: user.id,
                    username,
                    display_name: username,
                    global_points: 0,
                    level: 1
                })
                .select()
                .single();
            profile = created;
        }
        return profile;
    }

    async function updateHeader(session) {
        const pill = document.querySelector('.user-pill');
        if (!pill) return;

        if (session?.user) {
            const profile = await ensureProfile(session.user);
            const points = profile?.global_points || 0;
            const name = (profile?.display_name || profile?.username || 'Player').slice(0, 12);

            pill.innerHTML = `
                <span id="display-points">⭐ ${points.toLocaleString()} Pts</span>
                <span class="auth-user">· ${name}</span>
                <button id="btn-signout" class="auth-btn-small">Sign out</button>
            `;
            document.getElementById('btn-signout')?.addEventListener('click', window.handleSignOut);

            window.currentUser = session.user;
            window.currentProfile = profile;
        } else {
            pill.innerHTML = `
                <span id="display-points">⭐ 0 Pts</span>
                <button id="btn-open-auth" class="auth-btn-small">Sign in</button>
            `;
            document.getElementById('btn-open-auth')?.addEventListener('click', window.openAuthModal);
            window.currentUser = null;
            window.currentProfile = null;
        }
    }

    // Public function other files (Ludo) can call
    window.awardGlobalPoints = async function (points, gameId, reason, matchId = null) {
        if (!window.currentUser || !window.currentProfile) {
            window.showAuthBanner?.('Sign in to earn points', true);
            return false;
        }
        if (points <= 0) return false;

        // 1. Insert detailed transaction (for audit)
        await window.supabaseClient.from('point_transactions').insert({
            user_id: window.currentUser.id,
            game_id: gameId,
            points: points,
            reason: reason,
            match_id: matchId
        });

        // 2. Update global total + level
        const newTotal = window.currentProfile.global_points + points;
        let newLevel = 1;
        if (newTotal >= 5000) newLevel = 5;
        else if (newTotal >= 3000) newLevel = 4;
        else if (newTotal >= 1000) newLevel = 3;
        else if (newTotal >= 500) newLevel = 2;

        const { data } = await window.supabaseClient
            .from('profiles')
            .update({ global_points: newTotal, level: newLevel })
            .eq('id', window.currentUser.id)
            .select()
            .single();

        if (data) {
            window.currentProfile = data;
            const el = document.getElementById('display-points');
            if (el) el.textContent = `⭐ ${data.global_points.toLocaleString()} Pts`;
            window.showAuthBanner?.(`+${points} pts! Total: ${data.global_points}`);
            return true;
        }
        return false;
    };

    // Listen to auth changes
    document.addEventListener('DOMContentLoaded', () => {
        if (!window.supabaseClient) return;

        window.supabaseClient.auth.onAuthStateChange((event, session) => {
            updateHeader(session);
        });

        window.supabaseClient.auth.getSession().then(({ data: { session } }) => {
            updateHeader(session);
        });
    });
})();