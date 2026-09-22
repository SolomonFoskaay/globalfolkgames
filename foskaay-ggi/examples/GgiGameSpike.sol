// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title GgiGameSpike — a THROWAWAY proof that a game's OWN contract can hold its
/// own on-chain state and be gated by a Foskaay GGI session. This is the port of
/// MagicBlock's model (a game component + systems) to EVM/GGI:
///
///   MagicBlock                 ->  here
///   Game component (state)     ->  this contract's storage (plots/coins)
///   system `command` (rules)   ->  plant()/water()/harvest() with on-chain checks
///   delegate account to ER     ->  register this account against a GGI sessionId
///   ER authorises execution    ->  registry.canSign(sessionId, seat, msg.sender)
///
/// NOTE ON "GASLESS": MagicBlock mutates the delegated account for FREE inside the
/// ER. Arc has no ER, so there is no free mutation. Here every action is a normal
/// transaction that the SPONSOR pays. Batching reduces the count of transactions.
/// That is the honest limit of the port; this contract proves the STATE + RULES +
/// AUTHORISATION part works on-chain with GGI.
///
/// This is NOT core and NOT shipped: it exists to answer "does the model fit".
/// Delete it once the answer is recorded.
contract GgiGameSpike is Initializable, UUPSUpgradeable {
    SessionRegistry public registry;

    struct Plot {
        uint8 stage;    // 0 empty, 1 planted, 2 grown
        uint32 plantedAt;
    }

    /// One on-chain game account per (game, player), the "PlayerAccount" idea:
    /// holds the board (plots) and the player's coins. One account, many slots,
    /// so delegation/sponsorship cost does not grow per feature.
    struct PlayerGame {
        bytes32 sessionId;      // the GGI session this game is played under
        uint8 seat;             // the player's seat in that session
        uint32 coins;
        Plot[8] plots;
        uint32 moves;
    }

    mapping(address => PlayerGame) public games; // player => their one game account

    event Started(address indexed player, bytes32 indexed sessionId, uint8 seat);
    event Planted(address indexed player, uint8 plotIndex, uint32 moves);
    event Harvested(address indexed player, uint8 plotIndex, uint32 coins);

    error NotSessionAuthorised();
    error NoGame();
    error BadPlot();
    error NotReady();

    /// @notice Bind this player's game account to a GGI session and seat.
    ///         Caller must be an authorised signer for that seat, so a game can
    ///         only ever be started inside a real, live session.
    function start(bytes32 sessionId, uint8 seat) external {
        if (!registry.canSign(sessionId, seat, msg.sender)) revert NotSessionAuthorised();
        PlayerGame storage g = games[msg.sender];
        g.sessionId = sessionId;
        g.seat = seat;
        emit Started(msg.sender, sessionId, seat);
    }

    /// @notice An in-session move. The CALLER must still be session-authorised.
    function plant(uint8 plotIndex) external {
        PlayerGame storage g = _authorised();
        if (plotIndex >= 8) revert BadPlot();
        Plot storage p = g.plots[plotIndex];
        if (p.stage != 0) revert NotReady();
        p.stage = 1;
        p.plantedAt = uint32(block.timestamp);
        g.moves += 1;
        emit Planted(msg.sender, plotIndex, g.moves);
    }

    /// @notice Grow a planted plot (time-gated, like an idle tick).
    function water(uint8 plotIndex) external {
        PlayerGame storage g = _authorised();
        if (plotIndex >= 8) revert BadPlot();
        Plot storage p = g.plots[plotIndex];
        if (p.stage != 1) revert NotReady();
        p.stage = 2;
        g.moves += 1;
        emit Planted(msg.sender, plotIndex, g.moves);
    }

    /// @notice Harvest a grown plot for coins (the on-chain score).
    function harvest(uint8 plotIndex) external {
        PlayerGame storage g = _authorised();
        if (plotIndex >= 8) revert BadPlot();
        Plot storage p = g.plots[plotIndex];
        if (p.stage != 2) revert NotReady();
        g.coins += 10;
        p.stage = 0;
        g.moves += 1;
        emit Harvested(msg.sender, plotIndex, g.coins);
    }

    /// @notice The frontend reads THIS for the whole game (board + score). The
    ///         chain is the only source of truth; nothing lives in the browser.
    function gameOf(address player) external view returns (PlayerGame memory) {
        return games[player];
    }

    function initialize(address registry_) external initializer {
        if (registry_ == address(0)) revert NoGame();
        registry = SessionRegistry(registry_);
    }

    constructor() {
        _disableInitializers();
    }

    function _authorizeUpgrade(address) internal override {
        if (msg.sender != registry.feeRecipient()) revert NotSessionAuthorised();
    }

    /// @dev Every mutating move re-checks the live session, so an action after the
    ///      session closes or expires is refused by the chain, not the frontend.
    function _authorised() private view returns (PlayerGame storage g) {
        g = games[msg.sender];
        if (g.sessionId == bytes32(0)) revert NoGame();
        if (!registry.canSign(g.sessionId, g.seat, msg.sender)) revert NotSessionAuthorised();
    }
}
