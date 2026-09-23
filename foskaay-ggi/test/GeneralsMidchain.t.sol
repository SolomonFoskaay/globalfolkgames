// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GeneralsMidchain} from "../demos/pvp/generals/GeneralsMidchain.sol";

/// PROOF of the midchain: the game's rules are a PURE function, so the same move
/// log always produces the same final hash. That is what lets play run for free
/// via eth_call and only the start/final hashes touch the chain.
contract GeneralsMidchainTest {
    GeneralsMidchain game;

    function setUp() public {
        game = new GeneralsMidchain();
    }

    function _cmd(uint8 p, uint8 sx, uint8 sy, uint8 tx, uint8 ty, uint8 pct)
        internal
        pure
        returns (GeneralsMidchain.Move memory m)
    {
        m = GeneralsMidchain.Move({kind: 0, playerIndex: p, a: sx, b: sy, c: tx, d: ty, e: pct});
    }

    function _tickMove() internal pure returns (GeneralsMidchain.Move memory m) {
        m.kind = 1;
    }

    function _seeds() internal pure returns (bytes32[] memory s) {
        s = new bytes32[](0);
    }

    function testInitialBoardMatchesTheOnChainTwin() public {
        GeneralsMidchain.State memory s = game.getInitialState();
        require(s.status == 2, "playing");
        // capitals at (1,1) and (14,6), exactly their generate coordinates
        require(s.cells[1 * 16 + 1].kind == uint8(GeneralsMidchain.CellKind.Capital), "capital 0");
        require(s.cells[1 * 16 + 1].ownerPlayer == 0, "capital 0 owner");
        require(s.cells[6 * 16 + 14].kind == uint8(GeneralsMidchain.CellKind.Capital), "capital 1");
        require(s.cells[6 * 16 + 14].ownerPlayer == 1, "capital 1 owner");
        // a city at (2,5)
        require(s.cells[5 * 16 + 2].kind == uint8(GeneralsMidchain.CellKind.City), "city");
    }

    function testCommandConquersAdjacentField() public {
        GeneralsMidchain.State memory s = game.getInitialState();
        // P1 capital (1,1) strength 20 moves 50% into the empty field (2,1):
        // moved = (20-1)*50/100 = 9, which beats strength 0.
        s = game.applyMove(s, _cmd(0, 1, 1, 2, 1, 50), _seeds());
        GeneralsMidchain.Cell memory target = s.cells[1 * 16 + 2];
        require(target.ownerKind == uint8(GeneralsMidchain.OwnerKind.Player), "conquered");
        require(target.ownerPlayer == 0, "owned by P1");
        require(target.strength == 9, "leftover strength");
        require(s.turn == 1, "turn passed");
    }

    function testHashChainIsDeterministic() public {
        GeneralsMidchain.State memory a = game.getInitialState();
        GeneralsMidchain.State memory b = game.getInitialState();
        bytes32 h0a = game.hashState(a);
        bytes32 h0b = game.hashState(b);
        require(h0a == h0b, "same start hash");

        a = game.applyMove(a, _cmd(0, 1, 1, 2, 1, 50), _seeds());
        b = game.applyMove(b, _cmd(0, 1, 1, 2, 1, 50), _seeds());
        require(game.hashState(a) == game.hashState(b), "same hash after same move");

        // a different move produces a different hash
        GeneralsMidchain.State memory c = game.getInitialState();
        c = game.applyMove(c, _cmd(0, 1, 1, 1, 2, 50), _seeds());
        require(game.hashState(c) != game.hashState(a), "different move, different hash");
    }

    function testTickGrowsCapital() public {
        GeneralsMidchain.State memory s = game.getInitialState();
        uint8 before = s.cells[1 * 16 + 1].strength;
        for (uint256 i = 0; i < 100; i++) {
            s = game.applyMove(s, _tickMove(), _seeds());
        }
        uint8 afterStrength = s.cells[1 * 16 + 1].strength;
        require(afterStrength == before + 1, "capital grew once at the 5s tick");
    }

    function testFinishStaysPlayingWhileOpponentLives() public {
        GeneralsMidchain.State memory s = game.getInitialState();
        GeneralsMidchain.Move memory fin;
        fin.kind = 2;
        fin.playerIndex = 0;
        s = game.applyMove(s, fin, _seeds());
        require(s.status == 2, "P2 still holds a capital, so not finished");
    }
}
