// scripts/relay-server.mjs
// Local dev relay: `npm run relay` -> http://localhost:8787/api/delegate
// The Vite dev server proxies /api to this port (see vite.config.js).

import { createServer } from 'http';
import { handleDelegate } from './delegate-relay.mjs';

const PORT = process.env.RELAY_PORT || 8787;

const server = createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
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
