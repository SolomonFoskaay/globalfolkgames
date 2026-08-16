// src/magicblock-vrf.js
// Provably-fair, GASLESS dice for the Ludo game via MagicBlock VRF + Ephemeral
// Rollup (Solana devnet).
//
// Why gasless: players are Web2-native and never hold SOL. On their first roll
// the app-sponsored relay (POST config.relayUrl) creates + delegates the
// player's dice PDA to a MagicBlock Ephemeral Rollup (the only base-layer txs,
// paid by us). Every roll then runs on the ER:
//   - the transaction is FREE (ER is gasless for end users),
//   - the VRF request on the ER queue is FREE,
//   - the player's Dynamic session key signs silently (no popup).
//
// Flow (roll()):
//   1. ensure the player's dice PDA exists and is delegated (via the relay),
//   2. send rollDice(clientSeed) on the ER, signed by the session key,
//   3. wait for the VRF program to callback into callback_roll_dice,
//   4. read [last_roll1, last_roll2] from the PDA and return them.
//
// The module ONLY activates once configure() has been called. Until then
// available() returns false and the game keeps using local randomness.

import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { getWalletAccounts } from '@dynamic-labs-sdk/client';
import { signTransaction, signAllTransactions } from '@dynamic-labs-sdk/solana';
import { getDelegationStatus } from './gfg-rpc.js';
import bs58 from 'bs58';
import { BN } from 'bn.js';

const DELEGATION_PROGRAM = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
const PLAYER_SEED = Buffer.from('gfgplayerd');
const POINTS_SEED = Buffer.from('gfgpoints');
const RESULT_SEED = Buffer.from('gfgresult');

// Reasons recorded against a points award (mirrors the program's u8 codes).
export const POINT_REASONS = Object.freeze({
  WIN_1ST: 1,     // first place in a match
});

const config = {
  baseRpcUrl: 'https://api.devnet.solana.com',
  erRpcUrl: 'https://devnet-us.magicblock.app/',
  erValidator: 'MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd',
  // Devnet ER VRF queue (free VRF). Base-layer queue: Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh
  oracleQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc',
  relayUrl: '/api/delegate',
  programId: null,   // set by configure()
  idl: null,         // set by configure()
  requestTimeoutMs: 20000,
  erPickupWaitMs: 10000,
};

function getSolanaWalletAccount() {
  try {
    const client = window.dynamicClient;
    if (!client) return null;
    const accounts = getWalletAccounts(client);
    const sol = accounts.find(w => w.chain === 'SOL' && w.address);
    return sol ? { walletAccount: sol, publicKey: new PublicKey(sol.address) } : null;
  } catch (e) {
    console.warn('[VRF] Could not read Solana wallet account', e);
    return null;
  }
}

// Provider pointed at the Ephemeral Rollup. Transactions here are gasless, so
// the player's wallet (session key) can be the fee payer with zero SOL.
function getErProgram() {
  if (!config.programId || !config.idl) return null;
  const wallet = getSolanaWalletAccount();
  if (!wallet) return null;

  const connection = new Connection(config.erRpcUrl, 'confirmed');
  const walletAdapter = {
    publicKey: wallet.publicKey,
    async signTransaction(transaction) {
      const { signedTransaction } = await signTransaction({
        transaction,
        walletAccount: wallet.walletAccount,
      });
      return signedTransaction;
    },
    async signAllTransactions(transactions) {
      const { signedTransactions } = await signAllTransactions({
        transactions,
        walletAccount: wallet.walletAccount,
      });
      return signedTransactions;
    },
  };

  const provider = new AnchorProvider(connection, walletAdapter, {
    commitment: 'confirmed',
    skipPreflight: true,
  });

  return {
    program: new Program(config.idl, provider),
    wallet,
  };
}

