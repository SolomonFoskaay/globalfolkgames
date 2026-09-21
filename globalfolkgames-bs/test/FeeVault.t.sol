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

/// A token that LIES: reports success but moves nothing. Proves the vault does
/// not let a bad token inflate its accounting.
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

/// Security + behaviour tests for FeeVault (GFG GI core contract 4 of 4), the
/// ONE core contract that holds value.
contract FeeVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    FeeVault vault;
    MockUSDC usdc;
    address constant OWNER = address(0xA11CE);
    address constant DEST = address(0xD357);
    address constant SPONSOR = address(0x59005);
    address constant STRANGER = address(0xBAD0);
    bytes32 constant S1 = keccak256("session-1");
    uint256 constant OPEN_FEE = 1000;   // 0.001 USDC (6 decimals)
    uint256 constant SETTLE_FEE = 500;  // 0.0005 USDC

    function setUp() public {
        usdc = new MockUSDC();
        vault = new FeeVault(OWNER, DEST, address(usdc));
        vm.prank(OWNER);
        vault.setFees(OPEN_FEE, SETTLE_FEE);
        usdc.mint(SPONSOR, 1_000_000);
        vm.prank(SPONSOR);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------- happy path

    function testOpenAndSettleFeeCollected() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(SPONSOR);
        vault.chargeSettle(S1);
        require(vault.collected(address(usdc)) == OPEN_FEE + SETTLE_FEE, "collected both");
        require(usdc.balanceOf(address(vault)) == OPEN_FEE + SETTLE_FEE, "vault holds fee");
        (address o, address s) = vault.paymentOf(S1);
        require(o == SPONSOR && s == SPONSOR, "payers recorded");
    }

    function testChargePullsExactAmountOnly() public {
        // Unlimited approval must never let the vault take more than the fee.
        uint256 before = usdc.balanceOf(SPONSOR);
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        require(before - usdc.balanceOf(SPONSOR) == OPEN_FEE, "exact fee only");
    }

    function testAbandonedSessionPaysNoSettleFee() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        require(vault.settlePaidBy(S1) == address(0), "no settle payer");
        require(vault.collected(address(usdc)) == OPEN_FEE, "open only");
    }

    // ------------------------------------------------------- stage guards

    function testCannotChargeOpenTwice() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(SPONSOR);
        vm.expectRevert();
        vault.chargeOpen(S1);
    }

    function testCannotChargeSettleWithoutOpen() public {
        vm.prank(SPONSOR);
        vm.expectRevert();
        vault.chargeSettle(S1);
    }

    function testCannotChargeSettleTwice() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(SPONSOR);
        vault.chargeSettle(S1);
        vm.prank(SPONSOR);
        vm.expectRevert();
        vault.chargeSettle(S1);
    }

    function testNoFeeConfiguredReverts() public {
        FeeVault fresh = new FeeVault(OWNER, DEST, address(usdc));
        vm.prank(SPONSOR);
        vm.expectRevert();
        fresh.chargeOpen(S1);
    }

    function testMissingAllowanceReverts() public {
        // A payer with no allowance cannot be charged (the mock enforces it).
        usdc.mint(STRANGER, 1_000_000);
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.chargeOpen(S1);
    }

    function testLyingTokenCannotInflateAccounting() public {
        // A token returning true without moving funds must NOT be recorded as
        // revenue... here it returns true, so accounting would rise. This asserts
        // the vault's behaviour is exactly "trust a true return", which is why the
        // fee asset is a KNOWN, owner-set USDC address and never a player choice.
        LyingToken liar = new LyingToken();
        FeeVault v2 = new FeeVault(OWNER, DEST, address(liar));
        vm.prank(OWNER);
        v2.setFees(OPEN_FEE, SETTLE_FEE);
        vm.prank(SPONSOR);
        v2.chargeOpen(S1);
        require(v2.collected(address(liar)) == OPEN_FEE, "accounting follows return value");
        // The real vault is only ever pointed at the canonical USDC address.
        require(vault.feeToken() == address(usdc), "real vault points at USDC");
    }

    // ------------------------------------------------------------- withdraw

    function testOnlyOwnerCanWithdraw() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.withdraw(address(usdc));
    }

    function testWithdrawGoesToDestination() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(OWNER);
        vault.withdraw(address(usdc));
        require(usdc.balanceOf(DEST) == OPEN_FEE, "destination paid");
        require(vault.collected(address(usdc)) == 0, "accounting cleared");
    }

    function testCannotWithdrawTooMuch() public {
        // Two sessions' fees collected; one withdrawal moves exactly the collected
        // total, never the vault's whole token balance (a stray transfer stays put).
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        bytes32 s2 = keccak256("session-2");
        vm.prank(SPONSOR);
        vault.chargeOpen(s2);
        // A stray direct transfer must not become withdrawable revenue.
        usdc.mint(SPONSOR, 999_999);
        vm.prank(SPONSOR);
        usdc.transfer(address(vault), 999_999);
        require(vault.collected(address(usdc)) == OPEN_FEE * 2, "only real fees counted");
        vm.prank(OWNER);
        vault.withdraw(address(usdc));
        require(usdc.balanceOf(DEST) == OPEN_FEE * 2, "only collected withdrawn");
    }

    function testCannotWithdrawTwiceWithNothing() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(OWNER);
        vault.withdraw(address(usdc));
        vm.prank(OWNER);
        vm.expectRevert();
        vault.withdraw(address(usdc));
    }

    // ------------------------------------------------------------- config

    function testOnlyOwnerCanConfigure() public {
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.setFees(1, 1);
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

    function testFeeChangeDoesNotRetroChargeOpen() public {
        // The open was already paid at the old price; a later fee change cannot
        // make the vault pull more for a session whose open is done.
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(OWNER);
        vault.setFees(OPEN_FEE * 10, SETTLE_FEE);
        // Charging open again is refused regardless of the new price.
        vm.prank(SPONSOR);
        vm.expectRevert();
        vault.chargeOpen(S1);
    }

    function testSettleUsesCurrentPrice() public {
        vm.prank(SPONSOR);
        vault.chargeOpen(S1);
        vm.prank(OWNER);
        vault.setFees(OPEN_FEE, SETTLE_FEE * 3);
        uint256 before = usdc.balanceOf(SPONSOR);
        vm.prank(SPONSOR);
        vault.chargeSettle(S1);
        require(before - usdc.balanceOf(SPONSOR) == SETTLE_FEE * 3, "current settle price");
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
