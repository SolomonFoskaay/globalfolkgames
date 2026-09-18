// src/chain/arc.js — the Arc rail (arcv2m16). Phase 0 STUB.
//
// Nothing is wired yet, so every call throws a clear error instead of silently
// doing the wrong thing. Phase 1 replaces these stubs with the real Arc
// implementation (relayer, contracts in evm/, batched randomness).
const NOT_YET = 'Arc rail is not wired yet (arcv2m16 Phase 2)';

// PUBLIC config (addresses + endpoints only, never secrets). The addresses live
// in /arc-config.json so they can be read by any browser without touching the
// server env, which is reserved for secrets.
export async function arcPublicConfig() {
  const res = await fetch('/arc-config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('arc-config.json ' + res.status);
  return res.json();
}

export const arcAdapter = {
  name: 'arc',
  isReady() { return false; },
  walletAddress() {
    try { return (window.getDynamicEvmWallet && window.getDynamicEvmWallet()) || null; } catch (e) { return null; }
  },
  fetchLedger() { throw new Error(NOT_YET); },
  recordPoints() { throw new Error(NOT_YET); },
};
