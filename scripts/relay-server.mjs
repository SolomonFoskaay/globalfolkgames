// scripts/relay-server.mjs
// Local dev relay: `npm run relay` -> http://localhost:8787
//   POST /api/delegate   app-sponsored initialize + delegate for gfg-dice
//   POST /api/roll       server-side house VRF roll for computer turns
//   POST /api/comp       S2 competition lifecycle (create/fund/close/settle)
//   POST /api/comp/claim winner claims their allocation (gasless ER)
//   GET  /api/comp       current competition state
//   GET  /api/endpoints  admin dashboard health probe (see endpoints-probe.mjs)
//   GET  /api/dynamic-search?email=... user lookup via Dynamic API (or Supabase fallback)
//   POST /api/backfill-global  backfill orphaned M3 points into M4 (auto-reads gap from chain)
// The Vite dev server proxies /api to this port (see vite.config.js).

import { createServer } from 'http';
import { Keypair } from '@solana/web3.js';
import { handleDelegate, handleMigratePoints } from './delegate-relay.mjs';
import { runProbe } from './endpoints-probe.mjs';
import { handleHouseRoll } from './roll-relay.mjs';
import { createComp, fundComp, closeComp, settleComp, claimComp, fetchCompState } from './comp-relay.mjs';
import { pickErRpcUrl } from '../src/gfg-rpc.js';
import './load-env.mjs';

const PORT = process.env.RELAY_PORT || 8787;

async function handleDynamicSearch(email) {
  const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
  const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';

  console.log('[dynamic-search] env check: token=' + (DYNAMIC_API_TOKEN ? 'set (' + DYNAMIC_API_TOKEN.slice(0, 8) + '...)' : 'MISSING') + ' envId=' + (DYNAMIC_ENV_ID || 'MISSING'));

  if (!DYNAMIC_API_TOKEN || !DYNAMIC_ENV_ID) {
    return {
      users: [],
      source: 'unconfigured',
      error: 'Dynamic API not configured. Add DYNAMIC_API_TOKEN and DYNAMIC_ENV_ID to env. Or enter a wallet address directly.',
    };
  }

  try {
    const filter = JSON.stringify({ filterColumn: 'email', filterValue: email });
    const url = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV_ID}/users?filter=${encodeURIComponent(filter)}&limit=5`;
    console.log('[dynamic-search] GET', url);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${DYNAMIC_API_TOKEN}` },
    });
    console.log('[dynamic-search] response:', resp.status, resp.statusText);
    if (!resp.ok) {
      const body = await resp.text();
      console.error('[dynamic-search] API error:', resp.status, body.slice(0, 300));
      return { users: [], source: 'dynamic', error: `Dynamic API ${resp.status}: ${body.slice(0, 200)}` };
    }
    const data = await resp.json();
    console.log('[dynamic-search] count:', data.count, 'users:', data.users?.length);
    const users = (data.users || []).map((u) => {
      let wallet = null;
      let walletChain = null;
      if (u.verifiedCredentials && Array.isArray(u.verifiedCredentials)) {
        const solCred = u.verifiedCredentials.find(c => c.chain === 'SOL' || c.format === 'blockchain');
        if (solCred) { wallet = solCred.address; walletChain = solCred.chain || 'SOL'; }
      }
      if (!wallet && u.wallets && Array.isArray(u.wallets)) {
        const solWallet = u.wallets.find(w => w.chain === 'SOL');
        if (solWallet) { wallet = solWallet.publicKey; walletChain = solWallet.chain; }
      }
      if (!wallet && u.walletPublicKey) wallet = u.walletPublicKey;
      return { id: u.id, email: u.email, wallet, walletChain, createdAt: u.createdAt || u.created_at, source: 'dynamic' };
    });
    return { users, source: 'dynamic' };
  } catch (e) {
    console.error('[dynamic-search] error:', e.message, e.cause || '');
    return { users: [], source: 'dynamic', error: e.message + (e.cause ? ' (' + e.cause + ')' : '') };
  }
}

