// header.js
// Single source of truth for the global header + auth modal
// Any page that calls initGlobalHeader() gets the full working header + login modal

(function () {

    // ---------- Auth Modal HTML ----------
    function ensureAuthModal() {
        if (document.getElementById('auth-modal')) return; // already exists

        const modalHTML = `
            <div id="auth-modal" class="auth-modal">
                <div class="auth-modal-content">
                    <button id="auth-modal-close" class="auth-modal-close">×</button>
                    <h2>Account</h2>
                    <p class="auth-hint">Simple email + password. No wallet needed.</p>

                    <input type="email" id="auth-email" placeholder="Email address" autocomplete="email">
                    <input type="password" id="auth-password" placeholder="Password (min 6 chars)" autocomplete="current-password">

                    <div class="auth-actions">
                        <button id="btn-signin" class="auth-btn primary">Sign In</button>
                        <button id="btn-signup" class="auth-btn secondary">Create Account</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // Re-attach the event listeners (auth.js already defined the functions)
        document.getElementById('auth-modal-close')?.addEventListener('click', () => {
            document.getElementById('auth-modal')?.classList.remove('visible');
        });

        document.getElementById('btn-signin')?.addEventListener('click', () => {
            if (window.handleSignIn) window.handleSignIn();
        });

        document.getElementById('btn-signup')?.addEventListener('click', () => {
            if (window.handleSignUp) window.handleSignUp();
        });

        // Close when clicking the dark background
        document.getElementById('auth-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'auth-modal') {
                document.getElementById('auth-modal')?.classList.remove('visible');
            }
        });
    }

    // ---------- Global Header ----------
    function renderHeader(options = {}) {
        const showLocal = options.showLocal || false;
        const localPoints = options.localPoints || 0;
        const gameName = options.gameName || '';

        // Remove old header if it exists
        const old = document.querySelector('.gfg-header');
        if (old) old.remove();

        const headerHTML = `
            <header class="gfg-header">
                <div class="gfg-header-left">
                    <a href="/" class="gfg-brand">🌍 GlobalFolkGames</a>
                    ${gameName ? `<span class="gfg-game-tag">${gameName}</span>` : ''}
                </div>
                <div class="gfg-header-right">
                    ${showLocal ? `<span class="gfg-local-pts">Local: ${localPoints}</span>` : ''}
                    <div class="gfg-user-pill" id="gfg-user-pill">
                        <span id="display-points">⭐ 0 Pts</span>
                    </div>
                </div>
            </header>
        `;

        document.body.insertAdjacentHTML('afterbegin', headerHTML);

        // Make sure the auth modal also exists on this page
        ensureAuthModal();

        // Tell profiles.js the header is ready
        if (typeof window.refreshAuthHeader === 'function') {
            window.refreshAuthHeader();
        }
    }

    // Public function used by every page
    window.initGlobalHeader = function (options) {
        renderHeader(options || {});
    };

})();