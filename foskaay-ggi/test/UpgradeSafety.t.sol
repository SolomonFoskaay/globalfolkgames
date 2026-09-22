// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Randomness} from "../src/Randomness.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {BatchedSettlement} from "../src/BatchedSettlement.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function prank(address) external;
    function expectRevert() external;
}

/// UPGRADE SAFETY: the property that matters most before mainnet. An upgrade must
/// never strand or corrupt existing data, and only the owner may upgrade.
///
/// This is the test that would have caught the "redeploy = new address" mistake at
/// design time: it proves the ADDRESS stays and DATA survives an upgrade.
contract UpgradeSafetyTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OWNER = address(0xA11CE);
    address constant STRANGER = address(0xBAD0);

    function testRegistryUpgradeKeepsAddressAndData() public {
        SessionRegistry reg = Deploy.registry(address(this), address(0));
        address proxyAddr = address(reg);

        vm.prank(OWNER);
        bytes32 id = reg.open(2, 1 hours, bytes32("rules"), 0);
        vm.prank(OWNER);
        reg.setAuthority(id, 0, OWNER);

        SessionRegistry impl2 = new SessionRegistry();
        reg.upgradeToAndCall(address(impl2), "");

        require(address(reg) == proxyAddr, "proxy address must never change");
        require(reg.getSession(id).owner == OWNER, "session survived the upgrade");
        require(reg.authorityOf(id, 0) == OWNER, "authority survived the upgrade");
        require(reg.isLive(id), "session still live after upgrade");
    }

    function testOnlyOwnerCanUpgrade() public {
        SessionRegistry impl = new SessionRegistry();
        bytes memory init = abi.encodeCall(SessionRegistry.initialize, (OWNER, address(0)));
        SessionRegistry reg = SessionRegistry(address(new ERC1967Proxy(address(impl), init)));

        SessionRegistry impl2 = new SessionRegistry();
        vm.prank(STRANGER);
        vm.expectRevert();
        reg.upgradeToAndCall(address(impl2), "");
    }

    function testFeeVaultUpgradeKeepsCollectedData() public {
        FeeVault vault = Deploy.feeVault(OWNER, OWNER, address(0x1234));
        vm.prank(OWNER);
        vault.setFee(1234);

        FeeVault impl2 = new FeeVault();
        vm.prank(OWNER);
        vault.upgradeToAndCall(address(impl2), "");

        require(vault.sessionFee() == 1234, "fee config survived the upgrade");
        require(vault.owner() == OWNER, "owner survived the upgrade");
    }

    function testRandomnessUpgradeKeepsRegistryLink() public {
        SessionRegistry reg = Deploy.registry(address(this), address(0));
        Randomness rnd = Deploy.randomness(reg);
        require(address(rnd.registry()) == address(reg), "registry wired");

        Randomness impl2 = new Randomness();
        rnd.upgradeToAndCall(address(impl2), "");

        require(address(rnd.registry()) == address(reg), "registry link survived the upgrade");
    }

    function testBatchedUpgradeKeepsWindows() public {
        BatchedSettlement bs = Deploy.batched(address(this));
        bs.setWindowConfig(4, 1 hours);
        bs.submit(bytes32(uint256(1)), keccak256("d"));
        bytes32[] memory before = bs.leavesOf(address(this), 0);
        require(before.length == 1, "leaf before upgrade");

        BatchedSettlement impl2 = new BatchedSettlement();
        bs.upgradeToAndCall(address(impl2), "");

        bytes32[] memory afterUp = bs.leavesOf(address(this), 0);
        require(afterUp.length == 1 && afterUp[0] == before[0], "leaf survived the upgrade");
    }
}
