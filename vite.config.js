import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        ludo: 'games/ludo/index.html'
      }
    }
  },
  server: {
    port: 3000
  }
});
