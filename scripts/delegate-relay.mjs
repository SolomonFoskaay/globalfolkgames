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
// Sponsor key: env GFG_Gasless_Sponsor_Keypair (JSON array of 64 ints, solana
// CLI keypair format) or falls back to ~/.config/solana/id.json for local dev.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BN } from 'bn.js';
import './load-env.mjs'; // load .env (Alchemy key) before resolving the RPC chain
import { baseRpcUrl, createConnection, sendMagicTx, routerUrl, getDelegationStatus, pickErRpcUrl, erRpcEndpoints, regionUrlForFqdn, ER_REGION_URLS } from '../src/gfg-rpc.js';
import { authorizeSpend, assertSponsorReserve, recordSpend } from './spend-ledger.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));

const PROGRAM_ID = new PublicKey(idl.address);
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
// Devnet ER validator this player PDA is pinned to. Was the US validator
// (MUS3hc9...); flipped 2026-08-18 to the AS validator (MAS1Dt9...) because
// devnet-us.magicblock.app answers "-32005 client temporarily banned" and new
// accounts should land on the healthy AS region. Every gfg component that
// pins a PDA (delegate-relay, comp-relay, lab probes) must agree on this so
// the client's region resolution targets the same region the accounts live on.
const ER_VALIDATOR = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
// Base-layer devnet RPC (Router-first). The gfg-dice client, the sponsor relay
// and the lab harnesses all read their devnet RPC here. See src/gfg-rpc.js for
// the full chain: Magic Router (primary) -> GFG_DEVNET_RPC (Alchemy key) ->
// keyless OnFinality public -> api.devnet.solana.com (last resort).
const BASE_URL = baseRpcUrl();
const PLAYER_SEED = Buffer.from('gfgplayerd');
const POINTS_SEED = Buffer.from('gfgpoints');
const RESULT_SEED = Buffer.from('gfgresult');
const GLOBAL_TAG = Buffer.from('global');
const PREMIUM_SEED = Buffer.from('gfgprem'); // M5 premium points ledger (buy-only)
const LIVES_SEED = Buffer.from('gfglives'); // M10 lives ledger [gfglives, player]

// ER helpers — all post-delegation writes stay gasless on ER (sponsor is payer, user never pays)
// Mirrors src/magicblock-er-vrf.js region-aware targeting, but for sponsor-signed admin writes.
const erConns = new Map();
function erConnFor(url) {
  let c = erConns.get(url);
  if (!c) { c = createConnection(url, 'confirmed', 30000, { backoffMs: [400, 800, 1200, 1800, 2500] }); erConns.set(url, c); }
  return c;
}
async function resolvedRegionUrl(pda, baseConn) {
  try {
    const st = await getDelegationStatus(baseConn, pda);
    if (st && st.isDelegated) {
      const u = regionUrlForFqdn(st.fqdn);
      if (u) return u;
    }
  } catch (e) { /* fallback to rotation */ }
  return null;
}
function erProgramForSponsor(url, sponsor) {
  const conn = erConnFor(url);
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return new Program(idl, provider);
}

// Registered M1A game tags (mirrors is_valid_game_tag in the program). Each
// game owns its per-game points ledger seed [gfgpoints, game_tag, player].
export function isValidGameTag(tag) {
  return ['ludo', 'ayo_olopon', 'ludo_lab', 'ayo_lab', 'sandbox'].includes(tag);
}

// Legacy (pre-game_tag) points PDA derivation: [gfgpoints, player]. Used only
// by the migration so old Scope B devnet points survive the seed change.
export function legacyPointsPdaFor(player) {
  return PublicKey.findProgramAddressSync([POINTS_SEED, player.toBytes()], PROGRAM_ID);
}

export function loadSponsor() {
  if (process.env.GFG_Gasless_Sponsor_Keypair) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_Gasless_Sponsor_Keypair)));
  }
  const path = join(homedir(), '.config', 'solana', 'id.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); },
  };
}

// Estimated sponsor cost of one base-layer step (initialize or delegate):
// rent ~0.0009 SOL + tx fee ~0.0005 SOL + ER session cost. Real onboarding is
// ~0.0013 SOL total, so a per-step estimate of 0.0015 (2x-3x margin) gives
// fresh players 2 x 0.0015 = 0.003 SOL of budget — comfortably under the
// 0.005 SOL default per-player cap, while still leaving abuse headroom tight.
// The realized balance delta is what actually lands in the ledger.
//
// Scope B adds a second PDA per player (points, seed `gfgpoints`), so a fully
// fresh onboarding is 4 steps (dice init+delegate, points init+delegate)
// ≈ 0.003 SOL budget — still under the 0.005 default cap.
//
// Scope C adds a THIRD PDA per player (result, seed `gfgresult`), so a fully
// fresh onboarding is now 6 steps (dice + points + result, init+delegate each)
// ≈ 0.009 SOL budget. The per-player cap default was raised to 0.015 SOL.
const ESTIMATED_STEP_COST_LAMPORTS = 0.0015 * 1e9; // 0.0015 SOL

