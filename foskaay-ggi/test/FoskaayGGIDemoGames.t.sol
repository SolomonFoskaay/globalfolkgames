// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FoskaayGGIDemoGames} from "../demos/ludo/FoskaayGGIDemoGames.sol";
import {FoskaayGGIDemoPlayer} from "../demos/ludo/FoskaayGGIDemoPlayer.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
}

/// The demo games contract: Ludo rules on-chain (dice, move, capture, home, win)
/// and points credited inside the room at match end.
contract FoskaayGGIDemoGamesTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    FoskaayGGIDemoGames games;
    FoskaayGGIDemoPlayer player;
    address constant SPONSOR = address(0xA11CE);
    address constant HUMAN = address(0x1111);
    uint64 constant REF = 7;
    bytes32 constant LUDO = keccak256("ludo");
    bytes32 constant SID = keccak256("session-1");

    function setUp() public {
        (games, player) = Deploy.demoGames(address(this), SPONSOR);
    }

    function _players() internal pure returns (address[4] memory p) {
        p[0] = HUMAN;
        p[1] = SPONSOR;
    }
    function _computer() internal pure returns (bool[4] memory c) {
        c[1] = true;
    }

    function _create() internal {
        games.createMatch(REF, SID, LUDO, _players(), _computer(), 2, bytes32("seed"));
    }

    function testDiceIsOnChainAndDeterministic() public {
        _create();
        (uint8 a1, uint8 a2) = games.diceOf(REF, 1);
        (uint8 b1, uint8 b2) = games.diceOf(REF, 1);
        require(a1 == b1 && a2 == b2, "same counter, same dice");
        require(a1 >= 1 && a1 <= 6 && a2 >= 1 && a2 <= 6, "dice in 1..6");
        (uint8 c1, uint8 c2) = games.diceOf(REF, 2);
        require(a1 != c1 || a2 != c2, "counter changes the dice");
    }

    function testCreateAndInitialBoard() public {
        _create();
        (uint8 status, uint8 turn, , uint32 moveCount) = games.matchStatus(REF);
        require(status == 1 && turn == 0 && moveCount == 0, "playing, seat 0, no moves");
        int16[16] memory b = games.boardOf(REF);
        for (uint256 i = 0; i < 16; i++) require(b[i] == -1, "all tokens in the yard");
    }

    function testYardNeedsASix() public {
        _create();
        // steps 5 on a yard token must revert.
        vm.expectRevert(FoskaayGGIDemoGames.InYardNeedsSix.selector);
        games.move(REF, 0, 0, 5);
        // steps 6 releases the token.
        games.move(REF, 0, 0, 6);
        require(games.tokenOf(REF, 0, 0) == 0, "released onto the start cell");
    }

    function testOnlyTurnSeatCanMove() public {
        _create();
        vm.expectRevert(FoskaayGGIDemoGames.NotYourTurn.selector);
        games.move(REF, 1, 0, 6);
    }

    function testMoveAndHomeAndWinCreditsPoints() public {
        _create();
        // seat 0 takes all four tokens home: release with 6, then walk to 57.
        // (The contract requires an exact count into home.)
        for (uint8 t = 0; t < 4; t++) {
            games.move(REF, 0, t, 6);        // yard -> 0
            // walk forward in legal chunks; ensure 57 reached exactly.
            int16 pos = 0;
            while (pos < 57) {
                uint8 step = 6;
                if (pos + int16(uint16(step)) > 57) step = uint8(uint16(57 - pos));
                games.move(REF, 0, t, step);
                pos += int16(uint16(step));
            }
            require(games.tokenOf(REF, 0, t) == 57, "token home");
        }
        (uint8 status, , uint8 winner, ) = games.matchStatus(REF);
        require(status == 2 && winner == 0, "match finished, seat 0 won");
        (uint64 lifetime, uint64 spendable) = player.pointsOf(HUMAN, LUDO);
        require(lifetime == 100 && spendable == 100, "winner credited 100 inside the room");
        (uint32 wins, uint32 played) = player.recordOf(HUMAN, LUDO);
        require(wins == 1 && played == 1, "winner record");
    }

    function testCaptureSendsOpponentHome() public {
        _create();
        // Seat 0 releases a token and walks it to position 20 (a non-start cell).
        games.move(REF, 0, 0, 6);
        int16 pos = 0;
        while (pos < 20) { uint8 step = 6; if (pos + int16(uint16(step)) > 20) step = uint8(uint16(20 - pos)); games.move(REF, 0, 0, step); pos += int16(uint16(step)); }
        require(games.tokenOf(REF, 0, 0) == 20, "seat 0 at 20");

        // Seat 1 releases a token and walks it to position 20 as well.
        games.pass(REF);
        games.move(REF, 1, 0, 6);
        pos = 0;
        while (pos < 20) { uint8 step = 6; if (pos + int16(uint16(step)) > 20) step = uint8(uint16(20 - pos)); games.move(REF, 1, 0, step); pos += int16(uint16(step)); }
        require(games.tokenOf(REF, 1, 0) == 20, "seat 1 at 20");

        // Seat 0 lands on seat 1's token: capture sends it back to the yard.
        games.captureAt(REF, 0, 0);
        require(games.tokenOf(REF, 1, 0) == -1, "captured token returned to the yard");
    }

    function testTimeoutIsPermissionless() public {
        _create();
        vm.expectRevert(FoskaayGGIDemoGames.TooEarly.selector);
        games.enforceTimeout(REF);
        vm.warp(block.timestamp + 31);
        games.enforceTimeout(REF);
        (, uint8 turn, , ) = games.matchStatus(REF);
        require(turn == 1, "turn advanced after the timer");
    }

    function testOverflowHomeIsRejected() public {
        _create();
        games.move(REF, 0, 0, 6);
        // walk to 55, then a 6 would overflow past 57
        int16 pos = 0;
        while (pos < 55) { uint8 step = 6; if (pos + int16(uint16(step)) > 55) step = uint8(uint16(55 - pos)); games.move(REF, 0, 0, step); pos += int16(uint16(step)); }
        vm.expectRevert(FoskaayGGIDemoGames.OverflowHome.selector);
        games.move(REF, 0, 0, 6);
    }
}
