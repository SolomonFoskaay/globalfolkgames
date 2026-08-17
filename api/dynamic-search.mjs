// api/dynamic-search.mjs
// Vercel serverless: queries Dynamic Management API for users by email.
// Falls back to Supabase profiles if Dynamic API key is not configured.
// Keeps all secrets server-side (never bundled to client).

import { createClient } from '@supabase/supabase-js';

const DYNAMIC_API_KEY = process.env.DYNAMIC_API_KEY || '';
const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email query param required' });

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
        return res.json({ users, source: 'dynamic' });
      }
    } catch (e) {
      console.warn('[dynamic-search] Dynamic API error, falling back to Supabase:', e.message);
    }
  }

  // Fallback: Supabase profiles table
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
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
        return res.json({ users, source: 'supabase' });
      }
    } catch (e) {
      console.warn('[dynamic-search] Supabase error:', e.message);
    }
  }

  return res.json({ users: [], source: 'none', note: 'No Dynamic API key or Supabase configured' });
}
