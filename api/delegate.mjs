// api/delegate.mjs
// Vercel serverless function: app-sponsored initialize + delegate for gfg-dice.
// Requires the env var GFG_Gasless_Sponsor_Keypair (solana CLI keypair format, JSON
// array of 64 ints) set in the Vercel project settings.

import { handleDelegate } from '../scripts/delegate-relay.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  // Vercel auto-parses JSON request bodies into an object; local relay sends
  // a raw string. Accept either so the client's application/json fetch works.
  let body = {};
  try {
    body = typeof req.body === 'string' && req.body.length
      ? JSON.parse(req.body)
      : (req.body || {});
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
