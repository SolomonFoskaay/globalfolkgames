// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EventMidchainCore} from "../prototypes/EventMidchainCore.sol";

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function expectRevert() external;
}

/// PROOF of the event-based midchain: handover and settle write NO storage, the
/// handover event itself carries the game link (no separate link tx), and settle
/// still refuses a forged or wrong signature. Batch functions are covered too.
contract EventMidchainCoreTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EventMidchainCore core;

    uint256 constant PK0 = 0xA11CE;
    uint256 constant PK1 = 0xB0B;
    address p0;
    address p1;

    function setUp() public {
        core = new EventMidchainCore();
        p0 = vm.addr(PK0);
        p1 = vm.addr(PK1);
    }

    function _twoPlayers() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = p0;
        a[1] = p1;
    }

    function testHandoverEmitsOnlyAndCarriesTheGameLink() public {
        address[] memory players = _twoPlayers();
        // The game link (gameLogic) is part of the event, so no separate link tx.
        core.handover(bytes32("s1"), address(0x1234), bytes32("start"), players, players, 0);
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
        core.settle(sessionId, finalHash, sigs, _twoPlayers());
    }

    function testSettleRejectsForgedSignature() public {
        bytes32 sessionId = bytes32("s1");
        bytes32 finalHash = bytes32("final");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, core.settleDigest(sessionId, finalHash));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        address[] memory signers = new address[](1);
        signers[0] = p0;
        vm.expectRevert();
        core.settle(sessionId, finalHash, sigs, signers);
    }

    function testHandoverManyAndSettleMany() public {
        uint256 n = 3;
        bytes32[] memory ids = new bytes32[](n);
        bytes32[] memory starts = new bytes32[](n);
        bytes32[] memory finals = new bytes32[](n);
        address[][] memory players = new address[][](n);
        address[][] memory keys = new address[][](n);
        bytes[][] memory sigs = new bytes[][](n);
        address[][] memory signers = new address[][](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = keccak256(abi.encodePacked("s", i));
            starts[i] = keccak256(abi.encodePacked("start", i));
            finals[i] = keccak256(abi.encodePacked("final", i));
            players[i] = _twoPlayers();
            keys[i] = _twoPlayers();
            signers[i] = _twoPlayers();
            bytes32 digest = core.settleDigest(ids[i], finals[i]);
            (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK0, digest);
            (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, digest);
            bytes[] memory s = new bytes[](2);
            s[0] = abi.encodePacked(r0, s0, v0);
            s[1] = abi.encodePacked(r1, s1, v1);
            sigs[i] = s;
        }
        core.handoverMany(ids, address(0x1234), starts, players, keys, 0);
        core.settleMany(ids, finals, sigs, signers);
    }

    function testSettleManyRejectsForgedSignature() public {
        uint256 n = 2;
        bytes32[] memory ids = new bytes32[](n);
        bytes32[] memory finals = new bytes32[](n);
        bytes[][] memory sigs = new bytes[][](n);
        address[][] memory signers = new address[][](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = keccak256(abi.encodePacked("s", i));
            finals[i] = keccak256(abi.encodePacked("final", i));
            signers[i] = _twoPlayers();
            bytes[] memory s = new bytes[](2);
            // game 0 is valid, game 1 is forged
            uint256 key0 = i == 0 ? PK0 : 0xDEAD;
            uint256 key1 = i == 0 ? PK1 : 0xDEAD;
            bytes32 digest = core.settleDigest(ids[i], finals[i]);
            (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(key0, digest);
            (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(key1, digest);
            s[0] = abi.encodePacked(r0, s0, v0);
            s[1] = abi.encodePacked(r1, s1, v1);
            sigs[i] = s;
        }
        vm.expectRevert();
        core.settleMany(ids, finals, sigs, signers);
    }
}
