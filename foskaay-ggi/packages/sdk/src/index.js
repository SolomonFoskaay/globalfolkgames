// @foskaay/ggi-sdk — Foskaay Gasless Games Infrastructure (GGI) client.
//
// WHAT THIS IS: the one-line integration that makes any on-chain game gasless.
// A game opens a SESSION, plays inside for free (signed actions, no chain writes,
// no wallet popups), and settles ONCE. See /foskaay-ggi-docs for the full story.
//
// THE FOUR CALLS: open, act, settle, dispute. Plus session-key signing and read
// helpers. Nothing here is opinionated: the rail never learns your game.
//
// DESIGN NOTES:
//   - `viem` is a peer dependency, so this package stays tiny.
//   - The fee is READ FROM CHAIN at runtime (`feeOf`), never hardcoded, so the
//     operator can change it without republishing this package.
//   - `act()` does NOT write to the chain. It folds an action into a running
//     digest and returns the new digest plus the exact string to sign. The
//     signed log stays with the game; the rail only sees the final digest.
//   - `settle()` is the one transaction that anchors the result, reveals any
//     committed seed, and pays the fee.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  keccak256,
  toBytes,
  encodePacked,
  getAddress,
} from 'viem';

// Addresses are imported as a JS object (not JSON) so every bundler and Node
// version works the same way. The JSON file remains the single source of truth.
import addresses from '../../contracts/deployments/addresses.js';

// ---------------------------------------------------------------- ABIs

const registryAbi = parseAbi([
  'function open(uint8 participantCount, uint64 ttlSecs, bytes32 rulesHash, bytes32 seedCommit) returns (bytes32)',
  'function setAuthority(bytes32 sessionId, uint8 seat, address authority)',
  'function registerSessionKey(address key, uint64 validUntil, bytes32 scopeHash)',
  'function revokeSessionKey(address key)',
  'function close(bytes32 sessionId)',
  'function getSession(bytes32 sessionId) view returns ((address owner, uint8 status, uint8 participantCount, uint64 createdAt, uint64 expiresAt, uint64 closedAt, bytes32 rulesHash, bytes32 seedCommit))',
  'function authorityOf(bytes32 sessionId, uint8 seat) view returns (address)',
  'function isLive(bytes32 sessionId) view returns (bool)',
  'function canSign(bytes32 sessionId, uint8 seat, address who) view returns (bool)',
  'function isSessionKeyLive(address key) view returns (bool)',
]);

const stateAbi = parseAbi([
  'function recordEvent(bytes32 sessionId, uint8 seat, uint64 sequence, bytes32 payloadHash)',
  'function commitDigest(bytes32 sessionId, bytes32 digest, uint16 eventCount)',
  'function sealFinal(bytes32 sessionId, bytes32 digest)',
  'function getState(bytes32 sessionId) view returns ((bytes32 digest, uint16 eventCount, uint64 lastSequence, bytes32 lastPayloadHash, bool committed))',
  'function digestOf(bytes32 sessionId) view returns (bytes32)',
  'function finalDigest(bytes32 sessionId) view returns (bytes32)',
]);

const rndAbi = parseAbi([
  'function declareStreams(bytes32 sessionId, uint8 count)',
  'function reveal(bytes32 sessionId, bytes32[] seeds)',
  'function commitHashOf(bytes32[] seeds) pure returns (bytes32)',
  'function derive(bytes32 seed, uint64 counter) pure returns (bytes32)',
  'function deriveFor(bytes32 sessionId, uint8 stream, uint64 counter) view returns (bytes32)',
  'function seedsOf(bytes32 sessionId) view returns (bytes32[])',
  'function revealed(bytes32 sessionId) view returns (bool)',
  'function streamCountOf(bytes32 sessionId) view returns (uint8)',
]);

const vaultAbi = parseAbi([
  'function chargeOpen(bytes32 sessionId)',
  'function chargeSettle(bytes32 sessionId)',
  'function withdraw(address token)',
  'function openFee() view returns (uint256)',
  'function settleFee() view returns (uint256)',
  'function feeToken() view returns (address)',
  'function collected(address token) view returns (uint256)',
  'function lockedSettleFee(bytes32 sessionId) view returns (uint256)',
  'function paymentOf(bytes32 sessionId) view returns (address, address)',
]);

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

// ---------------------------------------------------------------- helpers

function networkConfig(network) {
  const net = addresses[network];
  if (!net) throw new Error('GGI: unknown network "' + network + '". Use "testnet" or "mainnet".');
  return net;
}

function makeChain(net) {
  return defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [net.rpc] } },
  });
}

/// Deterministic payload hash for an action. The rail only ever sees this hash.
export function payloadHashOf(payload) {
  const canonical = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return keccak256(toBytes(canonical));
}

/// Fold one action into a running digest. Mirrors SessionState.recordEvent so an
/// off-chain log reproduces the on-chain digest exactly. Pure, free, no chain.
export function foldDigest(prevDigest, seat, sequence, payloadHash) {
  return keccak256(
    encodePacked(['bytes32', 'uint8', 'uint64', 'bytes32'], [prevDigest, seat, sequence, payloadHash])
  );
}

