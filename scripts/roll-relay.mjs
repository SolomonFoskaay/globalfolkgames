// scripts/roll-relay.mjs
// Server-side "house" dice rolls for the Ludo COMPUTER seats, on the
// MagicBlock Ephemeral Rollup VRF queue (gasless, fast).
//
// Why a server-side house key:
//   - Computer turns must be as provably fair as the human's, but a computer
//     has no wallet/session key to sign a transaction.
//   - The house key (the app-owned sponsor wallet) is sponsored once: its
//     dice PDA is initialize+delegate'd through the existing relay flow,
//     then every computer roll runs FREE on the ER VRF queue.
//   - The key never leaves the server, so players cannot roll for the house.
//
// Concurrency: the house dice account stores only its LAST roll. Shape all
// computer rolls through a simple promise queue so two game tabs never hit
// the same PDA at once and race each other's callback.
//
// Env: reuses GFG_Gasless_Sponsor_Keypair (or ~/.config/solana/id.json), exactly like
// the delegate relay. No new secrets.

import { readFileSync } from 'fs';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import './load-env.mjs';
import { createConnection } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const PLAYER_SEED = Buffer.from('gfgplayerd');
const ER_RPC = 'https://devnet-us.magicblock.app/';
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc'); // devnet ER VRF queue (free)
const ER_PICKUP_WAIT_MS = 10000;
const CALLBACK_WAIT_MS = 25000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Rotating seed so two consecutive rolls never reuse the same clientSeed
// (a repeated seed can confuse the VRF callback check).
let seedCounter = Math.floor(Math.random() * 200);

// Delegation is expensive to re-check on every roll (2-4 RPC round trips).
// Cache "delegated + picked up" state for a short TTL: warm rolls then go
// straight to the gasless ER roll. Any failure resets the cache. On Vercel
// the instance may be cold per invocation, so the cache mostly helps the
// local relay (and warm serverless instances).
const DELEGATION_TTL_MS = 4 * 60 * 1000;
let lastEnsuredAt = 0;
let lastRollSucceeded = false;

// Single-flight queue: serializes all house rolls in this process.
let rollQueue = Promise.resolve();

// Public entry: queue + run one gasless ER VRF roll for the house.
export function handleHouseRoll() {
  const run = rollQueue.catch(() => {}).then(() => houseRollOnce());
  rollQueue = run.catch(() => {});
  return run;
}

async function houseRollOnce() {
  const sponsor = loadSponsor();
  const housePubkey = sponsor.publicKey;
  const [pda] = PublicKey.findProgramAddressSync([PLAYER_SEED, housePubkey.toBytes()], PROGRAM_ID);

  // 1) Ensure the house dice account exists and is delegated (idempotent;
  //    the sponsor pays the one-time init+delegate cost, ~0.0013 SOL).
  //    Skip the re-check when we recently succeeded (warm roll).
  const warm = Date.now() - lastEnsuredAt < DELEGATION_TTL_MS && lastRollSucceeded;
  if (!warm) await handleDelegate(housePubkey.toBase58());

  // 2) Wait until the ER validator has picked the account up.
  const erConn = createConnection(ER_RPC, 'confirmed');
  if (!warm) {
    const pickupDeadline = Date.now() + ER_PICKUP_WAIT_MS;
    let pickedUp = false;
    while (Date.now() < pickupDeadline) {
      try {
        const info = await erConn.getAccountInfo(pda);
        if (info && info.owner.toBase58() === PROGRAM_ID.toBase58() && info.data.length > 0) {
          pickedUp = true;
          break;
        }
      } catch (e) { /* ER not ready yet; keep polling */ }
      await sleep(400);
    }
    if (!pickedUp) throw new Error('House dice account never picked up by the ER validator');
  }

  // 3) Gasless rollDice on the ER, signed by the house key.
  const walletAdapter = {
    publicKey: housePubkey,
    async signTransaction(t) { t.partialSign(sponsor); return t; },
    async signAllTransactions(ts) { ts.forEach(t => t.partialSign(sponsor)); return ts; },
  };
  const provider = new AnchorProvider(erConn, walletAdapter, { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  seedCounter = (seedCounter + 1) % 256;
  const clientSeed = seedCounter;

  const signature = await program.methods
    .rollDice(clientSeed)
    .accounts({
      player: pda,
      payer: housePubkey,
      playerAuthority: housePubkey,
      oracleQueue: ER_QUEUE,
    })
    .rpc();

  // 4) Wait for the VRF oracle to callback into the program.
  const callbackDeadline = Date.now() + CALLBACK_WAIT_MS;
  while (Date.now() < callbackDeadline) {
    await sleep(500);
    try {
      const account = await program.account.playerDice.fetch(pda);
      if (account.lastClientSeed === clientSeed) {
        lastEnsuredAt = Date.now();
        lastRollSucceeded = true;
        return {
          roll1: Number(account.lastRoll1),
          roll2: Number(account.lastRoll2),
          seed: clientSeed,
          signature,
          pda: pda.toString(),
        };
      }
    } catch (e) { /* not settled yet; keep polling */ }
  }

  lastRollSucceeded = false;
  throw new Error('House VRF roll timed out waiting for the callback');
}

// Allow running a house roll directly for debugging:
//   node scripts/roll-relay.mjs
if (process.argv[1] && process.argv[1].endsWith('roll-relay.mjs')) {
  handleHouseRoll()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}