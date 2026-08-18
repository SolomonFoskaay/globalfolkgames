// src/gfg-dice-config.js
// One-off deployment config for the gfg-dice MagicBlock VRF program.
// baseRpcUrl is resolved via src/gfg-rpc.js (provider key env override with
// keyless failover) — see THAT file for the endpoint priority order.
// programId + idl filled in AFTER `anchor build && anchor deploy`
// (see programs/README.md for the deploy steps).
//
// GASLESS setup (Ephemeral Rollup):
//   - erRpcUrl     : MagicBlock ER devnet RPC (US region) — rolls run here, free.
//   - erValidator  : the devnet ER validator the player PDA is delegated to.
//   - oracleQueue  : devnet ER VRF queue (free VRF). Base-layer queue is
//                    Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh.
//   - relayUrl     : app-sponsored initialize+delegate (scripts/relay-server.mjs
//                    in dev, api/delegate.mjs on Vercel). Players hold no SOL.

import idl from './gfg-dice-idl.json';
import { baseRpcUrl, pickErRpcUrl } from './gfg-rpc.js';

export const GFG_DICE = {
  programId: 'CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ',
  idl,
  baseRpcUrl: baseRpcUrl(),
  erRpcUrl: pickErRpcUrl(), // current best ER region; rotation handled in gfg-rpc.js
  erValidator: 'MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd',
  oracleQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc', // devnet ER VRF queue
  relayUrl: '/api/delegate',
};
