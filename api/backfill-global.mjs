// api/backfill-global.mjs
// Vercel serverless: backfills orphaned M3 points into M4 global ledger.
// Security: reads the gap amount from on-chain M3, never accepts manual input.
// Uses the sponsor key to call record_global_points on the ER.

import { readFileSync } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';

const ER_URL = 'https://devnet-us.magicblock.app/';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { wallet, sourceTag, matchRef } = req.body;
    if (!wallet || !sourceTag || !matchRef) throw new Error('missing wallet/sourceTag/matchRef');

    // Re-derive the gap from on-chain M3 (never trust client-provided amounts)
    const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
    const programId = new PublicKey(idl.metadata.address);
    const playerPub = new PublicKey(wallet);
    const POINTS_SEED = Buffer.from('gfgpoints', 'utf8');

    const erConn = new Connection(ER_URL, 'confirmed');
    const baseConn = new Connection('https://api.devnet.solana.com', 'confirmed');

    // Read M3 local pure
    const m3Pda = PublicKey.findProgramAddressSync(
        [POINTS_SEED, Buffer.from(sourceTag, 'utf8'), playerPub.toBytes()], programId,
    )[0];
    let m3Info = await erConn.getAccountInfo(m3Pda).catch(() => null);
    if (!m3Info) m3Info = await baseConn.getAccountInfo(m3Pda);
    if (!m3Info) return res.json({ ok: false, error: 'No M3 points found for this game' });
    const m3Pure = Number(m3Info.data.readBigUInt64LE(8));

    // Read M4 global pure
    const GLOBAL_SEED = Buffer.from('global', 'utf8');
    const m4Pda = PublicKey.findProgramAddressSync(
        [POINTS_SEED, GLOBAL_SEED, playerPub.toBytes()], programId,
    )[0];
    let m4Info = await erConn.getAccountInfo(m4Pda).catch(() => null);
    if (!m4Info) m4Info = await baseConn.getAccountInfo(m4Pda);
    const m4Pure = m4Info ? Number(m4Info.data.readBigUInt64LE(2)) : 0;

    const gap = m3Pure - m4Pure;
    if (gap <= 0) return res.json({ ok: false, error: 'No orphaned points (M3=' + m3Pure + ', M4=' + m4Pure + ')' });

    // Import sponsor key and call record_global_points
    const { loadSponsor, mkWallet } = await import('../scripts/delegate-relay.mjs');
    const sponsor = loadSponsor();
    const provider = new AnchorProvider(erConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
    const program = new Program(idl, provider);

    const tx = await program.methods.recordGlobalPoints(
        new BN(gap), 0, 1, new BN(Date.now()),
    ).accounts({
        globalPoints: m4Pda, payer: sponsor.publicKey, playerAuthority: playerPub,
    }).transaction();

    tx.feePayer = sponsor.publicKey;
    const { sendMagicTx } = await import('../src/gfg-rpc.js');
    const sig = await sendMagicTx(erConn, tx, [sponsor], { skipPreflight: true });
    await erConn.confirmTransaction({ signature: sig }, 'confirmed');

    return res.json({ ok: true, signature: sig, gap, m3Pure, m4PureBefore: m4Pure });
  } catch (e) {
    console.error('[backfill-global] error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
