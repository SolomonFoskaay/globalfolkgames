// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Randomness} from "../src/Randomness.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
}

/// Security + behaviour tests for Randomness (Foskaay GGI core contract 3 of 4).
/// Focus: a seed cannot be revealed before play ends, a game cannot swap the
/// seed, no randomness can be invented where none was declared, and derivation
/// is deterministic and reproducible by a verifier.
contract RandomnessTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SessionRegistry reg;
    Randomness rnd;
    address constant OWNER = address(0xA11CE);
    address constant STRANGER = address(0xBAD0);
    uint64 constant TTL = 1 hours;

    function _openWithSeed(bytes32[] memory seeds) internal returns (bytes32 id) {
        // Compute the commitment BEFORE the prank: a staticcall inside the prank
        // would consume it and open() would run as the test contract, not OWNER.
        bytes32 commitment = rnd.commitHashOf(seeds);
        vm.prank(OWNER);
        id = reg.open(2, TTL, 0, commitment);
    }

    function _seed(bytes32 a) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](1);
        s[0] = a;
    }

    function setUp() public {
        reg = new SessionRegistry(address(this), address(0));
        rnd = new Randomness(address(reg));
    }

    // ------------------------------------------------------------- happy path

    function testRevealAfterCloseMatchesCommitment() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        rnd.reveal(id, seeds);
        require(rnd.revealed(id), "revealed");
        require(rnd.seedsOf(id)[0] == seeds[0], "seed stored");
    }

    function testRevealIsPermissionless() public {
        // Anyone may submit the reveal; the commitment is the referee, not msg.sender.
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        vm.prank(STRANGER);
        rnd.reveal(id, seeds);
        require(rnd.revealed(id), "stranger may reveal");
    }

    function testMultipleStreamsReveal() public {
        bytes32[] memory seeds = new bytes32[](3);
        seeds[0] = keccak256("s0");
        seeds[1] = keccak256("s1");
        seeds[2] = keccak256("s2");
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        rnd.reveal(id, seeds);
        require(rnd.seedsOf(id).length == 3, "three streams");
        require(rnd.deriveFor(id, 2, 0) == rnd.derive(seeds[2], 0), "stream 2 derives");
    }

    function testDeriveIsDeterministicAndCounterSensitive() public {
        bytes32 seed = keccak256("seed");
        require(rnd.derive(seed, 1) == rnd.derive(seed, 1), "same inputs, same output");
        require(rnd.derive(seed, 1) != rnd.derive(seed, 2), "counter changes output");
        require(rnd.derive(seed, 1) != rnd.derive(keccak256("other"), 1), "seed changes output");
    }

    // ------------------------------------------------------- commit-reveal law

    function testCannotRevealWhileOpen() public {
        // The whole guarantee: no seed is revealed while play can still adapt.
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.expectRevert();
        rnd.reveal(id, seeds);
    }

    function testCannotRevealExpiredButOpen() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert();
        rnd.reveal(id, seeds);
    }

    function testCannotRevealUnknownSession() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        vm.expectRevert();
        rnd.reveal(bytes32("nope"), seeds);
    }

    function testCannotRevealWrongSeed() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        bytes32[] memory fakes = _seed(keccak256("different"));
        vm.expectRevert();
        rnd.reveal(id, fakes);
    }

    function testCannotRevealTwice() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        rnd.reveal(id, seeds);
        vm.expectRevert();
        rnd.reveal(id, seeds);
    }

    function testCannotRevealWhereNoRandomnessDeclared() public {
        // open() with seedCommit == 0 means "this game asked for no randomness".
        vm.prank(OWNER);
        bytes32 id = reg.open(2, TTL, 0, 0);
        vm.prank(OWNER);
        reg.close(id);
        bytes32[] memory seeds = _seed(keccak256("sneaky"));
        vm.expectRevert();
        rnd.reveal(id, seeds);
    }

    function testCannotRevealEmptySeed() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        bytes32[] memory zero = _seed(bytes32(0));
        vm.expectRevert();
        rnd.reveal(id, zero);
    }

    function testCannotRevealNoSeeds() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert();
        rnd.reveal(id, none);
    }

    function testCannotRevealTooManyStreams() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        bytes32[] memory tooMany = new bytes32[](rnd.MAX_STREAMS() + 1);
        for (uint8 i = 0; i < tooMany.length; i++) tooMany[i] = bytes32(uint256(i + 1));
        vm.expectRevert();
        rnd.reveal(id, tooMany);
    }

    // ----------------------------------------------------- commitment hygiene

    function testCommitmentIsStreamCountBound() public {
        // [a, b] must not collide with a single seed equal to a||b.
        bytes32[] memory two = new bytes32[](2);
        two[0] = keccak256("a");
        two[1] = keccak256("b");
        bytes32[] memory one = _seed(keccak256(abi.encodePacked(keccak256("a"), keccak256("b"))));
        require(rnd.commitHashOf(two) != rnd.commitHashOf(one), "length bound");
    }

    function testCommitmentIsOrderSensitive() public {
        bytes32[] memory ab = new bytes32[](2);
        ab[0] = keccak256("a");
        ab[1] = keccak256("b");
        bytes32[] memory ba = new bytes32[](2);
        ba[0] = keccak256("b");
        ba[1] = keccak256("a");
        require(rnd.commitHashOf(ab) != rnd.commitHashOf(ba), "order matters");
    }

    function testDeriveForRevertsBeforeReveal() public {
        bytes32[] memory seeds = _seed(keccak256("seed-1"));
        bytes32 id = _openWithSeed(seeds);
        vm.prank(OWNER);
        reg.close(id);
        vm.expectRevert();
        rnd.deriveFor(id, 0, 1);
    }

    function testConstructorRejectsZeroRegistry() public {
        vm.expectRevert();
        new Randomness(address(0));
    }
}
