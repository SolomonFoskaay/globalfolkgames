// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../../src/SessionRegistry.sol";

/// @title GeneralsGame — the ported on-chain game (MagicBlock solana-generals -> Arc + GGI).
///
/// This is the GAME's own contract, NOT rail core. It is a faithful port of
/// MagicBlock's open-source `Game` component + `command`/`tick`/`finish` systems:
///   - the BOARD is one shared account (this contract's storage), owned by the game
///   - players are SEATS inside the board (authority + ready), not separate boards
///   - the RULES run on-chain (adjacency, ownership, mountain, strength, invade math)
///   - a TICK grows cell strength over time (permissionless)
///
/// The only thing that changes from their version is the rail underneath:
///   MagicBlock: the board is delegated to the ER, executed for free.
///   Here:       the board is bound to a GGI session; every move is authorised by
///               SessionRegistry.canSign(sessionId, seat, caller) and submitted by
///               the sponsor. Same rules, same state, gasless for the player.
///
/// Names follow theirs so the two codebases can be read side by side.
contract GeneralsGame {
    SessionRegistry public registry;

    uint16 public constant TICKS_PER_SECOND = 20;

    enum GameStatus { Generate, Lobby, Playing, Finished }
    enum GameCellKind { Field, City, Capital, Mountain, Forest }
    enum GameCellOwnerKind { Nobody, Player }

    struct GamePlayer {
        bool ready;
        address authority;      // who may play this seat (set from the GGI session)
        uint64 lastActionSlot;  // their last_action_slot
    }

    struct GameCell {
        GameCellKind kind;
        GameCellOwnerKind ownerKind;
        uint8 ownerPlayer;      // valid when ownerKind == Player
        uint8 strength;
    }

    /// One shared board. `cells` is a fixed 16x8 = 128 grid, like their component.
    struct Board {
        GameStatus status;
        uint8 sizeX;
        uint8 sizeY;
        GamePlayer[2] players;
        GameCell[128] cells;
        uint64 tickNextSlot;
        bytes32 sessionId;      // the GGI session this board is played under
    }

    mapping(uint256 => Board) public boards; // boardId => board

    event BoardCreated(uint256 indexed boardId, bytes32 indexed sessionId, uint8 sizeX, uint8 sizeY);
    event Joined(uint256 indexed boardId, uint8 playerIndex, address authority);
    event Started(uint256 indexed boardId);
    event Commanded(uint256 indexed boardId, uint8 playerIndex, uint8 sourceX, uint8 sourceY, uint8 targetX, uint8 targetY, uint8 strengthPercent);
    event TickDone(uint256 indexed boardId, uint64 tickNextSlot);
    event Finished(uint256 indexed boardId);

    error StatusIsNotGenerate();
    error StatusIsNotLobby();
    error StatusIsNotPlaying();
    error PlayerAlreadyJoined();
    error PlayerIsNotPayer();
    error PlayerIsNotReady();
    error CellIsOutOfBounds();
    error CellsAreNotAdjacent();
    error CellStrengthIsInsufficient();
    error CellIsNotOwnedByPlayer();
    error CellIsNotWalkable();
    error NotSessionAuthorised();
    error BoardExists();

    constructor(address registry_) {
        registry = SessionRegistry(registry_);
    }

    // ---------------------------------------------------------------- setup

    /// @notice Create the board for a GGI session. Only an authorised signer for
    ///         seat 0 may create it, so a board can only exist inside a live
    ///         session. This is the port of "create the component".
    function createBoard(uint256 boardId, bytes32 sessionId, uint8 sizeX, uint8 sizeY) external {
        if (boards[boardId].sizeX != 0) revert BoardExists();
        if (!registry.canSign(sessionId, 0, msg.sender)) revert NotSessionAuthorised();
        Board storage b = boards[boardId];
        b.status = GameStatus.Generate;
        b.sizeX = sizeX;
        b.sizeY = sizeY;
        b.sessionId = sessionId;
        for (uint256 i = 0; i < 128; i++) {
            b.cells[i] = GameCell(GameCellKind.Field, GameCellOwnerKind.Nobody, 0, 0);
        }
        emit BoardCreated(boardId, sessionId, sizeX, sizeY);
    }

    /// @notice Generate the map (their `generate` system): mountains, forests,
    ///         cities, and a capital per seat. Gated by the session.
    function generate(uint256 boardId) external {
        Board storage b = _authorised(boardId, 0);
        if (b.status != GameStatus.Generate) revert StatusIsNotGenerate();
        _generate(b);
        b.status = GameStatus.Lobby;
    }

    /// @notice A player joins a seat. The seat authority must already be set on
    ///         the GGI session (ggi.setAuthority) to THAT seat; then the joiner
    ///         must be its authorised signer.
    function join(uint256 boardId, uint8 playerIndex) external {
        Board storage b = boards[boardId];
        if (playerIndex >= 2) revert PlayerIsNotPayer();
        if (b.players[playerIndex].authority != address(0)) revert PlayerAlreadyJoined();
        if (!registry.canSign(b.sessionId, playerIndex, msg.sender)) revert NotSessionAuthorised();
        b.players[playerIndex].authority = msg.sender;
        emit Joined(boardId, playerIndex, msg.sender);
    }

    function setReady(uint256 boardId, uint8 playerIndex, bool ready) external {
        Board storage b = _authorised(boardId, playerIndex);
        if (b.status != GameStatus.Lobby) revert StatusIsNotLobby();
        b.players[playerIndex].ready = ready;
    }

    /// @notice Start the game (their `start` system). Only seat 0's authority may.
    function start(uint256 boardId) external {
        Board storage b = _authorised(boardId, 0);
        if (b.status != GameStatus.Lobby) revert StatusIsNotLobby();
        if (!b.players[0].ready || !b.players[1].ready) revert PlayerIsNotReady();
        b.status = GameStatus.Playing;
        emit Started(boardId);
    }

    // ---------------------------------------------------------------- rules

    /// @notice The move (their `command` system), rules copied exactly:
    ///         adjacency, ownership, mountain not walkable, strength > 1, and the
    ///         invade math with Forest halving the damage.
    function command(
        uint256 boardId,
        uint8 playerIndex,
        uint8 sourceX,
        uint8 sourceY,
        uint8 targetX,
        uint8 targetY,
        uint8 strengthPercent
    ) external {
        Board storage b = _authorised(boardId, playerIndex);
        if (b.status != GameStatus.Playing) revert StatusIsNotPlaying();

        b.players[playerIndex].lastActionSlot = uint64(block.number);

        GameCell storage source = _cell(b, sourceX, sourceY);
        GameCell storage target = _cell(b, targetX, targetY);

        // adjacency
        int32 dx = int32(uint32(sourceX)) - int32(uint32(targetX));
        int32 dy = int32(uint32(sourceY)) - int32(uint32(targetY));
        if ((dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy) != 1) revert CellsAreNotAdjacent();

        // ownership + walkable + strength
        if (source.ownerKind != GameCellOwnerKind.Player || source.ownerPlayer != playerIndex) revert CellIsNotOwnedByPlayer();
        if (target.kind == GameCellKind.Mountain) revert CellIsNotWalkable();
        if (source.strength <= 1) revert CellStrengthIsInsufficient();

        uint8 movedStrength = uint8((uint32(source.strength - 1) * uint32(strengthPercent)) / 100);

        if (target.ownerKind == GameCellOwnerKind.Player && target.ownerPlayer == playerIndex) {
            // reinforce
            uint8 before = target.strength;
            target.strength = _addSat(target.strength, movedStrength);
            source.strength = source.strength - (target.strength - before);
        } else {
            // invade
            source.strength = source.strength - movedStrength;
            uint8 damage = target.kind == GameCellKind.Forest ? movedStrength / 2 : movedStrength;
            if (damage < target.strength) {
                target.strength = target.strength - damage;
            } else if (damage == target.strength) {
                target.ownerKind = GameCellOwnerKind.Nobody;
                target.ownerPlayer = 0;
                target.strength = 0;
            } else {
                target.ownerKind = GameCellOwnerKind.Player;
                target.ownerPlayer = playerIndex;
                target.strength = damage - target.strength;
            }
        }
        emit Commanded(boardId, playerIndex, sourceX, sourceY, targetX, targetY, strengthPercent);
    }

    /// @notice The clock (their `tick` system). PERMISSIONLESS: anyone may call it,
    ///         so no cron or server is needed. Grows strength over time.
    function tick(uint256 boardId) external {
        Board storage b = boards[boardId];
        if (b.status != GameStatus.Playing) revert StatusIsNotPlaying();
        uint64 nowSlot = uint64(block.number);
        uint256 incremented = 0;
        while (nowSlot >= b.tickNextSlot) {
            b.tickNextSlot = b.tickNextSlot + 1;
            if (b.tickNextSlot % TICKS_PER_SECOND != 0) continue;
            for (uint8 x = 0; x < b.sizeX; x++) {
                for (uint8 y = 0; y < b.sizeY; y++) {
                    GameCell storage c = _cell(b, x, y);
                    if (c.ownerKind == GameCellOwnerKind.Nobody) continue;
                    if (c.kind == GameCellKind.Capital && b.tickNextSlot % (TICKS_PER_SECOND * 5) == 0) {
                        c.strength = _addSat(c.strength, 1);
                    } else if (c.kind == GameCellKind.City && b.tickNextSlot % (TICKS_PER_SECOND * 10) == 0) {
                        c.strength = _addSat(c.strength, 1);
                    } else if (c.kind == GameCellKind.Field && b.tickNextSlot % (TICKS_PER_SECOND * 60) == 0) {
                        c.strength = _addSat(c.strength, 1);
                    }
                }
            }
            incremented += 1;
            if (incremented >= 5) break;
        }
        emit TickDone(boardId, b.tickNextSlot);
    }

    /// @notice Finish the game (their `finish` system).
    function finish(uint256 boardId) external {
        Board storage b = _authorised(boardId, 0);
        if (b.status != GameStatus.Playing) revert StatusIsNotPlaying();
        b.status = GameStatus.Finished;
        emit Finished(boardId);
    }

    // ---------------------------------------------------------------- reads

    /// @notice Read a cell (the frontend renders from this; it owns no state).
    function cellOf(uint256 boardId, uint8 x, uint8 y) external view returns (GameCell memory) {
        return _cell(boards[boardId], x, y);
    }

    function boardStatus(uint256 boardId) external view returns (GameStatus) {
        return boards[boardId].status;
    }

    function playerOf(uint256 boardId, uint8 i) external view returns (GamePlayer memory) {
        return boards[boardId].players[i];
    }

    // ------------------------------------------------------------- internal

    /// @dev The move is only valid if the caller is an authorised signer for that
    ///      seat of the board's live GGI session. This is the port of delegation
    ///      authority: the chain decides, never the frontend.
    function _authorised(uint256 boardId, uint8 playerIndex) private view returns (Board storage b) {
        b = boards[boardId];
        if (b.sizeX == 0) revert StatusIsNotPlaying();
        if (!registry.canSign(b.sessionId, playerIndex, msg.sender)) revert NotSessionAuthorised();
        if (b.players[playerIndex].authority != address(0) && b.players[playerIndex].authority != msg.sender) {
            revert NotSessionAuthorised();
        }
    }

    function _cell(Board storage b, uint8 x, uint8 y) private view returns (GameCell storage) {
        if (x >= b.sizeX || y >= b.sizeY) revert CellIsOutOfBounds();
        return b.cells[uint256(y) * uint256(b.sizeX) + uint256(x)];
    }

    function _addSat(uint8 a, uint8 v) private pure returns (uint8) {
        uint16 s = uint16(a) + uint16(v);
        return s > 255 ? 255 : uint8(s);
    }

    /// @dev Deterministic generation, no randomness needed: mountains and forests
    ///      on a fixed pattern, cities on some fields, one capital per seat.
    function _generate(Board storage b) private {
        for (uint8 x = 0; x < b.sizeX; x++) {
            for (uint8 y = 0; y < b.sizeY; y++) {
                GameCell storage c = b.cells[uint256(y) * uint256(b.sizeX) + uint256(x)];
                if ((x + y) % 11 == 0) {
                    c.kind = GameCellKind.Mountain;
                    c.strength = 0;
                } else if ((x * 3 + y * 7) % 13 == 0) {
                    c.kind = GameCellKind.Forest;
                    c.strength = 0;
                } else if ((x + y) % 9 == 0) {
                    c.kind = GameCellKind.City;
                    c.strength = 40;
                } else {
                    c.kind = GameCellKind.Field;
                    c.strength = 0;
                }
                c.ownerKind = GameCellOwnerKind.Nobody;
                c.ownerPlayer = 0;
            }
        }
        // capitals per seat
        GameCell storage c0 = b.cells[uint256(b.sizeY - 1) * uint256(b.sizeX) + 0];
        c0.kind = GameCellKind.Capital; c0.ownerKind = GameCellOwnerKind.Player; c0.ownerPlayer = 0; c0.strength = 20;
        GameCell storage c1 = b.cells[uint256(0) * uint256(b.sizeX) + uint256(b.sizeX - 1)];
        c1.kind = GameCellKind.Capital; c1.ownerKind = GameCellOwnerKind.Player; c1.ownerPlayer = 1; c1.strength = 20;
    }
}
