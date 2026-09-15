// public/changelog/arch-nav.js
// V2-ONLY left-rail navigation for the Architecture v2 workspace.
//
// Arcv1 keeps its own pages (architecture.html + architecture-m1..m9.html) with
// their own inline nav, untouched. Arcv2 has its own pages
// (architecture-v2.html + architecture-v2-m1..m12 + architecture-v2-arcv2m13)
// and uses THIS rail. The two versions never point at each other's pages.
(function () {
  var MODULES = [
    { key: 'm1', label: 'M1 · Game core' },
    { key: 'm2', label: 'M2 · Result seam' },
    { key: 'm3', label: 'M3 · Local points' },
    { key: 'm4', label: 'M4 · Global ledgers' },
    { key: 'm5', label: 'M5 · Subscription' },
    { key: 'm6', label: 'M6 · Point sources' },
    { key: 'm7', label: 'M7 · Competitions' },
    { key: 'm8', label: 'M8 · Sponsor escrow' },
    { key: 'm9', label: 'M9 · Player inventory' },
    { key: 'm10', label: 'M10 · Lives + daily' },
    { key: 'm11', label: 'M11 · Community' },
    { key: 'm12', label: 'M12 · Multiplayer' },
    { key: 'arcv2m13', label: 'arcv2m13 · Academy' }
  ];

  function pageFile() {
    var p = location.pathname || '';
    return p.substring(p.lastIndexOf('/') + 1) || 'architecture-v2.html';
  }

  function activeKey() {
    var m = (document.body && document.body.dataset && document.body.dataset.module) || '';
    if (m) return String(m).toLowerCase();
    var f = pageFile();
    var mm = f.match(/architecture-v2-(.+)\.html/);
    return mm ? mm[1] : 'v2home';
  }

  function render(opts) {
    if (!window.GFG_DASH_NAV) return;
    opts = opts || {};
    window.GFG_DASH_NAV.render({
      brand: '🚀 Architecture v2',
      active: opts.active || activeKey(),
      sections: [
        { heading: 'Workspace', items: [
          { key: 'v2home', label: '🚀 Overview (v2)', href: '/changelog/architecture-v2.html' }
        ]},
        { heading: 'Modules (v2)', items: MODULES.map(function (mo) {
          return { key: mo.key, label: mo.label, href: '/changelog/architecture-v2-' + mo.key + '.html' };
        })},
        { heading: 'Legacy', items: [
          { key: 'v1', label: '📐 Architecture v1 (record)', href: '/changelog/architecture.html' }
        ]}
      ]
    });
  }

  window.GFG_ARCH_NAV = { render: render, activeKey: activeKey, pageFile: pageFile };
})();
