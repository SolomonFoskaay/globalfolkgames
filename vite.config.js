import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        ludo: './games/ludo/index.html',
        'ludo-lab': './games/ludo-lab/index.html',
        changelog: './changelog/index.html',
        'changelog-admin': './changelog/admin.html',
        'changelog-economics': './changelog/economics.html',
        'changelog-architecture': './changelog/architecture.html',
        'changelog-architecture-m1': './changelog/architecture-m1.html',
        'changelog-architecture-m2': './changelog/architecture-m2.html',
        'changelog-architecture-m3': './changelog/architecture-m3.html',
        'changelog-architecture-m4': './changelog/architecture-m4.html',
        'changelog-architecture-m5': './changelog/architecture-m5.html',
        'changelog-architecture-m6': './changelog/architecture-m6.html',
        'changelog-architecture-m7': './changelog/architecture-m7.html',
        'changelog-architecture-m8': './changelog/architecture-m8.html',
        'changelog-architecture-m9': './changelog/architecture-m9.html',
        competitions: './competitions/index.html',
        about: './about/index.html',
        contact: './contact/index.html',
        support: './support/index.html',
        forum: './forum/index.html',
        profile: './profile/index.html',
        'profile-points': './profile/points.html',
        'profile-ledger': './profile/ledger.html',
        'profile-activity': './profile/activity.html',
        dashboard: './dashboard/index.html',
        'dashboard-ops': './dashboard/ops.html',
        'dashboard-endpoints': './dashboard/endpoints.html',
        'dashboard-activity': './dashboard/activity.html',
        'dashboard-accounts': './dashboard/accounts.html',
        'dashboard-release': './dashboard/release.html',
        'dashboard-recovery': './dashboard/recovery.html',
        'dashboard-content-guide': './dashboard/content-style-guide.html',
        'points-check': './points-check/index.html',
        verify: './verify/index.html'
      }
    }
  },
  server: {
    port: 3000,
    // Dev-only: allow LAN IPs and random tunnel domains (trycloudflare.com)
    // to reach Vite without its host check rejecting them.
    allowedHosts: true,
    proxy: {
      // App-sponsored delegation relay (scripts/relay-server.mjs)
      '/api': 'http://localhost:8787'
    }
  }
});
