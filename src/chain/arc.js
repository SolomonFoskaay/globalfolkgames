// src/chain/arc.js — the Arc rail (arcv2m16). Phase 0 STUB.
//
// Nothing is wired yet, so every call throws a clear error instead of silently
// doing the wrong thing. Phase 1 replaces these stubs with the real Arc
// implementation (relayer, contracts in evm/, batched randomness).
const NOT_YET = 'Arc rail is not wired yet (arcv2m16 Phase 1)';

export const arcAdapter = {
  name: 'arc',
  isReady() { return false; },
  walletAddress() {
    try { return (window.getDynamicEvmWallet && window.getDynamicEvmWallet()) || null; } catch (e) { return null; }
  },
  fetchLedger() { throw new Error(NOT_YET); },
  recordPoints() { throw new Error(NOT_YET); },
};
