// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmDeploy {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Arc deploy script for the TWO core Foskaay GGI contracts, behind UUPS proxies.
///
/// WHY PROXIES: the proxy address is PERMANENT. Upgrading public logic never
/// moves an address, so active sessions and data are never stranded. The owner
/// controls upgrades now; before mainnet that moves to a timelock or multisig.
///
/// NO secrets live here: at run time the deployer key comes from the environment.
/// On Arc the gas token is USDC (native, 18 decimals), so the sponsor only needs
/// test USDC. The fee is taken in native USDC.
contract DeployGI {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// 0.001 native USDC per session (18 decimals). Owner-changeable on the vault.
    uint256 constant SESSION_FEE = 1e15;

    function run() external returns (address registry, address feeVault) {
        vm.startBroadcast();

        // 1. SessionRegistry (feeVault set after the vault exists).
        SessionRegistry regImpl = new SessionRegistry();
        registry = address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(SessionRegistry.initialize, (msg.sender, address(0)))
        ));

        // 2. FeeVault(owner, destination, fee, sessionRegistry).
        FeeVault fvImpl = new FeeVault();
        feeVault = address(new ERC1967Proxy(
            address(fvImpl),
            abi.encodeCall(FeeVault.initialize, (msg.sender, msg.sender, SESSION_FEE, registry))
        ));

        // 3. Wire the registry to the vault.
        SessionRegistry(registry).setFeeVault(feeVault);

        vm.stopBroadcast();
        return (registry, feeVault);
    }
}
