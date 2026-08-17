// header.js
// Single source of truth for the global header + auth modal + slide-in nav
// Any page that calls initGlobalHeader() gets the full working header, the
// hamburger nav drawer and the login modal.

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

    // ---------- Menu items ----------
    // Essential links every visitor needs; admin-only items are shown when the
    // connected wallet is staff.
    // The Ludo label/flag comes from the central games registry so the origin
    // stays correct in one place as more games ship.
    let gameRegistry = null;
    function loadGameRegistry() {
        return fetch('/games/registry.json', { cache: 'no-store' })
            .then(res => (res.ok ? res.json() : null))
            .then(data => { gameRegistry = data; })
            .catch(() => { gameRegistry = null; });
    }
    function ludoNavLabel() {
        const g = gameRegistry && gameRegistry.games
            ? gameRegistry.games.find(x => x.id === 'ludo')
            : null;
        if (g && g.origin && g.origin.flag) return `${g.origin.flag} ${g.name}`;
        return '🇮🇳 Ludo';
    }
    function NAV_SECTIONS() {
        return [
            {
                heading: 'Play',
                items: [
                    { label: ludoNavLabel(), href: '/games/ludo/', match: 'ludo' },
                    { label: '🏆 Competitions', href: '/competitions/', match: 'competitions' },
                    { label: 'Home', href: '/', match: 'home' }
                ]
            },
            {
                heading: 'Discover',
                items: [
                    { label: 'What’s New', href: '/changelog/', match: 'changelog' },
                    { label: 'About', href: '/about/', match: 'about' },
                    { label: 'Forum', href: '/forum/', match: 'forum' },
                    { label: 'Support', href: '/support/', match: 'support' },
                    { label: 'Contact', href: '/contact/', match: 'contact' }
                ]
            },
            {
                heading: 'Account',
                items: [
                    { label: 'My Profile', href: '/profile/', match: 'profile' }
                ]
            }
        ];
    }

    // Admin-only links shown only to staff (admin / moderator wallets).
    const ADMIN_NAV = [
        { label: '🛡 Dashboard', href: '/dashboard/', match: 'dashboard' },
        { label: 'Changelog (raw)', href: '/changelog/admin.html', match: 'changelog-admin' },
        { label: 'Game Economics', href: '/changelog/economics.html', match: 'changelog-economics' },
        { label: 'Architecture (Modules)', href: '/changelog/architecture.html', match: 'changelog-architecture' }
    ];

    // Resolve the connected wallet the same way the changelog page does.
    function currentWallet() {
        try {
            if (window.getDynamicSolanaWallet) {
                const w = window.getDynamicSolanaWallet();
                if (w) return w;
            }
            if (window.currentProfile && window.currentProfile.solana_wallet) {
                return window.currentProfile.solana_wallet;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Return 'admin' | 'moderator' | 'user' for the connected wallet.
    async function resolveMyRole() {
        try {
            const res = await fetch('/changelog/roles.json', { cache: 'no-store' });
            if (!res.ok) return 'user';
            const roles = await res.json();
            const wallet = currentWallet();
            if (!wallet || !roles) return 'user';
            const w = wallet.toLowerCase();
            const norm = list => Array.isArray(list) ? list.map(a => String(a).toLowerCase()) : [];
            if (norm(roles.admin).includes(w)) return 'admin';
            if (norm(roles.moderator).includes(w)) return 'moderator';
        } catch (e) { /* ignore */ }
        return 'user';
    }

    // Build the slide-in navigation drawer. Glassmorphic so the page content
    // stays visible behind it; it slides OVER the page (never pushes it).
    function ensureDrawer() {
        if (document.getElementById('gfg-drawer')) return;

        const html = `
            <div id="gfg-drawer-scrim" class="gfg-drawer-scrim"></div>
            <aside id="gfg-drawer" class="gfg-drawer" aria-hidden="true">
                <div class="gfg-drawer-head">
                    <span class="gfg-brand">🌍 GlobalFolkGames</span>
                    <button id="gfg-drawer-close" class="gfg-drawer-close" aria-label="Close menu">×</button>
                </div>
                <nav class="gfg-drawer-nav" id="gfg-drawer-nav">
                    ${NAV_SECTIONS().map(sec => `
                        <div class="gfg-drawer-section">
                            <div class="gfg-drawer-heading">${sec.heading}</div>
                            <ul>
                                ${sec.items.map(it => `
                                    <li><a href="${it.href}" data-nav-item="${it.match}">${it.label}</a></li>
                                `).join('')}
                            </ul>
                        </div>
                    `).join('')}
                    <!-- Admin links are NOT in the DOM for visitors; added only
                         after the wallet is verified staff (see ensureAdminSection). -->
                </nav>
            </aside>
        `;
        document.body.insertAdjacentHTML('beforeend', html);

        const drawer = document.getElementById('gfg-drawer');
        const scrim = document.getElementById('gfg-drawer-scrim');
        const closeBtn = document.getElementById('gfg-drawer-close');

        function openDrawer() {
            drawer?.classList.add('open');
            scrim?.classList.add('show');
            if (drawer) drawer.setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        }
        function closeDrawer() {
            drawer?.classList.remove('open');
            scrim?.classList.remove('show');
            if (drawer) drawer.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
        }

        closeBtn?.addEventListener('click', closeDrawer);
        scrim?.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeDrawer();
        });
        // Clicking any link closes the drawer; the default navigation proceeds.
        drawer?.querySelectorAll('a[data-nav-item]').forEach(a => {
            a.addEventListener('click', closeDrawer);
        });

        window.openGlobalDrawer = openDrawer;
        window.closeGlobalDrawer = closeDrawer;

        // Admin-only links appear ONLY after the connected wallet is verified
        // staff. For everyone else the Admin section never exists in the DOM,
        // so a non-admin inspecting the page cannot even see the target URLs.
        resolveMyRole().then(role => {
            if (role !== 'user') ensureAdminSection();
        });
    }

    // Insert the Admin nav section for staff wallets only. Built lazily so
    // visitors and signed-in non-admins never receive the admin URLs in the
    // client payload at all.
    function ensureAdminSection() {
        if (document.getElementById('gfg-drawer-admin')) return;
        const nav = document.getElementById('gfg-drawer-nav');
        if (!nav) return;
        const sec = document.createElement('div');
        sec.className = 'gfg-drawer-section gfg-drawer-admin';
        sec.id = 'gfg-drawer-admin';
        sec.innerHTML = `
            <div class="gfg-drawer-heading">Admin</div>
            <ul>
                ${ADMIN_NAV.map(it => `
                    <li><a href="${it.href}" data-nav-item="${it.match}">${it.label}</a></li>
                `).join('')}
            </ul>
        `;
        nav.appendChild(sec);
        sec.querySelectorAll('a[data-nav-item]').forEach(a => {
            a.addEventListener('click', () => {
                if (typeof window.closeGlobalDrawer === 'function') window.closeGlobalDrawer();
            });
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
                    <button id="gfg-menu-btn" class="gfg-menu-btn" aria-label="Open menu" aria-haspopup="true">☰</button>
                </div>
            </header>
        `;

        document.body.insertAdjacentHTML('afterbegin', headerHTML);

        // Measure the global header's REAL rendered height and expose it as
        // --gfg-header-h. The header may sit on one row (desktop) or two
        // (mobile when brand + right side don't fit), and its height varies
        // with the pill's content and font loading, so a fixed 50px guess
        // would leave the pill overlapping page headers below. Local headers
        // that stick under it (e.g. Ludo) read this variable. Re-measure on
        // resize and after fonts load so the value tracks any changes.
        function syncHeaderHeight() {
            const h = document.querySelector('.gfg-header');
            if (h) {
                document.documentElement.style.setProperty('--gfg-header-h', h.offsetHeight + 'px');
            }
        }
        syncHeaderHeight();
        window.addEventListener('resize', syncHeaderHeight);
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => setTimeout(syncHeaderHeight, 120));
        }

        // Wire the hamburger menu to the slide-in drawer.
        const menuBtn = document.getElementById('gfg-menu-btn');
        menuBtn?.addEventListener('click', () => {
            ensureDrawer();
            if (window.openGlobalDrawer) window.openGlobalDrawer();
        });

        // Make sure the auth modal also exists on this page
        ensureAuthModal();
        ensureConfirmDialog();

        // Tell profiles.js the header is ready
        if (typeof window.refreshAuthHeader === 'function') {
            window.refreshAuthHeader();
        }

        // Live on-chain local-points chip. When a page opts in via
        // initGlobalHeader({ localPointsTag: 'ludo' }), the chip reads the M3
        // module (window.localPoints — the universal points consumer) instead
        // of a static value: an initial fetch, then every bank/spend refresh
        // the module publishes updates the chip live. Reads are gasless.
        if (options.localPointsTag) {
            const chip = document.querySelector('.gfg-local-pts');
            const tag = options.localPointsTag;
            const apply = function (gameTag, ledger) {
                if (!chip || gameTag !== tag) return;
                const pts = ledger && ledger.pureLifetime != null ? ledger.pureLifetime : 0;
                chip.textContent = 'Local: ' + Number(pts).toLocaleString();
            };
            if (window.localPoints) {
                if (typeof window.localPoints.subscribe === 'function') {
                    window.localPoints.subscribe(apply);
                }
                window.localPoints.fetch(tag).then(function (ledger) { apply(tag, ledger); }).catch(function () {});
            }
        }

        // Live on-chain global-spendable points in the header pill. When a page
        // opts in via initGlobalHeader({ globalPointsTag: true }), the pill
        // subscribes to M4 (window.globalLedger) and overlays the on-chain
        // spendable balance over the Supabase fallback. This makes every page
        // show the real on-chain points, not just the DB mirror.
        if (options.globalPointsTag) {
            var applyGlobal = function (ledger) {
                // Re-query every time because updateHeader() rebuilds the pill DOM.
                var el = document.getElementById('display-points');
                if (!el || !ledger) return;
                var spendable = ledger.spendableBalance != null ? ledger.spendableBalance : null;
                if (spendable === null) return;
                el.textContent = '\u2B50 ' + Number(spendable).toLocaleString() + ' Pts';
            };
            if (window.globalLedger) {
                if (typeof window.globalLedger.subscribe === 'function') {
                    window.globalLedger.subscribe(applyGlobal);
                }
                window.globalLedger.fetch().then(applyGlobal).catch(function () {});
                // Re-fetch after sign-in/sign-out so the pill gets the on-chain
                // value even if updateHeader() just rebuilt the DOM with Supabase data.
                window.addEventListener('gfg:auth-changed', function () {
                    window.globalLedger.fetch().then(applyGlobal).catch(function () {});
                });
            }
        }
    }

    // ---------- Generic confirm dialog (platform-styled, thumb-safe) ----------
    // Used across the platform for destructive actions (sign out, etc.).
    // Button order: OK on the LEFT, Cancel on the RIGHT. On mobile the right
    // side is where a thumb naturally lands when reaching for the menu, so a
    // stray tap hits Cancel and nothing happens; signing out (OK) is a
    // deliberate, careful tap.
    function ensureConfirmDialog() {
        if (document.getElementById('gfg-confirm-dialog')) return;

        const html = `
            <div id="gfg-confirm-dialog" class="auth-modal">
                <div class="auth-modal-content">
                    <h2 id="gfg-confirm-title">${String.fromCharCode(63)}</h2>
                    <p id="gfg-confirm-message" class="auth-hint" style="margin-bottom:16px;"></p>
                    <div class="auth-actions gfg-confirm-actions">
                        <button id="gfg-confirm-ok" class="auth-btn primary">Okay</button>
                        <button id="gfg-confirm-cancel" class="auth-btn secondary">Cancel</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);

        const dialog = document.getElementById('gfg-confirm-dialog');
        let onOk = null;

        function close() {
            dialog?.classList.remove('visible');
            onOk = null;
        }

        document.getElementById('gfg-confirm-ok')?.addEventListener('click', () => {
            const cb = onOk;
            close();
            if (cb) cb();
        });
        document.getElementById('gfg-confirm-cancel')?.addEventListener('click', close);
        // Clicking the dark background also cancels (safe default).
        dialog?.addEventListener('click', (e) => {
            if (e.target.id === 'gfg-confirm-dialog') close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('gfg-confirm-dialog')?.classList.contains('visible')) close();
        });

        // Public: window.showConfirmDialog({ title, message, okText, cancelText, onOk })
        window.showConfirmDialog = function (opts = {}) {
            const dlg = document.getElementById('gfg-confirm-dialog');
            if (!dlg) return;
            document.getElementById('gfg-confirm-title').textContent = opts.title || 'Are you sure?';
            document.getElementById('gfg-confirm-message').textContent = opts.message || '';
            document.getElementById('gfg-confirm-ok').textContent = opts.okText || 'Okay';
            document.getElementById('gfg-confirm-cancel').textContent = opts.cancelText || 'Cancel';
            onOk = opts.onOk || null;
            dlg.classList.add('visible');
        };
    }

    // Public function used by every page
    window.initGlobalHeader = function (options) {
        renderHeader(options || {});
        loadGameRegistry(); // keeps nav labels in sync with the games registry
    };

})();