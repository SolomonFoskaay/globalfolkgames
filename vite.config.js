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
        'profile-activity': './profile/activity.html',
        'subscription-paid': './subscription-paid/index.html',
        dashboard: './dashboard/index.html',
        'dashboard-ops': './dashboard/ops.html',
        'dashboard-endpoints': './dashboard/endpoints.html',
        'dashboard-activity': './dashboard/activity.html',
        'dashboard-accounts': './dashboard/accounts.html',
        'dashboard-release': './dashboard/release.html',
        'dashboard-recovery': './dashboard/recovery.html',
        'dashboard-premium': './dashboard/premium.html',
        'dashboard-content-guide': './dashboard/content-style-guide.html',
        verify: './verify/index.html',
        // The header loader (public/global_header.js) injects the Dynamic
        // bootstrap module at runtime as /src/main.js (and /src/main-lab.js for
        // ludo-lab). Keep them as build inputs so they exist in dist under
        // those stable paths (see entryFileNames below). Before this, pages
        // referenced them with <script type="module"> tags, which is how Vite
        // bundled them; with the loader every page is header-script-free, so
        // the modules must be emitted explicitly.
        'src/main.js': './src/main.js',
        'src/main-lab.js': './src/main-lab.js'
      },
      output: {
        // Emit the runtime-injected modules under their stable root paths.
        entryFileNames: (chunk) => {
          if (chunk.name === 'src/main.js') return 'src/main.js';
          if (chunk.name === 'src/main-lab.js') return 'src/main-lab.js';
          return 'assets/[name]-[hash].js';
        }
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
