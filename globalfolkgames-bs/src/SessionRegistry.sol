// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SessionRegistry — GlobalFolkGames Gasless Infrastructure (GI), CORE contract 1 of 4.
///
/// @notice Opens and closes a SESSION: the room a game plays inside for free.
/// A session records WHO may act (participants), WHO may sign for them (each
/// participant's authority), and WHEN it expires. It knows NOTHING about any
/// game: no board, token, position, seat count, turn or dice. Game state is an
/// opaque payload handled by SessionState.
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
contract SessionRegistry {
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

    /// owner => nonce, to derive collision-free, un-front-runnable session ids.
    mapping(address => uint64) public nonces;

    /// The protocol fee recipient (the owner wallet). Set at deploy.
    address public immutable feeRecipient;

    /// Optional operator that may administratively close ANY session (used to
    /// wind down an abandoned game). Zero address disables it.
    address public operator;

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

    /// @param feeRecipient_ the wallet that receives session fees (the deployer).
    /// @param operator_ optional address allowed to force-close any session; may
    ///        be zero to disable that power entirely (recommended at first).
    constructor(address feeRecipient_, address operator_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        operator = operator_;
        emit OperatorSet(operator_);
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
    ///         that is not a live, properly-authorised seat.
    function canSign(bytes32 sessionId, uint8 seat, address who) external view returns (bool) {
        if (!isLive(sessionId)) return false;
        Session storage s = _sessions[sessionId];
        if (seat >= s.participantCount) return false;
        address a = _authority[sessionId][seat];
        return a != address(0) && a == who;
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
