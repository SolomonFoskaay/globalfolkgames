// public/changelog/render.js
// Shared renderer for both changelog pages.
//   - mode 'user'  : watered-down summaries, always readable.
//   - mode 'admin' : raw details (full bullets, git refs, dates), gated to staff.
// Roles come from roles.json keyed by Solana wallet (web3-native, Supabase-
// independent). Non-staff visitors to the admin page are bounced home.
(function () {
  const CHANGELOG_JSON = '/changelog/changelog.json';
  const ROLES_JSON = '/changelog/roles.json';

  function qs(sel) { return document.querySelector(sel); }

  // Resolve the connected user's Solana wallet. Prefers the Dynamic SDK path
  // used across the app; falls back to the cached profile wallet.
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

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + url + ' -> ' + res.status);
    return res.json();
  }

  async function loadRoles() {
    try { return await loadJson(ROLES_JSON); } catch (e) { return { admin: [], moderator: [] }; }
  }

  function roleForWallet(wallet, roles) {
    if (!wallet || !roles) return 'user';
    const w = wallet.toLowerCase();
    // Lowercase role lists too — Solana base58 addresses are case-sensitive on
    // chain but we normalize for matching (mirrors the .equals() gotcha: never
    // compare raw strings of different cases).
    const norm = list => Array.isArray(list) ? list.map(a => String(a).toLowerCase()) : [];
    if (norm(roles.admin).includes(w)) return 'admin';
    if (norm(roles.moderator).includes(w)) return 'moderator';
    return 'user';
  }

  // Ranks so moderator inherits access to pages that only need >= moderator.
  const RANK = { user: 0, moderator: 1, admin: 2 };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function typeBadge(type) {
    const label = { major: 'Major', minor: 'Minor', patch: 'Patch' }[type] || 'Update';
    const cls = { major: 'b-major', minor: 'b-minor', patch: 'b-patch' }[type] || 'b-minor';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function statusBadge(status) {
    const s = status === 'in-progress' ? 'in-progress' : 'planned';
    const label = s === 'in-progress' ? 'In progress' : 'Planned';
    return `<span class="badge b-status ${s}">${label}</span>`;
  }

  // Roadmap (Feature Tracker) item — shown on BOTH pages so users watch what's
  // being shaped live. Public page: summary only. Admin page: + dev details.
  function renderRoadmapItem(e, mode) {
    let extra = '';
    if (mode === 'admin' && (e.details && e.details.length)) {
      extra = `
        <div class="entry-details">
          <h4>Dev plan</h4>
          <ul>${e.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
        </div>`;
    }
    return `
      <article class="entry roadmap-entry ${e.status === 'in-progress' ? 'entry-in-progress' : ''}">
        <div class="entry-head">
          <span class="entry-version">Next</span>
          ${statusBadge(e.status)}
          <span class="entry-date">added ${esc(e.added || '')}</span>
        </div>
        <h3>${esc(e.title)}</h3>
        <p class="entry-summary">${esc(e.summary) || '<em>(coming soon)</em>'}</p>
        ${extra}
      </article>`;
  }

  function renderRoadmap(roadmap, mode) {
    if (!Array.isArray(roadmap) || !roadmap.length) return '';
    return `
      <section class="roadmap">
        <div class="roadmap-title">
          <h3>Coming next</h3>
          <p>What we're building right now — the platform taking shape live.</p>
        </div>
        ${roadmap.map(r => renderRoadmapItem(r, mode)).join('')}
      </section>`;
  }

  function renderEntry(e, mode) {
    const isUser = mode !== 'admin';
    let extra = '';
    if (mode === 'admin' && (e.details && e.details.length)) {
      extra = `
        <div class="entry-details">
          <h4>Technical details</h4>
          <ul>${e.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
        </div>`;
    }
    let git = '';
    if (mode === 'admin' && e.git) {
      git = `<div class="entry-git">git ${esc(e.git.head || '')} — ${esc(e.git.message || '')}</div>`;
    }
    return `
      <article class="entry ${e.type === 'major' ? 'entry-major' : ''}">
        <div class="entry-head">
          <span class="entry-version">v${esc(e.version)}</span>
          ${typeBadge(e.type)}
          <span class="entry-date">${esc(e.date)}</span>
        </div>
        <h3>${esc(e.title)}</h3>
        <p class="entry-summary">${esc(e.summary) || '<em>(no summary)</em>'}</p>
        ${extra}
        ${git}
      </article>`;
  }

  async function render(mode) {
    const out = qs('#changelog-entries');
    const verEl = qs('#changelog-version');
    const whoEl = qs('#changelog-role');
    if (!out) return;

    try {
      const data = await loadJson(CHANGELOG_JSON);
      if (verEl) verEl.textContent = data.current || '';
      if (whoEl) whoEl.textContent = esc(mode === 'admin' ? 'Admin view' : 'Public changelog');

      const entriesBody = Array.isArray(data.entries) && data.entries.length
        ? data.entries.map(e => renderEntry(e, mode)).join('')
        : '<p class="empty">No changelog entries yet.</p>';
      const body = renderRoadmap(data.roadmap, mode) + '<h3 class="releases-title">Released</h3>' + entriesBody;
      out.innerHTML = body;

      if (mode === 'admin') {
        const where = data.entries[0] && data.entries[0].version
          ? `This page shows engineer-facing details for v${esc(data.entries[0].version)} and earlier.`
          : 'This page shows engineer-facing details only staff can see.';
        const note = document.createElement('p');
        note.className = 'admin-note';
        note.textContent = where;
        out.prepend(note);
      }
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the changelog (${esc(e.message)}). Try the <a href="/">homepage</a>.</p>`;
    }
  }

  // Admin gate: bounce non-staff to the homepage. Runs after a short auth
  // settle window (mirrors profiles.js). Staff = admin or moderator.
  async function requireStaff() {
    const roles = await loadRoles();
    const wallet = currentWallet();

    // Give Dynamic/Supabase a moment to restore the session if it exists.
    if (!wallet && window.refreshAuthHeader) {
      try { await window.refreshAuthHeader(); } catch (e) { /* ignore */ }
      const w2 = currentWallet();
      if (w2) return handleStaffCheck(w2, roles);
    }

    function handleStaffCheck(w, r) {
      const role = roleForWallet(w, r);
      if (RANK[role] >= RANK.moderator) return role;
      // Bounce non-staff.
      window.location.replace('/');
      return null;
    }

    const role = handleStaffCheck(wallet, roles);
    // Post-resolve: after auth fully settles, re-verify once in case the first
    // pass raced a slow wallet load.
    setTimeout(async () => {
      const w = currentWallet();
      if (w) {
        const finalRole = roleForWallet(w, roles);
        const badge = qs('#changelog-role');
        if (badge) badge.textContent = w.slice(0, 4) + '…' + w.slice(-4) + ' · ' + finalRole;
      }
    }, 2500);
    return role;
  }

  // Non-bouncing role lookup for the public page (shows the staff link).
  async function getRole() {
    const roles = await loadRoles();
    let wallet = currentWallet();
    if (!wallet && window.refreshAuthHeader) {
      try { await window.refreshAuthHeader(); } catch (e) { /* ignore */ }
      wallet = currentWallet() || wallet;
    }
    return roleForWallet(wallet, roles);
  }

  window.renderChangelog = render;
  window.requireStaffAccess = requireStaff;
  window.getChangelogRole = getRole;
})();