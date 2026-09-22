// @foskaay/ggi-contracts — Solidity interfaces for Foskaay Gasless Games Infrastructure (GGI).
//
// These are the FOUR core contracts. Copy them into your own contract, or import
// this package, and call them directly. Nothing here is opinionated: no account
// layout, no commit cadence, no game concept.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// CORE 1: open/close a session; participant authorities; session keys (scope + expiry).
interface ISessionRegistry {
    struct Session {
        address owner;
        uint8 status; // 0 = None, 1 = Open, 2 = Closed
        uint8 participantCount;
        uint64 createdAt;
        uint64 expiresAt;
        uint64 closedAt;
        bytes32 rulesHash;
        bytes32 seedCommit;
    }

    struct SessionKey {
        address owner;
        uint64 validUntil;
        bytes32 scopeHash;
        bool revoked;
    }

    function open(uint8 participantCount, uint64 ttlSecs, bytes32 rulesHash, bytes32 seedCommit)
        external
        returns (bytes32 sessionId);

    function setAuthority(bytes32 sessionId, uint8 seat, address authority) external;
    function close(bytes32 sessionId) external;
    function registerSessionKey(address key, uint64 validUntil, bytes32 scopeHash) external;
    function revokeSessionKey(address key) external;

    function getSession(bytes32 sessionId) external view returns (Session memory);
    function authorityOf(bytes32 sessionId, uint8 seat) external view returns (address);
    function setGameState(bytes32 sessionId, address stateAccount) external;
    function gameStateOf(bytes32 sessionId) external view returns (address);
    function isLive(bytes32 sessionId) external view returns (bool);
    function canSign(bytes32 sessionId, uint8 seat, address who) external view returns (bool);
    function isSessionKeyLive(address key) external view returns (bool);
    function sessionKeyOf(address key) external view returns (SessionKey memory);
}

/// CORE 2: accept signed session events (opaque payload + sequence + digest).
interface ISessionState {
    struct State {
        bytes32 digest;
        uint16 eventCount;
        uint64 lastSequence;
        bytes32 lastPayloadHash;
        bool committed;
    }

    function recordEvent(bytes32 sessionId, uint8 seat, uint64 sequence, bytes32 payloadHash) external;
    function commitDigest(bytes32 sessionId, bytes32 digest, uint16 eventCount) external;
    function sealFinal(bytes32 sessionId, bytes32 digest) external;

    function getState(bytes32 sessionId) external view returns (State memory);
    function digestOf(bytes32 sessionId) external view returns (bytes32);
    function finalDigest(bytes32 sessionId) external view returns (bytes32);
}

/// CORE 3: commit-reveal seed(s); derive hash(seed, counter). Used only if a game asks.
interface IRandomness {
    function declareStreams(bytes32 sessionId, uint8 count) external;
    function reveal(bytes32 sessionId, bytes32[] calldata seeds) external;

    function commitHashOf(bytes32[] calldata seeds) external pure returns (bytes32);
    function derive(bytes32 seed, uint64 counter) external pure returns (bytes32);
    function deriveFor(bytes32 sessionId, uint8 stream, uint64 counter) external view returns (bytes32);
    function seedsOf(bytes32 sessionId) external view returns (bytes32[] memory);
    function revealed(bytes32 sessionId) external view returns (bool);
    function streamCountOf(bytes32 sessionId) external view returns (uint8);
}

/// CORE 4: per-session fee collection; configurable destination.
interface IFeeVault {
    function chargeOpen(bytes32 sessionId) external;
    function chargeSettle(bytes32 sessionId) external;
    function withdraw(address token) external;

    function openFee() external view returns (uint256);
    function settleFee() external view returns (uint256);
    function feeToken() external view returns (address);
    function owner() external view returns (address);
    function destination() external view returns (address);
    function collected(address token) external view returns (uint256);
    function lockedSettleFee(bytes32 sessionId) external view returns (uint256);
    function paymentOf(bytes32 sessionId) external view returns (address openPayer, address settlePayer);
}