// Initialize + delegate a player's dice PDA AND their points PDA (Scope B)
// AND their result PDA (Scope C) AND their global points PDA (M4).
// Idempotent for each PDA individually.
// playerPubkey: the player's Solana wallet address (seed basis for all PDAs).
// gameTag: which game's per-game points ledger to onboard (default 'ludo').
// Returns { pda, pointsPda, resultPda, globalPointsPda, gameTag, delegated, steps }.
export async function handleDelegate(playerPubkey, gameTag = 'ludo') {
  if (!isValidGameTag(gameTag)) throw new Error(`invalid game_tag: ${gameTag}`);
  const player = new PublicKey(playerPubkey);
  const sponsor = loadSponsor();
  // Polling confirm: Alchemy's devnet endpoint doesn't implement the
  // signatureSubscribe websocket method, so web3's default confirm would hang
  // even when the tx landed. createConnection polls getSignatureStatuses.
  const conn = createConnection(BASE_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  const [pda] = PublicKey.findProgramAddressSync([PLAYER_SEED, player.toBytes()], PROGRAM_ID);
  const [pointsPda] = PublicKey.findProgramAddressSync([POINTS_SEED, Buffer.from(gameTag, 'utf8'), player.toBytes()], PROGRAM_ID);
  const [resultPda] = PublicKey.findProgramAddressSync([RESULT_SEED, player.toBytes()], PROGRAM_ID);
  const [globalPointsPda] = PublicKey.findProgramAddressSync([POINTS_SEED, GLOBAL_TAG, player.toBytes()], PROGRAM_ID);
  const [premiumPointsPda] = PublicKey.findProgramAddressSync([PREMIUM_SEED, player.toBytes()], PROGRAM_ID);
  const [livesPda] = PublicKey.findProgramAddressSync([LIVES_SEED, player.toBytes()], PROGRAM_ID);

  // Delegation check uses the MAGIC ROUTER's getDelegationStatus, not
  // getAccountInfo.owner: with the Router as the primary RPC, getAccountInfo
  // returns the ER-side view of the account (owner = OUR program, because the
  // ER hosts the account's state), which never equals the delegation program.
  // getDelegationStatus is the authoritative answer and also tells us WHICH
  // region the account lives on.
  const retry = async (fn, n = 4, delay = 400) => {
    for (let i = 0; i < n; i++) {
      try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, delay)); }
    }
    return null;
  };
  const status = await retry(() => getDelegationStatus(conn, pda));
  const pointsStatus = await retry(() => getDelegationStatus(conn, pointsPda));
  const resultStatus = await retry(() => getDelegationStatus(conn, resultPda));
  const globalStatus = await retry(() => getDelegationStatus(conn, globalPointsPda));
  const premiumStatus = await retry(() => getDelegationStatus(conn, premiumPointsPda));
  const livesStatus = await retry(() => getDelegationStatus(conn, livesPda));
  if (status && status.isDelegated && pointsStatus && pointsStatus.isDelegated && resultStatus && resultStatus.isDelegated && globalStatus && globalStatus.isDelegated && premiumStatus && premiumStatus.isDelegated && livesStatus && livesStatus.isDelegated) {
    return { pda: pda.toString(), pointsPda: pointsPda.toString(), resultPda: resultPda.toString(), globalPointsPda: globalPointsPda.toString(), premiumPointsPda: premiumPointsPda.toString(), livesPda: livesPda.toString(), gameTag, delegated: true, steps: [] };
  }

  // Sponsor spend guard: authorize the estimated cost of the steps we are
  // ABOUT to run against the per-player and global caps, and verify the
  // sponsor wallet keeps its reserve after this spend. Throws SpendCapExceeded
  // before any SOL leaves the wallet.
  // Steps per PDA: fresh = initialize + delegate (2); existing = delegate only (1).
  // Scope B adds points, Scope C adds result, M4 adds global, M5 adds premium.
  const plannedSteps =
    (status && status.isDelegated ? 0 : (await retry(() => conn.getAccountInfo(pda)) ? 1 : 2)) +
    (pointsStatus && pointsStatus.isDelegated ? 0 : (await retry(() => conn.getAccountInfo(pointsPda)) ? 1 : 2)) +
    (resultStatus && resultStatus.isDelegated ? 0 : (await retry(() => conn.getAccountInfo(resultPda)) ? 1 : 2)) +
    (globalStatus && globalStatus.isDelegated ? 0 : (await retry(() => conn.getAccountInfo(globalPointsPda)) ? 1 : 2)) +
    (premiumStatus && premiumStatus.isDelegated ? 0 : (await retry(() => conn.getAccountInfo(premiumPointsPda)) ? 1 : 2)) +
    (livesStatus && livesStatus.isDelegated ? 0 : (await retry(() => conn.getAccountInfo(livesPda)) ? 1 : 2));
  const budgetLamports = plannedSteps * ESTIMATED_STEP_COST_LAMPORTS;
  authorizeSpend(player.toBase58(), budgetLamports);
  const sponsorBalance = await retry(() => conn.getBalance(sponsor.publicKey));
  assertSponsorReserve(sponsorBalance ?? 0, budgetLamports);
  const balanceBefore = await retry(() => conn.getBalance(sponsor.publicKey));

  const steps = [];

  // Dice PDA: create if missing, then delegate if not delegated.
  if (!(status && status.isDelegated)) {
    const info = await retry(() => conn.getAccountInfo(pda));
    if (!info) {
      const sig = await sendAndConfirmBase(conn, sponsor,
        await program.methods.initialize()
          .accounts({ player: pda, payer: sponsor.publicKey, playerAuthority: player })
          .transaction()
      );
      steps.push({ step: 'initialize', sig });
    }
    const sig = await delegateDicePda(program, conn, sponsor, player, pda);
    if (sig) steps.push({ step: 'delegate', sig });
  }

  // Points PDA: create if missing, then delegate if not delegated (Scope B).
  if (!(pointsStatus && pointsStatus.isDelegated)) {
    const pinfo = await retry(() => conn.getAccountInfo(pointsPda));
    if (!pinfo) {
      const sig = await sendAndConfirmBase(conn, sponsor,
        await program.methods.initializePoints(gameTag)
          .accounts({ points: pointsPda, payer: sponsor.publicKey, playerAuthority: player })
          .transaction()
      );
      steps.push({ step: 'initialize_points', sig });
    }
    const sig = await delegatePointsPda(program, conn, sponsor, player, pointsPda, gameTag);
    if (sig) steps.push({ step: 'delegate_points', sig });
  }

  // Result PDA: create if missing, then delegate if not delegated (Scope C).
  if (!(resultStatus && resultStatus.isDelegated)) {
    const rinfo = await retry(() => conn.getAccountInfo(resultPda));
    if (!rinfo) {
      const sig = await sendAndConfirmBase(conn, sponsor,
        await program.methods.initializeResult()
          .accounts({ result: resultPda, payer: sponsor.publicKey, playerAuthority: player })
          .transaction()
      );
      steps.push({ step: 'initialize_result', sig });
    }
    const sig = await delegateResultPda(program, conn, sponsor, player, resultPda);
    if (sig) steps.push({ step: 'delegate_result', sig });
  }

  // Global Points PDA: create if missing, then delegate if not delegated (M4).
  if (!(globalStatus && globalStatus.isDelegated)) {
    const ginfo = await retry(() => conn.getAccountInfo(globalPointsPda));
    if (!ginfo) {
      const sig = await sendAndConfirmBase(conn, sponsor,
        await program.methods.initializeGlobalPoints()
          .accounts({ globalPoints: globalPointsPda, payer: sponsor.publicKey, playerAuthority: player })
          .transaction()
      );
      steps.push({ step: 'initialize_global_points', sig });
    }
    const sig = await delegateGlobalPointsPda(program, conn, sponsor, player, globalPointsPda);
    if (sig) steps.push({ step: 'delegate_global_points', sig });
  }

  // Premium Points PDA: create if missing, then delegate if not delegated (M5).
  if (!(premiumStatus && premiumStatus.isDelegated)) {
    const pinfo = await retry(() => conn.getAccountInfo(premiumPointsPda));
    if (!pinfo) {
      const sig = await sendAndConfirmBase(conn, sponsor,
        await program.methods.initializePremiumPoints()
          .accounts({ premiumPoints: premiumPointsPda, payer: sponsor.publicKey, playerAuthority: player })
          .transaction()
      );
      steps.push({ step: 'initialize_premium_points', sig });
    }
    const sig = await delegatePremiumPointsPda(program, conn, sponsor, player, premiumPointsPda);
    if (sig) steps.push({ step: 'delegate_premium_points', sig });
  }

  // Lives PDA (M10): create if missing, then delegate if not delegated. This is
  // BUNDLED into the same first-time onboarding as dice/points/result/global/
  // premium - the sponsor pays ONE one-time base cost per player LIFETIME, and
  // after that every lives write (join/begin/consume_life + the daily pool
  // gates) runs GASLESS on the ER. No per-use cost anywhere. If the account
  // already exists but was never delegated, we only delegate it.
  if (!(livesStatus && livesStatus.isDelegated)) {
    const linfo = await retry(() => conn.getAccountInfo(livesPda));
    if (!linfo) {
      const sig = await sendAndConfirmBase(conn, sponsor,
        await program.methods.initializeLives()
          .accounts({ lives: livesPda, payer: sponsor.publicKey, playerAuthority: player, systemProgram: SystemProgram.programId })
          .transaction()
      );
      steps.push({ step: 'initialize_lives', sig });
    }
    const sig = await delegateLivesPda(program, conn, sponsor, player, livesPda);
    if (sig) steps.push({ step: 'delegate_lives', sig });
  }

  // Record the REAL cost (balance delta), not the estimate, so the ledger
  // reflects actual sponsor spend. Caps were already enforced on the estimate.
  if (steps.length) {
    const balanceAfter = await retry(() => conn.getBalance(sponsor.publicKey));
    const spent = Math.max(0, (balanceBefore ?? balanceAfter) - balanceAfter);
    if (spent > 0) {
      // Category distinguishes player onboarding from the house's own setup
      // (the roll relay delegates the house dice account through this same
      // handler), so the dashboard can show which activity burns the reserve.
      const isHouse = player.equals(sponsor.publicKey);
      recordSpend(player.toBase58(), spent, {
        category: isHouse ? 'house' : 'onboarding',
        steps: steps.length,
      });
      console.log(`[relay] sponsored ${player.toBase58()}: ${(spent / 1e9).toFixed(6)} SOL (+${steps.length} step(s), ${isHouse ? 'house' : 'onboarding'})`);
    }
  }

  return { pda: pda.toString(), pointsPda: pointsPda.toString(), resultPda: resultPda.toString(), globalPointsPda: globalPointsPda.toString(), premiumPointsPda: premiumPointsPda.toString(), gameTag, delegated: true, steps };
}

