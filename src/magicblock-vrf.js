// src/magicblock-vrf.js
// Provably-fair dice for the Ludo game via MagicBlock VRF (Solana devnet).
//
// Flow: the game calls window.magicblockDice.roll(). The module:
//   1. ensures the player's dice PDA exists (initialize),
//   2. sends `rollDice(clientSeed)` — signed by the Dynamic embedded wallet,
//   3. waits for the VRF program to callback into `callback_roll_dice`,
//   4. reads [last_roll1, last_roll2] from the PDA and returns them.
//
// The module ONLY activates once configure() has been called with a deployed
// programId + IDL. Until then available() returns false and the game keeps
// using its existing client-side randomness (nothing breaks).

import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { getWalletAccounts } from '@dynamic-labs-sdk/client';
import { signTransaction, signAllTransactions } from '@dynamic-labs-sdk/solana';

// Devnet base-layer VRF oracle queue (see MagicBlock VRF docs).
const DEVNET_ORACLE_QUEUE = 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh';
const PLAYER_SEED = Buffer.from('gfgplayerd');

const config = {
  rpcUrl: 'https://api.devnet.solana.com',
  programId: null,   // base58 // set by configure()
  idl: null,         // object // set by configure()
  oracleQueue: DEVNET_ORACLE_QUEUE,
  requestTimeoutMs: 15000,
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

function getProgram() {
  if (!config.programId || !config.idl) return null;
  const wallet = getSolanaWalletAccount();
  if (!wallet) return null;

  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Adapter: lets Anchor build/send transactions using the Dynamic embedded
  // wallet for signing (session keys make this non-interactive).
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
    program: new Program(config.idl, new PublicKey(config.programId), provider),
    wallet,
  };
}

function playerPda(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [PLAYER_SEED, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

async function ensurePlayerPda(program, pda, payerPubkey) {
  try {
    const info = await program.provider.connection.getAccountInfo(pda);
    if (info) return;
  } catch (e) {
    // getAccountInfo failure: fall through and try to create anyway.
  }
  await program.methods
    .initialize()
    .accounts({ player: pda, payer: payerPubkey })
    .rpc();
}

async function rollOnce() {
  const ctx = getProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { program, wallet } = ctx;
  const [pda] = playerPda(wallet.publicKey);

  await ensurePlayerPda(program, pda, wallet.publicKey);

  // Unique entropy commitment for this roll (included in the VRF proof).
  const clientSeed = Math.floor(Math.random() * 256);

  await program.methods
    .rollDice(clientSeed)
    .accounts({
      player: pda,
      payer: wallet.publicKey,
      oracleQueue: new PublicKey(config.oracleQueue),
    })
    .rpc();

  // Wait for the VRF oracle to fulfill and callback into our program.
  const deadline = Date.now() + config.requestTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
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
      if (opts.rpcUrl) config.rpcUrl = opts.rpcUrl;
      if (opts.oracleQueue) config.oracleQueue = opts.oracleQueue;
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
  };
}