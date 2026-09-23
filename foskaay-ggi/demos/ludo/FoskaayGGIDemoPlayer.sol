// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";

/// @title FoskaayGGIDemoPlayer — the DEMO player account.
///
/// @notice ONE account for a player across EVERY Foskaay GGI demo game, now and in
/// the future. Points for each game live in a bucket keyed by the game tag, so
/// adding a game never adds an account. This is the consolidation the docs ask
/// for: one player account, lifted once, for any number of games.
///
/// @notice This is DEMO code, not rail core. It is deployed once and shared by the
/// demo games (today Ludo; later an idle game and more). The game contract
/// (`FoskaayGGIDemoGames`) is the only writer of points, so a credit is always the
/// result of an on-chain game outcome.
///
/// @dev UPGRADEABLE (UUPS). Storage is APPEND-ONLY; new variables consume from
///      `__gap`, which shrinks by the same count. `version` marks layout changes.
contract FoskaayGGIDemoPlayer is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// A per-game bucket. `gameTag` is a short id (e.g. "ludo", "idle").
    struct Bucket {
        uint64 pureLifetime;   // total ever earned in this game (never decreases)
        uint64 spendable;      // balance that can be spent in this game
        uint32 wins;           // matches won in this game
        uint32 played;         // matches finished in this game
    }

    /// The demo game contract allowed to credit/settle results.
    address public gameContract;

    /// player => gameTag => bucket
    mapping(address => mapping(bytes32 => Bucket)) private _buckets;

    /// player => lifetime total across all games (a convenience read)
    mapping(address => uint64) public lifetimeTotal;

    /// Layout marker. Bump only on a layout change.
    uint8 public version;

    /// Reserved slots. Consume from the top, shrink by the same count.
    uint256[20] private __gap;

    event GameContractSet(address gameContract);
    event PointsCredited(address indexed player, bytes32 indexed gameTag, uint64 amount, uint8 reason, uint64 matchRef);
    event ResultRecorded(address indexed player, bytes32 indexed gameTag, bool won, uint64 matchRef);

    error NotGameContract();
    error ZeroAddress();
    error UnknownGame();

    function initialize(address owner_, address gameContract_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        gameContract = gameContract_;
        emit GameContractSet(gameContract_);
    }

    constructor() {
        _disableInitializers();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Point the player account at the demo game contract (owner only).
    function setGameContract(address gameContract_) external onlyOwner {
        if (gameContract_ == address(0)) revert ZeroAddress();
        gameContract = gameContract_;
        emit GameContractSet(gameContract_);
    }

    /// @notice Credit points to a player's bucket for one game. ONLY the demo game
    ///         contract may call this, so points are always the result of an
    ///         on-chain game outcome, never an arbitrary write.
    /// @param player the player's address (their Dynamic embedded wallet).
    /// @param gameTag the game id ("ludo", "idle", ...).
    /// @param amount points to add.
    /// @param reason a small code (1 = win, 2 = runner-up, ...).
    /// @param matchRef the on-chain match reference this credit came from.
    function credit(address player, bytes32 gameTag, uint64 amount, uint8 reason, uint64 matchRef) external {
        if (msg.sender != gameContract) revert NotGameContract();
        if (player == address(0)) revert ZeroAddress();
        Bucket storage b = _buckets[player][gameTag];
        b.pureLifetime += amount;
        b.spendable += amount;
        lifetimeTotal[player] += amount;
        emit PointsCredited(player, gameTag, amount, reason, matchRef);
    }

    /// @notice Record a finished match for a player (won or not). ONLY the demo
    ///         game contract may call this.
    function recordResult(address player, bytes32 gameTag, bool won, uint64 matchRef) external {
        if (msg.sender != gameContract) revert NotGameContract();
        Bucket storage b = _buckets[player][gameTag];
        b.played += 1;
        if (won) b.wins += 1;
        emit ResultRecorded(player, gameTag, won, matchRef);
    }

    // ---------------------------------------------------------------- reads

    function pointsOf(address player, bytes32 gameTag) external view returns (uint64 pureLifetime, uint64 spendable) {
        Bucket storage b = _buckets[player][gameTag];
        return (b.pureLifetime, b.spendable);
    }

    function recordOf(address player, bytes32 gameTag) external view returns (uint32 wins, uint32 played) {
        Bucket storage b = _buckets[player][gameTag];
        return (b.wins, b.played);
    }
}
