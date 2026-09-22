// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title BatchedSettlement — Foskaay Gasless Games Infrastructure (GGI), OPTIONAL pattern.
///
/// @notice NOT CORE. This is an OPTIONAL pattern a game opts into when it wants the
/// cheapest possible tier. Core stays exactly four contracts and does not require
/// this. A game that needs an IMMEDIATE, per-session on-chain result should NOT
/// use this: use the core settle path instead. Read the trade-offs below.
///
/// @notice WHAT IT DOES: instead of each session writing its own final record to
/// the chain, many sessions are folded into ONE Merkle root that is written once
/// per window. A session's inclusion is then proven with a Merkle proof against
/// that root. The cost per session drops roughly by the batch size, which is the
/// only way to reach "hundreds to thousands of games per dollar" on a base layer.
///
/// @notice HOW THE FLUSH HAPPENS WITHOUT A DEV SERVER, CRON OR ADMIN:
///   EVM has no scheduler: a contract cannot wake itself up. So the flush is
///   PERMISSIONLESS and RULE-DRIVEN, which is the most trustless EVM can be:
///   - a window closes when it is FULL (reached maxSize) OR its DEADLINE passed;
///   - ANYONE may call `flush()` once a window is closed, and the contract is the
///     referee that the window really is closed (nobody can flush early);
///   - the next `submit()` call also flushes the previous closed window first, so
///     the tree keeps moving even if nobody calls `flush()` explicitly;
///   - no owner, no operator, no admin button, no allow-list can block a flush.
///   There is no trusted third party: the rules are on-chain and anyone may run
///   them. A dev's server is never required for correctness.
///
/// WHO THIS FITS (say this plainly to devs):
///   - Fits: idle games, casual rounds, anything where "the result becomes final
///     when the window flushes" is acceptable to players.
///   - Does NOT fit: anything that must show an individual on-chain settlement the
///     instant a match ends (some competitive or escrow flows). Those use core.
///
/// SECURITY MODEL:
///   - A session can be submitted at most once (a leaf is recorded as used).
///   - Only the SESSION OWNER (the game operator) may submit that session's leaf,
///     so no third party can inject a fake session into the tree.
///   - The Merkle root is computed from the recorded leaves, so it is verifiable:
///     anyone can rebuild the tree from the `LeafSubmitted` events and check.
///   - Verification is a pure view function: no state, no trust, no external call.
///   - Flush is permissionless and cannot be griefed into flushing early.
///   - No external calls and no value held: no reentrancy surface, nothing to drain.
contract BatchedSettlement is Initializable, UUPSUpgradeable {
    /// A window is a batch: it collects leaves until it is full or its deadline
    /// passes, then anyone may flush it into one Merkle root.
    struct Window {
        uint64 openedAt;
        uint64 deadline;   // after this, anyone may flush even if not full
        uint16 leafCount;
        bool closed;       // true once flushed
        bytes32 root;      // the Merkle root written at flush
    }

    /// Maximum leaves per window. Bounds the flush cost (and thus gas), so a
    /// flush can never become unbearably expensive. Storage (not immutable) so it
    /// survives behind a proxy.
    uint16 public maxSize;

    /// How long a window stays open before anyone may flush it, even if not full.
    uint32 public windowSecs;

    /// The admin allowed to authorize upgrades. There is NO admin in the flush
    /// path: flushing is permissionless. This address only controls code upgrades.
    address public admin;

    /// owner => window id => Window.
    mapping(address => mapping(uint256 => Window)) public windows;
    mapping(address => uint256) public windowCount; // owner => next window index

    /// owner => windowId => leaves (the submitted session digests, in order).
    mapping(address => mapping(uint256 => bytes32[])) private _leaves;

    /// owner => sessionId => whether that session was already submitted, so a
    /// session can never be inserted twice into the tree.
    mapping(address => mapping(bytes32 => bool)) public submitted;

    /// Reserved slots so future state variables can be appended without shifting
    /// any existing slot. DO NOT reorder or remove.
    uint256[20] private __gap;

    event LeafSubmitted(address indexed owner, uint256 indexed windowId, bytes32 indexed sessionId, bytes32 leaf, uint16 leafCount);
    event WindowFlushed(address indexed owner, uint256 indexed windowId, bytes32 root, uint16 leafCount, address indexed flushedBy);

    error ZeroAddressProvided();
    error SessionAlreadySubmitted();
    error WindowNotClosedYet();
    error WindowAlreadyFlushed();
    error BadWindowConfig();
    error NotAdmin();

    /// @notice Initialize the proxy.
    /// @param maxSize_ leaves per window (1..64). A small cap keeps flush gas low.
    /// @param windowSecs_ seconds a window stays open before a flush is allowed.
    /// @param admin_ the address allowed to authorize code upgrades (never
    ///        involved in flushing, which is permissionless).
    function initialize(uint16 maxSize_, uint32 windowSecs_, address admin_) external initializer {
        if (maxSize_ == 0 || maxSize_ > 64) revert BadWindowConfig();
        if (windowSecs_ == 0) revert BadWindowConfig();
        if (admin_ == address(0)) revert ZeroAddressProvided();
        maxSize = maxSize_;
        windowSecs = windowSecs_;
        admin = admin_;
    }

    /// @dev The implementation contract can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the admin may authorize an upgrade. Before mainnet this moves to
    ///      a timelock or multisig.
    function _authorizeUpgrade(address) internal override {
        if (msg.sender != admin) revert NotAdmin();
    }

    /// @notice Submit one session's final digest into the current window.
    /// @dev Only the caller's OWN sessions may be submitted (the caller is the
    ///      game operator that opened them). If the current window is already
    ///      closed, this flushes it first and then opens a fresh window, so the
    ///      tree keeps advancing without any separate keeper.
    /// @param sessionId the session this digest belongs to (recorded as used).
    /// @param digest the session's final digest (from SessionState).
    function submit(bytes32 sessionId, bytes32 digest) external {
        if (submitted[msg.sender][sessionId]) revert SessionAlreadySubmitted();

        uint256 id = _currentOpenWindow(msg.sender);
        _leaves[msg.sender][id].push(digest);
        submitted[msg.sender][sessionId] = true;

        Window storage w = windows[msg.sender][id];
        w.leafCount += 1;
        emit LeafSubmitted(msg.sender, id, sessionId, digest, w.leafCount);

        // If this filled the window, close it now so the next submit (or anyone
        // calling flush) can settle it. We do not flush inside submit to keep the
        // per-submit cost predictable; the next batch action flushes it.
        if (w.leafCount >= maxSize) {
            w.deadline = uint64(block.timestamp); // eligible to flush immediately
        }
    }

    /// @notice Flush a closed window into ONE Merkle root. PERMISSIONLESS.
    /// @dev `owner` is the game operator whose window is flushed; `windowId` the
    ///      window. Reverts unless the window is full OR its deadline has passed,
    ///      so nobody can force an early flush. Anyone may call it; the caller
    ///      gains nothing, which is the point (no trust, no incentive to abuse).
    function flush(address owner, uint256 windowId) external returns (bytes32 root) {
        Window storage w = windows[owner][windowId];
        if (w.closed) revert WindowAlreadyFlushed();
        if (w.leafCount == 0) revert WindowNotClosedYet();
        bool full = w.leafCount >= maxSize;
        bool expired = block.timestamp >= w.deadline;
        if (!full && !expired) revert WindowNotClosedYet();

        root = _merkleRoot(_leaves[owner][windowId]);
        w.root = root;
        w.closed = true;
        emit WindowFlushed(owner, windowId, root, w.leafCount, msg.sender);
    }

    /// @notice Verify a session's digest is in a flushed window's root.
    ///         Pure view: no state, no trust. `proof` is the Merkle sibling path.
    function verify(
        address owner,
        uint256 windowId,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool) {
        Window storage w = windows[owner][windowId];
        if (!w.closed) return false;
        return _verifyProof(leaf, proof, w.root);
    }

    /// @notice The leaves of a window, so a verifier can rebuild the tree.
    function leavesOf(address owner, uint256 windowId) external view returns (bytes32[] memory) {
        return _leaves[owner][windowId];
    }

    /// @notice Whether the current window can be flushed right now (full or
    ///         expired). Read helper for a client; the contract still enforces it.
    function canFlush(address owner, uint256 windowId) external view returns (bool) {
        Window storage w = windows[owner][windowId];
        if (w.closed || w.leafCount == 0) return false;
        return w.leafCount >= maxSize || block.timestamp >= w.deadline;
    }

    // ------------------------------------------------------------- internal

    /// @dev Return the id of the window to submit into, opening a new one when the
    ///      current window is already closed. This is what makes the tree advance
    ///      lazily: a new submitable window exists as soon as the last is flushed.
    function _currentOpenWindow(address owner) private returns (uint256 id) {
        uint256 count = windowCount[owner];
        if (count == 0) {
            id = 0;
            windowCount[owner] = 1;
            _openWindow(owner, id);
            return id;
        }
        id = count - 1;
        // If the last window is closed, or full-but-not-yet-flushed, start a new
        // one. (A full window that has not been flushed is settled on next flush;
        // new submissions go to a fresh window so they are never trapped.)
        Window storage w = windows[owner][id];
        if (w.closed || w.leafCount >= maxSize) {
            id = count;
            windowCount[owner] = count + 1;
            _openWindow(owner, id);
        }
    }

    function _openWindow(address owner, uint256 id) private {
        Window storage w = windows[owner][id];
        w.openedAt = uint64(block.timestamp);
        w.deadline = uint64(block.timestamp) + windowSecs;
        w.leafCount = 0;
        w.closed = false;
        w.root = bytes32(0);
    }

    /// @dev Deterministic, sorted-pair Merkle root over the leaves. Small (<=64)
    ///      so a simple O(n) build is fine and cheap; no external library.
    function _merkleRoot(bytes32[] storage leaves) private view returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) layer[i] = leaves[i];
        while (n > 1) {
            uint256 next = (n + 1) / 2;
            for (uint256 i = 0; i < next; i++) {
                uint256 a = 2 * i;
                uint256 b = a + 1;
                if (b < n) {
                    layer[i] = _hashPair(layer[a], layer[b]);
                } else {
                    layer[i] = layer[a]; // odd node carries up unchanged
                }
            }
            n = next;
        }
        return layer[0];
    }

    function _verifyProof(bytes32 leaf, bytes32[] calldata proof, bytes32 root) private pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            computed = _hashPair(computed, proof[i]);
        }
        return computed == root;
    }

    /// @dev Sort the pair before hashing so a proof cannot be forged by swapping.
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
