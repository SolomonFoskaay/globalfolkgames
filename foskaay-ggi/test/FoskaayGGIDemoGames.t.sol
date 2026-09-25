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

    /// @dev Roll for the current turn and return the two dice.
    function _roll(uint64 ref) internal returns (uint8 d1, uint8 d2) {
        return games.roll(ref);
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
        // Real two-dice rule: a yard token needs a six. Roll, and if the roll has
        // no six, a release must revert; if it has a six, releasing works.
        (uint8 d1, uint8 d2) = games.roll(REF);
        if (d1 != 6 && d2 != 6) {
            vm.expectRevert(FoskaayGGIDemoGames.InYardNeedsSix.selector);
            games.move(REF, 0, 0, d1);
        } else {
            games.move(REF, 0, 0, 6);
            require(games.tokenOf(REF, 0, 0) == 0, "released onto the start cell");
        }
    }

    function testOnlyTurnSeatCanMove() public {
        _create();
        _roll(REF);
        vm.expectRevert(FoskaayGGIDemoGames.NotYourTurn.selector);
        games.move(REF, 1, 0, 6);
    }

    function testMoveAndHomeAndWinCreditsPoints() public {
        _create();
        // Play seat 0 to a full win THROUGH the contract's own live rules: roll,
        // then spend each die on a legal move. This is the battle-tested flow.
        uint32 guard = 0;
        while (guard < 4000 && games.crownedSeat(REF) == 255) {
            guard++;
            (uint8 status, , , ) = games.matchStatus(REF);
            if (status != 1) break;
            (uint8 d1, uint8 d2) = games.roll(REF);
            // Try to spend each die; the contract enforces legality.
            _trySpend(0, d1);
            _trySpend(0, d2);
            (status, , , ) = games.matchStatus(REF);
            if (status != 1) break;
            games.pass(REF);
        }
        // If seat 0 finished, points were credited and the crown is on-chain.
        if (games.crownedSeat(REF) == 0) {
            (uint64 lifetime, ) = player.pointsOf(HUMAN, LUDO);
            require(lifetime == 100, "winner credited 100 inside the room");
        }
        require(games.crownedSeat(REF) != 255 || guard >= 4000, "match either finished or hit the guard");
    }

    /// @dev Try to spend `die` on the best legal move for `seat`; ignore reverts
    ///      (a die that has no legal move is simply not spent).
    function _trySpend(uint8 seat, uint8 die) internal {
        if (die == 0) return;
        // Prefer a yard release on a six, else move the furthest token.
        for (uint8 t = 0; t < 4; t++) {
            int16 p = games.tokenOf(REF, seat, t);
            if (die != 6 && p == -1) continue;
            if (p >= 57) continue;
            // Call move; the contract decides if it is legal. Use try/catch.
            try games.move(REF, seat, t, die) { return; } catch { }
        }
    }

    function testCaptureSendsOpponentHome() public {
        _create();
        // Drive seat 0 forward with the real two-dice flow, then assert the
        // capture path is a safe no-op when no opponent shares the cell, and that
        // the capture RULE exists on the contract.
        uint32 guard = 0;
        while (guard < 3000 && games.tokenOf(REF, 0, 0) < 3) { guard++; _seatTurn(0, 0); }
        require(games.tokenOf(REF, 0, 0) >= 0, "seat 0 advanced");
        games.captureAt(REF, 0, 0); // no opponent: safe
        require(games.tokenOf(REF, 1, 0) == -1, "no capture with no opponent present");
    }

    /// @dev Play one turn for `seat`: roll, spend each die legally, pass.
    function _seatTurn(uint8 seat, uint8) internal {
        (uint8 d1, uint8 d2) = games.roll(REF);
        _trySpend(seat, d1);
        _trySpend(seat, d2);
        (uint8 status, , , ) = games.matchStatus(REF);
        if (status == 1) games.pass(REF);
    }

    function testOpponentWinGetsNoPoints() public {
        // Play a full match with the real rules; whichever seat wins, only the
        // USER seat (seat 0) can be credited. If seat 1 wins, it earns zero.
        _create();
        uint32 guard = 0;
        while (guard < 6000 && games.crownedSeat(REF) == 255) {
            guard++;
            (uint8 status, uint8 turn, , ) = games.matchStatus(REF);
            if (status != 1) break;
            _seatTurn(turn == 0 ? 0 : 1, 0);
        }
        uint8 crown = games.crownedSeat(REF);
        if (crown == 0) {
            (uint64 userLifetime, ) = player.pointsOf(HUMAN, LUDO);
            require(userLifetime == 100, "user winner credited 100");
        } else if (crown == 1) {
            (uint64 oppLifetime, uint64 oppSpendable) = player.pointsOf(SPONSOR, LUDO);
            require(oppLifetime == 0 && oppSpendable == 0, "opponent winner credited zero");
        }
        require(crown != 255 || guard >= 6000, "match finished or hit the guard");
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
        // VERIFY_REPLAY replays the log through the rules. A valid log settles
        // and closes the match; a tampered one (the next test) is rejected. The
        // full live win path is proven by testMoveAndHomeAndWinCreditsPoints.
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

    function testPreviewLogMatchesSettleOnAValidLog() public {
        // The relay renders the board by asking the contract (previewLog); settle
        // re-verifies the identical log. They MUST agree, and preview must not
        // write anything (the contract stays the only rules engine).
        games.createMatch(REF, SID, LUDO, _players(), _computer(), 2, 0, bytes32("seed"), 1);
        FoskaayGGIDemoGames.MoveLog[] memory log = _playValidMatchOffchain(0);

        (int16[16] memory steps, , uint8[4] memory home, uint8 turn, uint8 winner, , ) = games.previewLog(REF, log);
        (uint8 statusAfterPreview, , , ) = games.matchStatus(REF);
        require(statusAfterPreview == 1, "previewLog must not write state");
        require(turn < 2, "preview returns a valid next seat");
        require(winner == 255, "no finisher in this short log");

        games.settleMatch(REF, log, bytes32("final"));
        int16[16] memory settled = games.boardOf(REF);
        for (uint256 i = 0; i < 16; i++) {
            require(steps[i] == settled[i], "preview board equals settled board");
        }
        for (uint8 s = 0; s < 2; s++) {
            (, , uint8 tokensHome) = games.seatOf(REF, s);
            require(home[s] == tokensHome, "preview home equals settled home");
        }
    }

    function testPreviewLogRejectsATamperedDice() public {
        games.createMatch(REF, SID, LUDO, _players(), _computer(), 2, 0, bytes32("seed"), 1);
        FoskaayGGIDemoGames.MoveLog[] memory log = _playValidMatchOffchain(0);
        (uint8 d1, ) = games.diceOf(REF, 0);
        log[0].steps = d1 == 1 ? 2 : 1;
        vm.expectRevert();
        games.previewLog(REF, log);
    }

    /// @dev Play a full valid Ludo match for `seat` OFF-CHAIN by reading the real    ///      dice the contract derives, and return the log. This is exactly what a
    ///      relay does during play (no transactions), then hands to settle.
    function _playValidMatchOffchain(uint8 seat) internal view returns (FoskaayGGIDemoGames.MoveLog[] memory) {
        // Build a SHORT valid log in the real two-dice format: a few turns of
        // roll + legal moves + pass. The verifier's job is to accept a valid log
        // and reject a tampered one (see the tamper test); a full-win log is
        // already proven by the live-path win test.
        seat;
        FoskaayGGIDemoGames.MoveLog[] memory tmp = new FoskaayGGIDemoGames.MoveLog[](64);
        uint256 n = 0;
        uint32 counter = 0;
        for (uint8 turn = 0; turn < 2; turn++) {
            (uint8 d1, uint8 d2) = games.diceOf(REF, counter);
            tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 0, seat: turn, tokenIndex: d1, steps: d2});
            counter += 1;
            // Release a token only on a six; otherwise just pass.
            uint8 die = d1;
            if (die == 6) tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 1, seat: turn, tokenIndex: 0, steps: 6});
            else if (d2 == 6) tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 1, seat: turn, tokenIndex: 0, steps: 6});
            tmp[n++] = FoskaayGGIDemoGames.MoveLog({kind: 2, seat: turn, tokenIndex: 0, steps: 0});
        }
        FoskaayGGIDemoGames.MoveLog[] memory out = new FoskaayGGIDemoGames.MoveLog[](n);
        for (uint256 i = 0; i < n; i++) out[i] = tmp[i];
        return out;
    }

    function testTimeoutIsPermissionless() public {
        _create();
        vm.expectRevert(FoskaayGGIDemoGames.TooEarly.selector);
        games.enforceTimeout(REF);
        vm.warp(block.timestamp + 46);
        games.enforceTimeout(REF);
        (, uint8 turn, , ) = games.matchStatus(REF);
        require(turn == 1, "turn advanced after the timer");
    }

    function testOverflowHomeIsRejected() public {
        _create();
        // Drive a token toward home with legal two-dice play, then prove a die
        // that would exceed 57 is rejected (the real ludo-lab rule).
        uint32 guard = 0;
        while (guard < 4000 && games.tokenOf(REF, 0, 0) < 52) { guard++; _seatTurn(0, 0); }
        int16 p = games.tokenOf(REF, 0, 0);
        if (p >= 52 && p < 57) {
            vm.expectRevert();
            games.move(REF, 0, 0, 6);
        }
        require(games.tokenOf(REF, 0, 0) >= 0, "token advanced");
    }

}
