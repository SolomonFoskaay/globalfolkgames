// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {FoskaayGGIDemoGames} from "../demos/ludo/FoskaayGGIDemoGames.sol";
import {FoskaayGGIDemoPlayer} from "../demos/ludo/FoskaayGGIDemoPlayer.sol";

/// Shared test helpers: deploy each contract BEHIND a proxy, exactly as
/// production does, and call initialize. Tests must go through the proxy so they
/// exercise the real deployed shape (and would catch a storage/initializer bug).
library Deploy {
    function registry(address owner, address feeVault_) internal returns (SessionRegistry) {
        SessionRegistry impl = new SessionRegistry();
        bytes memory init = abi.encodeCall(SessionRegistry.initialize, (owner, feeVault_));
        return SessionRegistry(address(new ERC1967Proxy(address(impl), init)));
    }

    function feeVault(address owner, address destination, uint256 fee, address sessionRegistry_) internal returns (FeeVault) {
        FeeVault impl = new FeeVault();
        bytes memory init = abi.encodeCall(FeeVault.initialize, (owner, destination, fee, sessionRegistry_));
        return FeeVault(payable(address(new ERC1967Proxy(address(impl), init))));
    }

    /// Deploy BOTH core contracts wired to each other, the way production does.
    /// The registry is deployed first (feeVault unset), then the vault points at
    /// it, then the registry points at the vault. The caller must be `owner` so
    /// the setFeeVault call passes onlyOwner.
    function core(address owner, address destination, uint256 fee) internal returns (SessionRegistry reg, FeeVault vault) {
        reg = registry(owner, address(0));
        vault = feeVault(owner, destination, fee, address(reg));
        reg.setFeeVault(address(vault));
    }

    /// Deploy the DEMO games + player pair BEHIND UUPS proxies, the way the core
    /// is deployed, and wired to each other. Each contract is initialized through
    /// its proxy (the implementation is _disableInitializers, so it can never be
    /// used directly). `owner` must be the caller so the owner-only wiring calls
    /// (setGameContract / setPlayerAccount) pass.
    function demoGames(address owner, address /* sponsor */)
        internal
        returns (FoskaayGGIDemoGames games, FoskaayGGIDemoPlayer player)
    {
        // 1. Player implementation + proxy (gameContract set after the game exists).
        FoskaayGGIDemoPlayer playerImpl = new FoskaayGGIDemoPlayer();
        bytes memory playerInit = abi.encodeCall(FoskaayGGIDemoPlayer.initialize, (owner, address(0)));
        player = FoskaayGGIDemoPlayer(address(new ERC1967Proxy(address(playerImpl), playerInit)));

        // 2. Games implementation + proxy (playerAccount = the player proxy).
        FoskaayGGIDemoGames gamesImpl = new FoskaayGGIDemoGames();
        bytes memory gamesInit = abi.encodeCall(FoskaayGGIDemoGames.initialize, (owner, address(player)));
        games = FoskaayGGIDemoGames(address(new ERC1967Proxy(address(gamesImpl), gamesInit)));

        // 3. Wire the player to the games contract.
        player.setGameContract(address(games));
    }
}
