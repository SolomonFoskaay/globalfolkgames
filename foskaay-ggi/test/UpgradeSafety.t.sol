// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert() external;
}

/// Upgrade safety for the two core contracts: an upgrade keeps the proxy address
/// and preserves live data, and only the owner can authorize it.
contract UpgradeSafetyTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant FEE = 1e15;
    bytes32 constant SID = keccak256("s1");

    function testRegistryUpgradeKeepsAddressAndData() public {
        (SessionRegistry reg, FeeVault vault) = Deploy.core(address(this), address(0xD357), FEE);
        address before = address(reg);
        address vaultBefore = reg.feeVault();

        SessionRegistry impl = new SessionRegistry();
        reg.upgradeToAndCall(address(impl), "");

        require(address(reg) == before, "address kept");
        require(reg.feeVault() == vaultBefore, "feeVault data kept");
        require(address(vault) != address(0), "vault still wired");
    }

    function testFeeVaultUpgradeKeepsAddressAndData() public {
        (SessionRegistry reg, FeeVault vault) = Deploy.core(address(this), address(0xD357), FEE);
        vm.deal(address(reg), 100 ether);
        address[] memory players = new address[](1);
        players[0] = address(0x1);
        reg.handover{value: FEE}(SID, address(0x1234), bytes32("start"), bytes32("seed"), players, players, 0);

        address before = address(vault);
        uint256 feeBefore = vault.fee();
        address destBefore = vault.destination();
        uint256 collectedBefore = vault.collected();

        FeeVault impl = new FeeVault();
        vault.upgradeToAndCall(address(impl), "");

        require(address(vault) == before, "address kept");
        require(vault.fee() == feeBefore, "fee kept");
        require(vault.destination() == destBefore, "destination kept");
        require(vault.collected() == collectedBefore, "collected kept");
        require(vault.paid(SID), "paid record kept");
    }

    function testOnlyOwnerCanUpgrade() public {
        (SessionRegistry reg, ) = Deploy.core(address(this), address(0xD357), FEE);
        SessionRegistry impl = new SessionRegistry();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        reg.upgradeToAndCall(address(impl), "");
    }
}
