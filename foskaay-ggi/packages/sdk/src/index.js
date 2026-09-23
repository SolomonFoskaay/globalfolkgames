// @foskaay/ggi-sdk — Foskaay Gasless Games Infrastructure (Foskaay GGI) client.
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
  recoverMessageAddress,
  recoverAddress,
} from 'viem';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Addresses come from the PUBLISHED dependency @foskaay/ggi-contracts, not a
// relative repo path: a relative path works in the monorepo but breaks the
// moment the SDK is installed on its own (which is exactly how a game dev gets
// it). Requiring the sibling package keeps one source of truth and makes the
// published SDK self-contained.
import ggiContracts from '@foskaay/ggi-contracts';
const addresses = ggiContracts.all;

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
  'function setGameState(bytes32 sessionId, address stateAccount)',
  'function gameStateOf(bytes32 sessionId) view returns (address)',
  // Event-based midchain (cheap anchor). Additive; storage-based paths above are unchanged.
  'function handover(bytes32 sessionId, address gameLogic, bytes32 startHash, address[] players, address[] sessionKeys, uint16 randomCount)',
  'function handoverMany(bytes32[] sessionIds, address gameLogic, bytes32[] startHashes, address[][] players, address[][] sessionKeys, uint16 randomCount)',
  'function settle(bytes32 sessionId, bytes32 finalHash, bytes[] sigs, address[] signers)',
  'function settleMany(bytes32[] sessionIds, bytes32[] finalHashes, bytes[][] sigs, address[][] signers)',
  'function midchainDigest(bytes32 sessionId, bytes32 finalHash) view returns (bytes32)',
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
  'function chargeSession(bytes32 sessionId)',
  'function sessionFee() view returns (uint256)',
  'function feeToken() view returns (address)',
  'function collected(address token) view returns (uint256)',
  'function paymentOf(bytes32 sessionId) view returns (address, uint256)',
]);

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

// ---------------------------------------------------------------- helpers

