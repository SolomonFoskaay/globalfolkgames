// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";

/// Minimal cheatcode interface (no forge-std dependency, matching the repo style).
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// Security + behaviour tests for SessionRegistry (GFG GI core contract 1 of 4).
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
}
