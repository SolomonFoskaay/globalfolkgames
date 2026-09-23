// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts/utils/ReentrancyGuardUpgradeable.sol";

/// @title FeeVault — Foskaay Gasless Games Infrastructure (Foskaay GGI), core 2 of 2.
///
/// @notice Holds the small PER-SESSION fee and lets the owner withdraw it. The
/// fee is charged ONCE, at connect, and is NEVER per action, so a heavy game
/// costs the same as a light one.
///
/// @notice ONLY THE SessionRegistry CAN DEPOSIT. That is what makes the fee
/// unbypassable: a session starts through SessionRegistry.handover, which forwards
/// the fee here in the same transaction. There is no other door in.
///
/// @notice CURRENCY: native USDC (Arc's gas token, 18 decimals). Taking it as
/// `msg.value` is the cheapest possible collection (no ERC-20 approval, no
/// transferFrom, no extra call). On Arc native and ERC-20 USDC are ONE balance, so
/// the owner's destination wallet receives normal, movable USDC.
///
/// @dev OPENZEPPELIN ONLY: upgradeability (UUPS + Initializable + Ownable) and the
///      reentrancy guard are the audited OpenZeppelin implementations.
///
/// @dev UPGRADEABLE (UUPS). Storage is APPEND-ONLY: new variables go at the top of
///      `__gap`, which shrinks by the same number of slots. `version` marks layout
///      changes. `initialize` replaces the constructor; the implementation is
///      `_disableInitializers()` so it can never be used directly.
contract FeeVault is Initializable, UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    /// Where withdrawals go (the owner's wallet).
    address public destination;

    /// The whole per-session fee, in native USDC base units (18 decimals on Arc).
    /// Zero would disable the fee, but the rail is designed to charge.
    uint256 public fee;

    /// The one contract allowed to record a payment (the SessionRegistry).
    address public sessionRegistry;

    /// sessionId => paid at connect. A settlement is refused unless this is true.
    mapping(bytes32 => bool) public paid;

    /// Native USDC collected and withdrawable.
    uint256 public collected;

    /// Layout marker. 0 on the first deployed layout; bump only on a layout change.
    uint8 public version;

    /// Reserved slots for future variables. Consume from the top, shrink by the
    /// same count. DO NOT reorder or remove.
    uint256[20] private __gap;

    event FeeSet(uint256 fee);
    event DestinationSet(address destination);
    event SessionRegistrySet(address sessionRegistry);
    event FeePaid(bytes32 indexed sessionId, address indexed payer, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error NotSessionRegistry();
    error BadFee();
    error AlreadyPaid();
    error NothingToWithdraw();
    error TransferFailed();
    error ZeroAddress();

    /// @notice Initialize the proxy.
    /// @param owner_ the config owner (the project owner).
    /// @param destination_ where withdrawals go.
    /// @param fee_ the per-session fee in native USDC base units (18 decimals).
    /// @param sessionRegistry_ the only contract allowed to record a payment.
    function initialize(address owner_, address destination_, uint256 fee_, address sessionRegistry_) external initializer {
        if (owner_ == address(0) || destination_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        destination = destination_;
        fee = fee_;
        sessionRegistry = sessionRegistry_;
        emit DestinationSet(destination_);
        emit FeeSet(fee_);
        emit SessionRegistrySet(sessionRegistry_);
    }

    /// @dev The implementation contract can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the owner may authorize an upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ------------------------------------------------------------- config

    /// @notice Set the per-session fee (native USDC base units, 18 decimals).
    function setFee(uint256 fee_) external onlyOwner {
        fee = fee_;
        emit FeeSet(fee_);
    }

    /// @notice Set where withdrawals go.
    function setDestination(address destination_) external onlyOwner {
        if (destination_ == address(0)) revert ZeroAddress();
        destination = destination_;
        emit DestinationSet(destination_);
    }

    /// @notice Set the SessionRegistry allowed to deposit. Normally set once.
    function setSessionRegistry(address sessionRegistry_) external onlyOwner {
        if (sessionRegistry_ == address(0)) revert ZeroAddress();
        sessionRegistry = sessionRegistry_;
        emit SessionRegistrySet(sessionRegistry_);
    }

    // ------------------------------------------------------------- charge

    /// @notice Record one paid session. Only the SessionRegistry may call it, and
    ///         `msg.value` must equal the fee. Called from SessionRegistry.handover
    ///         with the fee forwarded, so a session cannot start unpaid.
    function deposit(bytes32 sessionId) external payable {
        if (msg.sender != sessionRegistry) revert NotSessionRegistry();
        if (msg.value != fee) revert BadFee();
        if (paid[sessionId]) revert AlreadyPaid();
        paid[sessionId] = true;
        collected += msg.value;
        emit FeePaid(sessionId, msg.sender, msg.value);
    }

    /// @notice Record MANY paid sessions in one call. `msg.value` must equal
    ///         fee x count.
    function depositMany(bytes32[] calldata sessionIds) external payable {
        if (msg.sender != sessionRegistry) revert NotSessionRegistry();
        uint256 n = sessionIds.length;
        if (n == 0 || msg.value != fee * n) revert BadFee();
        for (uint256 i = 0; i < n; i++) {
            if (paid[sessionIds[i]]) revert AlreadyPaid();
            paid[sessionIds[i]] = true;
            emit FeePaid(sessionIds[i], msg.sender, fee);
        }
        collected += msg.value;
    }

    // ----------------------------------------------------------- withdraw

    /// @notice Withdraw all collected native USDC to the destination. Owner only,
    ///         reentrancy-guarded. No user-supplied call target exists, so the
    ///         caller cannot steer the transfer.
    function withdraw() external onlyOwner nonReentrant {
        uint256 amount = collected;
        if (amount == 0) revert NothingToWithdraw();
        collected = 0;
        (bool ok, ) = payable(destination).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(destination, amount);
    }

    // -------------------------------------------------------------- reads

    /// @notice Whether a session was paid at connect. The SessionRegistry checks
    ///         this before it will settle.
    function paymentOf(bytes32 sessionId) external view returns (bool) {
        return paid[sessionId];
    }

    /// @dev Accept native USDC only from the SessionRegistry deposit path. A plain
    ///      send is refused so the accounting (collected) can never drift from
    ///      what was genuinely charged.
    receive() external payable {
        revert NotSessionRegistry();
    }
}
