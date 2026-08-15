// public/changelog/architecture.js
// Admin-only "Architecture (Modules)" workspace renderer.
//
// Shows the modular architecture: each module is a pluggable, game-agnostic
// piece of the platform (M1 game core, M2 universal result seam, M3 local
// points, M4 global ledgers, M5 subscription, M6 point sources, M7
// competitions, M8 sponsor escrow).
// Status per module: planned / in-progress / shipped. Plus the rules that
// govern how modules may touch each other, and the implementation order.
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

  let state = { status: 'in-progress' };
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

  function renderModule(m) {
    const details = Array.isArray(m.details) && m.details.length
      ? `<div class="entry-details"><h4>Dev notes</h4><ul>${m.details.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`
      : '';
    return `
      <article class="entry roadmap-entry econ-entry">
        <div class="entry-head">
          <span class="entry-version">${esc(m.id)}</span>
          <span class="badge b-status">${esc(STATUS_LABEL[m.status] || m.status)}</span>
        </div>
        <h3>${esc(m.title)}</h3>
        ${m.summary ? `<p class="entry-summary">${esc(m.summary)}</p>` : ''}
        ${details}
      </article>`;
  }

  function renderTabs() {
    return `
      <nav class="changelog-tabs econ-tabs" role="tablist" aria-label="Module status">
        ${STATUSES.map(s => `
          <button class="changelog-tab econ-tab ${s === state.status ? 'active' : ''}"
            role="tab" aria-selected="${s === state.status}"
            data-status="${s}">${STATUS_LABEL[s]}</button>
        `).join('')}
      </nav>`;
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

  async function paint() {
    const out = qs('#architecture-items');
    if (!out) return;
    try {
      if (!cache) cache = await loadJson(ARCH_JSON);
      const modules = (cache.modules || []).filter(m => m.status === state.status);
      const updated = cache.updated || '';
      out.innerHTML = `
        ${renderTabs()}
        <p class="econ-updated">Workspace last updated: ${esc(updated)}</p>
        ${modules.length
          ? modules.map(renderModule).join('')
          : `<p class="empty">No modules in "${esc(STATUS_LABEL[state.status]).toLowerCase()}" right now.</p>`}
        <hr class="arch-divider">
        ${renderRules(cache.rules)}
        ${renderOrder(cache.implementationOrder)}
      `;
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the architecture workspace (${esc(e.message)}).</p>`;
    }
  }

  function bind() {
    const out = qs('#architecture-items');
    if (!out) return;
    out.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (btn) {
        state.status = btn.dataset.status;
        paint();
      }
    });
  }

  async function render() {
    bind();
    await paint();
  }

  window.renderArchitecture = render;
})();
