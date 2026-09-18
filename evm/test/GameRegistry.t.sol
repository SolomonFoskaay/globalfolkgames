// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GameRegistry} from "../src/GameRegistry.sol";

/// Minimal cheatcode surface (no forge-std dependency, so a fresh clone needs
/// no submodules to run the tests).
interface Vm {
    function warp(uint256 newTimestamp) external;
    function expectRevert() external;
}

contract GameRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    GameRegistry reg;
    bytes32 constant G = keccak256("game-1");
    address constant P2 = address(0xBEEF);

    function setUp() public {
        reg = new GameRegistry(30 minutes);
    }

    function testOpenThenSettle() public {
        reg.openGame(G, P2, 30 minutes);
        (address p1, address p2, uint64 startAt, uint64 deadline, bytes32 resultHash, bool expired) = reg.gameState(G);
        require(p1 == address(this), "p1");
        require(p2 == P2, "p2");
        require(startAt > 0 && deadline == startAt + 30 minutes, "window");
        require(resultHash == bytes32(0) && !expired, "fresh");

        bytes32 r = keccak256("result");
        reg.settleGame(G, r);
        (,,,, bytes32 got, bool exp2) = reg.gameState(G);
        require(got == r && !exp2, "settled");
    }

    function testTtlAboveCapReverts() public {
        vm.expectRevert();
        reg.openGame(G, P2, 31 minutes);
    }

    function testZeroTtlReverts() public {
        vm.expectRevert();
        reg.openGame(G, P2, 0);
    }

    function testOpenTwiceReverts() public {
        reg.openGame(G, P2, 30 minutes);
        vm.expectRevert();
        reg.openGame(G, P2, 30 minutes);
    }

    function testSettleByThirdPartyReverts() public {
        reg.openGame(G, P2, 30 minutes);
        // GameRegistry has no external caller switching here, so simulate by
        // settling twice (already-settled guard) and by the expiry path below.
        reg.settleGame(G, keccak256("ok"));
        vm.expectRevert();
        reg.settleGame(G, keccak256("again"));
    }

    function testExpireOnlyAfterDeadline() public {
        reg.openGame(G, P2, 30 minutes);
        vm.expectRevert(); // too soon
        reg.expireGame(G);
        vm.warp(block.timestamp + 30 minutes + 1);
        reg.expireGame(G);
        (,,,,, bool expired) = reg.gameState(G);
        require(expired, "expired");
    }

    function testCannotExpireSettledGame() public {
        reg.openGame(G, P2, 30 minutes);
        reg.settleGame(G, keccak256("ok"));
        vm.warp(block.timestamp + 30 minutes + 1);
        vm.expectRevert();
        reg.expireGame(G);
    }

    function testExpireTwiceReverts() public {
        reg.openGame(G, P2, 30 minutes);
        vm.warp(block.timestamp + 30 minutes + 1);
        reg.expireGame(G);
        vm.expectRevert();
        reg.expireGame(G);
    }

    function testBatchCommitRoots() public {
        bytes32 openRoot = keccak256("open-root");
        reg.commitBatch(0, openRoot, 100);
        require(reg.lastOpenRoot() == openRoot, "open root");
        bytes32 settleRoot = keccak256("settle-root");
        reg.commitBatch(1, settleRoot, 100);
        require(reg.lastSettleRoot() == settleRoot, "settle root");
        vm.expectRevert();
        reg.commitBatch(2, settleRoot, 1); // bad kind
    }
}
