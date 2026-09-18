// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlayerCore} from "../src/PlayerCore.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
}

contract PlayerCoreTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PlayerCore core;
    address constant P = address(0xA11CE);
    address constant BAD = address(0xBAD);
    bytes32 constant LUDO = bytes32("ludo");
    bytes32 constant CHESS = bytes32("chess");

    function setUp() public {
        core = new PlayerCore(address(this)); // this test acts as the relayer/admin
    }

    function testChargeLifeConsumesOne() public {
        core.chargeLife(P, 1);
        (uint16 used, uint16 pool, uint64 boosterUntil, uint64 day) = core.livesOf(P);
        require(used == 1, "used");
        require(pool == 5, "default pool");
        require(boosterUntil == 0, "no booster");
        require(day == block.timestamp / 86400, "day");
    }

    function testNoLivesAfterPoolExhausted() public {
        for (uint64 i = 1; i <= 5; i++) core.chargeLife(P, i);
        vm.expectRevert();
        core.chargeLife(P, 6);
    }

    function testDailyRefill() public {
        for (uint64 i = 1; i <= 5; i++) core.chargeLife(P, i);
        vm.warp(block.timestamp + 1 days + 1);
        core.chargeLife(P, 100);
        (uint16 used,,,) = core.livesOf(P);
        require(used == 1, "refilled");
    }

    function testBoosterMakesLivesUnlimited() public {
        core.activateBooster(P, 72);
        for (uint64 i = 1; i <= 20; i++) core.chargeLife(P, i);
        (uint16 used,, uint64 boosterUntil,) = core.livesOf(P);
        require(used == 0, "no draw while unlimited");
        require(boosterUntil > block.timestamp, "booster set");
    }

    function testRecordPointsBucketAndGlobal() public {
        core.recordPoints(P, LUDO, 100, 1, 42);
        (uint64 purePts, uint64 spendable) = core.bucketOf(P, LUDO);
        require(purePts == 100 && spendable == 100, "bucket");
        (uint64 gp, uint64 gl, uint64 gs) = core.globalsOf(P);
        require(gp == 100 && gl == 100 && gs == 100, "global all tracks");

        core.recordPoints(P, CHESS, 50, 1, 43);
        (uint64 cp,) = core.bucketOf(P, CHESS);
        require(cp == 50, "second bucket");
    }

    function testDuplicateMatchRefReverts() public {
        core.recordPoints(P, LUDO, 100, 1, 42);
        vm.expectRevert();
        core.recordPoints(P, LUDO, 100, 1, 42);
    }

    function testRecordGlobalKind1DoesNotTouchPure() public {
        core.recordGlobal(P, 1, 500, 7);
        (uint64 gp, uint64 gl, uint64 gs) = core.globalsOf(P);
        require(gp == 0, "pure untouched");
        require(gl == 500 && gs == 500, "lifetime + spendable");
    }

    function testSpendLocalAndGlobal() public {
        core.recordPoints(P, LUDO, 100, 1, 42);
        core.spendLocal(P, LUDO, 40);
        (uint64 purePts, uint64 spendable) = core.bucketOf(P, LUDO);
        require(purePts == 100 && spendable == 60, "local spend");
        core.spendGlobal(P, 30);
        (, uint64 gl, uint64 gs) = core.globalsOf(P);
        require(gl == 100 && gs == 70, "global spend");
        vm.expectRevert();
        core.spendGlobal(P, 1000);
    }

    function testPremiumCapsAndIdempotency() public {
        core.creditPremium(P, 5000, 1);
        (uint64 pl, uint64 ps,,) = core.premiumOf(P);
        require(pl == 5000 && ps == 5000, "credited");
        vm.expectRevert();
        core.creditPremium(P, 5000, 1); // duplicate ref
        vm.expectRevert();
        core.creditPremium(P, 2_000_000, 2); // single credit too large
    }

    function testActivatePlanSetsPool() public {
        core.activatePlan(P, 2, 30);
        (uint16 used, uint16 pool,,) = core.livesOf(P);
        (,, uint8 level, uint64 until) = core.premiumOf(P);
        require(level == 2 && pool == 10 && until > block.timestamp, "plan");
        require(used == 0, "fresh");
        vm.expectRevert();
        core.activatePlan(P, 9, 30);
    }

    function testOnlyAdminCanWrite() public {
        vm.prank(BAD);
        vm.expectRevert();
        core.chargeLife(P, 1);
        vm.prank(BAD);
        vm.expectRevert();
        core.recordPoints(P, LUDO, 10, 1, 5);
        vm.prank(BAD);
        vm.expectRevert();
        core.activatePlan(P, 2, 30);
    }
}
