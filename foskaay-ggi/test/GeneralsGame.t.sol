// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GeneralsGame} from "../demos/pvp/generals/GeneralsGame.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function prank(address) external;
    function expectRevert() external;
    function roll(uint256) external;
}

/// PROOF of the port: the ported generals game runs fully on-chain, and every
/// action is authorised by a live Foskaay GGI session. Two players, real moves, real
/// rules, no frontend trust.
///
/// The game contract lives in the demo folder (`demos/pvp/generals/`); this test
/// lives in the standard Foundry `test/` path so `forge test` finds it. That is
/// the whole reason for the split: Foundry has one test path, and the demo stays
/// self-contained with its game.
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

        // The generated map puts P1's capital at (1,1), exactly their coordinates.
        GeneralsGame.GameCell memory cap = game.cellOf(BOARD, 1, 1);
        require(cap.kind == GeneralsGame.GameCellKind.Capital, "capital at (1,1)");
        require(cap.ownerPlayer == 0, "capital owned by P1");

        // One-read board view returns the same board (the renderer's single call).
        (, uint8 sx, uint8 sy, , GeneralsGame.GameCell[128] memory cells, , bytes32 linked) = game.boardView(BOARD);
        require(sx == 16 && sy == 8, "boardView size");
        require(cells[uint256(1) * 16 + 1].kind == GeneralsGame.GameCellKind.Capital, "boardView cell (1,1)");
        require(linked == sid, "boardView session link");

        // Move half of the capital's movable strength into the adjacent field (2,1).
        // moved = (20 - 1) * 50 / 100 = 9, which conquers the empty field.
        vm.prank(P1);
        game.command(BOARD, 0, 1, 1, 2, 1, 50);

        GeneralsGame.GameCell memory target = game.cellOf(BOARD, 2, 1);
        require(target.ownerKind == GeneralsGame.GameCellOwnerKind.Player, "invaded a cell");
        require(target.ownerPlayer == 0, "owned by P1 now");
        require(target.strength == 9, "conquer leftover strength");

        // Last-one-standing: P2 still holds its capital, so finish(0) must NOT end it.
        vm.prank(P1);
        game.finish(BOARD, 0);
        require(uint256(game.boardStatus(BOARD)) == 2, "not finished while opponent lives");
    }

    function testStrangerCannotMove() public {
        _startedGame();
        vm.prank(STRANGER);
        vm.expectRevert();
        game.command(BOARD, 0, 1, 1, 2, 1, 50);
    }

    function testPlayerCannotPlayOtherSeat() public {
        _startedGame();
        // P2 tries to move P1's cell
        vm.prank(P2);
        vm.expectRevert();
        game.command(BOARD, 0, 1, 1, 2, 1, 50);
    }

    function testMovesBlockedAfterSessionCloses() public {
        bytes32 sid = _startedGame();
        vm.prank(OPERATOR);
        reg.close(sid);
        vm.prank(P1);
        vm.expectRevert();
        game.command(BOARD, 0, 1, 1, 2, 1, 50);
    }

    function testTickIsPermissionlessAndGrowsStrength() public {
        _startedGame();
        // P1 capital at (1,1) starts at strength 20.
        uint8 before = game.cellOf(BOARD, 1, 1).strength;
        // Advance so the tick clock crosses a 5-second boundary (100 ticks at
        // TICKS_PER_SECOND=20); a stranger may call tick, no cron needed.
        vm.roll(block.number + 200);
        vm.prank(STRANGER);
        game.tick(BOARD);
        uint8 afterStrength = game.cellOf(BOARD, 1, 1).strength;
        require(afterStrength == before + 1, "capital grew by 1 on the 5s tick");
    }

    function testFinishRefusedForStranger() public {
        _startedGame();
        vm.prank(STRANGER);
        vm.expectRevert();
        game.finish(BOARD, 0);
    }

    function testCannotStartOutsideLiveSession() public {
        // no session at all: createBoard must be refused
        vm.prank(P1);
        vm.expectRevert();
        game.createBoard(99, bytes32("none"), 16, 8);
    }
}
