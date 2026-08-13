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
        changelog: './changelog/index.html',
        'changelog-admin': './changelog/admin.html',
        about: './about/index.html',
        contact: './contact/index.html',
        support: './support/index.html',
        forum: './forum/index.html',
        profile: './profile/index.html',
        dashboard: './dashboard/index.html'
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
