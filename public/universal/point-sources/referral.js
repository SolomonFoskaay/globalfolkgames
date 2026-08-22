// public/universal/point-sources/referral.js
// M6 — REFERRAL + AFFILIATE CLIENT (universal, game-agnostic).
//
// Every signed-in user has a referral code (their wallet address, deterministic).
// Shareable link: /?ref=<code>. When a referred player subscribes, the referrer
// earns 15% of that subscription (in USD cents) for up to 12 months, recorded
// ON-CHAIN by the relay. The ledger read goes through the platform API (server
// reads the chain) so this module never triggers client RPC on page load.
//
// Exposes:
//   window.gfgReferral = {
//     code()                  -> wallet-based referral code (or null)
//     shareLink()             -> https://<origin>/?ref=<code>
//     claimSignupBonus()      -> POST /api/signup (idempotent 500P kind=1 credit)
//     getLedger()             -> Promise<{lifetimeUsdCents,pendingUsdCents,...,
//                                        entries[]}> from /api/affiliate?wallet=
//   }
// DOM slots (any profile page): [data-ref-code], [data-ref-link],
// [data-ref-earned], [data-ref-pending].
(function () {
  if (window.gfgReferral) return;

  function wallet() {
    try {
      var w = window.getDynamicSolanaWallet ? window.getDynamicSolanaWallet() : null;
      if (!w && window.currentProfile && window.currentProfile.solana_wallet) w = window.currentProfile.solana_wallet;
      if (!w) return null;
      if (typeof w === 'string') return w;
      return w.address || String(w);
    } catch (e) { return null; }
  }

  var cachedLedger = null;
  var ledgerAt = 0;

  function getLedger(force) {
    var w = wallet();
    if (!w) return Promise.resolve(null);
    if (!force && cachedLedger && Date.now() - ledgerAt < 120000) return Promise.resolve(cachedLedger);
    return fetch('/api/affiliate?wallet=' + encodeURIComponent(w), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        cachedLedger = j; ledgerAt = Date.now();
        return j;
      })
      .catch(function (e) { return null; });
  }

  function claimSignupBonus() {
    var w = wallet();
    if (!w) return Promise.resolve({ ok: false, error: 'signin' });
    return fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: w }) })
      .then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  function shareLink() {
    var c = wallet();
    if (!c) return null;
    return (location.origin || '') + '/?ref=' + encodeURIComponent(c);
  }

  function fillSlots(ledger) {
    var code = wallet();
    var els = document.querySelectorAll('[data-ref-code]');
    for (var i = 0; i < els.length; i++) els[i].textContent = code ? code.slice(0, 12) + '...' : 'Sign in to get your code';
    var linkEls = document.querySelectorAll('[data-ref-link]');
    for (var j = 0; j < linkEls.length; j++) linkEls[j].textContent = code ? shareLink() : '';
    var earnedEls = document.querySelectorAll('[data-ref-earned]');
    for (var k = 0; k < earnedEls.length; k++) earnedEls[k].textContent = ledger ? ('$' + ((ledger.lifetimeUsdCents || 0) / 100).toFixed(2)) : '--';
    var pendEls = document.querySelectorAll('[data-ref-pending]');
    for (var m = 0; m < pendEls.length; m++) pendEls[m].textContent = ledger ? ('$' + ((ledger.pendingUsdCents || 0) / 100).toFixed(2)) : '--';
  }

  function refresh() {
    getLedger().then(function (l) { if (l && l.account) fillSlots(l); });
  }

  window.gfgReferral = {
    code: wallet,
    shareLink: shareLink,
    claimSignupBonus: claimSignupBonus,
    getLedger: getLedger,
    refresh: refresh,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(refresh, 800); });
  } else {
    setTimeout(refresh, 800);
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('gfg:auth-changed', function () { cachedLedger = null; setTimeout(refresh, 300); });
  }
})();