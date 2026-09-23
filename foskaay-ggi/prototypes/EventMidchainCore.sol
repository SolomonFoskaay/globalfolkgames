// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EventMidchainCore — the EVENT-BASED Foskaay GGI Midchain handover/settle.
///
/// @notice IT IS STILL THE Foskaay GGI Midchain. The Foskaay GGI Midchain is anything that is neither
/// fully on the base chain nor offchain: play happens off the base chain, but it
/// is cryptographically tied to it. This contract is the EVENT-BASED form of that
/// (the core's stored-session form is the STORAGE-BASED form). Same idea, cheaper
/// on-chain footprint: emit a log instead of writing storage, read it back with
/// eth_getLogs.
///
/// @notice WHY: the stored-session core writes the session struct with SSTORE at
/// open and settle, and SSTORE is the expensive opcode. The v5 guide's answer is
/// "event-driven cheap gas". This prototype does exactly that and adds BATCH
/// functions, so many games can be handed over and settled in ONE transaction.
///
/// @notice THE LINK IS BUILT IN. The `Handover` event carries sessionId, the
/// game's contract address (gameLogic), the start hash, the players and their
/// session keys. So there is NO separate link transaction: the session and the
/// game are bound in the same event, and the Foskaay GGI explorer can index it straight
/// from eth_getLogs. That is why this form is 2 txs per game, not 3.
///
/// @dev IT IS A MEASUREMENT PROTOTYPE, NOT CORE. It has NO storage, so there is
/// no on-chain `isLive`, no authority map and no replay guard. The truth is the
/// emitted event plus the players' signatures. A shipping version needs a small
/// nullifier to stop replay (see the handoff). Do not deploy this as the rail.
contract EventMidchainCore {
    /// The whole handover is an event: sessionId, game, start hash, players,
    /// their session keys, and how many random seeds a move needs. The game link
    /// lives HERE, so no extra transaction is needed.
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

    /// @notice Emit ONE session handover. No storage.
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

    /// @notice Emit MANY session handovers in ONE transaction. The per-game cost
    ///         drops because the 21k transaction base fee is shared.
    function handoverMany(
        bytes32[] calldata sessionIds,
        address gameLogic,
        bytes32[] calldata startHashes,
        address[][] calldata players,
        address[][] calldata sessionKeys,
        uint16 randomCount
    ) external {
        uint256 n = sessionIds.length;
        require(n > 0 && n == startHashes.length && n == players.length && n == sessionKeys.length, "bad batch");
        for (uint256 i = 0; i < n; i++) {
            require(players[i].length == sessionKeys[i].length && players[i].length > 0, "bad players");
            emit Handover(sessionIds[i], gameLogic, startHashes[i], players[i], sessionKeys[i], randomCount, msg.sender);
        }
    }

    /// @notice Verify ONE session's final signatures, then emit the settlement.
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

    /// @notice Verify MANY sessions' final signatures and emit all settlements in
    ///         ONE transaction. The per-game cost drops with the batch size.
    function settleMany(
        bytes32[] calldata sessionIds,
        bytes32[] calldata finalHashes,
        bytes[][] calldata sigs,
        address[][] calldata signers
    ) external {
        uint256 n = sessionIds.length;
        require(n > 0 && n == finalHashes.length && n == sigs.length && n == signers.length, "bad batch");
        for (uint256 i = 0; i < n; i++) {
            require(sigs[i].length == signers[i].length && signers[i].length > 0, "bad sigs");
            bytes32 digest = keccak256(abi.encodePacked("FoskaayGGI", block.chainid, sessionIds[i], finalHashes[i]));
            for (uint256 j = 0; j < signers[i].length; j++) {
                (bytes32 r, bytes32 s, uint8 v) = _split(sigs[i][j]);
                require(ecrecover(digest, v, r, s) == signers[i][j], "bad sig");
            }
            emit Settled(sessionIds[i], finalHashes[i], msg.sender);
        }
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
