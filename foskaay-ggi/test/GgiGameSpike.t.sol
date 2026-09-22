// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GgiGameSpike} from "../examples/GgiGameSpike.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Deploy} from "../test/Deploy.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
}

/// PROOF: a game's OWN contract can hold its own on-chain state (board + score)
/// and be gated by a Foskaay GGI session. This answers "does the MagicBlock model
/// fit on EVM/GGI?" with a yes/no, not an opinion.
contract GgiGameSpikeTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SessionRegistry reg;
    GgiGameSpike game;
    address constant OPERATOR = address(0xA11CE);
    address constant PLAYER = address(0xB0B);
    address constant STRANGER = address(0xBAD);
    uint64 constant TTL = 1 hours;

    function setUp() public {
        reg = Deploy.registry(address(this), address(0));
        GgiGameSpike impl = new GgiGameSpike();
        game = GgiGameSpike(address(new ERC1967Proxy(
            address(impl), abi.encodeCall(GgiGameSpike.initialize, (address(reg)))
        )));
    }

    function _openSessionWithPlayer() internal returns (bytes32 id) {
        vm.prank(OPERATOR);
        id = reg.open(1, TTL, 0, 0);
        vm.prank(OPERATOR);
        reg.setAuthority(id, 0, PLAYER);
    }

    function testGameStateLivesOnChainGatedBySession() public {
        bytes32 sid = _openSessionWithPlayer();

        // player starts their on-chain game inside the session
        vm.prank(PLAYER);
        game.start(sid, 0);

        // play a full loop; every move is an on-chain state change
        vm.startPrank(PLAYER);
        game.plant(0);
        game.water(0);
        game.harvest(0);
        game.plant(1);
        game.water(1);
        game.harvest(1);
        vm.stopPrank();

        GgiGameSpike.PlayerGame memory g = game.gameOf(PLAYER);
        require(g.coins == 20, "coins are on-chain state");
        require(g.moves == 6, "moves counted on-chain");
        require(g.plots[0].stage == 0, "plot reset after harvest");
        require(g.sessionId == sid, "game bound to the session");
    }

    function testStrangerCannotPlay() public {
        bytes32 sid = _openSessionWithPlayer();
        vm.prank(PLAYER);
        game.start(sid, 0);

        // a stranger is not a session authority, so the chain refuses the move
        vm.prank(STRANGER);
        vm.expectRevert();
        game.plant(0);
    }

    function testCannotStartOutsideALiveSession() public {
        // unknown session -> canSign false -> start refused
        vm.prank(PLAYER);
        vm.expectRevert();
        game.start(bytes32("nope"), 0);
    }

    function testMovesStopWhenSessionCloses() public {
        bytes32 sid = _openSessionWithPlayer();
        vm.prank(PLAYER);
        game.start(sid, 0);
        vm.prank(PLAYER);
        game.plant(0);

        // the operator closes the session (settle)
        vm.prank(OPERATOR);
        reg.close(sid);

        // the chain now refuses further moves, with no frontend involvement
        vm.prank(PLAYER);
        vm.expectRevert();
        game.water(0);
    }
}