// M3 data-preservation migration (see .opencode/rules/solana-upgrade-safety.md).
// Runs the on-chain `migrate_points` instruction on the base layer (sponsor
// pays, anyone could). Copies a player's legacy Scope B points PDA
// [gfgpoints, player] (old total_points layout) into the per-game ledger
// [gfgpoints, gameTag, player] as both tracks (1:1), so no lifetime points
// are lost across the seed change. Idempotent: no-ops when the legacy account
// is absent or the destination already holds awards.
// Returns { migrated: boolean, legacyPda, pointsPda, sig }.
export async function handleMigratePoints(playerPubkey, gameTag = 'ludo') {
  if (!isValidGameTag(gameTag)) throw new Error(`invalid game_tag: ${gameTag}`);
  const player = new PublicKey(playerPubkey);
  const sponsor = loadSponsor();
  const conn = createConnection(BASE_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  const [legacyPda] = legacyPointsPdaFor(player);
  const [pointsPda] = PublicKey.findProgramAddressSync([POINTS_SEED, Buffer.from(gameTag, 'utf8'), player.toBytes()], PROGRAM_ID);

  const retry = async (fn, n = 4, delay = 400) => {
    for (let i = 0; i < n; i++) {
      try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, delay)); }
    }
    return null;
  };

  const legacyInfo = await retry(() => conn.getAccountInfo(legacyPda));
  if (!legacyInfo) {
    return { migrated: false, legacyPda: legacyPda.toBase58(), pointsPda: pointsPda.toBase58(), sig: null };
  }
  const destInfo = await retry(() => conn.getAccountInfo(pointsPda));
  if (destInfo) {
    // Already created — only re-run if it holds no awards yet (empty ledger).
    const dest = program.coder.accounts.decode('playerPoints', destInfo.data);
    if (dest && Number(dest.awardCount ?? dest.award_count ?? 0) > 0) {
      return { migrated: false, legacyPda: legacyPda.toBase58(), pointsPda: pointsPda.toBase58(), sig: null };
    }
  }

  const sig = await sendAndConfirmBase(conn, sponsor,
    await program.methods.migratePoints(gameTag)
      .accounts({
        payer: sponsor.publicKey,
        playerAuthority: player,
        legacyPoints: legacyPda,
        points: pointsPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction()
  );
  console.log(`[relay] migrated legacy points ${legacyPda.toBase58()} -> ${pointsPda.toBase58()} (gameTag ${gameTag})`);
  return { migrated: true, legacyPda: legacyPda.toBase58(), pointsPda: pointsPda.toBase58(), sig };
}

// Delegate a dice PDA into the ER session (pin our devnet ER validator).
// Returns the tx signature, or null if the account turns out already delegated.
async function delegateDicePda(program, conn, sponsor, player, pda) {
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);

  const sig = await sendAndConfirmBase(conn, sponsor,
      await program.methods.delegate()
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
        .transaction()
    )
    .catch(async (err) => {
      // If delegation failed (e.g. the account was already delegated a moment
      // ago), confirm the account really is delegated now and treat it as
      // success. Otherwise rethrow with the on-chain error details.
      await new Promise(r => setTimeout(r, 600));
      const after = await getDelegationStatus(conn, pda);
      if (after && after.isDelegated) {
        return null;
      }
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate failed: ${detail}`);
    });
  return sig;
}

// Delegate a points PDA into the ER session (Scope B). Mirrors delegateDicePda
// but uses the points seed + delegate_points instruction accounts.
async function delegatePointsPda(program, conn, sponsor, player, pointsPda, gameTag) {  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pointsPda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pointsPda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pointsPda.toBytes()], DELEGATION_PROGRAM);

  const sig = await sendAndConfirmBase(conn, sponsor,
      await program.methods.delegatePoints(gameTag)
        .accounts({
          payer: sponsor.publicKey,
          playerAuthority: player,
          points: pointsPda,
          bufferPoints: buffer,
          delegationRecordPoints: record,
          delegationMetadataPoints: metadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
        .transaction()
    )
    .catch(async (err) => {
      await new Promise(r => setTimeout(r, 600));
      const after = await getDelegationStatus(conn, pointsPda);
      if (after && after.isDelegated) {
        return null;
      }
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate_points failed: ${detail}`);
    });
  return sig;
}

