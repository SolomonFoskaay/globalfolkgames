// auth.js
// Exposes global window.supabaseClient using the Publishable (anon) key.
// Handles Email signup / signin / signout + session restore.
// All UI feedback uses custom on-screen banners (no browser alerts).

(function () {
    // ────────────────────────────────────────────────
    // 1. PASTE YOUR KEYS HERE (only place they live)
    // ────────────────────────────────────────────────
    const SUPABASE_URL = 'https://ywrgxynjjgdicdzizpue.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_qbrLQtG1fx51sBIiDm_zGQ_dR6BcqEb';
    // The anon key is been sunset, so above is actual the new publishable key not anon key 
    // that can be published in frontend without exposing sensitie data

    // ────────────────────────────────────────────────
    // 2. Create the client and expose it globally
    // ────────────────────────────────────────────────
    if (!window.supabase) {
        console.error('Supabase JS SDK not loaded. Check the CDN script in index.html');
        return;
    }

    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // ────────────────────────────────────────────────
    // 3. Helper: show custom banner (success / error)
    // ────────────────────────────────────────────────
    function showBanner(message, isError = false) {
        // Remove any existing banner
        const old = document.getElementById('auth-banner');
        if (old) old.remove();

        const banner = document.createElement('div');
        banner.id = 'auth-banner';
        banner.className = isError ? 'auth-banner error' : 'auth-banner success';
        banner.textContent = message;
        document.body.appendChild(banner);

        // Auto-hide after 4 seconds
        setTimeout(() => {
            if (banner.parentNode) banner.remove();
        }, 4000);
    }

    // ────────────────────────────────────────────────
    // 4. Update the header UI based on current session
    // ────────────────────────────────────────────────
    function updateAuthUI(session) {
        const pill = document.querySelector('.user-pill');
        if (!pill) return;

        if (session && session.user) {
            // Logged in
            const email = session.user.email || 'Player';
            const short = email.split('@')[0].slice(0, 12);
            pill.innerHTML = `
                <span id="display-points">⭐ 0 Pts</span>
                <span class="auth-user">· ${short}</span>
                <button id="btn-signout" class="auth-btn-small">Sign out</button>
            `;
            document.getElementById('btn-signout').addEventListener('click', handleSignOut);
        } else {
            // Guest
            pill.innerHTML = `
                <span id="display-points">⭐ 0 Pts</span>
                <button id="btn-open-auth" class="auth-btn-small">Sign in</button>
            `;
            document.getElementById('btn-open-auth').addEventListener('click', openAuthModal);
        }
    }

    // ────────────────────────────────────────────────
    // 5. Open / close the auth modal
    // ────────────────────────────────────────────────
    function openAuthModal() {
        const modal = document.getElementById('auth-modal');
        if (modal) modal.classList.add('visible');
    }

    function closeAuthModal() {
        const modal = document.getElementById('auth-modal');
        if (modal) modal.classList.remove('visible');
        // Clear form fields
        document.getElementById('auth-email').value = '';
        document.getElementById('auth-password').value = '';
    }

    // ────────────────────────────────────────────────
    // 6. Signup
    // ────────────────────────────────────────────────
    async function handleSignUp() {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;

        if (!email || !password) {
            showBanner('Email and password are required', true);
            return;
        }
        if (password.length < 6) {
            showBanner('Password must be at least 6 characters', true);
            return;
        }

        const btn = document.getElementById('btn-signup');
        btn.disabled = true;
        btn.textContent = 'Creating…';

        const { data, error } = await window.supabaseClient.auth.signUp({
            email,
            password
        });

        btn.disabled = false;
        btn.textContent = 'Create Account';

        if (error) {
            showBanner(error.message, true);
            return;
        }

        showBanner('Account created! You are now signed in.');
        closeAuthModal();
        updateAuthUI(data.session);
    }

    // ────────────────────────────────────────────────
    // 7. Signin
    // ────────────────────────────────────────────────
    async function handleSignIn() {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;

        if (!email || !password) {
            showBanner('Email and password are required', true);
            return;
        }

        const btn = document.getElementById('btn-signin');
        btn.disabled = true;
        btn.textContent = 'Signing in…';

        const { data, error } = await window.supabaseClient.auth.signInWithPassword({
            email,
            password
        });

        btn.disabled = false;
        btn.textContent = 'Sign In';

        if (error) {
            showBanner(error.message, true);
            return;
        }

        showBanner('Welcome back!');
        closeAuthModal();
        updateAuthUI(data.session);
    }

    // ────────────────────────────────────────────────
    // 8. Sign out
    // ────────────────────────────────────────────────
    async function handleSignOut() {
        const { error } = await window.supabaseClient.auth.signOut();
        if (error) {
            showBanner(error.message, true);
            return;
        }
        showBanner('Signed out successfully');
        updateAuthUI(null);
    }

    // ────────────────────────────────────────────────
    // 9. Listen for auth state changes (session restore)
    // ────────────────────────────────────────────────
    window.supabaseClient.auth.onAuthStateChange((event, session) => {
        updateAuthUI(session);
    });

    // ────────────────────────────────────────────────
    // 10. Wire up the modal buttons once DOM is ready
    // ────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        // Initial session check
        window.supabaseClient.auth.getSession().then(({ data: { session } }) => {
            updateAuthUI(session);
        });

        // Modal buttons
        const btnClose = document.getElementById('auth-modal-close');
        if (btnClose) btnClose.addEventListener('click', closeAuthModal);

        const btnSignup = document.getElementById('btn-signup');
        if (btnSignup) btnSignup.addEventListener('click', handleSignUp);

        const btnSignin = document.getElementById('btn-signin');
        if (btnSignin) btnSignin.addEventListener('click', handleSignIn);

        // Close modal when clicking the dark overlay
        const modal = document.getElementById('auth-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeAuthModal();
            });
        }
    });
})();