// api/delegate.mjs
// Vercel serverless function: app-sponsored initialize + delegate for gfg-dice.
// Requires the env var GFG_SPONSOR_KEYPAIR (solana CLI keypair format, JSON
// array of 64 ints) set in the Vercel project settings.

import { handleDelegate } from '../scripts/delegate-relay.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  let body = {};
  try {
    body = JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ error: 'invalid JSON body' });
    return;
  }
  try {
    if (!body.player) throw new Error('missing "player" pubkey');
    const result = await handleDelegate(body.player);
    res.status(200).json(result);
  } catch (e) {
    console.error('relay error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