// Delegate a result PDA into the ER session (Scope C). Mirrors delegatePointsPda
// but uses the result seed + delegate_result instruction accounts.
async function delegateResultPda(program, conn, sponsor, player, resultPda) {
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), resultPda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), resultPda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), resultPda.toBytes()], DELEGATION_PROGRAM);

  const sig = await sendAndConfirmBase(conn, sponsor,
      await program.methods.delegateResult()
        .accounts({
          payer: sponsor.publicKey,
          playerAuthority: player,
          result: resultPda,
          bufferResult: buffer,
          delegationRecordResult: record,
          delegationMetadataResult: metadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
        .transaction()
    )
    .catch(async (err) => {
      await new Promise(r => setTimeout(r, 600));
      const after = await getDelegationStatus(conn, resultPda);
      if (after && after.isDelegated) {
        return null;
      }
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate_result failed: ${detail}`);
    });
  return sig;
}

// Delegate the global points PDA into the ER session (M4). Mirrors the other
// delegate helpers but uses the global points seed + delegate_global_points.
async function delegateGlobalPointsPda(program, conn, sponsor, player, globalPointsPda) {
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), globalPointsPda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), globalPointsPda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), globalPointsPda.toBytes()], DELEGATION_PROGRAM);

  const sig = await sendAndConfirmBase(conn, sponsor,
      await program.methods.delegateGlobalPoints()
        .accounts({
          payer: sponsor.publicKey,
          playerAuthority: player,
          globalPoints: globalPointsPda,
          bufferGlobalPoints: buffer,
          delegationRecordGlobalPoints: record,
          delegationMetadataGlobalPoints: metadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
        .transaction()
    )
    .catch(async (err) => {
      await new Promise(r => setTimeout(r, 600));
      const after = await getDelegationStatus(conn, globalPointsPda);
      if (after && after.isDelegated) {
        return null;
      }
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate_global_points failed: ${detail}`);
    });
  return sig;
}

