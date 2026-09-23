// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeVault} from "../src/FeeVault.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// The clean FeeVault: native-USDC per-session fee, deposit only from the
/// SessionRegistry, owner withdrawal, reentrancy-guarded (OpenZeppelin).
contract FeeVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant FEE = 1e15; // 0.001 native USDC
    bytes32 constant SID = keccak256("s1");
    address constant DEST = address(0xD357);

    FeeVault vault;

    function setUp() public {
        // Here the test contract IS the sessionRegistry, so deposit() can be called.
        vault = Deploy.feeVault(address(this), DEST, FEE, address(this));
        vm.deal(address(this), 100 ether);
    }

    function testDepositOnlyFromSessionRegistry() public {
        // A stranger cannot even reach the fee check: the door is shut first.
        vm.prank(address(0xBAD));
        vm.expectRevert(FeeVault.NotSessionRegistry.selector);
        vault.deposit(SID);
    }

    function testDepositRequiresExactFee() public {
        vm.expectRevert(FeeVault.BadFee.selector);
        vault.deposit{value: FEE - 1}(SID);
        vault.deposit{value: FEE}(SID);
        require(vault.paid(SID), "recorded");
        require(vault.collected() == FEE, "collected");
    }

    function testCannotDepositTwice() public {
        vault.deposit{value: FEE}(SID);
        vm.expectRevert(FeeVault.AlreadyPaid.selector);
        vault.deposit{value: FEE}(SID);
    }

    function testDepositMany() public {
        bytes32[] memory ids = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) ids[i] = keccak256(abi.encodePacked("s", i));
        vm.expectRevert(FeeVault.BadFee.selector);
        vault.depositMany{value: FEE * 2}(ids);
        vault.depositMany{value: FEE * 3}(ids);
        require(vault.paid(ids[0]) && vault.paid(ids[2]), "all paid");
        require(vault.collected() == FEE * 3, "collected");
    }

    function testWithdrawOnlyOwnerSendsNativeToDestination() public {
        vault.deposit{value: FEE}(SID);
        uint256 before = DEST.balance;
        vm.prank(address(0xBAD));
        vm.expectRevert();
        vault.withdraw();
        vault.withdraw();
        require(DEST.balance == before + FEE, "destination received the fee");
        require(vault.collected() == 0, "collected zeroed");
    }

    function testDirectSendIsRejected() public {
        (bool ok, ) = address(vault).call{value: FEE}("");
        require(!ok, "plain send refused so accounting cannot drift");
    }

    function testSetFeeAndDestinationOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        vault.setFee(2);
        vault.setFee(2);
        require(vault.fee() == 2, "fee updated");
        vault.setDestination(address(0xBEEF));
        require(vault.destination() == address(0xBEEF), "destination updated");
    }
}
