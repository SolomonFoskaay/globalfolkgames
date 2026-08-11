// src/main.js
import './dynamic-auth.js';
import './magicblock-vrf.js';
import { initMagicBlockDice } from './magicblock-vrf.js';
import { GFG_DICE } from './gfg-dice-config.js';

// Expose the dice module on window (requires the Dynamic client to be ready).
initMagicBlockDice();

// Activate provably-fair dice only when the gfg-dice program is deployed.
if (GFG_DICE.programId && GFG_DICE.idl && window.magicblockDice) {
  window.magicblockDice.configure(GFG_DICE);
  console.log('[VRF] MagicBlock VRF dice configured:', GFG_DICE.programId);
} else {
  console.log('[VRF] gfg-dice not configured yet — Ludo will use local rolls');
}

console.log('Vite + Dynamic auth layer loaded');