// Delegate the premium points PDA into the ER session (M5). Mirrors the other
// delegate helpers but uses the premium seed + delegate_premium_points.
async function delegatePremiumPointsPda(program, conn, sponsor, player, premiumPointsPda) {
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), premiumPointsPda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), premiumPointsPda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), premiumPointsPda.toBytes()], DELEGATION_PROGRAM);

  const sig = await sendAndConfirmBase(conn, sponsor,
      await program.methods.delegatePremiumPoints()
        .accounts({
          payer: sponsor.publicKey,
          playerAuthority: player,
          premiumPoints: premiumPointsPda,
          bufferPremiumPoints: buffer,
          delegationRecordPremiumPoints: record,
          delegationMetadataPremiumPoints: metadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
        .transaction()
    )
    .catch(async (err) => {
      await new Promise(r => setTimeout(r, 600));
      const after = await getDelegationStatus(conn, premiumPointsPda);
      if (after && after.isDelegated) {
        return null;
      }
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate_premium_points failed: ${detail}`);
    });
  return sig;
}

// M10 lives ledger: delegate the player's [gfglives, player] PDA into an ER
// session so join/begin/consume_life + the lives gates run GASLESS. Mirrors
// delegatePremiumPointsPda. The lives PDA is created + delegated ONCE during
// the same first-time onboarding as dice/points/result/global/premium (sponsor
// pays the one-time rent + session cost per player LIFETIME; after that every
// lives write is a 0-fee ER tx signed by the player - never a per-use cost).
async function delegateLivesPda(program, conn, sponsor, player, livesPda) {
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), livesPda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), livesPda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), livesPda.toBytes()], DELEGATION_PROGRAM);

  const sig = await sendAndConfirmBase(conn, sponsor,
      await program.methods.delegateLives()
        .accounts({
          payer: sponsor.publicKey,
          playerAuthority: player,
          lives: livesPda,
          bufferLives: buffer,
          delegationRecordLives: record,
          delegationMetadataLives: metadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
        .transaction()
    )
    .catch(async (err) => {
      await new Promise(r => setTimeout(r, 600));
      const after = await getDelegationStatus(conn, livesPda);
      if (after && after.isDelegated) {
        return null;
      }
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate_lives failed: ${detail}`);
    });
  return sig;
}

