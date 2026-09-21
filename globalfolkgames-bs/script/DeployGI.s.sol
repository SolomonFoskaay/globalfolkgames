// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {SessionState} from "../src/SessionState.sol";
import {Randomness} from "../src/Randomness.sol";
import {FeeVault} from "../src/FeeVault.sol";

interface VmDeploy {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata name) external returns (address);
}

/// Arc Testnet deploy for the FOUR core GlobalFolkGames Gasless Infrastructure
/// contracts. NO secrets live here: at run time the deployer key comes from the
/// environment (or the local key file), e.g.
///   forge script script/DeployGI.s.sol:DeployGI \
///     --rpc-url $GFG_Arc_RPC --private-key $GFG_Arc_Gasless_Sponsor_Key --broadcast
///
/// On Arc the gas token is USDC, so the sponsor only needs test USDC.
///
/// Constructor arguments (all public, no secrets):
///   SessionRegistry(feeRecipient = deployer, operator = 0)  -> operator disabled
///   SessionState(registry)
///   Randomness(registry)
///   FeeVault(owner = deployer, destination = deployer, feeToken = Arc USDC ERC-20)
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
        // The deployer (msg.sender in broadcast) is the owner / fee recipient.
        SessionRegistry reg = new SessionRegistry(msg.sender, address(0));
        SessionState st = new SessionState(address(reg));
        Randomness rnd = new Randomness(address(reg));
        FeeVault fv = new FeeVault(msg.sender, msg.sender, ARC_USDC);
        vm.stopBroadcast();
        return (address(reg), address(st), address(rnd), address(fv));
    }
}
