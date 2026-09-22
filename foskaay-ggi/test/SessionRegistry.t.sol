// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";

/// Minimal cheatcode interface (no forge-std dependency, matching the repo style).
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// Security + behaviour tests for SessionRegistry (Foskaay GGI core contract 1 of 4).
///
/// These tests exist because OTHER PROJECTS will depend on this rail. Anything
/// that could let a third party grief, hijack, replay or act-as-another is a
/// bug that would make GI the weak link, so each of those is asserted here.
contract SessionRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SessionRegistry reg;
    address constant OWNER = address(0xA11CE);      // a game operator
    address constant OTHER = address(0xB0B);        // an unrelated third party
    address constant RELAYER = address(0x5E1A);
    address constant KEY = address(0x5E55107);
    uint64 constant TTL = 1 hours;

    function setUp() public {
        reg = new SessionRegistry(address(this), address(0)); // this test = fee recipient, no operator
    }

    // ------------------------------------------------------------- happy path

    function testOpenCreatesLiveSession() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(4, TTL, bytes32("rules"), 0);

        SessionRegistry.Session memory s = reg.getSession(id);
        require(s.owner == OWNER, "owner");
        require(s.status == 1, "open");
        require(s.participantCount == 4, "seats");
        require(s.expiresAt == block.timestamp + TTL, "expiry");
        require(reg.isLive(id), "live");
    }

    function testIdsAreUniquePerOpen() public {
        vm.prank(OWNER);
        bytes32 a = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        bytes32 b = reg.open(2, TTL, 0, 0);
        require(a != b, "ids must differ");
    }

    function testSetAuthorityAndCanSign() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.setAuthority(id, 0, RELAYER);

        require(reg.canSign(id, 0, RELAYER), "relayer may sign seat 0");
        require(!reg.canSign(id, 1, RELAYER), "but not seat 1");
        require(!reg.canSign(id, 0, OTHER), "stranger may not sign");
    }

    function testSameAuthorityCanCoverSeveralSeats() public {
        // The rail does not care if one key runs several seats (house/AI seats).
        vm.prank(OWNER);
        bytes32 id = reg.open(4, TTL, 0, 0);
        vm.prank(OWNER);
        reg.setAuthority(id, 1, RELAYER);
        vm.prank(OWNER);
        reg.setAuthority(id, 2, RELAYER);
        require(reg.canSign(id, 1, RELAYER) && reg.canSign(id, 2, RELAYER), "both seats");
    }

    // ------------------------------------------------------- access control

    function testOnlyOwnerCanSetAuthority() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OTHER);
        vm.expectRevert();
        reg.setAuthority(id, 0, OTHER);
    }

    function testOnlyOwnerOrOperatorCanClose() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OTHER);
        vm.expectRevert();
        reg.close(id);
    }

    function testOwnerCanClose() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.close(id);
        require(!reg.isLive(id), "closed is not live");
        require(reg.getSession(id).closedAt != 0, "closedAt set");
    }

    // ------------------------------------------------------------- replay/DoS

    function testCannotReopenAClosedId() public {
        // Closing is one-way; the id stays closed forever (replay protection).
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.close(id);
        vm.prank(OWNER);
        vm.expectRevert();
        reg.close(id);
    }

    function testCannotSetAuthorityAfterClose() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.close(id);
        vm.prank(OWNER);
        vm.expectRevert();
        reg.setAuthority(id, 0, RELAYER);
    }

    function testCannotActAfterExpiry() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.warp(block.timestamp + TTL + 1);
        require(!reg.isLive(id), "expired is not live");
        vm.prank(OWNER);
        vm.expectRevert();
        reg.setAuthority(id, 0, RELAYER);
    }

    function testCannotActOnUnknownSession() public {
        require(!reg.isLive(bytes32("nope")), "unknown not live");
        require(!reg.canSign(bytes32("nope"), 0, OWNER), "unknown cannot sign");
    }

    // ------------------------------------------------------------- validation

    function testRejectsZeroParticipants() public {
        vm.prank(OWNER);
        vm.expectRevert();
        reg.open(0, TTL, 0, 0);
    }

    function testRejectsTooManyParticipants() public {
        vm.prank(OWNER);
        vm.expectRevert();
        reg.open(65, TTL, 0, 0);
    }

    function testRejectsZeroTtl() public {
        vm.prank(OWNER);
        vm.expectRevert();
        reg.open(2, 0, 0, 0);
    }

    function testRejectsTtlAboveCap() public {
        vm.prank(OWNER);
        vm.expectRevert();
        reg.open(2, 7 days + 1, 0, 0);
    }

    function testRejectsSeatOutOfRange() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        vm.expectRevert();
        reg.setAuthority(id, 2, RELAYER); // seats are 0..1 for a 2-seat session
    }

    function testRejectsZeroAuthority() public {
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        vm.expectRevert();
        reg.setAuthority(id, 0, address(0));
    }

    // ------------------------------------------------------------ operator

    function testOperatorCanForceClose() public {
        SessionRegistry r2 = new SessionRegistry(address(this), address(0xBEEF));
        vm.prank(OWNER);
        bytes32 id = r2.open(2, TTL, 0, 0);
        vm.prank(address(0xBEEF));
        r2.close(id);
        require(!r2.isLive(id), "operator closed");
    }

    function testOperatorDisabledByDefault() public {
        // With operator == 0 only the owner can close, so ANY non-owner reverts.
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OTHER);
        vm.expectRevert();
        reg.close(id);
    }

    // ------------------------------------------------------------- nonces

    function testNoncesAdvancePerOwner() public {
        vm.prank(OWNER);
        reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.open(2, TTL, 0, 0);
        require(reg.nonces(OWNER) == 2, "owner nonce");
        require(reg.nonces(OTHER) == 0, "other untouched");
    }

    function testConstructorRejectsZeroFeeRecipient() public {
        vm.expectRevert();
        new SessionRegistry(address(0), address(0));
    }

    // --------------------------------------------------------- session keys
    // A session key is an ephemeral signer the player registers once, so play
    // never pops a wallet. The on-chain half records scope + expiry, matching
    // MagicBlock's two-component model. These tests are the security proof.

    uint64 constant KEY_TTL = 1 hours;

    function _liveKeySession() internal returns (bytes32 id) {
        vm.prank(OWNER);
        id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.setAuthority(id, 0, OWNER); // this owner plays seat 0 themselves
    }

    function testRegisterAndUseSessionKey() public {
        bytes32 id = _liveKeySession();
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, bytes32("scope:ludo"));
        require(reg.isSessionKeyLive(KEY), "key live");
        require(reg.canSign(id, 0, KEY), "key signs owner's seat");
    }

    function testKeyInheritsOnlyItsOwnersSeats() public {
        // OWNER holds seat 0; OTHER holds seat 1. OWNER's key must not reach seat 1.
        bytes32 id = _liveKeySession();
        vm.prank(OWNER);
        reg.setAuthority(id, 1, OTHER);
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        require(reg.canSign(id, 0, KEY), "owner seat ok");
        require(!reg.canSign(id, 1, KEY), "cannot sign another owner's seat");
    }

    function testStrangerKeyCannotSign() public {
        bytes32 id = _liveKeySession();
        // A key registered by OTHER is no use for OWNER's seat.
        vm.prank(OTHER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        require(!reg.canSign(id, 0, KEY), "stranger key rejected");
    }

    function testRevokedKeyCannotSign() public {
        bytes32 id = _liveKeySession();
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        vm.prank(OWNER);
        reg.revokeSessionKey(KEY);
        require(!reg.isSessionKeyLive(KEY), "revoked is not live");
        require(!reg.canSign(id, 0, KEY), "revoked key rejected");
    }

    function testExpiredKeyCannotSign() public {
        bytes32 id = _liveKeySession();
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        vm.warp(uint64(block.timestamp) + KEY_TTL + 1);
        require(!reg.isSessionKeyLive(KEY), "expired is not live");
        require(!reg.canSign(id, 0, KEY), "expired key rejected");
    }

    function testOnlyOwnerCanRevokeOwnKey() public {
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        vm.prank(OTHER);
        vm.expectRevert();
        reg.revokeSessionKey(KEY);
    }

    function testCannotRevokeTwice() public {
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        vm.prank(OWNER);
        reg.revokeSessionKey(KEY);
        vm.prank(OWNER);
        vm.expectRevert();
        reg.revokeSessionKey(KEY);
    }

    function testCannotRegisterKeyWithPastExpiry() public {
        vm.prank(OWNER);
        vm.expectRevert();
        reg.registerSessionKey(KEY, uint64(block.timestamp), 0);
    }

    function testCannotRegisterZeroKey() public {
        vm.prank(OWNER);
        vm.expectRevert();
        reg.registerSessionKey(address(0), uint64(block.timestamp) + KEY_TTL, 0);
    }

    function testLiveKeyCannotBeStolenByReRegistration() public {
        // A key that is live and owned by OWNER cannot be re-registered by OTHER
        // to make it act for OTHER's seats.
        bytes32 id = _liveKeySession();
        vm.prank(OWNER);
        reg.setAuthority(id, 1, OTHER);
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        vm.prank(OTHER);
        vm.expectRevert();
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        require(!reg.canSign(id, 1, KEY), "still not OTHER's seat");
    }

    function testOwnerCanRotateKeyAfterRevocation() public {
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        vm.prank(OWNER);
        reg.revokeSessionKey(KEY);
        // Re-register the same address under the same owner: allowed.
        vm.prank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + 2 hours, bytes32("scope:2"));
        require(reg.isSessionKeyLive(KEY), "rotated key live");
        require(reg.sessionKeyOf(KEY).scopeHash == bytes32("scope:2"), "new scope");
    }

    function testKeyRegistrationIsCapped() public {
        uint8 cap = reg.MAX_SESSION_KEYS();
        vm.startPrank(OWNER);
        for (uint160 i = 0; i < cap; i++) {
            reg.registerSessionKey(address(0x1000 + i), uint64(block.timestamp) + KEY_TTL, 0);
        }
        vm.expectRevert();
        reg.registerSessionKey(address(0x9999), uint64(block.timestamp) + KEY_TTL, 0);
        vm.stopPrank();
    }

    function testKeysOfIsEnumerableForRevocation() public {
        vm.startPrank(OWNER);
        reg.registerSessionKey(KEY, uint64(block.timestamp) + KEY_TTL, 0);
        reg.registerSessionKey(address(0x7777), uint64(block.timestamp) + KEY_TTL, 0);
        vm.stopPrank();
        address[] memory keys = reg.keysOf(OWNER);
        require(keys.length == 2, "two keys");
        require(keys[0] == KEY && keys[1] == address(0x7777), "order preserved");
    }

    function testScopeIsOpaqueToTheRail() public {
        // The rail stores the scope hash and never interprets it: two keys with
        // totally different scopes behave identically.
        bytes32 id = _liveKeySession();
        vm.prank(OWNER);
        reg.registerSessionKey(address(0xAAA1), uint64(block.timestamp) + KEY_TTL, bytes32("idle:plots"));
        vm.prank(OWNER);
        reg.registerSessionKey(address(0xAAA2), uint64(block.timestamp) + KEY_TTL, bytes32("mmo:galaxy"));
        require(reg.canSign(id, 0, address(0xAAA1)), "scope A signs");
        require(reg.canSign(id, 0, address(0xAAA2)), "scope B signs");
        require(reg.sessionKeyOf(address(0xAAA1)).scopeHash == bytes32("idle:plots"), "stored verbatim");
    }
}
