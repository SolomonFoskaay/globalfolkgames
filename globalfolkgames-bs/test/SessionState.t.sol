// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {SessionState} from "../src/SessionState.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
}

/// Security + behaviour tests for SessionState (GFG GI core contract 2 of 4).
/// Focus: authorisation cannot be bypassed, events cannot be replayed or
/// reordered, digests change when anything changes, and bounded storage holds.
contract SessionStateTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SessionRegistry reg;
    SessionState st;
    address constant OWNER = address(0xA11CE);
    address constant P1 = address(0x1111);
    address constant P2 = address(0x2222);
    address constant STRANGER = address(0xBAD0);
    uint64 constant TTL = 1 hours;

    function setUp() public {
        reg = new SessionRegistry(address(this), address(0));
        st = new SessionState(address(reg));

        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.setAuthority(id, 0, P1);
        vm.prank(OWNER);
        reg.setAuthority(id, 1, P2);
    }

    function _newSession() internal returns (bytes32 id) {
        vm.prank(OWNER);
        id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.setAuthority(id, 0, P1);
        vm.prank(OWNER);
        reg.setAuthority(id, 1, P2);
    }

    // ------------------------------------------------------------- happy path

    function testAuthorisedSeatCanRecord() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.recordEvent(id, 0, 1, keccak256("move1"));
        require(st.getState(id).eventCount == 1, "count");
        require(st.getState(id).lastSequence == 1, "seq");
    }

    function testDigestChangesWithPayload() public {
        bytes32 a = _newSession();
        bytes32 b = _newSession();
        vm.prank(P1);
        st.recordEvent(a, 0, 1, keccak256("move1"));
        vm.prank(P1);
        st.recordEvent(b, 0, 1, keccak256("DIFFERENT"));
        require(st.digestOf(a) != st.digestOf(b), "digest must differ");
    }

    function testDigestChains() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.recordEvent(id, 0, 1, keccak256("m1"));
        bytes32 after1 = st.digestOf(id);
        vm.prank(P2);
        st.recordEvent(id, 1, 2, keccak256("m2"));
        bytes32 after2 = st.digestOf(id);
        require(after1 != after2, "chained digest must change");
        require(after1 != bytes32(0) && after2 != bytes32(0), "nonzero");
    }

    // ------------------------------------------------------- authorisation

    function testStrangerCannotRecord() public {
        bytes32 id = _newSession();
        vm.prank(STRANGER);
        vm.expectRevert();
        st.recordEvent(id, 0, 1, keccak256("x"));
    }

    function testSeatCannotSignForAnotherSeat() public {
        // P1 holds seat 0; recording as seat 1 must fail.
        bytes32 id = _newSession();
        vm.prank(P1);
        vm.expectRevert();
        st.recordEvent(id, 1, 1, keccak256("x"));
    }

    function testCannotRecordOnUnknownSession() public {
        vm.prank(P1);
        vm.expectRevert();
        st.recordEvent(bytes32("nope"), 0, 1, keccak256("x"));
    }

    function testCannotRecordEmptyPayload() public {
        // AUDIT FIX: a zero payload hash is not a real event and is refused.
        bytes32 id = _newSession();
        vm.prank(P1);
        vm.expectRevert();
        st.recordEvent(id, 0, 1, bytes32(0));
    }

    function testCannotRecordAfterExpiry() public {
        bytes32 id = _newSession();
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(P1);
        vm.expectRevert();
        st.recordEvent(id, 0, 1, keccak256("x"));
    }

    function testCannotRecordAfterClose() public {
        bytes32 id = _newSession();
        vm.prank(OWNER);
        reg.close(id);
        vm.prank(P1);
        vm.expectRevert();
        st.recordEvent(id, 0, 1, keccak256("x"));
    }

    // ------------------------------------------------------ replay / order

    function testCannotReplaySameSequence() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.recordEvent(id, 0, 5, keccak256("m"));
        vm.prank(P1);
        vm.expectRevert();
        st.recordEvent(id, 0, 5, keccak256("m")); // same sequence = replay
    }

    function testCannotGoBackwards() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.recordEvent(id, 0, 5, keccak256("m"));
        vm.prank(P2);
        vm.expectRevert();
        st.recordEvent(id, 1, 4, keccak256("m2"));
    }

    function testForwardSequenceAllowed() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.recordEvent(id, 0, 10, keccak256("a"));
        vm.prank(P2);
        st.recordEvent(id, 1, 11, keccak256("b"));
        require(st.getState(id).eventCount == 2, "two events");
    }

    // --------------------------------------------------- off-chain commit

    function testAuthorisedCanCommitDigest() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.commitDigest(id, keccak256("whole-match"), 120);
        require(st.getState(id).committed, "committed");
        require(st.getState(id).eventCount == 120, "count from digest");
    }

    function testStrangerCannotCommitDigest() public {
        bytes32 id = _newSession();
        vm.prank(STRANGER);
        vm.expectRevert();
        st.commitDigest(id, keccak256("x"), 1);
    }

    function testCannotCommitTwice() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.commitDigest(id, keccak256("a"), 1);
        vm.prank(P1);
        vm.expectRevert();
        st.commitDigest(id, keccak256("b"), 2);
    }

    function testCannotRecordAfterCommit() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        st.commitDigest(id, keccak256("a"), 1);
        vm.prank(P1);
        vm.expectRevert();
        st.recordEvent(id, 0, 2, keccak256("late"));
    }

    function testCannotCommitDigestOverRecordedEvents() public {
        // AUDIT FIX: an off-chain digest may not overwrite history that was built
        // from real on-chain events, or recorded events would be discarded.
        bytes32 id = _newSession();
        vm.prank(P1);
        st.recordEvent(id, 0, 1, keccak256("real"));
        vm.prank(P1);
        vm.expectRevert();
        st.commitDigest(id, keccak256("fake"), 99);
    }

    function testCannotCommitEmptyDigest() public {
        bytes32 id = _newSession();
        vm.prank(P1);
        vm.expectRevert();
        st.commitDigest(id, bytes32(0), 1);
    }

    // --------------------------------------------------------- final seal

    function testAuthorisedCanSealFinal() public {
        // AUDIT FIX: sealing is post-play, so the session must be CLOSED first.
        bytes32 id = _newSession();
        vm.prank(OWNER);
        reg.close(id);
        vm.prank(P2);
        st.sealFinal(id, keccak256("final"));
        require(st.finalDigest(id) == keccak256("final"), "sealed");
    }

    function testCannotSealTwice() public {
        bytes32 id = _newSession();
        vm.prank(OWNER);
        reg.close(id);
        vm.prank(P1);
        st.sealFinal(id, keccak256("final"));
        vm.prank(P1);
        vm.expectRevert();
        st.sealFinal(id, keccak256("other"));
    }

    function testStrangerCannotSeal() public {
        bytes32 id = _newSession();
        vm.prank(STRANGER);
        vm.expectRevert();
        st.sealFinal(id, keccak256("final"));
    }

    function testCannotSealWhileOpen() public {
        // AUDIT FIX: an open session cannot be sealed, so a premature result can
        // never be presented as final.
        bytes32 id = _newSession();
        vm.prank(P1);
        vm.expectRevert();
        st.sealFinal(id, keccak256("premature"));
    }

    function testCannotSealExpiredOpenSession() public {
        // AUDIT FIX: expiry alone does not make a result final; the session must
        // still be CLOSED, so a stale open session cannot be sealed.
        bytes32 id = _newSession();
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(P1);
        vm.expectRevert();
        st.sealFinal(id, keccak256("stale"));
    }

    function testCannotSealUnknownSession() public {
        vm.prank(P1);
        vm.expectRevert();
        st.sealFinal(bytes32("nope"), keccak256("final"));
    }

    function testCannotSealEmptyDigest() public {
        bytes32 id = _newSession();
        vm.prank(OWNER);
        reg.close(id);
        vm.prank(P1);
        vm.expectRevert();
        st.sealFinal(id, bytes32(0));
    }

    // ------------------------------------------------------------ bounds

    function testEventCapEnforced() public {
        bytes32 id = _newSession();
        uint16 cap = st.MAX_EVENTS();
        vm.startPrank(P1);
        for (uint64 i = 1; i <= cap; i++) {
            st.recordEvent(id, 0, i, bytes32(uint256(i)));
        }
        // The next one is over the cap and must revert.
        vm.expectRevert();
        st.recordEvent(id, 0, uint64(cap) + 1, bytes32("over"));
        vm.stopPrank();
    }

    function testConstructorRejectsZeroRegistry() public {
        vm.expectRevert();
        new SessionState(address(0));
    }

    function testManySeatsCommitIsBounded() public {
        // Loop cost is bounded by participantCount (max 64). Verify a 64-seat
        // session can still commit, so no griefing by many seats.
        vm.prank(OWNER);
        bytes32 id = reg.open(64, TTL, 0, 0);
        vm.prank(OWNER);
        reg.setAuthority(id, 63, P1);
        vm.prank(P1);
        st.commitDigest(id, keccak256("big"), 1);
        require(st.getState(id).committed, "64-seat commit works");
    }
}