/// The zero digest that starts a session's log.
export const ZERO_DIGEST = '0x' + '0'.repeat(64);

/// Compute the session id the same way SessionRegistry.open does, so a client can
/// predict it without a read (handy for optimistic UI).
export function predictSessionId(owner, nonce, chainId, registryAddress) {
  return keccak256(
    encodePacked(
      ['address', 'uint64', 'uint256', 'address'],
      [getAddress(owner), BigInt(nonce), BigInt(chainId), getAddress(registryAddress)]
    )
  );
}

// ---------------------------------------------------------------- client

export class GgiClient {
  /// @param {object} opts
  ///   network  'testnet' | 'mainnet' (default 'testnet')
  ///   walletClient  a viem WalletClient (signs) - optional for read-only use
  ///   publicClient  a viem PublicClient - optional, created from the network rpc
  constructor(opts = {}) {
    this.network = opts.network || 'testnet';
    this.net = networkConfig(this.network);
    this.chain = makeChain(this.net);
    this.publicClient =
      opts.publicClient || createPublicClient({ chain: this.chain, transport: http(this.net.rpc) });
    this.walletClient = opts.walletClient || null;
    this.addresses = this.net.contracts;
    this.usdc = this.net.usdc;
    this.deployed = Object.values(this.addresses).every(Boolean);
  }

  requireWallet() {
    if (!this.walletClient) throw new Error('GGI: a walletClient is required for write calls.');
    if (!this.deployed) throw new Error('GGI: contracts are not deployed on ' + this.network + ' yet.');
  }

  async write(req) {
    const hash = await this.walletClient.writeContract(req);
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error('GGI: transaction reverted ' + hash);
    return rc;
  }

  // ------------------------------------------------------------ OPEN

  /// Open a session. One transaction. Returns { sessionId, tx }.
  /// @param cfg.participants 1..64
  /// @param cfg.ttlSecs up to 7 days
  /// @param cfg.rulesHash optional commitment to your rules blob (default zero)
  /// @param cfg.seeds optional array; if given, its commitment is sealed at open
  async open(cfg = {}) {
    this.requireWallet();
    const participants = Number(cfg.participants || 1);
    const ttlSecs = Number(cfg.ttlSecs || 3600);
    const rulesHash = cfg.rulesHash || ZERO_DIGEST;
    let seedCommit = ZERO_DIGEST;
    if (Array.isArray(cfg.seeds) && cfg.seeds.length) {
      seedCommit = await this.publicClient.readContract({
        address: this.addresses.Randomness,
        abi: rndAbi,
        functionName: 'commitHashOf',
        args: [cfg.seeds],
      });
    }
    const rc = await this.write({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'open',
      args: [participants, BigInt(ttlSecs), rulesHash, seedCommit],
    });
    // The sessionId is in the SessionOpened event; read it from logs.
    const log = rc.logs.find(
      (l) => l.address && l.address.toLowerCase() === this.addresses.SessionRegistry.toLowerCase()
    );
    const sessionId = log ? log.topics[1] : null;
    return { sessionId, tx: rc.transactionHash, seedCommit };
  }