function playerPda(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [PLAYER_SEED, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Signature of the most recent on-chain proof roll. Consumed by the Ludo reward
// logic (win-detection.js) so a 1st-place user finish can reference the tx.
let lastProofRollSignature = null;

// True once the ER validator has the delegated account in its state.
// The ER hosts the account under its ORIGINAL program owner (getAccountInfo on
// the ER RPC returns owner=our program once picked up), so existence of the
// account with data on the ER RPC is the correct "picked up" signal — NOT
// owner===DELEGATION_PROGRAM (that would never match on an ER RPC).
async function waitForErPickup(pda) {
  const conn = new Connection(config.erRpcUrl, 'confirmed');
  const deadline = Date.now() + config.erPickupWaitMs;
  while (Date.now() < deadline) {
    try {
      const info = await conn.getAccountInfo(pda);
      if (info && info.owner.toBase58() === config.programId && info.data.length > 0) {
        return true;
      }
    } catch (e) {
      // ER not ready yet; keep polling.
    }
    await sleep(500);
  }
  return false;
}

// App-sponsored onboarding: creates the PDA + delegates it to the ER. The
// relay holds our devnet sponsor key, so the player never needs SOL.
// Delegation is checked via the Magic Router's getDelegationStatus (not
// getAccountInfo.owner): with the Router as the base RPC, getAccountInfo
// returns the ER-side view where the account is owned by OUR program, so the
// owner can never equal the delegation program even when delegated.
async function ensureDelegated(pda, playerPubkey) {
  const baseConn = new Connection(config.baseRpcUrl, 'confirmed');
  try {
    const status = await getDelegationStatus(baseConn, pda);
    if (status && status.isDelegated) return true;
  } catch (e) {
    // Router not reachable; fall back to the relay (it is idempotent).
  }

  console.log('[VRF] Delegating player dice account (sponsored by GlobalFolkGames)...');
  const res = await fetch(config.relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: playerPubkey.toString() }),
  });
  if (!res.ok) {
    let msg = `relay error ${res.status}`;
    try { msg += ': ' + (await res.text()); } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.delegated) throw new Error('delegation relay did not delegate the account');

  // Record the base-layer tx signatures the sponsor relay just ran (they ARE
  // explorer-visible, unlike ER txs) so the game can offer real verify links.
  lastDelegateSteps = Array.isArray(data.steps) ? data.steps.slice() : [];

  return waitForErPickup(pda);
}

// Most recent {step, sig} pairs from the sponsor relay. Only refreshed on a
// real (non-idempotent) delegation; empty array once every PDA is delegated.
let lastDelegateSteps = [];

function findLastDelegateSig(stepNames) {
  if (!Array.isArray(lastDelegateSteps)) return null;
  for (let i = lastDelegateSteps.length - 1; i >= 0; i--) {
    const s = lastDelegateSteps[i];
    if (s && s.sig && stepNames.indexOf(s.step) !== -1) return s.sig;
  }
  return null;
}

// Base-layer tx sig for the player's DICE PDA ('initialize'/'delegate' steps).
export function getLastDiceDelegationSignature() {
  return findLastDelegateSig(['delegate', 'initialize']);
}

// Base-layer tx sig for the player's RESULT PDA (Scope C game-record account).
export function getLastResultDelegationSignature() {
  return findLastDelegateSig(['delegate_result', 'initialize_result']);
}

async function rollOnce() {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { program, wallet } = ctx;
  const [pda] = playerPda(wallet.publicKey);

  await ensureDelegated(pda, wallet.publicKey);

  // The ER validator may need a moment to include the freshly delegated PDA.
  await waitForErPickup(pda);

  // Unique entropy commitment for this roll (included in the VRF proof).
  const clientSeed = Math.floor(Math.random() * 256);

  const proofResult = await program.methods
    .rollDice(clientSeed)
    .accounts({
      player: pda,
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
      oracleQueue: new PublicKey(config.oracleQueue),
    })
    .rpc();
  lastProofRollSignature = (typeof proofResult === 'string' && proofResult)
    ? proofResult
    : (proofResult && (proofResult.signature || proofResult.txSig)) || null;

  // Wait for the VRF oracle to fulfill and callback into our program.
  const deadline = Date.now() + config.requestTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const account = await program.account.playerDice.fetch(pda);
      if (account.lastClientSeed === clientSeed) {
        return [Number(account.lastRoll1), Number(account.lastRoll2)];
      }
    } catch (e) {
      // Account not settled yet; keep polling.
    }
  }

  console.warn('[VRF] Timeout waiting for callback result');
  throw new Error('VRF request timed out. Please try again.');
}