// M5 admin credit: the owner (sponsor key = the stored adminAuthority) credits
// a player's PREMIUM points ledger with `points` after a VERIFIED manual
// Paystack payment. Idempotent by `creditRef` (the program rejects a reused
// ref). Ensures the premium PDA exists first (sponsor pays rent).
//
// DELEGATION-AWARE: `credit_premium_points` is authority-gated and writes
// whatever the current LCM state is, but a base-layer write only works on a
// NON-delegated account (a delegated account lives on the ER). handleDelegate
// may have already delegated the premium PDA (onboarding), so the correct
// launch flow is: if delegated -> undelegate_premium_points (sponsor signs) ->
// credit base-layer -> re-delegate to AS so the player's ER spends keep
// working. This mirrors the migrate-to-as pattern.
// Returns { player, points, creditRef, sig, undelegated, redelegated }.
export async function handleCreditPremium(playerPubkey, points, creditRef, reason = 1) {
  if (!Number.isInteger(points) || points <= 0) throw new Error(`invalid points: ${points}`);
  if (!Number.isInteger(creditRef) || creditRef <= 0) throw new Error(`invalid creditRef: ${creditRef}`);
  const player = new PublicKey(playerPubkey);
  if (player.toBase58() !== String(playerPubkey || '').trim()) {
    throw new Error('invalid wallet address: base58 is case-sensitive, the string must match the canonical address exactly');
  }
  const sponsor = loadSponsor();
  const conn = createConnection(BASE_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  const [premiumPointsPda] = PublicKey.findProgramAddressSync([PREMIUM_SEED, player.toBytes()], PROGRAM_ID);

  const retry = async (fn, n = 4, delay = 400) => {
    for (let i = 0; i < n; i++) {
      try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, delay)); }
    }
    return null;
  };

  // Ensure the premium PDA exists (init if missing, v2). The sponsor is the payer,
  // so the account's stored adminAuthority = sponsor key = our credit signer.
  let info = await retry(() => conn.getAccountInfo(premiumPointsPda));
  if (!info) {
    await sendAndConfirmBase(conn, sponsor,
      await program.methods.initializePremiumPoints()
        .accounts({ premiumPoints: premiumPointsPda, payer: sponsor.publicKey, playerAuthority: player })
        .transaction()
    );
    info = await retry(() => conn.getAccountInfo(premiumPointsPda));
  }
  // v1 legacy account -> migrate to v2 first (permissionless, sponsor pays rent delta).
  if (info && info.data.length && info.data.length < 124) {
    await sendAndConfirmBase(conn, sponsor,
      await program.methods.upgradePremiumPoints()
        .accounts({ payer: sponsor.publicKey, premiumPoints: premiumPointsPda, systemProgram: SystemProgram.programId })
        .transaction()
    );
  }

  // Gasless ER rule: if the premium PDA is delegated, the credit runs GASLESS on its hosting ER region (sponsor is payer, user never pays).
  // If not delegated, it runs base-layer. No undelegate dance for the ER path.
  const status = await retry(() => getDelegationStatus(conn, premiumPointsPda));
  const wasDelegated = !!(status && status.isDelegated);
  let sig = null;
  const buildArgs = [new BN(points), new BN(creditRef), reason];
  if (wasDelegated) {
    const regionUrl = (await resolvedRegionUrl(premiumPointsPda, conn)) || pickErRpcUrl();
    const erProgram = erProgramForSponsor(regionUrl, sponsor);
    sig = await erProgram.methods.creditPremiumPoints(...buildArgs)
      .accounts({
        admin: sponsor.publicKey,
        playerAuthority: player,
        premiumPoints: premiumPointsPda,
      })
      .rpc();
    console.log(`[relay] credited ${player.toBase58()} +${points} premium points on ER ${regionUrl} (creditRef ${creditRef}, reason ${reason}, sig ${sig})`);
  } else {
    sig = await sendAndConfirmBase(conn, sponsor,
      await program.methods.creditPremiumPoints(...buildArgs)
        .accounts({
          admin: sponsor.publicKey,
          playerAuthority: player,
          premiumPoints: premiumPointsPda,
        })
        .transaction()
    );
    console.log(`[relay] credited ${player.toBase58()} +${points} premium points on base (creditRef ${creditRef}, reason ${reason}, sig ${sig})`);
  }
  return { player: player.toBase58(), points, creditRef, reason, sig, wasDelegated, gasless: wasDelegated };
}

