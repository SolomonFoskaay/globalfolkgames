// scripts/dev-tunnel.mjs
// Mobile dev testing: relay + Vite + a free Cloudflare HTTPS tunnel.
// `npm run dev:tunnel`
//
// WHY: a phone can't fully sign in against plain http://<LAN-IP>:3000 because
// WebCrypto (crypto.subtle) only exists on HTTPS or localhost. The tunnel gives
// a real https://<random>.trycloudflare.com URL that Dynamic's wallet login can
// use. 99% of users are mobile, so test on the phone before committing.
//
// The tunnel URL changes every run. Add it (or the wildcard https://*.trycloudflare.com)
// to Dynamic's allowed CORS origins once, then Dynamic login works on any run.
//
// Usage: npm run dev:tunnel

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const node = process.execPath;
const cloudflared = process.env.GFG_CLOUDFLARED || 'cloudflared';

const relay = spawn(node, ['scripts/relay-server.mjs'], { cwd: root, stdio: 'inherit' });
const vite = spawn(node, ['node_modules/vite/bin/vite.js', '--host'], { cwd: root, stdio: 'inherit' });

// Give Vite a moment to bind :3000 before opening the tunnel to it.
setTimeout(() => {
  const tunnel = spawn(cloudflared, ['tunnel', '--url', 'http://localhost:3000'], { cwd: root, stdio: 'inherit' });
  tunnel.on('exit', (code) => {
    console.log(`[dev:tunnel] cloudflared exited (${code}) — stopping relay + vite`);
    shutdown('SIGTERM');
  });
}, 1500);

function shutdown(signal) {
  console.log(`\n[dev:tunnel] ${signal} received — stopping relay + vite`);
  relay.kill('SIGTERM');
  vite.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
