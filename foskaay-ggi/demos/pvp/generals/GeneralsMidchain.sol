// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GeneralsMidchain — the free-execution ("midchain") twin of GeneralsGame.
///
/// @notice THE IDEA (see foskaay-ggi-build-guide-v5.md section 9): on Arc there is
/// no free execution layer like MagicBlock's ER, but EVM gives us the next best
/// thing: a PURE function can be run with `eth_call` for free. So the board does
/// not live in storage during play. It lives in a pure struct, the client
/// hash-chains every state, and only the START hash and FINAL hash ever touch the
/// chain (through a Foskaay GGI session open + settle). That is two transactions per
/// match, with every move free for the player AND the sponsor.
///
/// @dev This contract holds NO state and has NO owner and NO access control: it is
/// a pure rules engine. The on-chain truth is the session + the sealed final hash
/// (SessionRegistry / SessionState). Anyone can replay the signed move log through
/// `applyMove` to prove the final hash, so the midchain is verifiable, not trusted.
///
/// The rules are copied exactly from GeneralsGame (itself a port of MagicBlock's
/// solana-generals), so the two twins can be read side by side.
contract GeneralsMidchain {
    uint16 public constant TICKS_PER_SECOND = 20;
    uint8 public constant SIZE_X = 16;
    uint8 public constant SIZE_Y = 8;

    enum CellKind { Field, City, Capital, Mountain, Forest }
    enum OwnerKind { Nobody, Player }

    struct Cell {
        uint8 kind;        // CellKind
        uint8 ownerKind;   // OwnerKind
        uint8 ownerPlayer; // valid when ownerKind == Player
        uint8 strength;
    }

    /// The WHOLE game state. This is what the client carries and hashes; it is
    /// never stored on-chain. status: 0 Generate, 1 Lobby, 2 Playing, 3 Finished.
    struct State {
        uint8 status;
        uint8 turn;
        uint16 tick;
        Cell[128] cells;
    }

    /// One move. kind: 0 = command, 1 = tick, 2 = finish. The fields mean:
    ///   command: playerIndex, a=srcX, b=srcY, c=dstX, d=dstY, e=strengthPercent
    ///   tick:    (no other fields)
    ///   finish:  playerIndex
    struct Move {
        uint8 kind;
        uint8 playerIndex;
        uint8 a;
        uint8 b;
        uint8 c;
        uint8 d;
        uint8 e;
    }

    /// @notice The deterministic starting board, copied exactly from their
    ///         `generate` system (all fields, four cities, one capital per seat).
    function getInitialState() public pure returns (State memory s) {
        s.status = 2; // Playing: the midchain starts after the lobby is agreed
        s.turn = 0;
        s.tick = 0;
        for (uint256 i = 0; i < 128; i++) {
            s.cells[i] = Cell(uint8(CellKind.Field), uint8(OwnerKind.Nobody), 0, 0);
        }
        _put(s, 2, 5, CellKind.City, OwnerKind.Nobody, 0, 40);
        _put(s, 13, 2, CellKind.City, OwnerKind.Nobody, 0, 40);
        _put(s, 7, 3, CellKind.City, OwnerKind.Nobody, 0, 40);
        _put(s, 8, 4, CellKind.City, OwnerKind.Nobody, 0, 40);
        _put(s, 1, 1, CellKind.Capital, OwnerKind.Player, 0, 20);
        _put(s, 14, 6, CellKind.Capital, OwnerKind.Player, 1, 20);
    }

    /// @notice Hash a state. This is the ONE definition of "the hash", so the
    ///         client and any verifier always agree. Pure, free via eth_call.
    function hashState(State memory s) public pure returns (bytes32) {
        return keccak256(abi.encode(s));
    }

    /// @notice Apply one move and return the NEW state. Pure, so it runs for free
    ///         via eth_call. `seeds` is part of the Foskaay GGI game interface (a game may
    ///         need randomness); Generals needs none, so it is ignored.
    function applyMove(State memory s, Move memory m, bytes32[] memory /* seeds */)
        public
        pure
        returns (State memory)
    {
        if (m.kind == 0) {
            _command(s, m);
        } else if (m.kind == 1) {
            _tick(s);
        } else if (m.kind == 2) {
            _finish(s, m.playerIndex);
        } else {
            revert("unknown move kind");
        }
        return s;
    }

    /// @notice Is the game over, and who won (255 = nobody). Pure, free.
    function isTerminal(State memory s) public pure returns (bool, uint8) {
        if (s.status == 3) {
            for (uint8 p = 0; p < 2; p++) {
                bool owns = false;
                bool other = false;
                for (uint256 i = 0; i < 128; i++) {
                    Cell memory c = s.cells[i];
                    if (c.ownerKind == uint8(OwnerKind.Player)) {
                        if (c.ownerPlayer == p) owns = true;
                        else other = true;
                    }
                }
                if (owns && !other) return (true, p);
            }
            return (true, 255);
        }
        return (false, 255);
    }

    // ------------------------------------------------------------- rules

    /// @dev The command, copied exactly: adjacency, ownership, mountain not
    ///      walkable, strength > 1, invade math with Forest halving the damage.
    function _command(State memory s, Move memory m) private pure {
        Cell memory src = s.cells[uint256(m.b) * SIZE_X + uint256(m.a)];
        Cell memory dst = s.cells[uint256(m.d) * SIZE_X + uint256(m.c)];

        int32 dx = int32(uint32(m.a)) - int32(uint32(m.c));
        int32 dy = int32(uint32(m.b)) - int32(uint32(m.d));
        if ((dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy) != 1) revert("not adjacent");
        if (src.ownerKind != uint8(OwnerKind.Player) || src.ownerPlayer != m.playerIndex) revert("not owned");
        if (dst.kind == uint8(CellKind.Mountain)) revert("mountain");
        if (src.strength <= 1) revert("too weak");

        uint8 movedStrength = uint8((uint32(src.strength - 1) * uint32(m.e)) / 100);

        if (dst.ownerKind == uint8(OwnerKind.Player) && dst.ownerPlayer == m.playerIndex) {
            uint8 before = dst.strength;
            dst.strength = _addSat(dst.strength, movedStrength);
            src.strength = src.strength - (dst.strength - before);
        } else {
            src.strength = src.strength - movedStrength;
            uint8 damage = dst.kind == uint8(CellKind.Forest) ? movedStrength / 2 : movedStrength;
            if (damage < dst.strength) {
                dst.strength = dst.strength - damage;
            } else if (damage == dst.strength) {
                dst.ownerKind = uint8(OwnerKind.Nobody);
                dst.ownerPlayer = 0;
                dst.strength = 0;
            } else {
                dst.ownerKind = uint8(OwnerKind.Player);
                dst.ownerPlayer = m.playerIndex;
                dst.strength = damage - dst.strength;
            }
        }

        s.cells[uint256(m.b) * SIZE_X + uint256(m.a)] = src;
        s.cells[uint256(m.d) * SIZE_X + uint256(m.c)] = dst;
        s.turn = m.playerIndex == 0 ? 1 : 0;
    }

    /// @dev The clock, copied exactly: Capital +1 every 5s, City +1 every 10s,
    ///      Field +1 every 60s, at TICKS_PER_SECOND = 20.
    function _tick(State memory s) private pure {
        s.tick += 1;
        if (s.tick % TICKS_PER_SECOND != 0) return;
        for (uint8 x = 0; x < SIZE_X; x++) {
            for (uint8 y = 0; y < SIZE_Y; y++) {
                Cell memory c = s.cells[uint256(y) * SIZE_X + uint256(x)];
                if (c.ownerKind == uint8(OwnerKind.Nobody)) continue;
                if (c.kind == uint8(CellKind.Capital) && s.tick % (TICKS_PER_SECOND * 5) == 0) {
                    c.strength = _addSat(c.strength, 1);
                } else if (c.kind == uint8(CellKind.City) && s.tick % (TICKS_PER_SECOND * 10) == 0) {
                    c.strength = _addSat(c.strength, 1);
                } else if (c.kind == uint8(CellKind.Field) && s.tick % (TICKS_PER_SECOND * 60) == 0) {
                    c.strength = _addSat(c.strength, 1);
                }
                s.cells[uint256(y) * SIZE_X + uint256(x)] = c;
            }
        }
    }

    /// @dev The finish check, copied exactly: finished only when NO cell is owned
    ///      by any other player (last one standing).
    function _finish(State memory s, uint8 playerIndex) private pure {
        bool finished = true;
        for (uint8 x = 0; x < SIZE_X && finished; x++) {
            for (uint8 y = 0; y < SIZE_Y; y++) {
                Cell memory c = s.cells[uint256(y) * SIZE_X + uint256(x)];
                if (c.ownerKind == uint8(OwnerKind.Player) && c.ownerPlayer != playerIndex) {
                    finished = false;
                    break;
                }
            }
        }
        if (finished) s.status = 3;
    }

    function _put(State memory s, uint8 x, uint8 y, CellKind kind, OwnerKind ownerKind, uint8 ownerPlayer, uint8 strength) private pure {
        s.cells[uint256(y) * SIZE_X + uint256(x)] =
            Cell(uint8(kind), uint8(ownerKind), ownerPlayer, strength);
    }

    function _addSat(uint8 a, uint8 v) private pure returns (uint8) {
        uint16 t = uint16(a) + uint16(v);
        return t > 255 ? 255 : uint8(t);
    }
}
