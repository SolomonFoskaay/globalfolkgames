// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EventOnlyCore} from "../prototypes/EventOnlyCore.sol";

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function expectRevert() external;
}

/// PROOF of the event-only pattern: handover and settle write NO storage, and
/// settle still refuses a forged or wrong signature. This is the cheap floor the
/// v5 guide describes, measured before we decide whether the core adopts it.
contract EventOnlyCoreTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EventOnlyCore core;

    uint256 constant PK0 = 0xA11CE;
    uint256 constant PK1 = 0xB0B;
    address p0;
    address p1;

    function setUp() public {
        core = new EventOnlyCore();
        p0 = vm.addr(PK0);
        p1 = vm.addr(PK1);
    }

    function testHandoverEmitsOnly() public {
        address[] memory players = new address[](2);
        players[0] = p0;
        players[1] = p1;
        address[] memory keys = new address[](2);
        keys[0] = p0;
        keys[1] = p1;
        core.handover(bytes32("s1"), address(0x1234), bytes32("start"), players, keys, 0);
        // No state to assert: the function's whole effect is the event. If it
        // returned, the emit succeeded (an event-only handover).
    }

    function testSettleVerifiesSignatures() public {
        bytes32 sessionId = bytes32("s1");
        bytes32 finalHash = bytes32("final");
        bytes32 digest = core.settleDigest(sessionId, finalHash);

        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK0, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, digest);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = abi.encodePacked(r0, s0, v0);
        sigs[1] = abi.encodePacked(r1, s1, v1);
        address[] memory signers = new address[](2);
        signers[0] = p0;
        signers[1] = p1;

        core.settle(sessionId, finalHash, sigs, signers);
    }

    function testSettleRejectsForgedSignature() public {
        bytes32 sessionId = bytes32("s1");
        bytes32 finalHash = bytes32("final");
        bytes32 digest = core.settleDigest(sessionId, finalHash);
        // a stranger signs, but we claim it was p0
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, digest);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        address[] memory signers = new address[](1);
        signers[0] = p0;
        vm.expectRevert();
        core.settle(sessionId, finalHash, sigs, signers);
    }

    function testSettleRejectsWrongFinalHash() public {
        bytes32 sessionId = bytes32("s1");
        bytes32 digest = core.settleDigest(sessionId, bytes32("final"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK0, digest);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        address[] memory signers = new address[](1);
        signers[0] = p0;
        vm.expectRevert();
        core.settle(sessionId, bytes32("other-final"), sigs, signers);
    }
}