  /// Set who may sign for a seat (call before play).
  async setAuthority(sessionId, seat, authority) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'setAuthority',
      args: [sessionId, Number(seat), getAddress(authority)],
    });
  }

  /// Register a standing session key (silent signer, no popups during play).
  async registerSessionKey(key, validUntil, scopeHash = ZERO_DIGEST) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'registerSessionKey',
      args: [getAddress(key), BigInt(validUntil), scopeHash],
    });
  }

  async revokeSessionKey(key) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'revokeSessionKey',
      args: [getAddress(key)],
    });
  }

  // ------------------------------------------------------------ ACT (free)

  /// Record an action OFF-CHAIN. Zero chain cost, zero popup. Returns the new
  /// digest and the exact string your session key should sign.
  /// This is the heart of gasless play: nothing is written until settle.
  act(state, action) {
    const payloadHash = action.payloadHash || payloadHashOf(action.payload);
    const digest = foldDigest(
      state.digest || ZERO_DIGEST,
      Number(action.seat),
      BigInt(action.sequence),
      payloadHash
    );
    return {
      digest,
      payloadHash,
      seat: Number(action.seat),
      sequence: String(action.sequence),
      signThis: actionDigestString(state.sessionId, action.seat, action.sequence, payloadHash, digest),
      state: { ...state, digest, lastSequence: String(action.sequence), eventCount: (state.eventCount || 0) + 1 },
    };
  }

  /// Optionally anchor actions on-chain (most games do NOT do this; they settle once).
  async recordEvent(sessionId, seat, sequence, payloadHash) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionState,
      abi: stateAbi,
      functionName: 'recordEvent',
      args: [sessionId, Number(seat), BigInt(sequence), payloadHash],
    });
  }

  // ------------------------------------------------------------ SETTLE

  /// Settle a session. One transaction: close, reveal seeds, seal final digest,
  /// and pay the open/settle fee. Returns { tx, revealed, sealed }.
  /// @param cfg.digest the final digest from your off-chain log
  /// @param cfg.mode 'events' (recorded on-chain) or 'digest' (off-chain log)
  /// @param cfg.seeds optional seeds to reveal (must match the open commitment)
  /// @param cfg.payFee default true; charges the per-session fee
  async settle(sessionId, cfg = {}) {
    this.requireWallet();
    const out = { tx: [], revealed: false, sealed: false };

    // 1. fee (open stage) - charge before closing, so the session is live.
    if (cfg.payFee !== false) {
      const fee = await this.fees();
      if (fee.open > 0n) {
        await this.ensureAllowance(fee.open + fee.settle);
        out.tx.push(
          (await this.write({
            address: this.addresses.FeeVault,
            abi: vaultAbi,
            functionName: 'chargeOpen',
            args: [sessionId],
          })).transactionHash
        );
      }
    }

    // 2. your game's final digest
    if (cfg.mode === 'digest' && cfg.digest) {
      await this.write({
        address: this.addresses.SessionState,
        abi: stateAbi,
        functionName: 'commitDigest',
        args: [sessionId, cfg.digest, Number(cfg.eventCount || 0)],
      });
    }

    // 3. close the session
    await this.write({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'close',
      args: [sessionId],
    });

    // 4. reveal seeds if any were committed
    if (Array.isArray(cfg.seeds) && cfg.seeds.length) {
      await this.write({
        address: this.addresses.Randomness,
        abi: rndAbi,
        functionName: 'reveal',
        args: [sessionId, cfg.seeds],
      });
      out.revealed = true;
    }

    // 5. seal the final digest
    if (cfg.digest) {
      await this.write({
        address: this.addresses.SessionState,
        abi: stateAbi,
        functionName: 'sealFinal',
        args: [sessionId, cfg.digest],
      });
      out.sealed = true;
    }

    // 6. fee (settle stage, locked at open)
    if (cfg.payFee !== false) {
      const fee = await this.fees();
      if (fee.settle > 0n) {
        out.tx.push(
          (await this.write({
            address: this.addresses.FeeVault,
            abi: vaultAbi,
            functionName: 'chargeSettle',
            args: [sessionId],
          })).transactionHash
        );
      }
    }

    return out;
  }

  // ------------------------------------------------------------ DISPUTE (optional)

  /// The optional dispute path. GGI core has no dispute instruction on purpose:
  /// a dispute is a game-level concern. This helper records the signed reveal
  /// locally and hands it to YOUR verifier; a game that carries money ships a
  /// verifier (an optional pattern), and a free game needs none.
  dispute(sessionId, reveal) {
    return { sessionId, reveal, at: Date.now(), handled: 'game-verifier' };
  }

  // ------------------------------------------------------------ READS

  async getSession(sessionId) {
    return this.publicClient.readContract({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'getSession',
      args: [sessionId],
    });
  }

  async canSign(sessionId, seat, who) {
    return this.publicClient.readContract({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'canSign',
      args: [sessionId, Number(seat), getAddress(who)],
    });
  }

  async digestOf(sessionId) {
    return this.publicClient.readContract({
      address: this.addresses.SessionState,
      abi: stateAbi,
      functionName: 'digestOf',
      args: [sessionId],
    });
  }

  async streamCountOf(sessionId) {
    return this.publicClient.readContract({
      address: this.addresses.Randomness,
      abi: rndAbi,
      functionName: 'streamCountOf',
      args: [sessionId],
    });
  }

  async derive(seed, counter) {
    return this.publicClient.readContract({
      address: this.addresses.Randomness,
      abi: rndAbi,
      functionName: 'derive',
      args: [seed, BigInt(counter)],
    });
  }

  /// The CURRENT fees, read from chain at runtime (never hardcoded).
  async fees() {
    if (!this.addresses.FeeVault) return { open: 0n, settle: 0n, token: null };
    const [open, settle, token] = await Promise.all([
      this.publicClient.readContract({ address: this.addresses.FeeVault, abi: vaultAbi, functionName: 'openFee' }),
      this.publicClient.readContract({ address: this.addresses.FeeVault, abi: vaultAbi, functionName: 'settleFee' }),
      this.publicClient.readContract({ address: this.addresses.FeeVault, abi: vaultAbi, functionName: 'feeToken' }),
    ]);
    return { open, settle, token };
  }

  async ensureAllowance(amount) {
    const owner = this.walletClient.account.address;
    const current = await this.publicClient.readContract({
      address: this.usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, this.addresses.FeeVault],
    });
    if (current >= amount) return true;
    await this.write({
      address: this.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [this.addresses.FeeVault, amount],
    });
    return true;
  }
}

/// The exact string a session key signs for one action. Kept in one place so the
/// on-chain and off-chain sides can never drift.
export function actionDigestString(sessionId, seat, sequence, payloadHash, digest) {
  return ['foskaay-ggi-action', sessionId, String(seat), String(sequence), payloadHash, digest].join('|');
}

export default GgiClient;
