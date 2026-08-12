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
        'changelog-admin': './changelog/admin.html'
      }
    }
  },
  server: {
    port: 3000,
    proxy: {
      // App-sponsored delegation relay (scripts/relay-server.mjs)
      '/api': 'http://localhost:8787'
    }
  }
});
