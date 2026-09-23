// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EventOnlyCore — PROTOTYPE of the event-only handover/settle pattern.
///
/// @notice WHY THIS EXISTS: the midchain removed the per-move cost, but the
/// current core still stores data on-chain at open and settle (SSTORE is the
/// expensive opcode). The v5 guide's answer is "event-driven cheap gas": emit a
/// log instead of writing storage, and read history with eth_getLogs. This
/// contract does exactly that and NOTHING else, so we can MEASURE the floor
/// before deciding whether the real core should adopt it.
///
/// @dev IT IS A MEASUREMENT PROTOTYPE, NOT CORE. It has NO storage and therefore
/// no on-chain session state: there is no `isLive`, no authority map, no replay
/// guard. The truth is the emitted event plus the players' signatures, exactly as
/// the v5 guide describes. Those safety properties are the trade-off we are
/// pricing here. Do not deploy this as the rail.
contract EventOnlyCore {
    /// The whole handover is an event: sessionId, game, start hash, players,
    /// their session keys, and how many random seeds a move needs.
    event Handover(
        bytes32 indexed sessionId,
        address indexed gameLogic,
        bytes32 startHash,
        address[] players,
        address[] sessionKeys,
        uint16 randomCount,
        address indexed payer
    );

    /// The whole settlement is an event: the final hash plus who paid.
    event Settled(bytes32 indexed sessionId, bytes32 finalHash, address indexed payer);

    /// @notice Emit the session handover. No storage.
    function handover(
        bytes32 sessionId,
        address gameLogic,
        bytes32 startHash,
        address[] calldata players,
        address[] calldata sessionKeys,
        uint16 randomCount
    ) external {
        require(players.length == sessionKeys.length && players.length > 0, "bad players");
        emit Handover(sessionId, gameLogic, startHash, players, sessionKeys, randomCount, msg.sender);
    }

    /// @notice Verify each player signed the final hash, then emit the settlement.
    ///         No storage. `signers` are the expected player addresses; `sigs`
    ///         are their raw 65-byte signatures over the same digest.
    function settle(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external {
        require(sigs.length == signers.length && signers.length > 0, "bad sigs");
        bytes32 digest = keccak256(abi.encodePacked("FoskaayGGI", block.chainid, sessionId, finalHash));
        for (uint256 i = 0; i < signers.length; i++) {
            (bytes32 r, bytes32 s, uint8 v) = _split(sigs[i]);
            require(ecrecover(digest, v, r, s) == signers[i], "bad sig");
        }
        emit Settled(sessionId, finalHash, msg.sender);
    }

    /// @notice The digest a player signs to authorise a settlement. Exposed so a
    ///         client never has to guess the encoding.
    function settleDigest(bytes32 sessionId, bytes32 finalHash) external view returns (bytes32) {
        return keccak256(abi.encodePacked("FoskaayGGI", block.chainid, sessionId, finalHash));
    }

    function _split(bytes calldata sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "sig len");
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
    }
}
