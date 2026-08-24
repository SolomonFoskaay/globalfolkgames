// public/ad-gate.js — MONETAG AD GATE (universal, loaded on every page).
//
// Decides whether the Monetag ad tag runs on THIS page for the signed-in user:
//   - Signed out / Level 1 / Level 2  -> Monetag tag injected (ads ON).
//   - ACTIVE Level 3                  -> ad-FREE: the tag is never injected and
//     any previously-registered Monetag push service-workers are unregistered
//     (best-effort), so the L3 plan is a real no-ads plan (boost for a future
//     config list: adFree is a per-plan attribute in the plan ladder).
//
// The premium ledger is read through the already-cached window.premiumPoints
// (wallet-keyed, synchronous after its module loads). If the session is not
// resolved yet we wait briefly; if we can't tell, we show ads (never penalise
// the default). Deduped by data-zone so the tag loads at most once per page.
(function () {
    'use strict';
    if (window.__gfgAdGate) return;
    window.__gfgAdGate = true;

    var TAG_URL = 'https://quge5.com/88/tag.min.js';
    var ZONE = '272804';

    function signedIn() {
        try {
            if (window.getDynamicSolanaWallet && window.getDynamicSolanaWallet()) return true;
        } catch (e) { /* ignore */ }
        try {
            if (window.currentProfile && window.currentProfile.solana_wallet) return true;
        } catch (e) { /* ignore */ }
        try { if (window.currentUser) return true; } catch (e) { /* ignore */ }
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

    function injectTag() {
        if (document.querySelector('script[data-zone="' + ZONE + '"]')) return;
        var sc = document.createElement('script');
        sc.src = TAG_URL;
        sc.setAttribute('data-zone', ZONE);
        sc.async = true;
        sc.setAttribute('data-cfasync', 'false');
        (document.head || document.documentElement).appendChild(sc);
    }

    // Ad-free: remove any monetag push workers so their session gets no ads.
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
        var s = signedIn();
        var t = tier();
        if (t.lvl >= 3 && t.active) {
            unregisterAdServiceWorkers();
            return; // Level 3 = ad-free, never inject
        }
        // Signed in but premium snapshot not cached yet: wait briefly for it.
        if (s && !t.snapshot && tries < 16) {
            setTimeout(decide, 250);
            return;
        }
        // Everyone else (signout, L1, L2, or timeout): show ads.
        injectTag();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(decide, 120); });
    } else {
        setTimeout(decide, 120);
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', decide);
    }
    // Re-decide whenever the premium ledger refreshes (e.g. an L3 activation /
    // downgrade mid-session): active L3 immediately becomes ad-free.
    try {
        if (window.premiumPoints && typeof window.premiumPoints.subscribe === 'function') {
            window.premiumPoints.subscribe(decide);
        }
    } catch (e) { /* ignore */ }
})();