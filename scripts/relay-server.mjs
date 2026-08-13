// scripts/relay-server.mjs
// Local dev relay: `npm run relay` -> http://localhost:8787
//   POST /api/delegate   app-sponsored initialize + delegate for gfg-dice
//   POST /api/roll       server-side house VRF roll for computer turns
//   GET  /api/endpoints  admin dashboard health probe (see endpoints-probe.mjs)
// The Vite dev server proxies /api to this port (see vite.config.js).

import { createServer } from 'http';
import { handleDelegate } from './delegate-relay.mjs';
import { runProbe } from './endpoints-probe.mjs';
import { handleHouseRoll } from './roll-relay.mjs';

const PORT = process.env.RELAY_PORT || 8787;

const server = createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/api/endpoints') {
    try {
      const result = await runProbe();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('endpoints probe error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/roll') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await handleHouseRoll();
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('roll error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/delegate') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { player } = JSON.parse(body || '{}');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleDelegate(player);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('relay error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(404, cors);
  res.end();
});

server.listen(PORT, () => console.log(`[relay] sponsor relay listening on http://localhost:${PORT}`));

// A port conflict (EADDRINUSE, e.g. a stale relay from an earlier dev exit)
// must not become an unhandled 'error' that crashes Node with a stack dump.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[relay] port ${PORT} already in use (stale relay? kill it and rerun).`);
  } else {
    console.error(`[relay] server error:`, err.message);
  }
});
