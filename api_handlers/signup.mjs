// api/signup.mjs
// Vercel serverless: claim the M6 signup bonus (500P, kind=1, source signup_bonus)
// for a wallet. Idempotent by a stable matchRef derived from the wallet, so the
// program's duplicate guard prevents double-credit even on retries.

import { handleSignupBonus } from '../scripts/affiliate-relay.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
    if (!body.wallet) throw new Error('missing wallet');
    const result = await handleSignupBonus(body.wallet);
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('signup error:', e.message);
    res.status(500).json({ error: e.message });
  }
}