async function handleBackfillGlobal({ wallet, sourceTag, matchRef }) {
  const { Connection: Conn3, PublicKey: PubKey3 } = await import('@solana/web3.js');
  const { AnchorProvider: AP3, Program: Prog3 } = await import('@anchor-lang/core');
  const { BN: BN3 } = await import('bn.js');
  const { loadSponsor: loadS, mkWallet: mkW } = await import('./delegate-relay.mjs');
  const { sendMagicTx: sendTx } = await import('../src/gfg-rpc.js');
  const { readFileSync: rfs } = await import('fs');

  if (!wallet || !sourceTag || !matchRef) throw new Error('missing wallet/sourceTag/matchRef');

  const idl2 = JSON.parse(rfs(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
  const programId2 = new PubKey3(idl2.address || idl2.metadata?.address);
  const playerPub2 = new PubKey3(wallet);
  const POINTS_SEED2 = Buffer.from('gfgpoints', 'utf8');
  const GLOBAL_SEED2 = Buffer.from('global', 'utf8');
  const ER_URL2 = pickErRpcUrl();
  const erConn2 = new Conn3(ER_URL2, 'confirmed');

  // Re-derive gap from chain
  const m3Pda2 = PubKey3.findProgramAddressSync(
    [POINTS_SEED2, Buffer.from(sourceTag, 'utf8'), playerPub2.toBytes()], programId2,
  )[0];
  let m3Info2 = await erConn2.getAccountInfo(m3Pda2).catch(() => null);
  if (!m3Info2) {
    const baseConn2 = new Conn3('https://api.devnet.solana.com', 'confirmed');
    m3Info2 = await baseConn2.getAccountInfo(m3Pda2);
  }
  if (!m3Info2) throw new Error('No M3 points found for this game');
  const m3Pure2 = Number(m3Info2.data.readBigUInt64LE(8));

  const m4Pda2 = PubKey3.findProgramAddressSync(
    [POINTS_SEED2, GLOBAL_SEED2, playerPub2.toBytes()], programId2,
  )[0];
  let m4Info2 = await erConn2.getAccountInfo(m4Pda2).catch(() => null);
  if (!m4Info2) {
    const baseConn2b = new Conn3('https://api.devnet.solana.com', 'confirmed');
    m4Info2 = await baseConn2b.getAccountInfo(m4Pda2);
  }
  const m4Pure2 = m4Info2 ? Number(m4Info2.data.readBigUInt64LE(2)) : 0;
  const gap2 = m3Pure2 - m4Pure2;
  if (gap2 <= 0) return { ok: false, error: 'No orphaned points (M3=' + m3Pure2 + ', M4=' + m4Pure2 + ')' };

  // Execute backfill
  const sponsor2 = loadS();
  const provider2 = new AP3(erConn2, mkW(sponsor2), { commitment: 'confirmed', skipPreflight: true });
  const program2 = new Prog3(idl2, provider2);
  const tx2 = await program2.methods.recordGlobalPoints(
    0, sourceTag, new BN3(gap2), 1, new BN3(Date.now()),
  ).accounts({
    payer: sponsor2.publicKey, playerAuthority: playerPub2, globalPoints: m4Pda2,
  }).transaction();
  tx2.feePayer = sponsor2.publicKey;
  const sig2 = await sendTx(erConn2, tx2, [sponsor2], { skipPreflight: true });
  await erConn2.confirmTransaction({ signature: sig2 }, 'confirmed');
  return { ok: true, signature: sig2, gap: gap2, m3Pure: m3Pure2, m4PureBefore: m4Pure2 };
}

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
  if (req.method === 'GET' && req.url.startsWith('/api/dynamic-search')) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      if (!email) throw new Error('email query param required');
      const result = await handleDynamicSearch(email);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('dynamic-search error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/backfill-global') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await handleBackfillGlobal(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('backfill-global error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
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
