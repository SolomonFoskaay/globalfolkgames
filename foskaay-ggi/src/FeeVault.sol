// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC-20 surface. Declared at file level (Solidity does not allow
///      an interface inside a contract). The standalone project ships with
///      `libs = []`, and this is the whole token surface the rail needs.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @title FeeVault — Foskaay Gasless Games Infrastructure (GGI), CORE contract 4 of 4.
///
/// @notice Collects the small PER-SESSION rail fee and lets the owner withdraw it.
/// The fee is charged TWICE per session: once at open and once at settle. It is
/// NEVER per action, so a heavy game costs the same as a light one.
///
/// @dev WHO PAYS: the game operator (the sponsor/relayer), never the player. That
///      is the entire promise of GI: players pay nothing and see no wallet popup.
///      The sponsor's cost is a tiny fixed amount per SESSION, not per move.
///
/// @dev WHAT CURRENCY (Arc): USDC is the native asset on Arc AND its gas token.
///      Circle provides an ERC-20 interface to the same underlying balance at
///      0x3600000000000000000000000000000000000000, and recommends the ERC-20
///      interface for reading balances and sending transfers. GI therefore takes
///      its fee in USDC through that ERC-20 interface, so accounting is exact
///      (6 decimals) and never mixes the 18-decimal native view with the
///      6-decimal token view. The token address is DEPLOY-TIME CONFIG, so a
///      network or asset change is data, never a code change.
///
/// @dev WHY DEVNET TOO (owner decision, arcv2m18): the fee is charged on testnet
///      exactly as on mainnet, so a developer sees the TRUE economics before
///      committing. MagicBlock's "devnet looks free" left devs unable to know
///      their mainnet cost; this rail deliberately avoids that confusion.
///
/// @dev UNOPINIONATED (the core rule): this contract charges a per-session fee
///      and stores nothing else. It has no player account, no per-feature slot
///      and no batching opinion. A game that wants Managed Accounts or Batched
///      Settlement uses an OPTIONAL pattern; none of that is here.
///
/// SECURITY MODEL (this is the ONE core contract that holds value, so it is the
/// most carefully hardened):
///   - ERC-20 is moved with an EXACT-amount `transferFrom`: the vault never takes
///     an unlimited allowance, so a compromise of the vault cannot drain a payer
///     beyond the configured fee.
///   - A fee change NEVER affects a session already charged: open stores that the
///     open stage is paid, and settle charges the CURRENT settle price. A payer
///     always knows the open price up front; the settle price is small and public.
///   - Withdrawal is pull-payment by the owner to a fixed destination. No
///     user-supplied call target exists, so there is no external call the caller
///     can steer (the destination is owner-set only).
///   - Accounting is separate from the actual token balance: a stray direct
///     transfer is NOT counted as revenue and cannot be withdrawn as fees, so
///     collected amounts always equal what was genuinely charged.
///   - Each stage is charged at most once per session, so nothing can be
///     double-charged.
contract FeeVault {
    address public owner;        // may configure fees / asset / destination, and withdraw
    address public destination;  // where withdrawals go (the owner's wallet)
    address public feeToken;     // the USDC ERC-20 interface on Arc (set at deploy)

    uint256 public openFee;      // fee charged at open, in token base units
    uint256 public settleFee;    // fee charged at settle, in token base units

    /// sessionId => stage already charged, recording WHO paid, for the audit trail.
    mapping(bytes32 => address) public openPaidBy;
    mapping(bytes32 => address) public settlePaidBy;

    /// sessionId => the settle fee LOCKED at open. The payer sees this price when
    /// they pay the open fee, and settle charges exactly this amount, so an owner
    /// fee change can never alter the price of a session already in flight.
    mapping(bytes32 => uint256) public lockedSettleFee;

    /// Accounting: how much of the fee asset is actually withdrawable.
    mapping(address => uint256) public collected; // token => amount

    event FeesConfigured(uint256 openFee, uint256 settleFee);
    event FeeTokenSet(address token);
    event DestinationSet(address destination);
    event OwnerSet(address owner);
    event FeePaid(bytes32 indexed sessionId, bool indexed isSettle, address indexed payer, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error OpenAlreadyCharged();
    error SettleNotAllowed();
    error SettleAlreadyCharged();
    error FeeNotConfigured();
    error TransferFailed();
    error NothingToWithdraw();

    constructor(address owner_, address destination_, address feeToken_) {
        if (owner_ == address(0) || destination_ == address(0) || feeToken_ == address(0)) revert ZeroAddress();
        owner = owner_;
        destination = destination_;
        feeToken = feeToken_;
        emit OwnerSet(owner_);
        emit DestinationSet(destination_);
        emit FeeTokenSet(feeToken_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------- config

    /// @notice Set the per-session fees, in the fee asset's base units (USDC uses
    ///         6 decimals on Arc). Zero disables that stage's fee. Effects only
    ///         sessions charged AFTER this call.
    function setFees(uint256 openFee_, uint256 settleFee_) external onlyOwner {
        openFee = openFee_;
        settleFee = settleFee_;
        emit FeesConfigured(openFee_, settleFee_);
    }

    /// @notice Set the fee asset (the USDC ERC-20 interface on Arc). Kept settable
    ///         so a network or asset change is config, not a redeploy. Changing it
    ///         does NOT touch already-collected amounts of the previous asset.
    function setFeeToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        feeToken = token;
        emit FeeTokenSet(token);
    }

    /// @notice Set where withdrawals go.
    function setDestination(address destination_) external onlyOwner {
        if (destination_ == address(0)) revert ZeroAddress();
        destination = destination_;
        emit DestinationSet(destination_);
    }

    /// @notice Transfer ownership. The new owner should also point the destination
    ///         at itself (separate call, so the move is explicit).
    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerSet(owner_);
    }

    // ------------------------------------------------------------- charges

    /// @notice Charge the OPEN fee for a session. Call ONCE per session, by the
    ///         sponsor (the game operator). Players never call this.
    /// @dev The payer must have approved this vault for at least the fee; the
    ///      vault pulls the EXACT configured amount and nothing more.
    function chargeOpen(bytes32 sessionId) external {
        if (openPaidBy[sessionId] != address(0)) revert OpenAlreadyCharged();
        uint256 amount = _pull(openFee);
        openPaidBy[sessionId] = msg.sender;
        // LOCK the settle price now, so the payer knows up front what settle will
        // cost and the owner cannot change it mid-session.
        lockedSettleFee[sessionId] = settleFee;
        emit FeePaid(sessionId, false, msg.sender, amount);
    }

    /// @notice Charge the SETTLE fee for a session. Call ONCE per session, at
    ///         settle. A session that never settles is never charged this fee,
    ///         which is the agreed abandon behaviour (open fee only).
    /// @dev Charges the fee LOCKED at open, never the current config, so a fee
    ///      change between open and settle cannot affect this session.
    function chargeSettle(bytes32 sessionId) external {
        if (openPaidBy[sessionId] == address(0)) revert SettleNotAllowed();
        if (settlePaidBy[sessionId] != address(0)) revert SettleAlreadyCharged();
        uint256 amount = _pull(lockedSettleFee[sessionId]);
        settlePaidBy[sessionId] = msg.sender;
        emit FeePaid(sessionId, true, msg.sender, amount);
    }

    /// @dev Pull the exact configured fee in the fee asset from the caller, and
    ///      record it as collected revenue. Reverts on a failed or lying transfer.
    function _pull(uint256 amount) private returns (uint256) {
        if (amount == 0) revert FeeNotConfigured();
        bool ok = IERC20(feeToken).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        collected[feeToken] += amount;
        return amount;
    }

    // ---------------------------------------------------------- withdraw

    /// @notice Withdraw collected fees for `token` to the destination. Pull-payment
    ///         by the owner; no user-supplied call target, so no reentrancy surface.
    function withdraw(address token) external onlyOwner {
        uint256 amount = collected[token];
        if (amount == 0) revert NothingToWithdraw();
        collected[token] = 0;
        bool ok = IERC20(token).transfer(destination, amount);
        if (!ok) revert TransferFailed();
        emit Withdrawn(token, destination, amount);
    }

    /// @notice A session's stage state, for the SDK and the audit trail.
    function paymentOf(bytes32 sessionId) external view returns (address openPayer, address settlePayer) {
        return (openPaidBy[sessionId], settlePaidBy[sessionId]);
    }
}
