// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SessionRegistry — Foskaay Gasless Games Infrastructure (Foskaay GGI), core 1 of 2.
///
/// @notice The room a game plays in. It connects a session (paying the fee), lets
/// every move run off the base chain for free, and settles the result. It knows
/// NOTHING about any game: no board, token, position, seat or dice. The game's
/// state is opaque bytes the rail never parses.
///
/// @notice THE MIDCHAIN (a set of tools inside Foskaay GGI, not a separate
/// product): a pure function runs for free via eth_call. So `random`/`randomN`
/// are pure and free, exactly like moves, lives and timers: the game derives its
/// randomness from the session's committed seed and a counter, at no extra cost
/// and with no separate randomness contract.
///
/// @notice FEE ENFORCEMENT: `handover` is payable and forwards the fee to the
/// FeeVault in the SAME transaction, so a session cannot start without paying.
/// `settle` refuses unless the FeeVault recorded that session as paid. The fee is
/// therefore inside the function a dev must call, and cannot be skipped.
///
/// @dev OPENZEPPELIN ONLY: upgradeability (UUPS + Initializable + Ownable) and
///      signature recovery (ECDSA) are the audited OpenZeppelin implementations.
///      ECDSA.recover rejects malleable and malformed signatures, so a tampered
///      settlement cannot pass.
///
/// @dev UPGRADEABLE (UUPS). Storage is APPEND-ONLY: new variables go at the top of
///      `__gap`, which shrinks by the same number of slots. `version` marks layout
///      changes. `initialize` replaces the constructor; the implementation is
///      `_disableInitializers()` so it can never be used directly.
contract SessionRegistry is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// The FeeVault that collects the per-session fee. Set once at initialize.
    address public feeVault;

    /// Layout marker. 0 on the first deployed layout; bump only on a layout change.
    uint8 public version;

    /// sessionId => the committed randomness seed, recorded at connect. This one
    /// slot is the session's "connected" marker AND the seed commitment, so:
    ///   - settle can prove the revealed seed is the one committed at connect
    ///     (no picking a winning seed after seeing play), and
    ///   - a session that never connected has a zero commit, so it can never
    ///     settle (the fee cannot be bypassed).
    /// APPEND-ONLY: this consumed one slot from __gap (20 -> 19).
    mapping(bytes32 => bytes32) public seedCommits;

    /// sessionId => settled. Guards against settling the same session twice.
    /// APPEND-ONLY: consumed a second slot from __gap (19 -> 18).
    mapping(bytes32 => bool) public revealed;

    /// Reserved slots for future variables. Consume from the top, shrink by the
    /// same count. DO NOT reorder or remove.
    uint256[18] private __gap;

    /// The connect event. It carries the game link (gameLogic) and the committed
    /// randomness seed, so no separate link transaction is needed and the Foskaay
    /// GGI Explorer can index it straight from eth_getLogs.
    event Handover(
        bytes32 indexed sessionId,
        address indexed gameLogic,
        bytes32 startHash,
        bytes32 seedCommit,
        address[] players,
        address[] sessionKeys,
        uint16 randomCount,
        address indexed payer
    );

    /// The settle event. `finalHash` may be one game's final hash or a whole
    /// session's Merkle root; `seedReveal` opens the committed seed.
    event Settled(bytes32 indexed sessionId, bytes32 finalHash, bytes32 seedReveal, address indexed payer);

    event FeeVaultSet(address feeVault);

    error FeeNotPaid();
    error BadSignature();
    error BadInput();
    error ZeroAddress();
    error BadReveal();
    error AlreadySettled();

    /// @notice Initialize the proxy.
    /// @param owner_ the upgrade/config owner (the project owner).
    /// @param feeVault_ the FeeVault that collects the per-session fee.
    function initialize(address owner_, address feeVault_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        feeVault = feeVault_;
        emit FeeVaultSet(feeVault_);
    }

    /// @dev The implementation contract can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the owner may authorize an upgrade. Move to a timelock/multisig
    ///      before mainnet.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Point at the FeeVault (owner only). Kept settable so a future
    ///         FeeVault upgrade, if it ever needs a new address, is config not code.
    function setFeeVault(address feeVault_) external onlyOwner {
        if (feeVault_ == address(0)) revert ZeroAddress();
        feeVault = feeVault_;
        emit FeeVaultSet(feeVault_);
    }

    // ------------------------------------------------------------- connect

    /// @notice Connect a session and pay the fee. `msg.value` must equal the
    ///         FeeVault's current fee; it is forwarded to the FeeVault in this
    ///         same transaction, so the session cannot start unpaid.
    function handover(
        bytes32 sessionId,
        address gameLogic,
        bytes32 startHash,
        bytes32 seedCommit,
        address[] calldata players,
        address[] calldata sessionKeys,
        uint16 randomCount
    ) external payable {
        if (players.length == 0 || players.length != sessionKeys.length) revert BadInput();
        if (seedCommits[sessionId] != bytes32(0)) revert BadInput(); // already connected
        seedCommits[sessionId] = seedCommit == bytes32(0) ? bytes32(uint256(1)) : seedCommit;
        IFeeVault(feeVault).deposit{value: msg.value}(sessionId);
        emit Handover(sessionId, gameLogic, startHash, seedCommit, players, sessionKeys, randomCount, msg.sender);
    }

    /// @notice Connect MANY sessions in ONE transaction. `msg.value` must equal
    ///         fee x count. One transaction keeps the cost down when batching.
    function handoverMany(
        bytes32[] calldata sessionIds,
        address gameLogic,
        bytes32[] calldata startHashes,
        bytes32[] calldata seedCommitList,
        address[][] calldata players,
        address[][] calldata sessionKeys,
        uint16 randomCount
    ) external payable {
        uint256 n = sessionIds.length;
        if (n == 0 || n != startHashes.length || n != seedCommitList.length || n != players.length || n != sessionKeys.length) revert BadInput();
        IFeeVault(feeVault).depositMany{value: msg.value}(sessionIds);
        for (uint256 i = 0; i < n; i++) {
            _connectOne(sessionIds[i], startHashes[i], seedCommitList[i], players[i], sessionKeys[i], gameLogic, randomCount);
        }
    }

    /// @dev One batch item, factored out so the batch loop stays within the EVM
    ///      stack limit.
    function _connectOne(
        bytes32 sessionId,
        bytes32 startHash,
        bytes32 seedCommit_,
        address[] calldata players,
        address[] calldata sessionKeys,
        address gameLogic,
        uint16 randomCount
    ) private {
        if (players.length == 0 || players.length != sessionKeys.length) revert BadInput();
        if (seedCommits[sessionId] != bytes32(0)) revert BadInput();
        seedCommits[sessionId] = seedCommit_ == bytes32(0) ? bytes32(uint256(1)) : seedCommit_;
        emit Handover(sessionId, gameLogic, startHash, seedCommit_, players, sessionKeys, randomCount, msg.sender);
    }

    // -------------------------------------------------------------- settle

    /// @notice Settle ONE session: every declared signer must have signed
    ///         (sessionId, finalHash), and the session must have been paid at
    ///         connect. Emits the result and reveals the seed.
    function settle(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes32 seedReveal,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external {
        _settleOne(sessionId, finalHash, seedReveal, sigs, signers);
    }

    /// @notice Settle MANY sessions in ONE transaction (the per-session batch:
    ///         one settle covers all the games inside a session via a Merkle root).
    function settleMany(
        bytes32[] calldata sessionIds,
        bytes32[] calldata finalHashes,
        bytes32[] calldata seedReveals,
        bytes[][] calldata sigs,
        address[][] calldata signers
    ) external {
        uint256 n = sessionIds.length;
        if (n == 0 || n != finalHashes.length || n != seedReveals.length || n != sigs.length || n != signers.length) revert BadInput();
        for (uint256 i = 0; i < n; i++) {
            _settleOne(sessionIds[i], finalHashes[i], seedReveals[i], sigs[i], signers[i]);
        }
    }

    // ---------------------------------------------------------------- reads

    /// @notice The exact digest a participant signs to authorise a settlement.
    ///         Bound to this contract and chain, so a signature cannot be replayed
    ///         elsewhere. Read it via eth_call so a client never guesses.
    function midchainDigest(bytes32 sessionId, bytes32 finalHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("FoskaayGGI", block.chainid, address(this), sessionId, finalHash));
    }

    // ------------------------------------------------------- free randomness

    /// @notice One free random seed: keccak(seed, counter). Pure, so it costs
    ///         nothing via eth_call. The game derives dice/cards/loot from it.
    function random(bytes32 seed, uint256 counter) public pure returns (bytes32) {
        return keccak256(abi.encode(seed, counter));
    }

    /// @notice N free random seeds in one call. Pure and free.
    function randomN(bytes32 seed, uint256 counter, uint256 count) public pure returns (bytes32[] memory out) {
        out = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = keccak256(abi.encode(seed, counter, i));
        }
    }

    // ------------------------------------------------------------- internal

    function _settleOne(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes32 seedReveal,
        bytes[] calldata sigs,
        address[] calldata signers
    ) private {
        if (!IFeeVault(feeVault).paid(sessionId)) revert FeeNotPaid();
        bytes32 commit = seedCommits[sessionId];
        if (commit == bytes32(0)) revert FeeNotPaid();     // never connected
        if (revealed[sessionId]) revert AlreadySettled();  // settle once
        // Prove the revealed seed is the one committed at connect. A seed of zero
        // means "no randomness declared", so the reveal must also be zero. A
        // non-zero commit must match keccak(seedReveal).
        if (commit != bytes32(uint256(1))) {
            if (keccak256(abi.encodePacked(seedReveal)) != commit) revert BadReveal();
        } else if (seedReveal != bytes32(0)) {
            revert BadReveal();
        }
        uint256 n = signers.length;
        if (n == 0 || n != sigs.length) revert BadInput();
        bytes32 digest = midchainDigest(sessionId, finalHash);
        for (uint256 i = 0; i < n; i++) {
            // OpenZeppelin ECDSA.recover rejects malleable/malformed signatures.
            if (ECDSA.recover(digest, sigs[i]) != signers[i]) revert BadSignature();
        }
        revealed[sessionId] = true;
        emit Settled(sessionId, finalHash, seedReveal, msg.sender);
    }
}

/// @dev The FeeVault surface this contract calls. Declared here so the core stays
///      decoupled from the FeeVault implementation.
interface IFeeVault {
    function deposit(bytes32 sessionId) external payable;
    function depositMany(bytes32[] calldata sessionIds) external payable;
    function paid(bytes32 sessionId) external view returns (bool);
}
