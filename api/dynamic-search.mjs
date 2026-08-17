// api/dynamic-search.mjs
// Vercel serverless: queries Dynamic Management API for users by email.
// Dynamic is the source of truth (auth provider). No Supabase fallback.
// Requires DYNAMIC_API_TOKEN + DYNAMIC_ENV_ID in Vercel env vars.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email query param required' });

  const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
  const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';

  console.log('[dynamic-search] env check: token=' + (DYNAMIC_API_TOKEN ? 'set (' + DYNAMIC_API_TOKEN.slice(0, 8) + '...)' : 'MISSING') + ' envId=' + (DYNAMIC_ENV_ID || 'MISSING'));

  if (!DYNAMIC_API_TOKEN || !DYNAMIC_ENV_ID) {
    return res.json({
      users: [],
      source: 'unconfigured',
      error: 'Dynamic API not configured. Add DYNAMIC_API_TOKEN and DYNAMIC_ENV_ID to Vercel env vars. Or enter a wallet address directly.',
    });
  }

  try {
    const url = `https://api.dynamic.xyz/v1/quarters/${DYNAMIC_ENV_ID}/users?email=${encodeURIComponent(email)}`;
    console.log('[dynamic-search] GET', url);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${DYNAMIC_API_TOKEN}` },
    });
    console.log('[dynamic-search] response:', resp.status, resp.statusText);
    if (!resp.ok) {
      const body = await resp.text();
      console.error('[dynamic-search] API error:', resp.status, body.slice(0, 300));
      return res.json({ users: [], source: 'dynamic', error: `Dynamic API returned ${resp.status}: ${body.slice(0, 200)}` });
    }
    const data = await resp.json();
    console.log('[dynamic-search] data:', JSON.stringify(data).slice(0, 500));
    const users = (data.users || data || []).map((u) => ({
      id: u.id,
      email: u.email,
      wallet: u.wallet?.public_key || u.wallet?.address || null,
      walletChain: u.wallet?.chain || null,
      createdAt: u.created_at,
      source: 'dynamic',
    }));
    return res.json({ users, source: 'dynamic' });
  } catch (e) {
    console.error('[dynamic-search] fetch error:', e.message, e.cause || '');
    return res.json({ users: [], source: 'dynamic', error: e.message + (e.cause ? ' (' + e.cause + ')' : '') });
  }
}
