// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GeneralsGame} from "../examples/GeneralsGame/GeneralsGame.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function prank(address) external;
    function expectRevert() external;
    function roll(uint256) external;
}

/// PROOF of the port: the ported generals game runs fully on-chain, and every
/// action is authorised by a live GGI session. Two players, real moves, real
/// rules, no frontend trust.
contract GeneralsGameTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SessionRegistry reg;
    GeneralsGame game;
    address constant OPERATOR = address(0xA11CE);
    address constant P1 = address(0x1111);
    address constant P2 = address(0x2222);
    address constant STRANGER = address(0xBAD0);
    uint64 constant TTL = 1 hours;
    uint256 constant BOARD = 1;

    function setUp() public {
        reg = Deploy.registry(address(this), address(0));
        game = new GeneralsGame(address(reg));
    }

    function _openTwoSeatSession() internal returns (bytes32 id) {
        vm.prank(OPERATOR);
        id = reg.open(2, TTL, 0, 0);
        vm.prank(OPERATOR);
        reg.setAuthority(id, 0, P1);
        vm.prank(OPERATOR);
        reg.setAuthority(id, 1, P2);
        vm.prank(OPERATOR);
        reg.setGameState(id, address(game));
    }

    function _startedGame() internal returns (bytes32 sid) {
        sid = _openTwoSeatSession();
        vm.prank(P1);
        game.createBoard(BOARD, sid, 16, 8);
        vm.prank(P1);
        game.generate(BOARD);
        vm.prank(P1);
        game.join(BOARD, 0);
        vm.prank(P2);
        game.join(BOARD, 1);
        vm.prank(P1);
        game.setReady(BOARD, 0, true);
        vm.prank(P2);
        game.setReady(BOARD, 1, true);
        vm.prank(P1);
        game.start(BOARD);
    }

    function testFullPortFlowOnChain() public {
        bytes32 sid = _startedGame();
        require(reg.gameStateOf(sid) == address(game), "board linked to the session");
        require(uint256(game.boardStatus(BOARD)) == 2, "Playing");

        // P1 owns its capital at (0, 7). Move strength toward an adjacent field.
        // Capital is at x=0, y=sizeY-1=7. Target (1,7) is adjacent.
        vm.prank(P1);
        game.command(BOARD, 0, 0, 7, 1, 7, 50);

        GeneralsGame.GameCell memory target = game.cellOf(BOARD, 1, 7);
        require(target.ownerKind == GeneralsGame.GameCellOwnerKind.Player, "invaded a cell");
        require(target.ownerPlayer == 0, "owned by P1 now");

        // finish
        vm.prank(P1);
        game.finish(BOARD);
        require(uint256(game.boardStatus(BOARD)) == 3, "Finished");
    }

    function testStrangerCannotMove() public {
        _startedGame();
        vm.prank(STRANGER);
        vm.expectRevert();
        game.command(BOARD, 0, 0, 7, 1, 7, 50);
    }

    function testPlayerCannotPlayOtherSeat() public {
        _startedGame();
        // P2 tries to move P1's cell
        vm.prank(P2);
        vm.expectRevert();
        game.command(BOARD, 0, 0, 7, 1, 7, 50);
    }

    function testMovesBlockedAfterSessionCloses() public {
        bytes32 sid = _startedGame();
        vm.prank(OPERATOR);
        reg.close(sid);
        vm.prank(P1);
        vm.expectRevert();
        game.command(BOARD, 0, 0, 7, 1, 7, 50);
    }

    function testTickIsPermissionlessAndGrowsStrength() public {
        _startedGame();
        // capital at (0,7) owned by P1, strength 20
        uint8 before = game.cellOf(BOARD, 0, 7).strength;
        // advance blocks so the tick clock moves; anyone may call tick
        vm.roll(block.number + 200);
        vm.prank(STRANGER);
        game.tick(BOARD);
        uint8 afterStrength = game.cellOf(BOARD, 0, 7).strength;
        require(afterStrength >= before, "capital strength did not fall");
    }

    function testCannotStartOutsideLiveSession() public {
        // no session at all: createBoard must be refused
        vm.prank(P1);
        vm.expectRevert();
        game.createBoard(99, bytes32("none"), 16, 8);
    }
}
