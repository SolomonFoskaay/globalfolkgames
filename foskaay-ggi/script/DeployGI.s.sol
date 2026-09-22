// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {SessionState} from "../src/SessionState.sol";
import {Randomness} from "../src/Randomness.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmDeploy {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Arc testnet/deploy script for the FOUR core GlobalFolkGames Gasless Games
/// Infrastructure (GGI) contracts, behind UUPS proxies.
///
/// WHY PROXIES: the proxy address is PERMANENT. Upgrading public logic never
/// moves an address, so sessions and data are never stranded (the exact mistake
/// of redeploying fresh addresses). The owner controls upgrades now; before
/// mainnet that moves to a timelock or multisig.
///
/// NO secrets live here: at run time the deployer key comes from the environment.
/// On Arc the gas token is USDC, so the sponsor only needs test USDC.
contract DeployGI {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Arc USDC ERC-20 interface (same underlying balance as the native gas token,
    /// 6 decimals). Same address on testnet and mainnet.
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run()
        external
        returns (address registry, address state, address randomness, address feeVault)
    {
        vm.startBroadcast();

        // 1. SessionRegistry: implementation + proxy(initialize)
        SessionRegistry regImpl = new SessionRegistry();
        registry = address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(SessionRegistry.initialize, (msg.sender, address(0)))
        ));

        // 2. SessionState points at the registry PROXY
        SessionState stImpl = new SessionState();
        state = address(new ERC1967Proxy(
            address(stImpl),
            abi.encodeCall(SessionState.initialize, (registry))
        ));

        // 3. Randomness points at the registry PROXY
        Randomness rndImpl = new Randomness();
        randomness = address(new ERC1967Proxy(
            address(rndImpl),
            abi.encodeCall(Randomness.initialize, (registry))
        ));

        // 4. FeeVault(owner, destination, feeToken)
        FeeVault fvImpl = new FeeVault();
        feeVault = address(new ERC1967Proxy(
            address(fvImpl),
            abi.encodeCall(FeeVault.initialize, (msg.sender, msg.sender, ARC_USDC))
        ));

        vm.stopBroadcast();
        return (registry, state, randomness, feeVault);
    }
}
