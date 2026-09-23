// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function expectRevert() external;
}

/// The event-based midchain added to the core: handover/handoverMany and
/// settle/settleMany, additive and stateless (no stored session, no nullifier).
/// The storage-based paths are untouched and covered by SessionRegistry.t.sol.
contract SessionRegistryMidchainTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SessionRegistry reg;
    uint256 constant PK0 = 0xA11CE;
    uint256 constant PK1 = 0xB0B;
    address p0;
    address p1;

    function setUp() public {
        reg = Deploy.registry(address(this), address(0));
        p0 = vm.addr(PK0);
        p1 = vm.addr(PK1);
    }

    function _two() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = p0;
        a[1] = p1;
    }

    function testHandoverEmitsAndCarriesTheGameLink() public {
        reg.handover(bytes32("s1"), address(0x1234), bytes32("start"), _two(), _two(), 0);
    }

    function testHandoverRejectsMismatchedPlayers() public {
        address[] memory players = _two();
        address[] memory keys = new address[](1);
        keys[0] = p0;
        vm.expectRevert();
        reg.handover(bytes32("s1"), address(0x1234), bytes32("start"), players, keys, 0);
    }

    function testSettleVerifiesSignatures() public {
        bytes32 sid = bytes32("s1");
        bytes32 finalHash = bytes32("final");
        bytes32 digest = reg.midchainDigest(sid, finalHash);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK0, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, digest);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = abi.encodePacked(r0, s0, v0);
        sigs[1] = abi.encodePacked(r1, s1, v1);
        reg.settle(sid, finalHash, sigs, _two());
    }

    function testSettleRejectsForgedSignature() public {
        bytes32 sid = bytes32("s1");
        bytes32 finalHash = bytes32("final");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, reg.midchainDigest(sid, finalHash));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        address[] memory signers = new address[](1);
        signers[0] = p0;
        vm.expectRevert();
        reg.settle(sid, finalHash, sigs, signers);
    }

    function testSettleRejectsWrongFinalHash() public {
        bytes32 sid = bytes32("s1");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK0, reg.midchainDigest(sid, bytes32("final")));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        address[] memory signers = new address[](1);
        signers[0] = p0;
        vm.expectRevert();
        reg.settle(sid, bytes32("other"), sigs, signers);
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
            players[i] = _two();
            keys[i] = _two();
            signers[i] = _two();
            bytes32 digest = reg.midchainDigest(ids[i], finals[i]);
            (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK0, digest);
            (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, digest);
            bytes[] memory s = new bytes[](2);
            s[0] = abi.encodePacked(r0, s0, v0);
            s[1] = abi.encodePacked(r1, s1, v1);
            sigs[i] = s;
        }
        reg.handoverMany(ids, address(0x1234), starts, players, keys, 0);
        reg.settleMany(ids, finals, sigs, signers);
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
            signers[i] = _two();
            bytes32 digest = reg.midchainDigest(ids[i], finals[i]);
            uint256 k0 = i == 0 ? PK0 : 0xDEAD; // game 1 forged
            uint256 k1 = i == 0 ? PK1 : 0xDEAD;
            (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(k0, digest);
            (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(k1, digest);
            bytes[] memory s = new bytes[](2);
            s[0] = abi.encodePacked(r0, s0, v0);
            s[1] = abi.encodePacked(r1, s1, v1);
            sigs[i] = s;
        }
        vm.expectRevert();
        reg.settleMany(ids, finals, sigs, signers);
    }
}
