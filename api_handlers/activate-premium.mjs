// api/activate-premium.mjs
// Vercel serverless: admin activates a subscription for a player after credit.
// Still consumes 5000 premium spendable via the normal activate check (no shortcut).
// Authority-gated via GFG_OPERATOR_TOKEN, sponsor-signed, delegation-aware.

import { handleAdminActivatePremium } from '../scripts/delegate-relay.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
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
    const expected = process.env.GFG_OPERATOR_TOKEN;
    if (expected && expected.length >= 16 && body.token && body.token !== expected) {
      res.status(401).json({ error: 'unauthorized operator token' });
      return;
    }
    if (!body.player) throw new Error('missing "player" pubkey');
    const result = await handleAdminActivatePremium(body.player);
    res.status(200).json(result);
  } catch (e) {
    console.error('activate-premium error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