// M5 admin cancel: revoke a defective perpetual sub (authority-gated, gasless on ER).
// If the premium PDA is delegated, the cancel runs GASLESS on its hosting ER region (sponsor is payer, user never pays).
// If not delegated, it runs base-layer (first-time case). No undelegate dance for the ER path.
export async function handleCancelPremium(playerPubkey) {
  const player = new PublicKey(playerPubkey);
  if (player.toBase58() !== String(playerPubkey || '').trim()) {
    throw new Error('invalid wallet address: base58 is case-sensitive, the string must match the canonical address exactly');
  }
  const sponsor = loadSponsor();
  const baseConn = createConnection(BASE_URL, 'confirmed');
  const [premiumPointsPda] = PublicKey.findProgramAddressSync([PREMIUM_SEED, player.toBytes()], PROGRAM_ID);
  const retry = async (fn, n = 4, delay = 400) => {
    for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, delay)); } }
    return null;
  };
  const info = await retry(() => baseConn.getAccountInfo(premiumPointsPda));
  if (!info) throw new Error('premium PDA not found for player');
  const status = await retry(() => getDelegationStatus(baseConn, premiumPointsPda));
  const wasDelegated = !!(status && status.isDelegated);
  let sig = null;
  if (wasDelegated) {
    // Gasless ER write on the PDA's hosting region (sponsor pays, user 0 SOL)
    const regionUrl = (await resolvedRegionUrl(premiumPointsPda, baseConn)) || pickErRpcUrl();
    const erProgram = erProgramForSponsor(regionUrl, sponsor);
    sig = await erProgram.methods.adminCancelSubscription()
      .accounts({ admin: sponsor.publicKey, playerAuthority: player, premiumPoints: premiumPointsPda })
      .rpc();
    console.log(`[relay] cancelled subscription for ${player.toBase58()} on ER ${regionUrl} (sig ${sig})`);
  } else {
    const provider = new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
    const program = new Program(idl, provider);
    sig = await sendAndConfirmBase(baseConn, sponsor,
      await program.methods.adminCancelSubscription()
        .accounts({ admin: sponsor.publicKey, playerAuthority: player, premiumPoints: premiumPointsPda })
        .transaction()
    );
    console.log(`[relay] cancelled subscription for ${player.toBase58()} on base (sig ${sig})`);
  }
  return { player: player.toBase58(), sig, wasDelegated, redelegated: false, gasless: wasDelegated };
}

