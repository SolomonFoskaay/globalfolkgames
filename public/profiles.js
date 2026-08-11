// profiles.js
// Handles profile loading, 500 signup points, and header display
// Dynamic is primary login • Supabase is backup store

(function () {

    function getPill() {
        return document.getElementById('gfg-user-pill') || document.querySelector('.gfg-user-pill');
    }

    // Get current Dynamic user (works with current headless SDK)
    function getDynamicUser() {
        try {
            if (!window.dynamicClient) return null;

            const user = window.dynamicClient.auth?.currentUser
                || window.dynamicClient.user
                || window.dynamicClient.auth?.user
                || null;

            if (!user) return null;

            // Try to get the Solana wallet address
            let solanaWallet = null;
            try {
                // Preferred: read via the SDK helper exposed by src/dynamic-auth.js
                if (window.getDynamicSolanaWallet) {
                    solanaWallet = window.getDynamicSolanaWallet();
                }
                if (!solanaWallet) {
                    const wallets = window.dynamicClient?.walletAccounts
                        || user.walletAccounts
                        || [];

                    // Find a Solana wallet
                    const solWallet = wallets.find(w =>
                        w.chain === 'solana' ||
                        w.chain === 'SOL' ||
                        (w.address && w.address.length >= 32 && w.address.length <= 44)
                    );

                    if (solWallet) {
                        solanaWallet = solWallet.address || solWallet.publicKey || null;
                    }
                }
            } catch (e) {
                console.warn('Could not read Solana wallet', e);
            }

            return {
                dynamicId: user.userId || user.id || user.user_id,
                email: user.email
                    || (user.verifiedCredentials && user.verifiedCredentials[0]?.email)
                    || user.emailAddress
                    || null,
                solanaWallet: solanaWallet
            };
        } catch (e) {
            console.warn('Could not read Dynamic user', e);
            return null;
        }
    }

    // Create or load profile using dynamic_user_id
    async function ensureProfile(dynamicUser) {
        if (!dynamicUser || !dynamicUser.dynamicId) return null;

        // 1. Try to find existing profile by dynamic_user_id
        let { data: profile, error } = await window.supabaseClient
            .from('profiles')
            .select('*')
            .eq('dynamic_user_id', dynamicUser.dynamicId)
            .maybeSingle();

        if (error) {
            console.error('Profile fetch error:', error);
            return null;
        }

        // 2. Profile already exists
        if (profile) {
            // Backfill the wallet if it was captured as null earlier
            // (e.g. signup happened before Dynamic finished creating the wallet)
            if (!profile.solana_wallet && dynamicUser.solanaWallet) {
                const { error: backfillError } = await window.supabaseClient
                    .from('profiles')
                    .update({ solana_wallet: dynamicUser.solanaWallet })
                    .eq('dynamic_user_id', dynamicUser.dynamicId);

                if (backfillError) {
                    console.error('Profile wallet backfill error:', backfillError);
                } else {
                    profile.solana_wallet = dynamicUser.solanaWallet;
                }
            }
            return profile;
        }

        // 3. Create new profile
        let bonus = 500;
        const { data: config } = await window.supabaseClient
            .from('point_config')
            .select('value')
            .eq('key', 'signup_bonus')
            .maybeSingle();

        if (config && config.value) bonus = config.value;

        const code = 'GF' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const username = (dynamicUser.email || 'player').split('@')[0].slice(0, 20);

        // Generate a normal UUID for the primary key
        const newId = crypto.randomUUID();

        const { data: created, error: insertError } = await window.supabaseClient
        .from('profiles')
        .insert({
            id: newId,
            dynamic_user_id: dynamicUser.dynamicId,
            email: dynamicUser.email || null,
            solana_wallet: dynamicUser.solanaWallet || null,
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

        // Record signup bonus
        await window.supabaseClient.from('point_transactions').insert({
            user_id: newId,
            game_id: 'system',
            points: bonus,
            reason: 'signup_bonus'
        });

        if (window.showAuthBanner) {
            window.showAuthBanner('Welcome! +' + bonus + ' signup points added');
        }

        return created;
    }

    // Update the header UI
    async function updateHeader(dynamicUser) {
        const pill = getPill();
        if (!pill) return;

        if (dynamicUser) {
            const profile = await ensureProfile(dynamicUser);
            const points = profile ? profile.global_points : 0;
            const name = (profile?.display_name || profile?.username || 'Player').slice(0, 12);

            pill.innerHTML = `
                <span id="display-points">⭐ ${points.toLocaleString()} Pts</span>
                <span class="auth-user">· ${name}</span>
                <button id="btn-signout" class="auth-btn-small">Sign out</button>
            `;

            const btn = document.getElementById('btn-signout');
            if (btn) {
                btn.onclick = async function () {
                    if (window.logoutDynamic) {
                        await window.logoutDynamic();
                    }
                    updateHeader(null);
                };
            }

            window.currentUser = {
                id: profile?.id,
                dynamicId: dynamicUser.dynamicId,
                email: dynamicUser.email,
                source: 'dynamic'
            };
            window.currentProfile = profile;

        } else {
            // Logged out state
            pill.innerHTML = `
                <span id="display-points">⭐ 0 Pts</span>
                <button id="btn-open-auth" class="auth-btn-small">Sign in</button>
            `;

            const btn = document.getElementById('btn-open-auth');
            if (btn) {
                btn.onclick = function () {
                    if (window.openDynamicLogin) {
                        window.openDynamicLogin();
                    }
                };
            }

            window.currentUser = null;
            window.currentProfile = null;
        }
    }

    // Main refresh – Dynamic only (primary)
    window.refreshAuthHeader = async function () {
        const dynamicUser = getDynamicUser();
        await updateHeader(dynamicUser);
    };

    // Award points (used by Ludo later)
    window.awardGlobalPoints = async function (points, gameId, reason, matchId = null) {
        if (!window.currentUser || !window.currentProfile) {
            if (window.showAuthBanner) window.showAuthBanner('Sign in to earn points', true);
            return false;
        }
        if (points <= 0) return false;

        await window.supabaseClient.from('point_transactions').insert({
            user_id: window.currentUser.id,
            game_id: gameId,
            points: points,
            reason: reason,
            match_id: matchId
        });

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

    // On page load
    document.addEventListener('DOMContentLoaded', function () {
        // Give Dynamic a short moment to restore session
        setTimeout(() => {
            window.refreshAuthHeader();
        }, 900);
    });
})();