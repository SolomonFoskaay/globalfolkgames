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
import './load-env.mjs';

const PORT = process.env.RELAY_PORT || 8787;

async function handleDynamicSearch(email) {
  const DYNAMIC_API_KEY = process.env.DYNAMIC_API_KEY || '';
  const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';

  // Try Dynamic Management API first
  if (DYNAMIC_API_KEY && DYNAMIC_ENV_ID) {
    try {
      const url = `https://api.dynamic.xyz/v1/quarters/${DYNAMIC_ENV_ID}/users?email=${encodeURIComponent(email)}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${DYNAMIC_API_KEY}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        const users = (data.users || data || []).map((u) => ({
          id: u.id,
          email: u.email,
          wallet: u.wallet?.public_key || u.wallet?.address || null,
          walletChain: u.wallet?.chain || null,
          createdAt: u.created_at,
          source: 'dynamic',
        }));
        return { users, source: 'dynamic' };
      }
    } catch (e) {
      console.warn('[dynamic-search] Dynamic API error, falling back to Supabase:', e.message);
    }
  }

  // Fallback: Supabase profiles table
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supa = createClient(SUPABASE_URL, SUPABASE_KEY);
      const { data, error } = await supa
        .from('profiles')
        .select('id, email, solana_wallet, created_at')
        .ilike('email', email)
        .limit(10);
      if (!error && data) {
        const users = data.map((r) => ({
          id: r.id,
          email: r.email,
          wallet: r.solana_wallet || null,
          walletChain: 'solana',
          createdAt: r.created_at,
          source: 'supabase',
        }));
        return { users, source: 'supabase' };
      }
    } catch (e) {
      console.warn('[dynamic-search] Supabase error:', e.message);
    }
  }

  return { users: [], source: 'none', note: 'No Dynamic API key or Supabase configured' };
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
  const programId2 = new PubKey3(idl2.metadata.address);
  const playerPub2 = new PubKey3(wallet);
  const POINTS_SEED2 = Buffer.from('gfgpoints', 'utf8');
  const GLOBAL_SEED2 = Buffer.from('global', 'utf8');
  const ER_URL2 = 'https://devnet-us.magicblock.app/';
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
    new BN3(gap2), 0, 1, new BN3(Date.now()),
  ).accounts({
    globalPoints: m4Pda2, payer: sponsor2.publicKey, playerAuthority: playerPub2,
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
