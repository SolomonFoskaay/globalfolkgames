// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "./SessionRegistry.sol";

/// @title Randomness — Foskaay Gasless Games Infrastructure (GGI), CORE contract 3 of 4.
///
/// @notice Commit-reveal randomness, for the games that ask for it. A game seals
/// one or more random seeds BEFORE play (only their hashes are committed at
/// OPEN), and REVEALS the real seeds at settle. Anyone can then check that the
/// revealed seed hashes to the committed value, and recompute every random
/// result the game showed, as `derive(seed, counter)`.
///
/// @dev WHY THIS EXISTS (Arc has no usable randomness): Arc's built-in random
///      function (PREVRANDAO) returns 0, a known EVM issue, so a game cannot ask
///      the chain for a die roll. The rail supplies it the safe way: a sealed
///      envelope before play, opened after play. Because the envelope is sealed
///      BEFORE anyone can know the seed, the game cannot adapt its outcome to it;
///      because it is opened AFTER play, everyone can prove every value came from
///      that one seed and was not chosen in hindsight. This is the Arc equivalent
///      of MagicBlock's ER VRF, without a VRF service.
///
/// @dev GAME-TYPE AGNOSTIC (Law 1): the rail never learns what a seed means. A
///      die roll, a monster spawn and a plot bonus are all "give me a number from
///      this seed". The number of seeds is a LIST so a game may declare several
///      independent streams (e.g. one per player's own deck); one is the default.
///
/// SECURITY MODEL:
///   - A seed can only be revealed AFTER the session is CLOSED, so a revealed
///     seed can never be used to adapt play still in progress (the core commit-
///     reveal guarantee).
///   - `reveal` checks keccak256(seed) == the session's committed seedCommit, so
///     a game cannot swap in a different seed after the fact.
///   - A zero seedCommit means the session declared no randomness; reveal is then
///     refused, so a game that asks for none cannot be given a fake one.
///   - Reveal is one-way and single-shot, so a revealed seed cannot be replaced.
///   - No external calls and no value held: no reentrancy surface, nothing to
///     drain. This contract is a pure verifier plus a small mapping.
///   - `derive` is a pure function, so a verifier can recompute it off-chain at
///     zero cost and cross-check on-chain if needed.
contract Randomness {
    SessionRegistry public immutable registry;

    /// sessionId => the revealed seed(s). Empty until revealed.
    mapping(bytes32 => bytes32[]) private _seeds;

    /// sessionId => whether this session's seed(s) have been revealed.
    mapping(bytes32 => bool) public revealed;

    event SeedRevealed(bytes32 indexed sessionId, address indexed by, uint8 streamCount, bytes32 seedHash);

    error UnknownOrOpenSession();
    error NoRandomnessDeclared();
    error SeedMismatch();
    error AlreadyRevealed();
    error NoSeeds();
    error EmptySeed();
    error TooManyStreams();

    /// Hard cap on streams per session, so reveal stays cheap and bounded.
    uint8 public constant MAX_STREAMS = 16;

    constructor(address registry_) {
        if (registry_ == address(0)) revert UnknownOrOpenSession();
        registry = SessionRegistry(registry_);
    }

    /// @notice Reveal the seed(s) for a session. Callable by ANYONE (no authority
    ///         gate): the seeds are a public proof, and the contract itself is
    ///         the referee that they match the commitment, so who submits them
    ///         does not matter. Refused until the session is CLOSED, so a seed
    ///         cannot be revealed while play is still in progress.
    /// @param sessionId the session whose seed is being opened.
    /// @param seeds one seed per stream. Stream 0 is the default; more streams
    ///        are allowed up to MAX_STREAMS. The game promised the SET of streams
    ///        by committing their combined hash at OPEN (see `commitHashOf`).
    function reveal(bytes32 sessionId, bytes32[] calldata seeds) external {
        SessionRegistry.Session memory s = registry.getSession(sessionId);
        // Must exist and be CLOSED (status 2): reveal is post-play only.
        if (s.status != 2) revert UnknownOrOpenSession();
        if (revealed[sessionId]) revert AlreadyRevealed();
        if (seeds.length == 0) revert NoSeeds();
        if (seeds.length > MAX_STREAMS) revert TooManyStreams();
        // A session that declared no randomness cannot be given one now.
        if (s.seedCommit == bytes32(0)) revert NoRandomnessDeclared();
        // Every seed must be non-zero, so a "revealed" stream always carries
        // real entropy (a zero seed would make derive() predictable).
        for (uint8 i = 0; i < seeds.length; i++) {
            if (seeds[i] == bytes32(0)) revert EmptySeed();
        }
        // The revealed set must match the commitment sealed at OPEN.
        if (commitHashOf(seeds) != s.seedCommit) revert SeedMismatch();

        revealed[sessionId] = true;
        bytes32[] storage store = _seeds[sessionId];
        for (uint8 i = 0; i < seeds.length; i++) {
            store.push(seeds[i]);
        }

        emit SeedRevealed(sessionId, msg.sender, uint8(seeds.length), s.seedCommit);
    }

    /// @notice The commitment a game seals at OPEN for a given stream set. The
    ///         game hashes its seeds with this exact function off-chain and passes
    ///         the result to SessionRegistry.open as `seedCommit`. Exposed so the
    ///         rule is public and reproducible, never a private convention.
    /// @dev Domain-separated ("gfg-gi-seed") and length-bound, so two different
    ///      stream sets cannot collide by concatenation (e.g. [a,b] vs [a||b]).
    function commitHashOf(bytes32[] calldata seeds) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("gfg-gi-seed", seeds.length, seeds));
    }

    /// @notice Derive a random value from a revealed seed stream. Pure: the same
    ///         inputs always give the same output, so a verifier can recompute it
    ///         off-chain for free and compare.
    /// @dev The counter is supplied by the game (e.g. the move number), so every
    ///      in-session random value has its own provable number with no per-value
    ///      on-chain cost. Never zero-seed safe, hence the zero-seed ban at reveal.
    function derive(bytes32 seed, uint64 counter) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("gfg-gi-derive", seed, counter));
    }

    /// @notice Derive from an ALREADY-REVEALED stream of a session, in one call.
    ///         Convenience for the game and the SDK; reverts if not yet revealed.
    function deriveFor(bytes32 sessionId, uint8 stream, uint64 counter) external view returns (bytes32) {
        bytes32[] storage seeds = _seeds[sessionId];
        if (stream >= seeds.length) revert NoSeeds();
        return derive(seeds[stream], counter);
    }

    /// @notice The revealed seeds for a session (empty until revealed).
    function seedsOf(bytes32 sessionId) external view returns (bytes32[] memory) {
        return _seeds[sessionId];
    }
}
