// public/changelog/architecture.js
// Admin-only "Architecture (Modules)" workspace renderer.
//
// Two render modes, driven by the page:
//   1. OVERVIEW (default, /changelog/architecture.html): the module list
//      grouped by status tab (Planned / In progress / Shipped) + module rules
//      + implementation order. Each module card links to its own page.
//   2. MODULE PAGE (/changelog/architecture-m1.html ... -m8.html): a single
//      module's full detail + a left-rail navigation (dashboard style).
//      M1 additionally renders a searchable game dropdown: selecting a game
//      shows that game's LOCKED build spec (M1 sub-modules: M1-ludo locked,
//      M1-ayo-olopon planned). These locked specs are the build + test
//      benchmark the agent follows.
//
// Data lives in architecture.json (client-served but admin-gated; no unfixed
// security/anti-exploit details go here, per security-queue.md rules).
(function () {
  const ARCH_JSON = '/changelog/architecture.json';
  const STATUSES = ['planned', 'in-progress', 'shipped'];
  const STATUS_LABEL = {
    'planned': 'Planned',
    'in-progress': 'In progress',
    'shipped': 'Shipped'
  };

  let cache = null;

  function qs(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + url + ' -> ' + res.status);
    return res.json();
  }

  function statusBadge(status) {
    const label = STATUS_LABEL[status] || status;
    return `<span class="badge b-status ${esc(status)}">${esc(label)}</span>`;
  }

  function detailsHtml(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return `<div class="entry-details"><h4>Dev notes</h4><ul>${items.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  }

  function moduleCard(m) {
    const gameCount = Array.isArray(m.games) && m.games.length
      ? ` <span class="badge b-status in-progress">${m.games.length} game sub-module(s)</span>`
      : '';
    return `
      <article class="entry roadmap-entry econ-entry">
        <div class="entry-head">
          <a class="entry-version arch-module-link" href="/changelog/architecture-${m.id.toLowerCase()}.html">${esc(m.id)} →</a>
          ${statusBadge(m.status)}${gameCount}
        </div>
        <h3>${esc(m.title)}</h3>
        ${m.summary ? `<p class="entry-summary">${esc(m.summary)}</p>` : ''}
        ${detailsHtml(m.details)}
        <p class="entry-git">Module page: <a href="/changelog/architecture-${m.id.toLowerCase()}.html" style="color:#9b59b6;">${esc(m.id)} full detail →</a></p>
      </article>`;
  }

  // ----- OVERVIEW mode (home: /changelog/architecture.html) -----
  function renderOverview(cache, status) {
    const modules = (cache.modules || []).filter(m => m.status === status);
    const updated = cache.updated || '';
    return `
      <nav class="changelog-tabs econ-tabs" role="tablist" aria-label="Module status">
        ${STATUSES.map(s => `
          <button class="changelog-tab econ-tab ${s === status ? 'active' : ''}"
            role="tab" aria-selected="${s === status}"
            data-status="${s}">${STATUS_LABEL[s]}</button>
        `).join('')}
      </nav>
      <p class="econ-updated">Workspace last updated: ${esc(updated)}</p>
      <p class="muted-note" style="color:#888;font-size:0.82rem;line-height:1.5;">Each module has its own page with full detail (use the ☰ left rail to navigate). M1 carries a searchable game dropdown with per-game LOCKED build specs. Click a module id to open it.</p>
      ${modules.length
        ? modules.map(moduleCard).join('')
        : `<p class="empty">No modules in "${esc(STATUS_LABEL[status]).toLowerCase()}" right now.</p>`}
      <hr class="arch-divider">
      ${renderRules(cache.rules)}
      ${renderOrder(cache.implementationOrder)}
    `;
  }

  function renderRules(rules) {
    if (!Array.isArray(rules) || !rules.length) return '';
    return `
      <section class="arch-block">
        <h3 class="arch-block-title">⚙️ Module rules (non-negotiable)</h3>
        <ul>${rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      </section>`;
  }

  function renderOrder(order) {
    if (!Array.isArray(order) || !order.length) return '';
    return `
      <section class="arch-block">
        <h3 class="arch-block-title">🧭 Implementation order</h3>
        <ol>${order.map(o => `<li>${esc(o)}</li>`).join('')}</ol>
      </section>`;
  }

  // ----- MODULE PAGE mode (/changelog/architecture-mX.html) -----
  function renderModulePage(m) {
    return `
      <section class="changelog-head">
        <a href="/changelog/architecture.html" class="changelog-back">← Architecture home</a>
        <div class="entry-head">
          <span class="entry-version">${esc(m.id)}</span>
          ${statusBadge(m.status)}
        </div>
        <h2>${esc(m.title)}</h2>
        ${m.summary ? `<p class="changelog-sub">${esc(m.summary)}</p>` : ''}
        <div class="changelog-meta">
          <span id="changelog-role" class="changelog-role"></span>
          <a href="/changelog/admin.html" class="changelog-admin-link">Raw changelog →</a>
        </div>
      </section>
      <div class="changelog-entries">
        <article class="entry">
          ${detailsHtml(m.details)}
        </article>
      </div>
      ${Array.isArray(m.games) && m.games.length ? renderGamePicker(m) : ''}
      ${renderRules(cache.rules)}
      ${renderOrder(cache.implementationOrder)}
    `;
  }

  // ----- M1 per-game sub-module picker (searchable dropdown) -----
  function renderGamePicker(m) {
    const games = m.games || [];
    return `
      <section class="arch-block" id="game-picker-block">
        <h3 class="arch-block-title">🎮 ${esc(m.id)} game sub-modules</h3>
        <p class="muted-note" style="color:#888;font-size:0.82rem;line-height:1.5;margin:0 0 10px;">This module covers multiple games. Pick a game to see its LOCKED build spec (the build + test benchmark for that game). Select one from the dropdown.</p>
        <div class="game-picker">
          <input type="text" id="game-search" class="game-search" placeholder="Search games (e.g. Ludo, Ayo Olopon)…" autocomplete="off">
          <div class="game-options" id="game-options" role="listbox" aria-label="Games"></div>
        </div>
        <div id="game-spec" class="game-spec"></div>
      </section>
    `;
  }

  function gameSpecHtml(game, moduleId) {
    const locked = game.status === 'locked';
    const badge = locked
      ? `<span class="badge b-status in-progress">LOCKED ${esc(game.lockedAt || '')}</span>`
      : statusBadge(game.status);
    return `
      <article class="entry ${locked ? 'entry-major' : ''}">
        <div class="entry-head">
          <span class="entry-version">${esc(moduleId)} · ${esc(game.title)}</span>
          ${badge}
        </div>
        <h3>${esc(game.title)}</h3>
        ${game.summary ? `<p class="entry-summary">${esc(game.summary)}</p>` : ''}
        ${detailsHtml(game.details)}
      </article>`;
  }

  function initGamePicker(m) {
    const block = qs('#game-picker-block');
    if (!block) return;
    const games = m.games || [];
    const searchEl = qs('#game-search');
    const optionsEl = qs('#game-options');
    const specEl = qs('#game-spec');

    function renderOptions(filter) {
      const q = (filter || '').trim().toLowerCase();
      const matches = games.filter(g =>
        !q || (g.title || '').toLowerCase().includes(q) || (g.gameKey || g.id || '').toLowerCase().includes(q)
      );
      if (!matches.length) {
        optionsEl.innerHTML = `<div class="game-option game-option-empty">No games match "${esc(filter)}"</div>`;
        return;
      }
      optionsEl.innerHTML = matches.map(g => `
        <button type="button" class="game-option" data-game="${esc(g.id)}" role="option">
          <span class="game-option-title">${esc(g.title)}</span>
          <span class="badge b-status ${esc(g.status)}">${esc(STATUS_LABEL[g.status] || g.status)}</span>
        </button>
      `).join('');
    }

    function selectGame(gameId) {
      const game = games.find(g => g.id === gameId);
      if (!game) return;
      searchEl.value = game.title;
      specEl.innerHTML = gameSpecHtml(game, m.id);
      optionsEl.classList.remove('open');
      // highlight the active option
      optionsEl.querySelectorAll('.game-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.game === gameId);
      });
    }

    searchEl.addEventListener('focus', () => {
      renderOptions('');
      optionsEl.classList.add('open');
    });
    searchEl.addEventListener('input', () => {
      renderOptions(searchEl.value);
      optionsEl.classList.add('open');
    });
    optionsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-game]');
      if (btn) selectGame(btn.dataset.game);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.game-picker')) optionsEl.classList.remove('open');
    });

    // Default: first locked game (or the first game).
    const preferred = games.find(g => g.status === 'locked') || games[0];
    if (preferred) {
      renderOptions('');
      selectGame(preferred.id);
    }
  }

  async function paintOverview() {
    const out = qs('#architecture-items');
    if (!out) return;
    try {
      if (!cache) cache = await loadJson(ARCH_JSON);
      const state = { status: 'in-progress' };
      out.dataset.status = state.status;
      out.innerHTML = renderOverview(cache, state.status);
      out.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-status]');
        if (btn) {
          out.dataset.status = btn.dataset.status;
          out.innerHTML = renderOverview(cache, btn.dataset.status);
        }
      });
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the architecture workspace (${esc(e.message)}).</p>`;
    }
  }

  async function paintModulePage(moduleId) {
    const out = qs('#architecture-items');
    if (!out) return;
    try {
      if (!cache) cache = await loadJson(ARCH_JSON);
      const m = (cache.modules || []).find(x => x.id.toLowerCase() === String(moduleId).toLowerCase());
      if (!m) {
        out.innerHTML = `<p class="empty">Module ${esc(moduleId)} not found.</p>`;
        return;
      }
      out.innerHTML = renderModulePage(m);
      if (Array.isArray(m.games) && m.games.length) initGamePicker(m);
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the architecture workspace (${esc(e.message)}).</p>`;
    }
  }

  async function render() {
    const moduleId = (document.body && document.body.dataset.module) || null;
    if (moduleId) {
      await paintModulePage(moduleId);
    } else {
      await paintOverview();
    }
  }

  window.renderArchitecture = render;
})();
