// src/gfg-dice-config.js
// One-off deployment config for the gfg-dice MagicBlock VRF program.
// Filled in AFTER `anchor build && anchor deploy` (see programs/gfg-dice/README.md)
// by copying the program ID and the generated IDL from target/idl/gfg_dice.json.

export const GFG_DICE = {
  programId: null, // e.g. 'GFGxxxx...'  (awaiting deployment)
  idl: null,       // await anchor build → target/idl/gfg_dice.json
  rpcUrl: 'https://api.devnet.solana.com',
  oracleQueue: 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh', // devnet base-layer VRF queue
};