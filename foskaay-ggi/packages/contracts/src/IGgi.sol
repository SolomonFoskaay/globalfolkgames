// @foskaay/ggi-contracts-sdk — Solidity interfaces for Foskaay Gasless Games Infrastructure (Foskaay GGI).
//
// Foskaay GGI is TWO core contracts. Import this package (or copy these
// interfaces) and call them directly. Nothing here is opinionated: no account
// layout, no commit cadence, no game concept. The rail never learns your game.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// CORE 1: the room. Connect a session (paying the fee), settle the result, and
/// get free pure randomness. Every move inside runs off-chain for free.
interface ISessionRegistry {
    /// Connect a session. `msg.value` must equal the FeeVault fee; it is forwarded
    /// to the FeeVault in this same transaction, so a session cannot start unpaid.
    function handover(
        bytes32 sessionId,
        address gameLogic,
        bytes32 startHash,
        bytes32 seedCommit,
        address[] calldata players,
        address[] calldata sessionKeys,
        uint16 randomCount
    ) external payable;

    /// Connect MANY sessions in one transaction (msg.value = fee x count).
    function handoverMany(
        bytes32[] calldata sessionIds,
        address gameLogic,
        bytes32[] calldata startHashes,
        bytes32[] calldata seedCommits,
        address[][] calldata players,
        address[][] calldata sessionKeys,
        uint16 randomCount
    ) external payable;

    /// Settle ONE session: every declared signer must have signed
    /// (sessionId, finalHash). `finalHash` may be one game's final hash or a
    /// whole session's Merkle root. Refused unless the session was paid.
    function settle(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes32 seedReveal,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external;

    /// Settle MANY sessions in one transaction.
    function settleMany(
        bytes32[] calldata sessionIds,
        bytes32[] calldata finalHashes,
        bytes32[] calldata seedReveals,
        bytes[][] calldata sigs,
        address[][] calldata signers
    ) external;

    /// The exact digest a participant signs to authorise a settlement. Bound to
    /// this contract and chain, so a signature cannot be replayed elsewhere.
    function midchainDigest(bytes32 sessionId, bytes32 finalHash) external view returns (bytes32);

    /// FREE randomness: keccak(seed, counter), computed via eth_call at no cost.
    function random(bytes32 seed, uint256 counter) external pure returns (bytes32);

    /// FREE randomness: N seeds in one call.
    function randomN(bytes32 seed, uint256 counter, uint256 count) external pure returns (bytes32[] memory);

    /// The FeeVault this registry forwards the fee to.
    function feeVault() external view returns (address);

    /// The upgrade/config owner.
    function owner() external view returns (address);
}

/// CORE 2: the cashier. Holds the per-session fee and lets the owner withdraw it.
/// ONLY the SessionRegistry can record a payment, so the fee cannot be bypassed.
interface IFeeVault {
    /// Record one paid session. Only the SessionRegistry may call it; msg.value
    /// must equal the fee. Normally reached through SessionRegistry.handover.
    function deposit(bytes32 sessionId) external payable;

    /// Record MANY paid sessions in one call (msg.value = fee x count).
    function depositMany(bytes32[] calldata sessionIds) external payable;

    /// Withdraw all collected native USDC to the destination (owner only).
    function withdraw() external;

    /// The per-session fee, in native USDC base units (18 decimals on Arc).
    function fee() external view returns (uint256);

    /// Whether a session was paid at connect.
    function paid(bytes32 sessionId) external view returns (bool);

    /// Same as `paid`, named for readability.
    function paymentOf(bytes32 sessionId) external view returns (bool);

    /// The only contract allowed to record a payment (the SessionRegistry).
    function sessionRegistry() external view returns (address);

    /// Native USDC collected and withdrawable.
    function collected() external view returns (uint256);

    /// Where withdrawals go.
    function destination() external view returns (address);

    /// The config owner.
    function owner() external view returns (address);
}
