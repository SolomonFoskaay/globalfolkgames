// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function sign(uint256, bytes32) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256) external pure returns (address);
}

/// The clean core: connect (fee enforced), free randomness, settle (signatures
/// verified with OpenZeppelin ECDSA). Storage-based paths are gone.
contract SessionRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant FEE = 1e15; // 0.001 native USDC (18 decimals)
    uint256 constant PK0 = 0xA11CE;
    uint256 constant PK1 = 0xB0B;
    bytes32 constant SID = keccak256("session-1");

    SessionRegistry reg;
    FeeVault vault;
    address p0;
    address p1;

    function setUp() public {
        (reg, vault) = Deploy.core(address(this), address(0xBEEF), FEE);
        vm.deal(address(this), 100 ether);
        p0 = vm.addr(PK0);
        p1 = vm.addr(PK1);
    }

    function _players() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = p0;
        a[1] = p1;
    }

    function _connect() internal {
        reg.handover{value: FEE}(SID, address(0x1234), bytes32("start"), bytes32("seed"), _players(), _players(), 1);
    }

    function _sigs(bytes32 digest) internal pure returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK0, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, digest);
        sigs[0] = abi.encodePacked(r0, s0, v0);
        sigs[1] = abi.encodePacked(r1, s1, v1);
    }

    function testHandoverRequiresTheExactFee() public {
        vm.expectRevert(FeeVault.BadFee.selector);
        reg.handover{value: FEE - 1}(SID, address(0x1234), bytes32("start"), bytes32("seed"), _players(), _players(), 1);

        reg.handover{value: FEE}(SID, address(0x1234), bytes32("start"), bytes32("seed"), _players(), _players(), 1);
        require(vault.paid(SID), "session recorded as paid");
        require(vault.collected() == FEE, "fee collected");
    }

    function testSettleRefusedWhenNotPaid() public {
        bytes32 digest = reg.midchainDigest(SID, bytes32("final"));
        vm.expectRevert(SessionRegistry.FeeNotPaid.selector);
        reg.settle(SID, bytes32("final"), bytes32("seed"), _sigs(digest), _players());
    }

    function testSettleVerifiesSignatures() public {
        _connect();
        bytes32 finalHash = bytes32("final");
        bytes32 digest = reg.midchainDigest(SID, finalHash);
        reg.settle(SID, finalHash, bytes32("seed"), _sigs(digest), _players());
    }

    function testSettleRejectsForgedSignature() public {
        _connect();
        bytes32 finalHash = bytes32("final");
        bytes32 digest = reg.midchainDigest(SID, finalHash);
        bytes[] memory sigs = new bytes[](2);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(0xDEAD, digest); // stranger
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, digest);
        sigs[0] = abi.encodePacked(r0, s0, v0);
        sigs[1] = abi.encodePacked(r1, s1, v1);
        vm.expectRevert();
        reg.settle(SID, finalHash, bytes32("seed"), sigs, _players());
    }

    function testSettleRejectsWrongFinalHash() public {
        _connect();
        bytes32 digest = reg.midchainDigest(SID, bytes32("final"));
        vm.expectRevert();
        reg.settle(SID, bytes32("other"), bytes32("seed"), _sigs(digest), _players());
    }

    function testRandomnessIsFreePureAndDeterministic() public view {
        bytes32 a = reg.random(bytes32("seed"), 1);
        bytes32 b = reg.random(bytes32("seed"), 1);
        require(a == b, "same input, same output");
        require(a != reg.random(bytes32("seed"), 2), "counter changes the seed");
        bytes32[] memory ns = reg.randomN(bytes32("seed"), 1, 3);
        require(ns.length == 3 && ns[0] != ns[1] && ns[1] != ns[2], "N distinct seeds");
    }

    function testHandoverManyChargesPerSession() public {
        bytes32[] memory ids = new bytes32[](3);
        bytes32[] memory starts = new bytes32[](3);
        bytes32[] memory seeds = new bytes32[](3);
        address[][] memory players = new address[][](3);
        for (uint256 i = 0; i < 3; i++) {
            ids[i] = keccak256(abi.encodePacked("s", i));
            starts[i] = keccak256(abi.encodePacked("start", i));
            seeds[i] = keccak256(abi.encodePacked("seed", i));
            players[i] = _players();
        }
        vm.expectRevert(FeeVault.BadFee.selector);
        reg.handoverMany{value: FEE * 2}(ids, address(0x1234), starts, seeds, players, players, 1);

        reg.handoverMany{value: FEE * 3}(ids, address(0x1234), starts, seeds, players, players, 1);
        require(vault.paid(ids[0]) && vault.paid(ids[1]) && vault.paid(ids[2]), "all paid");
        require(vault.collected() == FEE * 3, "collected 3 fees");
    }

    function testUpgradeKeepsAddressAndData() public {
        address before = address(reg);
        address vaultBefore = reg.feeVault();
        SessionRegistry impl = new SessionRegistry();
        reg.upgradeToAndCall(address(impl), "");
        require(address(reg) == before, "proxy address unchanged");
        require(reg.feeVault() == vaultBefore, "feeVault preserved");
    }
}