// scope B: Points recorded on-chain.
//
// The relay's handleDelegate (idempotent) also creates + delegates a second
// player PDA (points, seed 'gfgpoints'), so recordPoints() is a pure gasless
// ER write signed by the player's session key — no SOL, no sponsor step here.
// The returned transaction signature is the authoritative on-chain receipt of
// the award, and the player's points PDA becomes the verifiable ledger of
// their rewards (total_points, award_count, last_*).
//
// `matchRef` = the proof-roll signature that earned the reward encoded as a
// u64 (its first 8 bytes), matching what the program stores as last_match_ref
// so the on-chain record is traceable back to the exact winning roll.
export async function recordPoints(points, reason, matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { program, wallet } = ctx;
  const [pointsPda] = pointsPdaFor(wallet.publicKey);

  // Relay is idempotent per PDA; it creates + delegates the points PDA if
  // missing, and is a no-op when already delegated. Once the ER validator has
  // picked the account up, the write below runs gasless.
  await ensureDelegated(pointsPda, wallet.publicKey);
  await waitForErPickup(pointsPda);

  const sig = await program.methods
    .recordPoints(new BN(points), reason, matchRef instanceof BN ? matchRef : new BN(matchRef.toString()))
    .accounts({
      points: pointsPda,
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
    })
    .rpc();

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

function pointsPdaFor(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [POINTS_SEED, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

// Scope C: commits the FULL 1st..4th finish order on-chain. Gasless on the ER
// (session key signs, 0 SOL), mirroring recordPoints. The relay's handleDelegate
// (idempotent) also creates + delegates the result PDA (seed 'gfgresult'), so
// this write is a pure ER send once onboarded.
//
// `finishOrder` = array of color/seat keys, index 0 = 1st place (maps to the
// program's `finish_order[i]` = seat index that finished in position i+1).
// `points`/`multiplier`/`matchRef` mirror the reward that was banked, tying the
// committed finish to the exact winning roll.
export async function recordResult(finishOrder, points, multiplier, matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { program, wallet } = ctx;
  const [resultPda] = resultPdaFor(wallet.publicKey);

  // Relay is idempotent per PDA; it creates + delegates the result PDA if
  // missing and is a no-op when already delegated. Then the ER write is free.
  await ensureDelegated(resultPda, wallet.publicKey);
  await waitForErPickup(resultPda);

  // Map colors to the canonical seat indexes (green=0, yellow=1, blue=2, red=3).
  const seatIndexes = finishOrder.map(color =>
    typeof color === 'number' ? color : SEAT_INDEX[color] ?? 0,
  );
  const order = Array.from({ length: 4 }, (_, i) => seatIndexes[i] ?? 0);

  const sig = await program.methods
    .recordResult(
      order,
      new BN(points),
      new BN(multiplier),
      matchRef instanceof BN ? matchRef : new BN(matchRef.toString()),
    )
    .accounts({
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
      result: resultPda,
    })
    .rpc();

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

const SEAT_INDEX = Object.freeze({ green: 0, yellow: 1, blue: 2, red: 3 });

function resultPdaFor(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [RESULT_SEED, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

// S2: winner claims their competition allocation. Gasless ER write signed by
// the player's session key (0 SOL), mirroring recordPoints. The relay's
// handleDelegate (idempotent) also creates + delegates the player's points
// PDA, which is what the claim credits.
//
// `compPda` identifies the competition (seed `gfgcomp` + sponsor pubkey, read
// via the relay's GET /api/comp). `winnerIndex` = the player's slot in the
// settled winner table (0, 1, 2). Returns the claim receipt signature.
export async function claimComp(compPda, winnerIndex) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { program, wallet } = ctx;
  const [pointsPda] = pointsPdaFor(wallet.publicKey);

  // The winner's points PDA must exist + be delegated for the claim to credit
  // it. Relay is idempotent: creates + delegates if missing, no-op if done.
  await ensureDelegated(pointsPda, wallet.publicKey);
  await waitForErPickup(pointsPda);

  // Read the sponsor out of the comp account so the PDA seed constraint passes.
  const compAccount = await program.account.competition.fetch(new PublicKey(compPda));
  const sponsorKey = new PublicKey(compAccount.sponsor);

  const sig = await program.methods
    .claimComp(winnerIndex)
    .accounts({
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
      points: pointsPda,
      sponsor: sponsorKey,
      comp: new PublicKey(compPda),
    })
    .rpc();

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// matchRef for a proof-roll signature: first 8 bytes interpreted as a u64.
export function matchRefFromSignature(sig) {
  if (!sig) return new BN(0);
  try {
    const bytes = bs58.decode(sig);
    if (!bytes || bytes.length < 8) return new BN(0);
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) view.setUint8(i, bytes[i]);
    const hex = Buffer.from(new Uint8Array(view.buffer)).toString('hex');
    return new BN(hex, 16);
  } catch (e) {
    return new BN(0);
  }
}

export function initMagicBlockDice() {
  // Reason codes for on-chain points records (shared with win-detection.js).
  window.POINT_REASONS = POINT_REASONS;
  window.magicblockDice = {
    configure(opts = {}) {
      if (opts.programId) config.programId = opts.programId;
      if (opts.idl) config.idl = opts.idl;
      if (opts.baseRpcUrl) config.baseRpcUrl = opts.baseRpcUrl;
      if (opts.erRpcUrl) config.erRpcUrl = opts.erRpcUrl;
      if (opts.erValidator) config.erValidator = opts.erValidator;
      if (opts.oracleQueue) config.oracleQueue = opts.oracleQueue;
      if (opts.relayUrl) config.relayUrl = opts.relayUrl;
    },

    isConfigured() {
      return !!(config.programId && config.idl);
    },

    // True only when a deployed program is configured AND a Solana wallet
    // session exists. Game falls back to local randomness otherwise.
    available() {
      return this.isConfigured() && !!getSolanaWalletAccount();
    },

    // Returns a Promise<[d1, d2]>, each 1..=6.
    roll() {
      return rollOnce();
    },

    getLastProofRollSignature() {
      return lastProofRollSignature;
    },

    // Base-layer tx that created + delegated the player's DICE PDA (the sponsor
    // relay runs these once, on devnet). Unlike ER rollup txs, this IS indexed
    // by public explorers, so it is the linkable proof of the dice account.
    getLastDiceDelegationSignature() {
      return getLastDiceDelegationSignature();
    },

    // Base-layer tx that created + delegated the player's RESULT PDA (the
    // Scope C game-record account). Also devnet-visible and linkable.
    getLastResultDelegationSignature() {
      return getLastResultDelegationSignature();
    },

    // Scope B: records the award on the player's on-chain points PDA (gasless
    // ER write, session key signs). Returns the receipt signature.
    recordPoints(points, reason, matchRef) {
      return recordPoints(points, reason, matchRef);
    },

    // Scope C: commits the full 1st..4th finish order on-chain (gasless ER
    // write, session key signs). Returns the receipt signature.
    recordResult(finishOrder, points, multiplier, matchRef) {
      return recordResult(finishOrder, points, multiplier, matchRef);
    },

    // S2: winner claims their competition allocation gasless on the ER
    // (session key signs, 0 SOL). `compPda` from the relay, `winnerIndex`
    // from the settled winner table. Returns the claim receipt signature.
    claimComp(compPda, winnerIndex) {
      return claimComp(compPda, winnerIndex);
    },

    // First 8 bytes of a proof-roll signature as u64 — the match_ref the
    // program stores, so the on-chain record traces to the exact winning roll.
    matchRefFromSignature(sig) {
      return matchRefFromSignature(sig);
    },

    // The player's on-chain points PDA address (for own-account profile view).
    pointsPda() {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return pointsPdaFor(wallet.publicKey)[0].toBase58();
    },

    // The player's on-chain game-record (result) PDA address.
    resultPda() {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return resultPdaFor(wallet.publicKey)[0].toBase58();
    },

    // Reads the player's on-chain points ledger from the ER (gasless, no sign).
    // Returns { totalPoints, lastPoints, lastReason, lastMatchRef, lastRecordedTs, awardCount }
    // or null if the PDA isn't visible yet.
    async fetchPointsPda() {
      const ctx = getErProgram();
      if (!ctx) return null;
      const { program, wallet } = ctx;
      const [pointsPda] = pointsPdaFor(wallet.publicKey);
      try {
        const acct = await program.account.playerPoints.fetch(pointsPda);
        return {
          totalPoints: Number(acct.totalPoints ?? acct.total_points),
          lastPoints: Number(acct.lastPoints ?? acct.last_points),
          lastReason: Number(acct.lastReason ?? acct.last_reason),
          lastMatchRef: (acct.lastMatchRef ?? acct.last_match_ref)?.toString() ?? '0',
          lastRecordedTs: Number(acct.lastRecordedTs ?? acct.last_recorded_ts) * 1000,
          awardCount: Number(acct.awardCount ?? acct.award_count),
        };
      } catch (e) {
        return null;
      }
    },

    // Cheap liveness probe for the on-chain outage monitor. Resolves true when
    // BOTH the base RPC and the ER RPC answer (devnet + the Rollup where rolls
    // execute). Never throws; the monitor treats any failure as "still down".
    ping() {
      return pingOnchainStack();
    },
  };
}

async function pingOnchainStack() {
  const probe = async (url) => {
    const conn = new Connection(url, 'confirmed');
    let timer;
    try {
      const slotPromise = conn.getSlot();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), 5000);
      });
      await Promise.race([slotPromise, timeout]);
      return true;
    } catch (e) {
      console.warn(`[VRF] ping failed for ${url}`, e.message || e);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const results = await Promise.all([probe(config.baseRpcUrl), probe(config.erRpcUrl)]);
  return results.every(Boolean);
}
