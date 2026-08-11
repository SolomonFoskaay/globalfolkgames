// src/gfg-dice-config.js
// One-off deployment config for the gfg-dice MagicBlock VRF program.
// programId + idl filled in AFTER `anchor build && anchor deploy`
// (see programs/README.md for the deploy steps).

import idl from './gfg-dice-idl.json';

export const GFG_DICE = {
  programId: 'CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ',
  idl,
  rpcUrl: 'https://api.devnet.solana.com',
  oracleQueue: 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh', // devnet base-layer VRF queue
};
