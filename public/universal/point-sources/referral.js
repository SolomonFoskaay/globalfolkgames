// public/universal/point-sources/referral.js
// M6 — REFERRAL + AFFILIATE CLIENT (universal, game-agnostic).
//
// Public identity is a HANDLE (GFG-XXXXXX) derived deterministically from Dynamic's
// stable user id (see public/universal/identity/handle.js) — never an email or a
// wallet. Shareable link: /?ref=<handle>. When a friend subscribes, the referrer
// earns 15% of that subscription (USD cents) for up to 12 months, recorded on-chain.
//
// Exposes:
//   window.gfgReferral = {
//     handle()                 -> GFG-XXXXXX (from Dynamic id, stable) or null
//     shareLink()              -> https://<origin>/?ref=<handle>
//     claimSignupBonus()       -> POST /api/signup {wallet, handle, refHandle}
//     getLedger()              -> Promise<{lifetimeUsdCents,...} or null
//   }
(function () {
  if (window.gfgReferral) return;

  function wallet() {
    try {
      var w = window.getDynamicSolanaWallet ? window.getDynamicSolanaWallet() : null;
      if (!w && window.currentProfile && window.currentProfile.solana_wallet) w = window.currentProfile.solana_wallet;
      if (!w) return null;
      return (typeof w === 'string') ? w : (w.address || String(w));
    } catch (e) { return null; }
  }

  var cachedHandle = null;
  function handle() {
    if (cachedHandle) return cachedHandle;
    var id = null;
    try { id = (window.getDynamicUser && window.getDynamicUser() && window.getDynamicUser().id) || null; } catch (e) {}
    if (!id) {
      try { if (window.currentProfile && window.currentProfile.dynamic_id) id = window.currentProfile.dynamic_id; } catch (e) {}
    }
    var h = (window.deriveProfileHandle && id) ? window.deriveProfileHandle(id) : null;
    cachedHandle = h;
    return h;
  }

  // Remember an invite handle from the URL (?ref=GFG-...) for the claim flow.
  var pendingRef = null;
  function pendingRefHandle() {
    if (pendingRef != null) return pendingRef;
    try {
      var q = new URLSearchParams(location.search).get('ref');
      if (q && window.isValidProfileHandle && window.isValidProfileHandle(q)) pendingRef = q.toUpperCase();
    } catch (e) {}
    if (!pendingRef) { try { pendingRef = localStorage.getItem('gfg_pending_ref') || null; } catch (e) {} }
    return pendingRef;
  }

  var cachedLedger = null, ledgerAt = 0;
  function getLedger(force) {
    var w = wallet();
    if (!w) return Promise.resolve(null);
    if (!force && cachedLedger && Date.now() - ledgerAt < 120000) return Promise.resolve(cachedLedger);
    return fetch('/api/affiliate?wallet=' + encodeURIComponent(w), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { cachedLedger = j; ledgerAt = Date.now(); return j; })
      .catch(function () { return null; });
  }

  function claimSignupBonus() {
    var w = wallet();
    if (!w) return Promise.resolve({ ok: false, error: 'signin' });
    var body = { wallet: w, handle: handle() };
    var ref = pendingRefHandle() || handle();
    if (ref) body.refHandle = ref;
    try { if (ref) localStorage.setItem('gfg_pending_ref', ref); } catch (e) {}
    return fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  function shareLink() {
    var h = handle();
    if (!h) return null;
    return (location.origin || '') + '/?ref=' + encodeURIComponent(h);
  }

  function fillSlots(ledger) {
    var h = handle();
    var els = document.querySelectorAll('[data-ref-code]');
    for (var i = 0; i < els.length; i++) els[i].textContent = h ? h : 'Sign in to get your code';
    var linkEls = document.querySelectorAll('[data-ref-link]');
    for (var j = 0; j < linkEls.length; j++) linkEls[j].textContent = h ? shareLink() : '';
    var earned = document.querySelectorAll('[data-ref-earned]');
    for (var k = 0; k < earned.length; k++) earned[k].textContent = ledger ? ('$' + ((ledger.lifetimeUsdCents || 0) / 100).toFixed(2)) : '--';
    var pend = document.querySelectorAll('[data-ref-pending]');
    for (var m = 0; m < pend.length; m++) pend[m].textContent = ledger ? ('$' + ((ledger.pendingUsdCents || 0) / 100).toFixed(2)) : '--';
  }

  function refresh() {
    getLedger().then(function (l) { if (l && l.account) fillSlots(l); });
    fillSlots(null);
  }

  window.gfgReferral = { handle, shareLink, claimSignupBonus, getLedger, refresh };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(refresh, 800); });
  else setTimeout(refresh, 800);
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('gfg:auth-changed', function () { cachedHandle = null; cachedLedger = null; setTimeout(refresh, 300); });
  }
})();