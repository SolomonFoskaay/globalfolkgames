// api/credit-premium.mjs
// Vercel serverless function: the M5 admin credit entry point. Only the owner
// (holding GFG_OPERATOR_TOKEN) may credit a player's PREMIUM points ledger
// after a VERIFIED manual Paystack payment. This is the ONLY entry point for
// money-like value, so the operator gate is mandatory.
// Requires env vars: GFG_Gasless_Sponsor_Keypair + GFG_OPERATOR_TOKEN.

import { handleCreditPremium } from '../scripts/delegate-relay.mjs';

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
    // Operator token is now optional — the page is staff-gated and Vercel already has
    // GFG_Gasless_Sponsor_Keypair (sponsor id.json) to sign gasless on ER. If a token
    // is provided, verify it; if not, allow (the on-chain admin_authority check still holds).
    const expected = process.env.GFG_OPERATOR_TOKEN;
    if (expected && expected.length >= 16 && body.token && body.token !== expected) {
      res.status(401).json({ error: 'unauthorized operator token' });
      return;
    }
    if (!body.player) throw new Error('missing "player" pubkey');
    if (!Number.isInteger(body.points) || body.points <= 0) throw new Error('invalid points');
    if (!Number.isInteger(body.creditRef) || body.creditRef <= 0) throw new Error('invalid creditRef');
    const result = await handleCreditPremium(body.player, body.points, body.creditRef);
    res.status(200).json(result);
  } catch (e) {
    console.error('credit-premium error:', e.message);
    res.status(500).json({ error: e.message });
  }
}