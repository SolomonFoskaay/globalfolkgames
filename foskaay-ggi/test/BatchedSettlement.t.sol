// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BatchedSettlement} from "../src/BatchedSettlement.sol";
import {Deploy} from "./Deploy.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
}

/// Tests for BatchedSettlement (Foskaay GGI OPTIONAL pattern).
/// Focus: permissionless flush, no early flush, no double submit, real Merkle
/// verification, and that ANYONE can flush but nobody can force it early.
contract BatchedSettlementTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    BatchedSettlement bs;
    address constant GAME = address(0x6A3E);
    address constant ANYONE = address(0xB0B);
    uint16 constant MAX = 4;
    uint32 constant SECS = 1 hours;

    function setUp() public {
        bs = Deploy.batched(address(this));
        // The dev sets their OWN cadence: 4 leaves per window, 1h deadline.
        vm.prank(GAME);
        bs.setWindowConfig(MAX, SECS);
    }

    function _submitN(uint256 n) internal {
        vm.startPrank(GAME);
        for (uint256 i = 1; i <= n; i++) {
            bs.submit(bytes32(i), keccak256(abi.encodePacked("digest", i)));
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------- basic flow

    function testSubmitRecordsLeaf() public {
        _submitN(2);
        require(bs.windowCount(GAME) == 1, "one window");
        bytes32[] memory leaves = bs.leavesOf(GAME, 0);
        require(leaves.length == 2, "two leaves");
    }

    function testCannotSubmitSameSessionTwice() public {
        vm.startPrank(GAME);
        bs.submit(bytes32(uint256(1)), keccak256("a"));
        vm.expectRevert();
        bs.submit(bytes32(uint256(1)), keccak256("b"));
        vm.stopPrank();
    }

    function testCannotSubmitEmptyWindowFlush() public {
        vm.expectRevert();
        bs.flush(GAME, 0); // no window opened yet
    }

    // --------------------------------------------------- permissionless flush

    function testAnyoneCanFlushWhenFull() public {
        _submitN(MAX); // fills the window; deadline set to now
        vm.prank(ANYONE); // NOT the game, NOT an admin
        bs.flush(GAME, 0);
        require(bs.canFlush(GAME, 0) == false && bs.leavesOf(GAME, 0).length == MAX, "flushed by anyone");
    }

    function testCannotFlushBeforeFullOrDeadline() public {
        _submitN(2); // not full, deadline in the future
        vm.prank(ANYONE);
        vm.expectRevert();
        bs.flush(GAME, 0);
    }

    function testAnyoneCanFlushAfterDeadline() public {
        _submitN(2);
        vm.warp(block.timestamp + SECS + 1);
        vm.prank(ANYONE);
        bs.flush(GAME, 0);
        require(bs.canFlush(GAME, 0) == false, "flush after deadline");
    }

    function testCannotFlushTwice() public {
        _submitN(MAX);
        vm.prank(ANYONE);
        bs.flush(GAME, 0);
        vm.prank(ANYONE);
        vm.expectRevert();
        bs.flush(GAME, 0);
    }

    // --------------------------------------------------- lazy window advance

    function testNextSubmitOpensNewWindowAfterFull() public {
        _submitN(MAX); // window 0 full
        // A new submit must go into a fresh window (not trapped in the full one).
        vm.prank(GAME);
        bs.submit(bytes32(uint256(99)), keccak256("next"));
        require(bs.windowCount(GAME) == 2, "second window opened");
        require(bs.leavesOf(GAME, 1).length == 1, "leaf in window 1");
    }

    // ------------------------------------------------------------- Merkle proof

    function testVerifyProofAgainstFlushedRoot() public {
        // Build the same tree the contract does, sorted-pair, odd carried up.
        bytes32 l0 = keccak256(abi.encodePacked("digest", uint256(1)));
        bytes32 l1 = keccak256(abi.encodePacked("digest", uint256(2)));
        bytes32 l2 = keccak256(abi.encodePacked("digest", uint256(3)));
        bytes32 l3 = keccak256(abi.encodePacked("digest", uint256(4)));
        _submitN(MAX);
        vm.prank(ANYONE);
        bytes32 root = bs.flush(GAME, 0);

        // leaf0 proof: [l1, h(l2,l3)]
        bytes32 h01 = _pair(l0, l1);
        bytes32 h23 = _pair(l2, l3);
        bytes32[] memory proof0 = new bytes32[](2);
        proof0[0] = l1;
        proof0[1] = h23;
        require(bs.verify(GAME, 0, l0, proof0), "proof for leaf 0");
        require(_pair(h01, h23) == root, "root matches rebuild");

        // A WRONG leaf must not verify.
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = l1;
        require(!bs.verify(GAME, 0, keccak256("fake"), badProof), "fake leaf rejected");
    }

    function testVerifyFalseBeforeFlush() public {
        _submitN(2);
        bytes32[] memory p = new bytes32[](1);
        p[0] = keccak256("x");
        require(!bs.verify(GAME, 0, keccak256("y"), p), "not verifiable before flush");
    }

    function testCanFlushViewMatchesRule() public {
        _submitN(2);
        require(!bs.canFlush(GAME, 0), "not flushable yet");
        vm.warp(block.timestamp + SECS + 1);
        require(bs.canFlush(GAME, 0), "flushable after deadline");
    }

    // ------------------------------------------------------------- config

    function testInitializeRejectsZeroAdmin() public {
        BatchedSettlement impl = new BatchedSettlement();
        vm.expectRevert();
        new ERC1967Proxy(address(impl), abi.encodeCall(BatchedSettlement.initialize, (address(0))));
    }

    function testRejectsBadWindowConfig() public {
        // A dev cannot set an impossible cadence (0 size or 0 seconds).
        vm.prank(GAME);
        vm.expectRevert();
        bs.setWindowConfig(0, SECS);
        vm.prank(GAME);
        vm.expectRevert();
        bs.setWindowConfig(MAX, 0);
    }

    function testCannotSubmitBeforeConfigSet() public {
        // A game must set its cadence before submitting (the rail does not guess).
        vm.prank(address(0x9999));
        vm.expectRevert();
        bs.submit(bytes32(uint256(1)), keccak256("x"));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
