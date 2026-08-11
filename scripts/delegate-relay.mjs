// scripts/delegate-relay.mjs
// App-sponsored onboarding for gfg-dice on Solana devnet.
//
// Players hold NO SOL. On their first dice roll the game calls this relay,
// which runs the two base-layer transactions that need funding:
//   1. initialize : creates the player's dice PDA (rent paid by sponsor)
//   2. delegate   : moves the PDA into a MagicBlock Ephemeral Rollup session
//                   (one-time session cost paid by sponsor)
// After delegation, every roll runs GASLESS on the ER, so no other funding
// is ever needed. This is the "app pays" layer for Web2-native users.
//
// Runs as:
//   - `npm run relay`  (local dev server on :8787, Vite proxies /api -> it)
//   - Vercel serverless function (api/delegate.mjs)
//
// Sponsor key: env GFG_SPONSOR_KEYPAIR (JSON array of 64 ints, solana CLI
// keypair format) or falls back to ~/.config/solana/id.json for local dev.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));

const PROGRAM_ID = new PublicKey(idl.address);
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
// Devnet ER validator this player PDA is pinned to (US region).
const ER_VALIDATOR = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');
const BASE_URL = 'https://api.devnet.solana.com';
const PLAYER_SEED = Buffer.from('gfgplayerd');

export function loadSponsor() {
  if (process.env.GFG_SPONSOR_KEYPAIR) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_SPONSOR_KEYPAIR)));
  }
  const path = join(homedir(), '.config', 'solana', 'id.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); },
  };
}

// Initialize + delegate a player's dice PDA. Idempotent.
// playerPubkey: the player's Solana wallet address (seed basis for the PDA).
// Returns { pda, delegated, steps: [{step, sig}] }.
export async function handleDelegate(playerPubkey) {
  const player = new PublicKey(playerPubkey);
  const sponsor = loadSponsor();
  const conn = new Connection(BASE_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  const [pda] = PublicKey.findProgramAddressSync([PLAYER_SEED, player.toBytes()], PROGRAM_ID);

  // The public devnet RPC intermittently returns null for existing accounts;
  // retry before concluding the PDA is missing.
  let info = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    info = await conn.getAccountInfo(pda);
    if (info) break;
    await new Promise(r => setTimeout(r, 400));
  }
  const delegated = !!info && info.owner.equals(DELEGATION_PROGRAM);
  if (delegated) {
    return { pda: pda.toString(), delegated: true, steps: [] };
  }

  const steps = [];

  // 1) Create the PDA if it does not exist yet.
  if (!info) {
    const sig = await program.methods.initialize()
      .accounts({ player: pda, payer: sponsor.publicKey, playerAuthority: player })
      .rpc();
    steps.push({ step: 'initialize', sig });
  }

  // 2) Delegate the PDA into the ER session (pin our devnet ER validator).
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);

  const sig = await program.methods.delegate()
    .accounts({
      payer: sponsor.publicKey,
      playerAuthority: player,
      player: pda,
      bufferPlayer: buffer,
      delegationRecordPlayer: record,
      delegationMetadataPlayer: metadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
    .rpc()
    .catch(async (err) => {
      // If delegation failed (e.g. the account was already delegated a moment
      // ago), confirm the account really is delegated now and treat it as
      // success. Otherwise rethrow with the on-chain error details.
      await new Promise(r => setTimeout(r, 600));
      const after = await conn.getAccountInfo(pda);
      if (after && after.owner.equals(DELEGATION_PROGRAM)) {
        return { alreadyDelegated: true };
      }
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate failed: ${detail}`);
    });
  if (!sig.alreadyDelegated) steps.push({ step: 'delegate', sig });

  return { pda: pda.toString(), delegated: true, steps };
}
