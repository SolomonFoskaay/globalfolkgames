// public/changelog/render.js
// Shared renderer for both changelog pages.
//   - mode 'user'  : watered-down summaries, always readable.
//   - mode 'admin' : raw details (numbered DEV Plan bullets, git refs, dates),
//     gated to staff (NOTE: gate is client-side today — cosmetic, not security).
// Content is organized by 3 status tabs (Planned / In progress / Shipped) and
// paginated per tab so long lists break into pages (Prev / pages / Next).
(function () {
  const CHANGELOG_JSON = '/changelog/changelog.json';
  const ROLES_JSON = '/changelog/roles.json';
  const PAGE_SIZE = 6;

  const TAB_ORDER = ['planned', 'in-progress', 'shipped'];
  const TAB_LABEL = {
    'planned': 'Planned',
    'in-progress': 'In progress',
    'shipped': 'Shipped'
  };

  // Current view state: which tab + which page within that tab.
  let state = { mode: 'user', tab: 'in-progress', page: 1 };
  let cache = null; // parsed changelog.json

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

  // Admin (dev) view: the technical plan renders as a numbered list (1. 2. 3.)
  // instead of bullet dots — easier to scan point by point.
  function devPlan(details) {
    if (!Array.isArray(details) || !details.length) return '';
    return `
      <div class="entry-details">
        <h4>DEV Plan</h4>
        <ol class="dev-plan-list">
          ${details.map(d => `<li>${esc(d)}</li>`).join('')}
        </ol>
      </div>`;
  }

  // Roadmap (Feature Tracker) item — planned or in-progress.
  function renderRoadmapItem(e, mode) {
    const extra = mode === 'admin' ? devPlan(e.details) : '';
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

  // Shipped changelog entry.
  function renderEntry(e, mode) {
    const extra = mode === 'admin' ? devPlan(e.details) : '';
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

  // ---- tabs ----
  function renderTabs(activeTab) {
    return `
      <nav class="changelog-tabs" role="tablist" aria-label="Filter changelog by status">
        ${TAB_ORDER.map(tab => `
          <button class="changelog-tab ${tab === activeTab ? 'active' : ''}"
            role="tab" aria-selected="${tab === activeTab}"
            data-tab="${tab}">${TAB_LABEL[tab]}</button>
        `).join('')}
      </nav>`;
  }

  // ---- pagination ----
  function renderPagination(page, totalPages) {
    if (totalPages <= 1) return '';
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(`<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}" aria-label="Page ${i}">${i}</button>`);
    }
    return `
      <nav class="changelog-pagination" aria-label="Pagination">
        <button class="page-btn" data-nav="prev" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹ Prev</button>
        ${pages.join('')}
        <button class="page-btn" data-nav="next" ${page >= totalPages ? 'disabled' : ''} aria-label="Next page">Next ›</button>
      </nav>`;
  }

  // Filter changelog data by the active tab.
  // Everything in this payload is user-safe by construction: unfixed security
  // work is never stored in changelog.json (client-served data), so there is
  // nothing to hide at render time.
  function itemsFor(data, tab) {
    if (tab === 'shipped') return Array.isArray(data.entries) ? data.entries.slice() : [];
    const roadmap = Array.isArray(data.roadmap) ? data.roadmap : [];
    return roadmap.filter(r => r.status === tab);
  }

  async function paint() {
    const out = qs('#changelog-entries');
    const verEl = qs('#changelog-version');
    const whoEl = qs('#changelog-role');
    if (!out) return;

    try {
      if (!cache) cache = await loadJson(CHANGELOG_JSON);
      const data = cache;
      const mode = state.mode;
      if (verEl) verEl.textContent = data.current || '';
      whoEl.textContent = esc(mode === 'admin' ? 'Admin view' : 'Public changelog');

      const all = itemsFor(data, state.tab);
      const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      // Clamp page so navigation never lands past the end of a tab.
      if (state.page > totalPages) state.page = totalPages;

      const pageItems = all.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
      const list = pageItems.length
        ? pageItems.map((e, i) => e.status
            ? renderRoadmapItem(e, mode)
            : renderEntry(e, mode)).join('')
        : `<p class="empty">Nothing ${esc(TAB_LABEL[state.tab].toLowerCase())} right now.</p>`;

      // On the admin page, a one-line note above the list (staff-only reminder).
      let note = '';
      if (mode === 'admin') {
        const where = data.entries[0] && data.entries[0].version
          ? `This page shows engineer-facing details for v${esc(data.entries[0].version)} and earlier.`
          : 'This page shows engineer-facing details only staff can see.';
        note = `<p class="admin-note">${esc(where)}</p>`;
      }

      out.innerHTML = `
        ${renderTabs(state.tab)}
        ${note}
        ${list}
        ${renderPagination(state.page, totalPages)}`;
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the changelog (${esc(e.message)}). Try the <a href="/">homepage</a>.</p>`;
    }
  }

  // Single delegated click handler for tabs + pagination (works on both pages).
  function bindControls() {
    const out = qs('#changelog-entries');
    if (!out || out.dataset.bound) return;
    out.dataset.bound = '1';
    out.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        state.tab = tabBtn.dataset.tab;
        state.page = 1;
        paint();
        return;
      }
      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn) {
        state.page = Number(pageBtn.dataset.page);
        paint();
        return;
      }
      const navBtn = e.target.closest('[data-nav]');
      if (navBtn) {
        const tabItems = cache ? itemsFor(cache, state.tab).length : 0;
        const lastPage = Math.max(1, Math.ceil(tabItems / PAGE_SIZE));
        if (navBtn.dataset.nav === 'prev' && state.page > 1) state.page -= 1;
        if (navBtn.dataset.nav === 'next' && state.page < lastPage) state.page += 1;
        paint();
      }
    });
  }

  async function render(mode) {
    state.mode = mode;
    // Default tab: land visitors on "In progress" (what we're building now),
    // keeping "Shipped" a click away for the release history.
    bindControls();
    await paint();
  }

  // Admin gate: bounce non-staff to the homepage. Runs after a short auth
  // settle window (mirrors profiles.js). Staff = admin or moderator.
  // NOTE: client-side only today — cosmetic convenience, not a security gate.
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