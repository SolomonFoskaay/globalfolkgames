// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title SessionRegistry — Foskaay Gasless Games Infrastructure (GGI), CORE contract 1 of 4.
///
/// @notice Opens and closes a SESSION: the room a game plays inside for free.
/// A session records WHO may act (participants), WHO may sign for them (each
/// participant's authority), and WHEN it expires. It knows NOTHING about any
/// game: no board, token, position, seat count, turn or dice. Game state is an
/// opaque payload handled by SessionState.
///
/// @notice SESSION KEYS: a player may register a standing EPHEMERAL key (a
/// throwaway signer the browser keeps locally) that signs in-session events
/// silently, so the player never sees a wallet popup during play. This mirrors
/// MagicBlock's two-component model: an ephemeral keypair PLUS an on-chain
/// record of its SCOPE and EXPIRY. On EVM the on-chain half is a mapping entry
/// here (a session token was a separate PDA on Solana; a slot is the EVM
/// equivalent and costs no extra account). The key is scoped to the PLAYER,
/// not to one session, so a game opening one session per match does not force
/// a re-registration every match (the rail serves many sessions by name, and
/// the key is reusable by name). Scope is an opaque hash: the rail never
/// learns what the scope means (Law 1). Keys are revocable at any time.
///
/// @dev DESIGN LAWS (do not violate — they are why this rail is reusable):
///   1. THE RAIL NEVER LEARNS A GAME CONCEPT. Participant count is data, not code.
///   2. UNOPINIONATED: no account layout, no commit cadence and no batching
///      policy is enforced here. A game may commit as often as it likes.
///   3. REOPEN-SAFE: a closed session id can never be reused (replay protection).
///
/// SECURITY MODEL (this contract is a shared dependency for other projects, so
/// it must never be the weak link):
///   - No ETH/USDC is held here, and no external call is made, so there is no
///     reentrancy surface and nothing to drain. (Checks-effects only.)
///   - Every function that mutates a session is access-controlled to the session
///     OWNER (the game's operator address) or an explicit participant authority.
///   - Session ids are derived from the owner + a caller nonce, so a third party
///     cannot front-run or grief another game's session id.
///   - Expiry is enforced on every write, so a stale session cannot be acted on.
///   - All state-changing paths are O(1) or bounded by the participant list,
///     which is capped, so gas cannot be griefed with unbounded loops.
/// @dev UPGRADEABLE (UUPS, owner-controlled for now; timelock/multisig before
///      mainnet). The proxy address is permanent, so sessions and data never move.
///      STORAGE RULES (do not violate, or live data is read as garbage):
///        - the layout below is APPEND-ONLY: never reorder, rename or remove a
///          state variable, including the gaps;
///        - new state variables go where a gap slot is, and the gap shrinks by
///          exactly the same number of slots;
///        - `version` is the first NEW variable added after launch, so a reader
///          can tell which layout an account has.
///      `initialize` replaces the constructor; the implementation contract is
///      initialized with `_disableInitializers()` so it can never be used directly.
contract SessionRegistry is Initializable, UUPSUpgradeable {
    /// Hard cap on participants per session. 1 participant is a solo/simulation
    /// session; up to 64 covers party games, tournaments and MMO rooms.
    uint8 public constant MAX_PARTICIPANTS = 64;

    /// A session can never be longer than this, so a forgotten session cannot
    /// stay writable forever. Refreshing/extending is the game's own choice.
    uint64 public constant MAX_SESSION_TTL = 7 days;

    /// Session lifecycle. Open = writable. Closed = settled/final.
    /// (There is deliberately no "disputed" flag here: a dispute is a game-level
    /// concern handled by an OPTIONAL verifier pattern, not by the core rail.)
    enum Status { None, Open, Closed }

    struct Session {
        address owner;            // the game operator that opened it (only it may close)
        uint8 status;             // Status
        uint8 participantCount;   // 1..MAX_PARTICIPANTS
        uint64 createdAt;         // block timestamp of open
        uint64 expiresAt;         // hard deadline; writes after this revert
        uint64 closedAt;          // set when closed (0 while open)
        bytes32 rulesHash;        // hash of the opaque rules/state blob the rail never parses
        bytes32 seedCommit;       // committed randomness seed hash (optional; 0 = no randomness)
    }

    /// sessionId => Session.
    mapping(bytes32 => Session) private _sessions;

    /// sessionId => participant index => the address allowed to sign for that seat.
    /// A game may set the same authority for several seats (e.g. a relayer that
    /// runs the house/AI seats); that is the game's choice, not the rail's.
    mapping(bytes32 => mapping(uint8 => address)) private _authority;

    /// A standing SESSION KEY: an ephemeral signer a player authorises once, so
    /// in-session events sign silently (no wallet popup). The on-chain half of
    /// MagicBlock's two-component model (the off-chain half is the keypair).
    struct SessionKey {
        address owner;        // the player who registered it (the real wallet)
        uint64 validUntil;    // absolute expiry; 0 = never registered/revoked
        bytes32 scopeHash;    // OPAQUE scope commitment; the rail never parses it
        bool revoked;         // killed by the owner; permanent
    }

    /// key address => SessionKey. A key belongs to ONE owner and is reusable
    /// across every session where that owner is a seat's authority.
    mapping(address => SessionKey) private _sessionKeys;

    /// owner => list of keys it registered, so revocation can be enumerated
    /// without any unbounded scan of all keys (bounded by MAX_SESSION_KEYS).
    mapping(address => address[]) private _keysOf;

    /// Hard cap on standing keys per owner, so registration cannot be used to
    /// grief storage, and any owner-side loop stays bounded.
    uint8 public constant MAX_SESSION_KEYS = 16;

    /// owner => nonce, to derive collision-free, un-front-runnable session ids.
    mapping(address => uint64) public nonces;

    /// The protocol fee recipient (the owner wallet). Storage (not immutable) so
    /// it survives behind a proxy.
    address public feeRecipient;

    /// Optional operator that may administratively close ANY session (used to
    /// wind down an abandoned game). Zero address disables it.
    address public operator;

    /// Layout marker for readers/migrations. 0 on the first deployed layout.
    /// Bump ONLY when the storage layout changes, never for a logic-only upgrade.
    uint8 public version;

    /// sessionId => the game's OWN state account for this session (the board).
    /// The rail stores it as an OPAQUE address: it never learns what it is, or any
    /// game concept. It exists so a reader can answer "which game state belongs to
    /// this session?" - the closest match to MagicBlock's delegation registry,
    /// where you can look up which accounts are delegated for a game. Optional:
    /// a game that does not care leaves it unset (zero).
    mapping(bytes32 => address) public gameStateOf;

    /// Reserved slots so future state variables can be appended without shifting
    /// any existing slot. Each future variable consumes from the top of this gap.
    /// DO NOT reorder or remove. (Shrunk from 20 to 19 when gameStateOf was added.)
    uint256[19] private __gap;

    event SessionOpened(
        bytes32 indexed sessionId,
        address indexed owner,
        uint8 participantCount,
        uint64 expiresAt,
        bytes32 rulesHash,
        bytes32 seedCommit
    );
    event SessionClosed(bytes32 indexed sessionId, address indexed owner, uint64 closedAt);
    event AuthoritySet(bytes32 indexed sessionId, uint8 indexed seat, address authority);
    event OperatorSet(address operator);
    event SessionKeyRegistered(address indexed owner, address indexed key, uint64 validUntil, bytes32 scopeHash);
    event SessionKeyRevoked(address indexed owner, address indexed key);
    event GameStateSet(bytes32 indexed sessionId, address indexed owner, address stateAccount);
    /// EVENT-BASED Foskaay GGI Midchain (optional, cheap anchor): the handover event carries
    /// the session + the game link, so no separate link transaction is needed.
    event Handover(
        bytes32 indexed sessionId,
        address indexed gameLogic,
        bytes32 startHash,
        address[] players,
        address[] sessionKeys,
        uint16 randomCount,
        address indexed payer
    );
    /// EVENT-BASED Foskaay GGI Midchain settlement: the final hash (or a session Merkle root)
    /// plus who paid. No stored session is required.
    event MidchainSettled(bytes32 indexed sessionId, bytes32 finalHash, address indexed payer);

    error NotOwner();
    error NotOperatorOrOwner();
    error UnknownSession();
    error SessionNotOpen();
    error SessionExpired();
    error BadParticipantCount();
    error BadTtl();
    error ZeroAddress();
    error AlreadyClosed();
    error BadSeat();
    error TooManySessionKeys();
    error AlreadyRevoked();
    error KeyOwnedByAnother();
    error BadSignature();

    /// @notice Initialize the proxy. Replaces the old constructor (a proxy never
    ///         runs the implementation's constructor).
    /// @param feeRecipient_ the wallet that receives session fees (the deployer).
    /// @param operator_ optional address allowed to force-close any session; may
    ///        be zero to disable that power entirely (recommended at first).
    function initialize(address feeRecipient_, address operator_) external initializer {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice The implementation contract is initialized with initializers
    ///         disabled, so it can never be used directly (only via the proxy).
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the fee recipient (the protocol owner) may authorize an upgrade.
    ///      Before mainnet this moves to a timelock or multisig.
    function _authorizeUpgrade(address) internal override {
        if (msg.sender != feeRecipient) revert NotOwner();
    }

    /// @notice Open a new session. The caller becomes the session OWNER (the game
    ///         operator). Returns the session id.
    /// @param participantCount 1..MAX_PARTICIPANTS.
    /// @param ttlSecs lifetime in seconds, 1..MAX_SESSION_TTL.
    /// @param rulesHash hash of the game's opaque rules/state blob (the rail never
    ///        parses it; it is a commitment so the rules can be proven later).
    /// @param seedCommit optional committed randomness seed hash (0 = none).
    function open(
        uint8 participantCount,
        uint64 ttlSecs,
        bytes32 rulesHash,
        bytes32 seedCommit
    ) external returns (bytes32 sessionId) {
        if (participantCount == 0 || participantCount > MAX_PARTICIPANTS) revert BadParticipantCount();
        if (ttlSecs == 0 || ttlSecs > MAX_SESSION_TTL) revert BadTtl();

        uint64 nonce = nonces[msg.sender]++;
        // sessionId binds the opener and the nonce, so no third party can predict
        // or grief another game's id, and ids are unique per opener forever.
        sessionId = keccak256(abi.encodePacked(msg.sender, nonce, block.chainid, address(this)));

        _sessions[sessionId] = Session({
            owner: msg.sender,
            status: uint8(Status.Open),
            participantCount: participantCount,
            createdAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + ttlSecs,
            closedAt: 0,
            rulesHash: rulesHash,
            seedCommit: seedCommit
        });

        emit SessionOpened(sessionId, msg.sender, participantCount, uint64(block.timestamp) + ttlSecs, rulesHash, seedCommit);
    }

    /// @notice Set the signing authority for one participant seat. Only the
    ///         session OWNER may do this, and only while the session is open and
    ///         unexpired. May be called again to rotate an authority.
    function setAuthority(bytes32 sessionId, uint8 seat, address authority) external {
        Session storage s = _requireOpenOwned(sessionId);
        if (seat >= s.participantCount) revert BadSeat();
        if (authority == address(0)) revert ZeroAddress();
        _authority[sessionId][seat] = authority;
        emit AuthoritySet(sessionId, seat, authority);
    }

    /// @notice Close (settle) a session. Only the owner (or the operator) may
    ///         close it. Closing is one-way; a session id can never be reopened.
    function close(bytes32 sessionId) external {
        Session storage s = _sessions[sessionId];
        if (s.status == uint8(Status.None)) revert UnknownSession();
        if (s.status == uint8(Status.Closed)) revert AlreadyClosed();
        if (msg.sender != s.owner && msg.sender != operator) revert NotOperatorOrOwner();
        s.status = uint8(Status.Closed);
        s.closedAt = uint64(block.timestamp);
        emit SessionClosed(sessionId, s.owner, s.closedAt);
    }

    /// @notice Change the optional operator (owner-only power-transfer to the
    ///         current owner; pass zero to disable). Kept simple and explicit.
    function setOperator(address operator_) external {
        if (msg.sender != feeRecipient) revert NotOwner();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice Register the game's OWN state account (its board) against a
    ///         session, so a reader can look up "which game state belongs to this
    ///         session?" - the equivalent of MagicBlock's "which accounts are
    ///         delegated for a game".
    /// @dev Only the session OWNER (the game operator) may set it, and only while
    ///      the session is open. The address is OPAQUE: the rail never calls it
    ///      and never learns any game concept. It is optional; a game that does
    ///      not need discovery can leave it unset. One state account per session.
    function setGameState(bytes32 sessionId, address stateAccount) external {
        Session storage s = _requireOpenOwned(sessionId);
        if (stateAccount == address(0)) revert ZeroAddress();
        gameStateOf[sessionId] = stateAccount;
        emit GameStateSet(sessionId, s.owner, stateAccount);
    }

    // ------------------------------------------------------- session keys

    /// @notice Register (or re-register/rotate) a standing SESSION KEY: an
    ///         ephemeral signer that may act for the caller's seats until
    ///         `validUntil`. One call, then no popups in play.
    /// @dev The caller is the key's OWNER (their real wallet). A key can never be
    ///      registered for another owner, so a key cannot be hijacked or made to
    ///      act for someone else.
    /// @param key the ephemeral signer address (never zero).
    /// @param validUntil absolute unix time the key dies. Must be in the future.
    ///        An expiry in the past would create a dead key, so it is refused.
    /// @param scopeHash OPAQUE commitment to what the key may do (e.g. a game tag
    ///        and allowed actions). The rail NEVER parses it; a game may compare
    ///        it to its own scope when it consumes an event.
    function registerSessionKey(address key, uint64 validUntil, bytes32 scopeHash) external {
        if (key == address(0)) revert ZeroAddress();
        if (validUntil <= block.timestamp) revert SessionExpired();

        SessionKey storage sk = _sessionKeys[key];
        // A live key owned by someone else cannot be stolen by re-registering it:
        // only its owner may change it, and only after it has died or been revoked.
        // (An expired-but-unrevoked key is dead, so the original owner can reuse
        // the address; a key that is still live and unrevoked is protected.)
        if (sk.owner != address(0) && sk.owner != msg.sender) {
            if (!sk.revoked && block.timestamp <= sk.validUntil) revert KeyOwnedByAnother();
        }

        bool isNew = sk.owner == address(0);
        if (isNew) {
            if (_keysOf[msg.sender].length >= MAX_SESSION_KEYS) revert TooManySessionKeys();
            _keysOf[msg.sender].push(key);
        }

        sk.owner = msg.sender;
        sk.validUntil = validUntil;
        sk.scopeHash = scopeHash;
        sk.revoked = false;

        emit SessionKeyRegistered(msg.sender, key, validUntil, scopeHash);
    }

    /// @notice Revoke a standing session key the caller owns, immediately. This
    ///         is the on-chain half of "revocable": a leaked ephemeral key is
    ///         useless the moment its owner revokes it.
    /// @dev Only the key's owner may revoke it. Revocation is one-way; the same
    ///      address may be registered again later, but the revoked registration
    ///      itself is dead for good.
    function revokeSessionKey(address key) external {
        SessionKey storage sk = _sessionKeys[key];
        if (sk.owner != msg.sender) revert NotOwner();
        if (sk.revoked) revert AlreadyRevoked();
        sk.revoked = true;
        emit SessionKeyRevoked(msg.sender, key);
    }

    // --------------------------------------- event-based Foskaay GGI Midchain (cheap anchor)

    /// @notice EVENT-BASED handover: emit the session + the game link instead of
    ///         writing a stored session. Cheaper than `open` + `setGameState`
    ///         because it is one event, and the link travels with it, so the
    ///         Foskaay GGI explorer can index it from eth_getLogs.
    /// @dev Purely additive. This does NOT create a stored session, so the
    ///      storage-based paths (`open`/`setAuthority`/`sealFinal`) are unchanged.
    function handover(
        bytes32 sessionId,
        address gameLogic,
        bytes32 startHash,
        address[] calldata players,
        address[] calldata sessionKeys,
        uint16 randomCount
    ) external {
        if (players.length == 0 || players.length != sessionKeys.length) revert BadParticipantCount();
        emit Handover(sessionId, gameLogic, startHash, players, sessionKeys, randomCount, msg.sender);
    }

    /// @notice Emit MANY event-based handovers in ONE transaction. The per-game
    ///         cost drops because the transaction base fee is shared.
    function handoverMany(
        bytes32[] calldata sessionIds,
        address gameLogic,
        bytes32[] calldata startHashes,
        address[][] calldata players,
        address[][] calldata sessionKeys,
        uint16 randomCount
    ) external {
        uint256 n = sessionIds.length;
        if (n == 0 || n != startHashes.length || n != players.length || n != sessionKeys.length) revert BadParticipantCount();
        for (uint256 i = 0; i < n; i++) {
            if (players[i].length == 0 || players[i].length != sessionKeys[i].length) revert BadParticipantCount();
            emit Handover(sessionIds[i], gameLogic, startHashes[i], players[i], sessionKeys[i], randomCount, msg.sender);
        }
    }

    /// @notice EVENT-BASED settlement: verify that every declared signer signed
    ///         (sessionId, finalHash), then emit. `finalHash` may be a single
    ///         game's final hash OR a whole session's Merkle root.
    /// @dev No stored session and no nullifier are needed: the digest is
    ///      deterministic and every settle must carry valid player signatures, so
    ///      a replay only re-emits an IDENTICAL event (harmless) and a different
    ///      result is impossible without those signatures. Keeping this stateless
    ///      is what makes it cheap.
    function settle(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external {
        _settleOne(sessionId, finalHash, sigs, signers);
    }

    /// @notice EVENT-BASED settlement of MANY sessions in ONE transaction.
    function settleMany(
        bytes32[] calldata sessionIds,
        bytes32[] calldata finalHashes,
        bytes[][] calldata sigs,
        address[][] calldata signers
    ) external {
        uint256 n = sessionIds.length;
        if (n == 0 || n != finalHashes.length || n != sigs.length || n != signers.length) revert BadParticipantCount();
        for (uint256 i = 0; i < n; i++) {
            _settleOne(sessionIds[i], finalHashes[i], sigs[i], signers[i]);
        }
    }

    /// @notice The digest a participant signs to authorise an event-based
    ///         settlement. Exposed so a client never has to guess the encoding.
    function midchainDigest(bytes32 sessionId, bytes32 finalHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("FoskaayGGI", block.chainid, sessionId, finalHash));
    }

    function _settleOne(bytes32 sessionId, bytes32 finalHash, bytes[] calldata sigs, address[] calldata signers) private {
        uint256 n = signers.length;
        if (n == 0 || n != sigs.length) revert BadParticipantCount();
        bytes32 digest = midchainDigest(sessionId, finalHash);
        for (uint256 i = 0; i < n; i++) {
            (bytes32 r, bytes32 s, uint8 v) = _splitSig(sigs[i]);
            if (ecrecover(digest, v, r, s) != signers[i]) revert BadSignature();
        }
        emit MidchainSettled(sessionId, finalHash, msg.sender);
    }

    function _splitSig(bytes calldata sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        if (sig.length != 65) revert BadSignature();
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
    }

    // ---------------------------------------------------------------- reads

    /// @notice Full session record.
    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice The authority allowed to sign for a seat (zero = unset).
    function authorityOf(bytes32 sessionId, uint8 seat) external view returns (address) {
        return _authority[sessionId][seat];
    }

    /// @notice True only while the session exists, is open, and has not expired.
    function isLive(bytes32 sessionId) public view returns (bool) {
        Session storage s = _sessions[sessionId];
        return s.status == uint8(Status.Open) && block.timestamp <= s.expiresAt;
    }

    /// @notice Whether an address may sign for a seat right now. Used by
    ///         SessionState to authorise events. Returns false for everything
    ///         that is not a live, properly-authorised seat, OR a live standing
    ///         session key whose OWNER is that seat's authority.
    /// @dev Two paths, one source of truth (the seat authority):
    ///      1. `who` IS the seat authority (a direct wallet signature).
    ///      2. `who` is a registered, unexpired, unrevoked session key whose
    ///         owner is the seat authority (the silent-play path).
    ///      A key therefore inherits EXACTLY its owner's seats and nothing more.
    function canSign(bytes32 sessionId, uint8 seat, address who) external view returns (bool) {
        if (!isLive(sessionId)) return false;
        Session storage s = _sessions[sessionId];
        if (seat >= s.participantCount) return false;
        address a = _authority[sessionId][seat];
        if (a == address(0)) return false;
        if (a == who) return true;
        // Session-key path: the key must be live AND owned by the seat authority.
        SessionKey storage sk = _sessionKeys[who];
        return sk.owner == a && !sk.revoked && block.timestamp <= sk.validUntil && sk.validUntil != 0;
    }

    /// @notice Whether a standing session key is usable right now (registered,
    ///         unexpired, unrevoked). Read helper for games and the SDK.
    function isSessionKeyLive(address key) public view returns (bool) {
        SessionKey storage sk = _sessionKeys[key];
        return sk.owner != address(0) && !sk.revoked && sk.validUntil != 0 && block.timestamp <= sk.validUntil;
    }

    /// @notice The full standing-key record for an address (all-zero if never
    ///         registered).
    function sessionKeyOf(address key) external view returns (SessionKey memory) {
        return _sessionKeys[key];
    }

    /// @notice The keys an owner has registered (bounded by MAX_SESSION_KEYS),
    ///         so a client can revoke them all without on-chain enumeration.
    function keysOf(address ownerAddr) external view returns (address[] memory) {
        return _keysOf[ownerAddr];
    }

    // ------------------------------------------------------------- internal

    /// @dev Shared guard: the session must exist, be open, be unexpired, and be
    ///      owned by the caller. Checks only; performs no writes (no reentrancy).
    function _requireOpenOwned(bytes32 sessionId) private view returns (Session storage s) {
        s = _sessions[sessionId];
        if (s.status == uint8(Status.None)) revert UnknownSession();
        if (s.status == uint8(Status.Closed)) revert AlreadyClosed();
        if (block.timestamp > s.expiresAt) revert SessionExpired();
        if (msg.sender != s.owner) revert NotOwner();
    }
}
