// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmDeploy {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Arc deploy script for the SINGLE core Foskaay GGI contract, behind a UUPS proxy.
///
/// WHY A PROXY: the proxy address is PERMANENT. Upgrading public logic never moves
/// an address, so active sessions and data are never stranded. The owner controls
/// upgrades now; before mainnet that moves to a timelock or multisig.
///
/// NO secrets live here: at run time the deployer key comes from the environment.
/// On Arc the gas token is USDC (native, 18 decimals), so the sponsor only needs
/// test USDC. The fee is taken in native USDC.
contract DeployGI {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// 0.0004 native USDC per session (18 decimals), the v7 unbatched tier.
    uint256 constant SESSION_FEE = 4e14;

    function run() external returns (address registry) {
        vm.startBroadcast();
        SessionRegistry regImpl = new SessionRegistry();
        registry = address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(SessionRegistry.initialize, (msg.sender, msg.sender, SESSION_FEE))
        ));
        vm.stopBroadcast();
        return registry;
    }
}
