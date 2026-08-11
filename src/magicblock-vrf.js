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

const DELEGATION_PROGRAM = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
const PLAYER_SEED = Buffer.from('gfgplayerd');

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
async function waitForErPickup(pda) {
  const conn = new Connection(config.erRpcUrl, 'confirmed');
  const deadline = Date.now() + config.erPickupWaitMs;
  while (Date.now() < deadline) {
    try {
      const info = await conn.getAccountInfo(pda);
      if (info && info.owner.toBase58() === DELEGATION_PROGRAM && info.data.length > 0) {
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
async function ensureDelegated(pda, playerPubkey) {
  const baseConn = new Connection(config.baseRpcUrl, 'confirmed');
  const info = await baseConn.getAccountInfo(pda);
  if (info && info.owner.toBase58() === DELEGATION_PROGRAM) {
    return true;
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

  return waitForErPickup(pda);
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

export function initMagicBlockDice() {
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
  };
}