function networkConfig(network) {
  const net = addresses[network];
  if (!net) throw new Error('Foskaay GGI: unknown network "' + network + '". Use "testnet" or "mainnet".');
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
    if (!this.walletClient) throw new Error('Foskaay GGI: a walletClient is required for write calls.');
    if (!this.deployed) throw new Error('Foskaay GGI: contracts are not deployed on ' + this.network + ' yet.');
  }

  async write(req) {
    const hash = await this.walletClient.writeContract(req);
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error('Foskaay GGI: transaction reverted ' + hash);
    return rc;
  }

  // ------------------------------------------------------------ OPEN

  /// Open a session. One transaction (+ one per authority you pass).
  /// Returns { sessionId, tx, txs, seedCommit }.
  ///
  /// IMPORTANT (this was a real integration blind spot): a session that never
  /// sets a seat authority can NEVER be settled, because SessionState only
  /// accepts commitDigest/sealFinal from an authorised seat signer. So if you
  /// pass `authorities`, this sets them for you right after open. Do that, or
  /// call setAuthority() yourself before you settle. The most common setup is
  /// one authority per player (their wallet or their session key).
  ///
  /// @param cfg.participants 1..64
  /// @param cfg.ttlSecs up to 7 days
  /// @param cfg.rulesHash optional commitment to your rules blob (default zero)
  /// @param cfg.seeds optional array; if given, its commitment is sealed at open
  /// @param cfg.authorities optional array of seat authorities (index = seat), set after open
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

    // Set seat authorities if the caller gave them, so the session is settlable.
    const txs = [rc.transactionHash];
    if (Array.isArray(cfg.authorities) && cfg.authorities.length) {
      for (let seat = 0; seat < participants; seat++) {
        const auth = cfg.authorities[seat] || cfg.authorities[0];
        if (!auth) continue;
        const r = await this.write({
          address: this.addresses.SessionRegistry,
          abi: registryAbi,
          functionName: 'setAuthority',
          args: [sessionId, seat, getAddress(auth)],
        });
        txs.push(r.transactionHash);
      }
    }
    return { sessionId, tx: rc.transactionHash, txs, seedCommit };
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

  /// Register the game's OWN state account (its board) against a session, so a
  /// reader can look up which game state belongs to this session. The rail stores
  /// the address as an opaque value and never learns what it is. Optional.
  /// @param stateAccount the game's board/state contract address
  async setGameState(sessionId, stateAccount) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'setGameState',
      args: [sessionId, getAddress(stateAccount)],
    });
  }

  /// The game state account registered for a session (zero if none).
  async gameStateOf(sessionId) {
    return this.publicClient.readContract({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'gameStateOf',
      args: [sessionId],
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

  /// Settle a session. Closes it, reveals seeds, seals the final digest and pays
  /// the one per-session fee. Returns { tx, revealed, sealed, paid }.
  /// @param cfg.digest the final digest from your off-chain log
  /// @param cfg.mode 'events' (recorded on-chain) or 'digest' (off-chain log)
  /// @param cfg.seeds optional seeds to reveal (must match the open commitment)
  /// @param cfg.payFee default true; charges the single per-session fee
  async settle(sessionId, cfg = {}) {
    this.requireWallet();
    const out = { tx: [], revealed: false, sealed: false, paid: false };

    // PRE-FLIGHT (blind-spot guard): sealing a final digest requires an authorised
    // seat signer. If none is set, the on-chain call reverts with a terse error.
    // We check first and throw a clear, actionable message instead.
    if (cfg.digest) {
      const session = await this.getSession(sessionId);
      const count = Number(session.participantCount || 0);
      let anyAuthority = false;
      for (let seat = 0; seat < count; seat++) {
        const a = await this.publicClient.readContract({
          address: this.addresses.SessionRegistry, abi: registryAbi,
          functionName: 'authorityOf', args: [sessionId, seat],
        }).catch(() => '0x0000000000000000000000000000000000000000');
        if (a && a !== '0x0000000000000000000000000000000000000000') { anyAuthority = true; break; }
      }
      if (!anyAuthority) {
        throw new Error(
          'Foskaay GGI: this session has no seat authority, so it cannot be settled. ' +
          'Call setAuthority(sessionId, seat, signer) first, or pass { authorities } to open().'
        );
      }
    }

    // 1. your game's final digest (optional: only if you kept the log off-chain
    //    and want it anchored; a game that recorded events on-chain skips this).
    if (cfg.mode === 'digest' && cfg.digest) {
      await this.write({
        address: this.addresses.SessionState,
        abi: stateAbi,
        functionName: 'commitDigest',
        args: [sessionId, cfg.digest, Number(cfg.eventCount || 0)],
      });
    }

    // 2. close the session
    await this.write({
      address: this.addresses.SessionRegistry,
      abi: registryAbi,
      functionName: 'close',
      args: [sessionId],
    });

    // 3. reveal seeds if any were committed. OPTIONAL on purpose: a game that
    //    asked for no randomness never calls this and never pays for it.
    if (Array.isArray(cfg.seeds) && cfg.seeds.length) {
      await this.write({
        address: this.addresses.Randomness,
        abi: rndAbi,
        functionName: 'reveal',
        args: [sessionId, cfg.seeds],
      });
      out.revealed = true;
    }

    // 4. seal the final digest
    if (cfg.digest) {
      await this.write({
        address: this.addresses.SessionState,
        abi: stateAbi,
        functionName: 'sealFinal',
        args: [sessionId, cfg.digest],
      });
      out.sealed = true;
    }

    // 5. the ONE per-session fee
    if (cfg.payFee !== false) {
      const fee = await this.fees();
      if (fee.session > 0n) {
        await this.ensureAllowance(fee.session);
        out.tx.push(
          (await this.write({
            address: this.addresses.FeeVault,
            abi: vaultAbi,
            functionName: 'chargeSession',
            args: [sessionId],
          })).transactionHash
        );
        out.paid = true;
      }
    }

    return out;
  }

  // ------------------------------------------------------------ DISPUTE (optional)

  /// The optional dispute path. Foskaay GGI core has no dispute instruction on purpose:
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

  /// The CURRENT fee, read from chain at runtime (never hardcoded). There is one
  /// per-session fee, charged once at settle.
  async fees() {
    if (!this.addresses.FeeVault) return { session: 0n, token: null };
    const [session, token] = await Promise.all([
      this.publicClient.readContract({ address: this.addresses.FeeVault, abi: vaultAbi, functionName: 'sessionFee' }),
      this.publicClient.readContract({ address: this.addresses.FeeVault, abi: vaultAbi, functionName: 'feeToken' }),
    ]);
    return { session, token };
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
  // ------------------------------------------------------------ session keys

  /// Create a fresh ephemeral session keypair in the browser/app. This is the
  /// throwaway signer that makes play silent (no wallet popup per action).
  /// Returns { privateKey, address }. Keep the private key in memory only (or an
  /// encrypted store), register the ADDRESS on-chain once, and use it to sign.
  /// An outsider should never have to know how to do this: it is one call.
  createSessionKey() {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    return { privateKey, address: account.address, account };
  }

  /// Sign one action string with a session key (silent, no wallet popup).
  /// `key` is the object from createSessionKey(), or a raw private key.
  /// Returns the signature hex, ready to store with your off-chain log.
  async signAction(key, signThis) {
    const pk = typeof key === 'string' ? key : key && key.privateKey;
    if (!pk) throw new Error('Foskaay GGI: signAction needs a session key from createSessionKey().');
    const acct = privateKeyToAccount(pk);
    return acct.signMessage({ message: signThis });
  }

  /// Record an action AND sign it in one call, so a game does not have to stitch
  /// the two together. Returns { state, digest, signThis, signature }.
  async actSigned(state, action, key) {
    const r = this.act(state, action);
    const signature = await this.signAction(key, r.signThis);
    return { ...r, signature };
  }

  /// Verify an action signature recovers to the expected session-key address.
  /// This is what a game (or its verifier) runs during a dispute.
  async verifyAction(signThis, signature, expectedKeyAddress) {
    const got = await recoverMessageAddress({ message: signThis, signature });
    return got.toLowerCase() === getAddress(expectedKeyAddress).toLowerCase();
  }

  // ------------------------------------------------- event-based midchain
  // The cheap anchor: the handover event carries the session + the game link
  // (no separate link tx), and settle verifies the players' signatures on-chain.
  // Every move inside is free; only the handover and settle are transactions.

  /// Emit ONE event-based handover. `cfg` = { sessionId, gameLogic, startHash,
  /// players[], sessionKeys[], randomCount }. Returns the tx hash.
  async handover(cfg = {}) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry, abi: registryAbi, functionName: 'handover',
      args: [cfg.sessionId, cfg.gameLogic, cfg.startHash, cfg.players, cfg.sessionKeys, cfg.randomCount || 0],
    });
  }

  /// Emit MANY event-based handovers in ONE transaction. `cfg` = { sessionIds[],
  /// gameLogic, startHashes[], players[][], sessionKeys[][], randomCount }.
  async handoverMany(cfg = {}) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry, abi: registryAbi, functionName: 'handoverMany',
      args: [cfg.sessionIds, cfg.gameLogic, cfg.startHashes, cfg.players, cfg.sessionKeys, cfg.randomCount || 0],
    });
  }

  /// The digest a participant signs to authorise an event-based settlement.
  async midchainDigest(sessionId, finalHash) {
    return this.publicClient.readContract({
      address: this.addresses.SessionRegistry, abi: registryAbi, functionName: 'midchainDigest', args: [sessionId, finalHash],
    });
  }

  /// Sign the event-based settlement digest with a session key (silent).
  async signMidchain(key, sessionId, finalHash) {
    const pk = typeof key === 'string' ? key : key && key.privateKey;
    if (!pk) throw new Error('Foskaay GGI: signMidchain needs a session key from createSessionKey().');
    const digest = await this.midchainDigest(sessionId, finalHash);
    return privateKeyToAccount(pk).sign({ hash: digest });
  }

  /// Verify an event-based settlement signature recovers to the signer.
  async verifyMidchain(sessionId, finalHash, signature, expectedSigner) {
    const digest = await this.midchainDigest(sessionId, finalHash);
    const got = await recoverAddress({ hash: digest, signature });
    return got.toLowerCase() === getAddress(expectedSigner).toLowerCase();
  }

  /// EVENT-BASED settlement of ONE session. `cfg` = { sessionId, finalHash,
  /// sigs[], signers[] }. `finalHash` may be one game's final hash or a whole
  /// session's Merkle root.
  async settleMidchain(cfg = {}) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry, abi: registryAbi, functionName: 'settle',
      args: [cfg.sessionId, cfg.finalHash, cfg.sigs, cfg.signers],
    });
  }

  /// EVENT-BASED settlement of MANY sessions in ONE transaction. `cfg` = {
  /// sessionIds[], finalHashes[], sigs[][], signers[][] }.
  async settleMidchainMany(cfg = {}) {
    this.requireWallet();
    return this.write({
      address: this.addresses.SessionRegistry, abi: registryAbi, functionName: 'settleMany',
      args: [cfg.sessionIds, cfg.finalHashes, cfg.sigs, cfg.signers],
    });
  }
}

/// The exact string a session key signs for one action. Kept in one place so the
/// on-chain and off-chain sides can never drift.
export function actionDigestString(sessionId, seat, sequence, payloadHash, digest) {
  return ['foskaay-ggi-action', sessionId, String(seat), String(sequence), payloadHash, digest].join('|');
}

export default GgiClient;
