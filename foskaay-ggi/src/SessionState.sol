// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "./SessionRegistry.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title SessionState — Foskaay Gasless Games Infrastructure (GGI), CORE contract 2 of 4.
///
/// @notice Accepts SIGNED session events and folds them into a running digest.
/// The rail NEVER reads the payload: a game's state is an opaque blob, and the
/// only thing the rail proves is that a properly AUTHORISED participant signed
/// a specific sequence of events. That is what makes it game-type agnostic (a
/// Ludo move, an idle-farm tick and an MMO world action are identical here).
///
/// @dev COST MODEL (why this is gasless in practice):
///   Recording an event ON-CHAIN costs gas, so games do NOT call this per move.
///   They keep the signed log off-chain and call `commitDigest` once (or at
///   whatever cadence THEY choose) to anchor the digest on-chain. `recordEvent`
///   exists for the cases a game genuinely wants a per-event anchor; nothing
///   forces it. Cadence is the developer's decision, never the rail's.
///
/// SECURITY MODEL:
///   - Authorisation is delegated to SessionRegistry.canSign, so there is ONE
///     source of truth for who may sign, and it cannot drift.
///   - Sequence numbers MUST be strictly increasing, so an event cannot be
///     replayed, reordered or duplicated.
///   - The digest is a rolling hash over (previous digest, seat, sequence,
///     keccak(payload)), so ANY change to any recorded event changes the digest
///     and breaks a later settlement.
///   - No external calls and no value held: no reentrancy surface, nothing to
///     drain. All functions are checks-effects-interactions free of ambiguity.
///   - Bounded storage per session (MAX_EVENTS) so a session cannot be used to
///     grief the chain with unbounded writes.
contract SessionState is Initializable, UUPSUpgradeable {
    /// Maximum anchored events per session. Generous for real use, bounded so
    /// storage can never grow without limit.
    uint16 public constant MAX_EVENTS = 512;

    /// The SessionRegistry this state contract authorises against. Storage (not
    /// immutable) so it survives behind a proxy.
    SessionRegistry public registry;

    /// Reserved slots so future state variables can be appended without shifting
    /// any existing slot. DO NOT reorder or remove.
    uint256[20] private __gap;

    struct State {
        bytes32 digest;         // rolling digest of everything anchored so far
        uint16 eventCount;      // number of anchored events
        uint64 lastSequence;    // last accepted sequence number (strictly increasing)
        bytes32 lastPayloadHash;// last anchored payload hash (for reference/proofs)
        bool committed;         // true once the final digest has been committed
    }

    mapping(bytes32 => State) private _state; // sessionId => State

    /// Optional per-session final summary written at settlement.
    mapping(bytes32 => bytes32) public finalDigest; // sessionId => committed final digest

    event EventRecorded(
        bytes32 indexed sessionId,
        uint8 indexed seat,
        uint64 sequence,
        bytes32 payloadHash,
        bytes32 digest
    );
    event DigestCommitted(bytes32 indexed sessionId, address indexed by, bytes32 digest, uint16 eventCount);

    error UnknownOrClosedSession();
    error NotAuthorisedSigner();
    error BadSequence();
    error TooManyEvents();
    error AlreadyCommitted();
    error AlreadyHasEvents();
    error AlreadySealed();
    error EmptyDigest();
    error EmptyPayload();

    /// @notice Initialize the proxy with the registry it authorises against.
    function initialize(address registry_) external initializer {
        if (registry_ == address(0)) revert UnknownOrClosedSession();
        registry = SessionRegistry(registry_);
    }

    /// @dev The implementation contract can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the registry owner (the protocol owner) may authorize an upgrade.
    function _authorizeUpgrade(address) internal override {
        if (msg.sender != registry.feeRecipient()) revert NotAuthorisedSigner();
    }

    /// @notice Anchor ONE signed event on-chain.
    /// @dev Games that want zero per-move gas should NOT call this per move;
    ///      they should keep the log off-chain and call `commitDigest` on their
    ///      own cadence. This function exists for games that choose otherwise.
    /// @param seat the participant seat the event belongs to.
    /// @param sequence a strictly increasing counter chosen by the game
    ///        (e.g. the move number). Prevents replay and reordering.
    /// @param payloadHash keccak256 of the game's opaque event payload.
    function recordEvent(bytes32 sessionId, uint8 seat, uint64 sequence, bytes32 payloadHash) external {
        SessionRegistry.Session memory s = registry.getSession(sessionId);
        if (s.status != 1) revert UnknownOrClosedSession(); // 1 = Open
        if (!registry.canSign(sessionId, seat, msg.sender)) revert NotAuthorisedSigner();

        State storage st = _state[sessionId];
        if (st.committed) revert AlreadyCommitted();
        if (st.eventCount >= MAX_EVENTS) revert TooManyEvents();
        // Strictly increasing: a later event may not reuse or go below the last
        // sequence. (The first event may use any starting sequence.)
        if (st.eventCount != 0 && sequence <= st.lastSequence) revert BadSequence();
        // AUDIT FIX (2026-09-21): reject a zero payload hash so an empty event
        // can never be anchored. Every real payload hashes to a non-zero value.
        if (payloadHash == bytes32(0)) revert EmptyPayload();

        bytes32 d = keccak256(abi.encodePacked(st.digest, seat, sequence, payloadHash));
        st.digest = d;
        st.lastSequence = sequence;
        st.lastPayloadHash = payloadHash;
        st.eventCount += 1;

        emit EventRecorded(sessionId, seat, sequence, payloadHash, d);
    }

    /// @notice Commit a digest computed OFF-chain (the gasless path). The caller
    ///         must be an authorised signer for at least one seat of the
    ///         session. This is how a game anchors a whole match for one tx.
    /// @dev AUDIT FIX (2026-09-21): this may ONLY be used when the session has NO
    ///      recorded on-chain events yet. Otherwise a signer could record real
    ///      events and then overwrite the running digest with an unrelated one,
    ///      discarding the recorded history. A session follows ONE of the two
    ///      paths: on-chain events (recordEvent) OR an off-chain digest.
    /// @param digest the running/final digest the game computed off-chain.
    /// @param eventCount how many events that digest covers (informational,
    ///        stored so a verifier knows the claimed length).
    function commitDigest(bytes32 sessionId, bytes32 digest, uint16 eventCount) external {
        SessionRegistry.Session memory s = registry.getSession(sessionId);
        if (s.status != 1) revert UnknownOrClosedSession();
        if (!_isAnyAuthority(sessionId, msg.sender, s.participantCount)) revert NotAuthorisedSigner();

        State storage st = _state[sessionId];
        if (st.committed) revert AlreadyCommitted();
        // AUDIT FIX: refuse to overwrite a digest that came from real on-chain
        // events, so recorded history can never be discarded.
        if (st.eventCount != 0) revert AlreadyHasEvents();
        if (digest == bytes32(0)) revert EmptyDigest();

        st.digest = digest;
        st.eventCount = eventCount;
        st.committed = true;

        emit DigestCommitted(sessionId, msg.sender, digest, eventCount);
    }

    /// @notice Seal a FINAL digest for a session (the settlement anchor). Only an
    ///         authorised signer may seal, and only once.
    /// @dev AUDIT FIX (2026-09-21): sealing now requires the session to be CLOSED
    ///      in the registry. Previously a signer could seal a "final" digest while
    ///      the session was still open (or even expired), so a premature or stale
    ///      result could be presented as final. Closing first makes the final
    ///      digest necessarily post-play.
    function sealFinal(bytes32 sessionId, bytes32 digest) external {
        SessionRegistry.Session memory s = registry.getSession(sessionId);
        // Must exist and be CLOSED (status 2). Open (1) and unknown (0) are refused.
        if (s.status != 2) revert UnknownOrClosedSession();
        if (!_isAnyAuthority(sessionId, msg.sender, s.participantCount)) revert NotAuthorisedSigner();
        if (digest == bytes32(0)) revert EmptyDigest();
        if (finalDigest[sessionId] != bytes32(0)) revert AlreadySealed();
        finalDigest[sessionId] = digest;
        emit DigestCommitted(sessionId, msg.sender, digest, _state[sessionId].eventCount);
    }

    // ---------------------------------------------------------------- reads

    function getState(bytes32 sessionId) external view returns (State memory) {
        return _state[sessionId];
    }

    function digestOf(bytes32 sessionId) external view returns (bytes32) {
        return _state[sessionId].digest;
    }

    /// @dev True if `who` is the authority of ANY seat in the session. Used by
    ///      the off-chain-digest path, where the signer is not tied to one seat.
    function _isAnyAuthority(bytes32 sessionId, address who, uint8 count) private view returns (bool) {
        for (uint8 i = 0; i < count; i++) {
            if (registry.authorityOf(sessionId, i) == who) return true;
        }
        return false;
    }
}