// M5 promo: admin gives subscription via the normal 5000P route. Gasless on ER when delegated.
// First credit 5000P (if needed) then activate — both respect the 5000 spend check, so no shortcut.
export async function handleAdminActivatePremium(playerPubkey, level = 1) {
  const player = new PublicKey(playerPubkey);
  if (player.toBase58() !== String(playerPubkey || '').trim()) {
    throw new Error('invalid wallet address: base58 is case-sensitive, the string must match the canonical address exactly');
  }
  const sponsor = loadSponsor();
  const baseConn = createConnection(BASE_URL, 'confirmed');
  const [premiumPointsPda] = PublicKey.findProgramAddressSync([PREMIUM_SEED, player.toBytes()], PROGRAM_ID);
  const retry = async (fn, n = 4, delay = 400) => {
    for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, delay)); } }
    return null;
  };
  const info = await retry(() => baseConn.getAccountInfo(premiumPointsPda));
  if (!info) throw new Error('premium PDA not found for player');
  // v1 legacy account -> migrate to v3 first so activate (v3 layout) works.
  if (info.data && info.data.length && info.data.length < 124) {
    const provider0 = new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
    const program0 = new Program(idl, provider0);
    await sendAndConfirmBase(baseConn, sponsor,
      await program0.methods.upgradePremiumPointsV3()
        .accounts({ payer: sponsor.publicKey, premiumPoints: premiumPointsPda, systemProgram: SystemProgram.programId })
        .transaction()
    );
  }
  const status = await retry(() => getDelegationStatus(baseConn, premiumPointsPda));
  const wasDelegated = !!(status && status.isDelegated);
  let sig = null;
  const lvl = Math.min(3, Math.max(1, Number(level) || 1));
  if (wasDelegated) {
    const regionUrl = (await resolvedRegionUrl(premiumPointsPda, baseConn)) || pickErRpcUrl();
    const erProgram = erProgramForSponsor(regionUrl, sponsor);
    sig = await erProgram.methods.activateSubscriptionLevel(new BN(lvl))
      .accounts({ payer: sponsor.publicKey, playerAuthority: player, premiumPoints: premiumPointsPda })
      .rpc();
    console.log(`[relay] admin activated Level ${lvl} for ${player.toBase58()} on ER ${regionUrl} (sig ${sig})`);
  } else {
    const provider = new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
    const program = new Program(idl, provider);
    sig = await sendAndConfirmBase(baseConn, sponsor,
      await program.methods.activateSubscriptionLevel(new BN(lvl))
        .accounts({ payer: sponsor.publicKey, playerAuthority: player, premiumPoints: premiumPointsPda })
        .transaction()
    );
    console.log(`[relay] admin activated Level ${lvl} for ${player.toBase58()} on base (sig ${sig})`);
  }
  return { player: player.toBase58(), level: lvl, sig, wasDelegated, redelegated: false, gasless: wasDelegated };
}

// Undelegate the premium PDA back to base (runs commit+undelegate on its
// hosting ER region, sponsor signs). Mirrors migrate-to-as's undelegate step.
async function undelegatePremiumPda(program, conn, sponsor, player, premiumPointsPda) {
  const magProg = new PublicKey('Magic11111111111111111111111111111111111111');
  const magContext = new PublicKey('MagicContext1111111111111111111111111111111');
  const tx = await program.methods.undelegatePremiumPoints()
    .accounts({
      payer: sponsor.publicKey,
      playerAuthority: player,
      premiumPoints: premiumPointsPda,
      magicProgram: magProg,
      magicContext: magContext,
    })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'processed');
  console.log(`  undelegate_premium_points ${sig} -> isDelegated=false`);
  return sig;
}

// Send a base-layer tx through the Magic Router with the correct per-layer
// blockhash (getBlockhashForAccounts), then confirm by polling the Router.
// Anchor's `.rpc()` uses getLatestBlockhash, which the Router answers with its
// OWN layer blockhash — invalid on base Solana. Must NOT be used here.
async function sendAndConfirmBase(conn, sponsor, transaction) {
  transaction.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, transaction, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

// Ensure the platform's USDC treasury ATA exists on the pay cluster.
// The sponsor owns the receiving account; it pays the one-time rent so the
// player's USDC transfer has a real destination to land on (a transfer to a
// non-existent token account fails with InvalidAccountData). Idempotent.
// Treasury + mint come from pay-config so a devnet->mainnet swap keeps one source.
export async function ensureTreasuryUsdcAta() {
  const { PAY_TREASURY_PUBKEY, USDC_MINT } = await import('./pay-config.mjs');
  const sponsor = loadSponsor();
  const conn = createConnection(BASE_URL, 'confirmed');
  const treasury = new PublicKey(PAY_TREASURY_PUBKEY);
  const [ata] = PublicKey.findProgramAddressSync(
    [treasury.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(USDC_MINT).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const exists = await conn.getAccountInfo(ata).catch(() => null);
  if (exists) return { ata: ata.toBase58(), created: false };
  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountInstruction(
    sponsor.publicKey, // payer
    ata,               // associated token account
    treasury,          // owner
    new PublicKey(USDC_MINT),
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  ));
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  await sendAndConfirmBase(conn, sponsor, tx);
  console.log(`[relay] created treasury USDC ATA ${ata.toBase58()} for ${treasury.toBase58()}`);
  return { ata: ata.toBase58(), created: true };
}
