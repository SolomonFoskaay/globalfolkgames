// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeVault} from "../src/FeeVault.sol";

interface Vm {
    function prank(address) external;
    function expectRevert() external;
}

/// A 6-decimal ERC-20 mimicking Arc's USDC ERC-20 interface.
contract MockUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A token that LIES: reports success but moves nothing.
contract LyingToken {
    function decimals() external pure returns (uint8) {
        return 6;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// Security + behaviour tests for FeeVault (Foskaay GGI core contract 4 of 4).
///
/// ONE charge per session, at settle (measured cost fix 2026-09-22): a two-stage
/// open+settle fee plus a per-session approve made fee collection ~39% of a
/// session's Arc cost. Now there is a single `chargeSession`.
contract FeeVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    FeeVault vault;
    MockUSDC usdc;
    address constant OWNER = address(0xA11CE);
    address constant DEST = address(0xD357);
    address constant SPONSOR = address(0x59005);
    address constant STRANGER = address(0xBAD0);
    bytes32 constant S1 = keccak256("session-1");
    uint256 constant FEE = 1500; // 0.0015 USDC (6 decimals) - placeholder, owner-set

    function setUp() public {
        usdc = new MockUSDC();
        vault = new FeeVault(OWNER, DEST, address(usdc));
        vm.prank(OWNER);
        vault.setFee(FEE);
        usdc.mint(SPONSOR, 1_000_000);
        vm.prank(SPONSOR);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------- happy path

    function testChargeSessionCollectsFee() public {
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        require(vault.collected(address(usdc)) == FEE, "fee collected");
        require(usdc.balanceOf(address(vault)) == FEE, "vault holds fee");
        (address payer, uint256 amount) = vault.paymentOf(S1);
        require(payer == SPONSOR && amount == FEE, "payer + amount recorded");
    }

    function testChargePullsExactAmountOnly() public {
        uint256 before = usdc.balanceOf(SPONSOR);
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        require(before - usdc.balanceOf(SPONSOR) == FEE, "exact fee only");
    }

    function testCannotChargeTwice() public {
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        vm.prank(SPONSOR);
        vm.expectRevert();
        vault.chargeSession(S1);
    }

    function testEachSessionChargedOnce() public {
        bytes32 s2 = keccak256("session-2");
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        vm.prank(SPONSOR);
        vault.chargeSession(s2);
        require(vault.collected(address(usdc)) == FEE * 2, "two sessions, two fees");
    }

    function testNoFeeConfiguredReverts() public {
        FeeVault fresh = new FeeVault(OWNER, DEST, address(usdc));
        vm.prank(SPONSOR);
        vm.expectRevert();
        fresh.chargeSession(S1);
    }

    function testMissingAllowanceReverts() public {
        usdc.mint(STRANGER, 1_000_000);
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.chargeSession(S1);
    }

    function testZeroFeeDisablesCharging() public {
        vm.prank(OWNER);
        vault.setFee(0);
        vm.prank(SPONSOR);
        vm.expectRevert();
        vault.chargeSession(S1);
    }

    function testLyingTokenBehaviourIsContained() public {
        // A token returning true without moving funds would inflate accounting.
        // This is why the fee asset is a KNOWN deploy-time USDC address, never a
        // player or game choice.
        LyingToken liar = new LyingToken();
        FeeVault v2 = new FeeVault(OWNER, DEST, address(liar));
        vm.prank(OWNER);
        v2.setFee(FEE);
        vm.prank(SPONSOR);
        v2.chargeSession(S1);
        require(v2.collected(address(liar)) == FEE, "accounting follows the token");
        require(vault.feeToken() == address(usdc), "real vault points at USDC");
    }

    // ------------------------------------------------------------- withdraw

    function testOnlyOwnerCanWithdraw() public {
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.withdraw(address(usdc));
    }

    function testWithdrawGoesToDestination() public {
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        vm.prank(OWNER);
        vault.withdraw(address(usdc));
        require(usdc.balanceOf(DEST) == FEE, "destination paid");
        require(vault.collected(address(usdc)) == 0, "accounting cleared");
    }

    function testWithdrawMovesOnlyCollectedNotStrayBalance() public {
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        // A stray direct transfer must not become withdrawable revenue.
        usdc.mint(SPONSOR, 999_999);
        vm.prank(SPONSOR);
        usdc.transfer(address(vault), 999_999);
        require(vault.collected(address(usdc)) == FEE, "only real fee counted");
        vm.prank(OWNER);
        vault.withdraw(address(usdc));
        require(usdc.balanceOf(DEST) == FEE, "only collected withdrawn");
    }

    function testCannotWithdrawWithNothing() public {
        vm.prank(OWNER);
        vm.expectRevert();
        vault.withdraw(address(usdc));
    }

    // ------------------------------------------------------------- config

    function testOnlyOwnerCanConfigure() public {
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.setFee(1);
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.setFeeToken(STRANGER);
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.setDestination(STRANGER);
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.setOwner(STRANGER);
    }

    function testFeeChangeDoesNotAffectAlreadyChargedSession() public {
        vm.prank(SPONSOR);
        vault.chargeSession(S1);
        vm.prank(OWNER);
        vault.setFee(FEE * 10);
        (address payer, uint256 amount) = vault.paymentOf(S1);
        require(payer == SPONSOR && amount == FEE, "paid amount locked at charge time");
        vm.prank(SPONSOR);
        vm.expectRevert();
        vault.chargeSession(S1); // already charged, regardless of new price
    }

    function testCannotSetZeroAddresses() public {
        vm.prank(OWNER);
        vm.expectRevert();
        vault.setFeeToken(address(0));
        vm.prank(OWNER);
        vm.expectRevert();
        vault.setDestination(address(0));
        vm.prank(OWNER);
        vm.expectRevert();
        vault.setOwner(address(0));
    }

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert();
        new FeeVault(address(0), DEST, address(usdc));
        vm.expectRevert();
        new FeeVault(OWNER, address(0), address(usdc));
        vm.expectRevert();
        new FeeVault(OWNER, DEST, address(0));
    }

    function testFeeAssetIsUsdcInterface() public {
        require(vault.feeToken() == address(usdc), "USDC set at deploy");
        require(usdc.decimals() == 6, "6-decimal USDC view");
    }
}
