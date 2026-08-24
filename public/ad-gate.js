// public/ad-gate.js — MONETAG AD GATE (universal, loaded on every page).
//
// Loads ONLY the two gentle Monetag formats chosen by the owner (2026-08-23):
//   * In-Page Push banner (zone 11643974, nap5k.com/tag.min.js)
//   * Vignette banner      (zone 11644008, n6wxm.com/vignette.min.js)
// The Multitag (push / popunder / direct-link) has been REMOVED, so those
// intrusive formats can never serve. Monetag decides exact placement/cadence
// from its dashboard; we control which pages get the tags.
//
// Tier logic (unchanged): signed-out / Level 1 / Level 2 get the two ads.
// ACTIVE Level 3 is ad-FREE: the tags are never injected. Any leftover Monetag
// push service-worker (from the multitag era) is unregistered sitewide, since
// push is no longer part of the ads we run.
(function () {
    'use strict';
    if (window.__gfgAdGate) return;
    window.__gfgAdGate = true;

    var ZONES = [
        { zone: '11643974', src: 'https://nap5k.com/tag.min.js' },      // In-Page Push (banner)
        { zone: '11644008', src: 'https://n6wxm.com/vignette.min.js' }, // Vignette banner
    ];

    function signedIn() {
        try { if (window.getDynamicSolanaWallet && window.getDynamicSolanaWallet()) return true; } catch (e) {}
        try { if (window.currentProfile && window.currentProfile.solana_wallet) return true; } catch (e) {}
        try { if (window.currentUser) return true; } catch (e) {}
        return false;
    }

    // Live premium snapshot (pure cache read, never triggers RPC).
    function tier() {
        var snapshot = null;
        try {
            snapshot = (window.premiumPoints && typeof window.premiumPoints.get === 'function')
                ? window.premiumPoints.get() : null;
        } catch (e) { snapshot = null; }
        var lvl = Number(snapshot && snapshot.subscriptionLevel ? snapshot.subscriptionLevel : 0);
        var until = Number(snapshot && snapshot.subscriptionActiveUntil ? snapshot.subscriptionActiveUntil : 0);
        return { snapshot: !!snapshot, lvl: lvl, active: lvl > 0 && until > Date.now() };
    }

    function injectZone(zone) {
        if (document.querySelector('script[data-zone="' + zone.zone + '"]')) return;
        var sc = document.createElement('script');
        sc.setAttribute('data-zone', zone.zone);
        sc.src = zone.src;
        sc.async = true;
        sc.setAttribute('data-cfasync', 'false');
        (document.head || document.documentElement || document.body).appendChild(sc);
    }

    // Push is no longer served (multitag removed): clear any Monetag push
    // service-worker for everyone so it can't fire behind the scenes.
    function unregisterAdServiceWorkers() {
        try {
            if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
                navigator.serviceWorker.getRegistrations().then(function (rs) {
                    (rs || []).forEach(function (r) { r.unregister().catch(function () { /* best-effort */ }); });
                }).catch(function () { /* ignore */ });
            }
        } catch (e) { /* ignore */ }
    }

    var tries = 0;
    function decide() {
        tries++;
        unregisterAdServiceWorkers();
        var t = tier();
        if (t.lvl >= 3 && t.active) return; // Level 3 = ad-free
        // Signed in but premium snapshot not cached yet: wait briefly for it.
        if (signedIn() && !t.snapshot && tries < 16) {
            setTimeout(decide, 250);
            return;
        }
        // Everyone else (signout, L1, L2, or timeout): show the two gentle ads.
        ZONES.forEach(injectZone);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(decide, 120); });
    } else {
        setTimeout(decide, 120);
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', decide);
    }
    try {
        if (window.premiumPoints && typeof window.premiumPoints.subscribe === 'function') {
            window.premiumPoints.subscribe(decide);
        }
    } catch (e) { /* ignore */ }
})();