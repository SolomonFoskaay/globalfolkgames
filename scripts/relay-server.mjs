// scripts/relay-server.mjs
// Local dev relay: `npm run relay` -> http://localhost:8787
//   POST /api/delegate   app-sponsored initialize + delegate for gfg-dice
//   POST /api/roll       server-side house VRF roll for computer turns
//   POST /api/comp       S2 competition lifecycle (create/fund/close/settle)
//   POST /api/comp/claim winner claims their allocation (gasless ER)
//   GET  /api/comp       current competition state
//   GET  /api/endpoints  admin dashboard health probe (see endpoints-probe.mjs)
// The Vite dev server proxies /api to this port (see vite.config.js).

import { createServer } from 'http';
import { Keypair } from '@solana/web3.js';
import { handleDelegate, handleMigratePoints } from './delegate-relay.mjs';
import { runProbe } from './endpoints-probe.mjs';
import { handleHouseRoll } from './roll-relay.mjs';
import { createComp, fundComp, closeComp, settleComp, claimComp, fetchCompState } from './comp-relay.mjs';

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
  if (req.method === 'GET' && req.url === '/api/comp') {
    try {
      const { compPda, compPda: _c } = await import('./comp-relay.mjs').then(async m => {
        const { loadSponsor } = await import('./delegate-relay.mjs');
        const sponsor = loadSponsor();
        return { compPda: m.compPda(sponsor.publicKey.toBase58()).toString() };
      });
      const state = await fetchCompState(compPda);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ compPda, state }));
    } catch (e) {
      console.error('comp state error:', e.message);
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
      const { player, gameTag } = JSON.parse(body || '{}');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleDelegate(player, gameTag);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('relay error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/migrate-points') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { player, gameTag } = JSON.parse(body || '{}');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleMigratePoints(player, gameTag);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('migrate error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/comp') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { action, amount, entryFee, endsAt, winners, amounts } = JSON.parse(body || '{}');
      let result;
      if (action === 'create') result = await createComp({ entryFee: entryFee || 0, endsAt });
      else if (action === 'fund') result = await fundComp(Number(amount));
      else if (action === 'close') result = await closeComp();
      else if (action === 'settle') result = await settleComp(winners, amounts);
      else throw new Error('unknown action (create|fund|close|settle)');
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('comp error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/comp/claim') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { compPda, winnerIndex, winnerSecret } = JSON.parse(body || '{}');
      if (!compPda || winnerIndex == null || !winnerSecret) throw new Error('missing compPda/winnerIndex/winnerSecret');
      const winnerKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(winnerSecret)));
      const result = await claimComp(compPda, Number(winnerIndex), winnerKeypair);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('comp claim error:', e.message);
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
