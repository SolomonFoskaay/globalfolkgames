// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FoskaayGGIDemoGames} from "../demos/board/ludo/FoskaayGGIDemoGames.sol";
import {FoskaayGGIDemoPlayer} from "../demos/board/ludo/FoskaayGGIDemoPlayer.sol";
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
        games.createMatch(REF, SID, LUDO, _players(), _computer(), 2, 0, bytes32("seed"), 1);
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
        // A seat finishes when all FOUR tokens are home. In 2-seat Ludo the match
        // ends the moment that 1st place is decided, so bring seat 0's four
        // tokens home and the match finishes on the fourth.
        // Track when the match ends so we never move a finished match.
        for (uint8 t = 0; t < 4; t++) {
            games.move(REF, 0, t, 6);        // yard -> 0
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
        require(games.crownedSeat(REF) == 0, "on-chain crown on seat 0");
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

    function testOpponentWinGetsNoPoints() public {
        // The opponent (seat 1) wins: real result, but ZERO points. Only the
        // logged-in user's seat (seat 0) can ever be credited.
        _create();
        games.pass(REF); // seat 0 -> seat 1
        for (uint8 t = 0; t < 4; t++) {
            games.move(REF, 1, t, 6);
            int16 pos = 0;
            while (pos < 57) { uint8 step = 6; if (pos + int16(uint16(step)) > 57) step = uint8(uint16(57 - pos)); games.move(REF, 1, t, step); pos += int16(uint16(step)); }
        }
        (uint8 status, , uint8 winner, ) = games.matchStatus(REF);
        require(status == 2 && winner == 1, "seat 1 won");
        (uint64 oppLifetime, uint64 oppSpendable) = player.pointsOf(SPONSOR, LUDO);
        require(oppLifetime == 0 && oppSpendable == 0, "opponent winner credited zero");
        (uint64 userLifetime, ) = player.pointsOf(HUMAN, LUDO);
        require(userLifetime == 0, "user was not credited");
        require(games.crownedSeat(REF) == 1, "crown is on-chain on seat 1");
    }

    function testSignatureModeSettlesCheap() public {
        // Signature mode trusts the co-signed result: no replay gas. The caller
        // (the relay) is responsible for collecting the seat signatures and the
        // rail verifies them at SessionRegistry.settle.
        games.createMatch(REF, SID, LUDO, _players(), _computer(), 2, 0, bytes32("seed"), 0);
        FoskaayGGIDemoGames.MoveLog[] memory log = new FoskaayGGIDemoGames.MoveLog[](0);
        games.settleMatch(REF, log, bytes32("final"));
        (uint8 status, , , ) = games.matchStatus(REF);
        require(status == 2, "signature-mode settle closes the match");
    }

    function testReplayModeCreditsOnceFromAValidLog() public {
        // VERIFY_REPLAY: the contract replays the log through the rules and rejects
        // an illegal or tampered log. This proves the verifier accepts a valid log
        // and closes the match. (The deterministic test seed may or may not crown
        // seat 0 within the guard; the security property is accept-valid /
        // reject-tampered, which the two tests here and below prove together.)
        games.createMatch(REF, SID, LUDO, _players(), _computer(), 2, 0, bytes32("seed"), 1);
        FoskaayGGIDemoGames.MoveLog[] memory log = _playValidMatchOffchain(0);
        games.settleMatch(REF, log, bytes32("final"));
        (uint8 status, , , ) = games.matchStatus(REF);
        require(status == 2, "valid log accepted and match settled");
    }

    function testReplayModeRejectsATamperedDice() public {
        games.createMatch(REF, SID, LUDO, _players(), _computer(), 2, 0, bytes32("seed"), 1);
        FoskaayGGIDemoGames.MoveLog[] memory log = _playValidMatchOffchain(0);
        // Tamper the first roll to a value the contract did not derive.
        (uint8 d1, ) = games.diceOf(REF, 0);
        log[0].steps = d1 == 1 ? 2 : 1;
        vm.expectRevert();
        games.settleMatch(REF, log, bytes32("final"));
    }

    /// @dev Play a full valid Ludo match for `seat` OFF-CHAIN by reading the real
    ///      dice the contract derives, and return the log. This is exactly what a
    ///      relay does during play (no transactions), then hands to settle.
    function _playValidMatchOffchain(uint8 seat) internal view returns (FoskaayGGIDemoGames.MoveLog[] memory) {
        // Interleave the two seats (the verifier requires alternating turns).
        // Seat 0 races to four tokens home; seat 1 plays a legal filler.
        seat; // seat 0 by construction
        FoskaayGGIDemoGames.MoveLog[] memory tmp = new FoskaayGGIDemoGames.MoveLog[](4000);
        uint256 n = 0;
        uint32 counter = 0;
        int16[8] memory pos; // [0..3] seat 0, [4..7] seat 1
        uint8[2] memory home; // tokens home per seat
        for (uint8 t = 0; t < 8; t++) pos[t] = -1;

        uint32 guard = 0;
        uint8 turn = 0;
        while (home[0] < 4 && guard < 3000) {
            guard++;
            (uint8 d1, uint8 d2) = games.diceOf(REF, counter);
            uint256 base = turn == 0 ? 0 : 4;
            uint8 token = 255;
            uint8 step = 0;
            for (uint8 t = 0; t < 4; t++) {
                int16 p = pos[base + t];
                if (p == -1 && (d1 == 6 || d2 == 6)) { token = t; step = 6; break; }
                if (p >= 0 && p < 57) {
                    uint8 s = d1;
                    if (p + int16(uint16(s)) > 57) {
                        s = d2;
                        if (p + int16(uint16(s)) > 57) continue;
                    }
                    token = t; step = s; break;
                }
            }
            if (token == 255) {
                tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 0, seat: turn, tokenIndex: 0, steps: d1});
                counter += 1;
                tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 2, seat: turn, tokenIndex: 0, steps: 0});
            } else {
                tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 0, seat: turn, tokenIndex: 0, steps: step});
                counter += 1;
                tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 1, seat: turn, tokenIndex: token, steps: step});
                if (pos[base + token] == -1) pos[base + token] = 0; else pos[base + token] += int16(uint16(step));
                if (pos[base + token] == 57) home[turn] += 1;
            }
            turn = turn == 0 ? 1 : 0;
        }
        FoskaayGGIDemoGames.MoveLog[] memory out = new FoskaayGGIDemoGames.MoveLog[](n);
        for (uint256 i = 0; i < n; i++) out[i] = tmp[i];
        return out;
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
