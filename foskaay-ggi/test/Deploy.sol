// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {SessionState} from "../src/SessionState.sol";
import {Randomness} from "../src/Randomness.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {BatchedSettlement} from "../src/BatchedSettlement.sol";

/// Shared test helpers: deploy each contract BEHIND a proxy, exactly as
/// production does, and call initialize. Tests must go through the proxy so they
/// exercise the real deployed shape (and would catch a storage/initializer bug).
library Deploy {
    function registry(address owner, address operator) internal returns (SessionRegistry) {
        SessionRegistry impl = new SessionRegistry();
        bytes memory init = abi.encodeCall(SessionRegistry.initialize, (owner, operator));
        return SessionRegistry(address(new ERC1967Proxy(address(impl), init)));
    }

    function state(SessionRegistry reg) internal returns (SessionState) {
        SessionState impl = new SessionState();
        bytes memory init = abi.encodeCall(SessionState.initialize, (address(reg)));
        return SessionState(address(new ERC1967Proxy(address(impl), init)));
    }

    function randomness(SessionRegistry reg) internal returns (Randomness) {
        Randomness impl = new Randomness();
        bytes memory init = abi.encodeCall(Randomness.initialize, (address(reg)));
        return Randomness(address(new ERC1967Proxy(address(impl), init)));
    }

    function feeVault(address owner, address destination, address token) internal returns (FeeVault) {
        FeeVault impl = new FeeVault();
        bytes memory init = abi.encodeCall(FeeVault.initialize, (owner, destination, token));
        return FeeVault(address(new ERC1967Proxy(address(impl), init)));
    }

    function batched(address admin) internal returns (BatchedSettlement) {
        BatchedSettlement impl = new BatchedSettlement();
        bytes memory init = abi.encodeCall(BatchedSettlement.initialize, (admin));
        return BatchedSettlement(address(new ERC1967Proxy(address(impl), init)));
    }
}
