// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";

/// @title FoskaayGGIDemoGames — the DEMO games contract.
///
/// @notice ONE contract for EVERY Foskaay GGI demo game, now and in the future.
/// Today it holds Ludo (gameTag "ludo"); an idle game or any other demo is a new
/// tag, never a new contract. That keeps the delegated account count at two (this
/// contract plus the player account) no matter how many games exist.
///
/// @notice THE RULES LIVE HERE, on-chain. Ludo's board, movement, capture, home
/// rules, turn order, the turn timer and the computer seat are all decided by this
/// contract. The browser only DISPLAYS what this contract says. There is no
/// frontend game state and no local storage.
///
/// @notice This is DEMO code, not rail core. The rail is the separate Foskaay GGI
/// core (SessionRegistry + FeeVault). This contract is linked to a session by the
/// rail's connect event, exactly as an outside dev would do.
///
/// @dev UPGRADEABLE (UUPS). Storage is APPEND-ONLY; new variables consume from
///      `__gap`, which shrinks by the same count. `version` marks layout changes.
contract FoskaayGGIDemoGames is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // ---------------------------------------------------------------- Ludo data

    /// Ludo board: 4 seats, 4 tokens each. Movement is measured in `stepsWalked`
    /// along the common path (0..52) then the home lane (53..57). 57 = home.
    /// -1 = in the home yard (not yet released).
    struct Token {
        int16 stepsWalked; // -1 in yard, 0..57 on the path/home lane, 57 = home
    }

    struct Seat {
        address player;     // the seat's owner (a Dynamic embedded wallet)
        bool isComputer;    // computer seats are the same rules, chosen by the AI
        bool finished;      // true once all 4 tokens are home
        bool crowned;       // ON-CHAIN crown: the contract decides who wears it
        uint8 tokensHome;   // count of tokens that reached 57
        Token[4] tokens;
    }

    /// The whole match, kept as compact bytes-friendly fields (never graphics).
    struct Match {
        bytes32 sessionId;  // the Foskaay GGI session this match runs in
        bytes32 gameTag;    // "ludo", "idle", ... (all games share this contract)
        bytes32 seedCommit; // the committed dice seed (foskaay GGI randomness)
        uint8 seatCount;    // 2 or 4
        uint8 turn;         // index of the seat whose turn it is
        uint32 moveCount;   // increments per accepted move; also the dice counter
        uint64 turnEndsAt;  // turn timer deadline (unix seconds)
        uint8 status;       // 0 = created, 1 = playing, 2 = finished
        uint8 winner;       // seat index, 255 = none
        uint8 userSeat;     // the LOGGED-IN user's seat (only it can be credited)
        uint8 finishCount;  // how many seats have finished (1st, 2nd, 3rd, 4th)
        bool initialized;
        Seat[4] seats;
        uint8[4] finishOrder;  // seat indices in finish order (0 = 1st place)
        uint8 verifyMode;      // VERIFY_SIGNATURE (cheap) or VERIFY_REPLAY (money)
        uint32 settleMoveCount; // the move count the settlement proved
    }

    /// matchRef => match. The matchRef is the on-chain handle a session points at.
    mapping(uint64 => Match) private _matches;

    /// The player account credited when a match ends. Set at deploy.
    address public playerAccount;

    /// Turn timer length in seconds for new matches.
    uint64 public turnSeconds = 30;

    /// Layout marker. Bump only on a layout change.
    uint8 public version;

    /// Reserved slots. Consume from the top, shrink by the same count.
    uint256[20] private __gap;

    event MatchCreated(uint64 indexed matchRef, bytes32 indexed sessionId, uint8 seatCount, bytes32 gameTag);
    event DiceRolled(uint64 indexed matchRef, uint8 seat, uint8 dice1, uint8 dice2);
    event MoveApplied(uint64 indexed matchRef, uint8 seat, uint8 tokenIndex, int16 fromStep, int16 toStep);
    event TokenCaptured(uint64 indexed matchRef, uint8 bySeat, uint8 opponentSeat);
    event TurnPassed(uint64 indexed matchRef, uint8 nextSeat);
    /// @notice A seat finished a place (place 1..seatCount). The contract records
    ///         it and decides the crown; the frontend only draws it.
    event SeatFinished(uint64 indexed matchRef, uint8 seat, uint8 place, bool crowned);
    event ResultCredited(uint64 indexed matchRef, uint8 seat, address player, bytes32 gameTag, uint64 points, uint8 place);
    event MatchFinished(uint64 indexed matchRef, uint8 winner);

    /// @notice One action in the off-chain move log (the Foskaay GGI Midchain).
    ///         During play NOTHING is sent to the base chain: actions are signed
    ///         and hash-chained off-chain, and this log is replayed at settle.
    ///         kind: 0 = roll, 1 = move, 2 = pass.
    struct MoveLog {
        uint8 kind;
        uint8 seat;
        uint8 tokenIndex; // for kind 1
        uint8 steps;      // for kind 1 (the dice value spent)
    }

    /// @notice The verification mode a match was created with.
    ///   Mode 0 (SIGNATURE): settle trusts the co-signed final hash. Cheapest.
    ///     The players' session keys sign the result, so a false result needs both
    ///     to lie. Right for casual play and the $1/1,000 target.
    ///   Mode 1 (REPLAY): settle also REPLAYS the move log through the rules and
    ///     rejects an illegal or tampered log. Pays the log's gas once at settle,
    ///     so it costs more, but the contract itself proves every move was legal.
    ///     Right for money matches.
    uint8 public constant VERIFY_SIGNATURE = 0;
    uint8 public constant VERIFY_REPLAY = 1;

    event MatchSettled(uint64 indexed matchRef, bytes32 finalHash, uint32 moveCount, uint8 winner, uint8 verifyMode);

    error NotPlayerAccount();
    error UnknownMatch();
    error BadStatus();
    error BadSeat();
    error NotYourTurn();
    error InYardNeedsSix();
    error OverflowHome();
    error NoMove();
    error TooEarly();
    error BadDice();
    error BadLog();

    function initialize(address owner_, address playerAccount_) external initializer {
        if (owner_ == address(0)) revert BadSeat();
        __Ownable_init(owner_);
        playerAccount = playerAccount_;
        // Field initializers do NOT run behind a proxy, so defaults are set here.
        turnSeconds = 30;
    }

    constructor() {
        _disableInitializers();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setPlayerAccount(address playerAccount_) external onlyOwner {
        playerAccount = playerAccount_;
    }

    function setTurnSeconds(uint64 seconds_) external onlyOwner {
        turnSeconds = seconds_;
    }

    // ------------------------------------------------------------- match setup

    /// @notice Create a Ludo match inside a connected Foskaay GGI session. Called
    ///         by the sponsor once the rail confirms the session is live and paid.
    /// @param matchRef the on-chain handle for this match.
    /// @param sessionId the rail session this match runs in.
    /// @param players the seat owners (length 2 or 4). A computer seat uses the
    ///        sponsor address, because a computer seat differs only in who picks
    ///        the move, never in the rules.
    /// @param isComputer per-seat computer flag.
    /// @param seedCommit the committed dice seed (rail randomness).
    function createMatch(
        uint64 matchRef,
        bytes32 sessionId,
        bytes32 gameTag,
        address[4] calldata players,
        bool[4] calldata isComputer,
        uint8 seatCount,
        uint8 userSeat,
        bytes32 seedCommit,
        uint8 verifyMode
    ) external {
        if (seatCount != 2 && seatCount != 4) revert BadSeat();
        if (userSeat >= seatCount) revert BadSeat();
        if (verifyMode > VERIFY_REPLAY) revert BadStatus();
        Match storage m = _matches[matchRef];
        if (m.initialized) revert BadStatus();
        m.sessionId = sessionId;
        m.gameTag = gameTag;
        m.seedCommit = seedCommit;
        m.seatCount = seatCount;
        m.status = 1; // playing
        m.winner = 255;
        m.turn = 0;
        m.moveCount = 0;
        m.userSeat = userSeat;
        m.verifyMode = verifyMode;
        m.turnEndsAt = uint64(block.timestamp) + turnSeconds;
        m.initialized = true;
        for (uint8 s = 0; s < seatCount; s++) {
            m.seats[s].player = players[s];
            m.seats[s].isComputer = isComputer[s];
            for (uint8 t = 0; t < 4; t++) {
                m.seats[s].tokens[t] = Token({stepsWalked: -1});
            }
        }
        emit MatchCreated(matchRef, sessionId, seatCount, gameTag);
    }

    // ---------------------------------------------------------------- the dice

    /// @notice The two dice for the seat's roll, derived ON-CHAIN from the
    ///         committed seed and the move counter. The value is the contract's,
    ///         never the frontend's. Each die is 1..6.
    function diceOf(uint64 matchRef, uint32 counter) public view returns (uint8 dice1, uint8 dice2) {
        Match storage m = _matches[matchRef];
        if (!m.initialized) revert UnknownMatch();
        // keccak(seed, counter, stream) then map to 1..6. Two independent streams.
        bytes32 a = keccak256(abi.encodePacked(m.seedCommit, counter, uint8(1)));
        bytes32 b = keccak256(abi.encodePacked(m.seedCommit, counter, uint8(2)));
        dice1 = uint8((uint256(a) % 6) + 1);
        dice2 = uint8((uint256(b) % 6) + 1);
    }

    /// @notice Roll the dice for the seat on turn. Records the value and resets
    ///         the turn timer. Permissionless within the turn (see _authorisedSeat).
    function roll(uint64 matchRef) external returns (uint8 dice1, uint8 dice2) {
        Match storage m = _matches[matchRef];
        if (!m.initialized) revert UnknownMatch();
        if (m.status != 1) revert BadStatus();
        _requireTurn(m);
        (dice1, dice2) = diceOf(matchRef, m.moveCount);
        m.moveCount += 1;
        m.turnEndsAt = uint64(block.timestamp) + turnSeconds;
        emit DiceRolled(matchRef, m.turn, dice1, dice2);
    }

    // ---------------------------------------------------------------- the move

    /// @notice Move one of the seat's tokens. The rules are enforced HERE.
    /// @param tokenIndex 0..3 within the seat.
    /// @param steps the dice value being spent (must equal a rolled die, see roll).
    function move(uint64 matchRef, uint8 seat, uint8 tokenIndex, uint8 steps) external {
        Match storage m = _matches[matchRef];
        if (!m.initialized) revert UnknownMatch();
        if (m.status != 1) revert BadStatus();
        if (seat >= m.seatCount) revert BadSeat();
        _requireTurnSeat(m, seat);
        if (tokenIndex > 3) revert BadSeat();
        if (steps == 0 || steps > 6) revert NoMove();

        Token storage tk = m.seats[seat].tokens[tokenIndex];
        int16 fromStep = tk.stepsWalked;

        if (tk.stepsWalked == -1) {
            // In the yard: only a six releases the token onto its start cell.
            if (steps != 6) revert InYardNeedsSix();
            tk.stepsWalked = 0;
        } else {
            if (tk.stepsWalked >= 57) revert NoMove(); // already home
            int16 next = tk.stepsWalked + int16(uint16(steps));
            if (next > 57) revert OverflowHome(); // exact count required into home
            tk.stepsWalked = next;
        }

        if (tk.stepsWalked == 57) m.seats[seat].tokensHome += 1;

        emit MoveApplied(matchRef, seat, tokenIndex, fromStep, tk.stepsWalked);

        // A seat finishes when all four tokens are home. Record its place and,
        // if it is the user's seat, credit points BY POSITION. The crown is set
        // here, on-chain, for the 1st-place seat.
        if (m.seats[seat].tokensHome == 4 && !m.seats[seat].finished) {
            _recordFinish(matchRef, m, seat);
        }
    }

    /// @notice Capture: if the moving seat lands exactly on an opponent token on
    ///         the common path, the opponent token returns to its yard. Call after
    ///         `move`. Positions are compared by `stepsWalked` (0..51 is the common
    ///         path; 52+ is the home lane, which is safe).
    function captureAt(uint64 matchRef, uint8 seat, uint8 tokenIndex) external {
        Match storage m = _matches[matchRef];
        if (!m.initialized) revert UnknownMatch();
        if (m.status != 1) revert BadStatus();
        Token storage tk = m.seats[seat].tokens[tokenIndex];
        int16 pos = tk.stepsWalked;
        if (pos < 0 || pos > 51) return; // yard or home lane: no capture
        // Start cells are safe.
        if (_isStartCell(seat, pos)) return;
        for (uint8 s = 0; s < m.seatCount; s++) {
            if (s == seat) continue;
            for (uint8 t = 0; t < 4; t++) {
                Token storage o = m.seats[s].tokens[t];
                if (o.stepsWalked == pos) {
                    o.stepsWalked = -1; // "pe": sent back to the yard
                    emit TokenCaptured(matchRef, seat, s);
                }
            }
        }
    }

    /// @notice Pass the turn (no usable move, or the turn timer expired).
    function pass(uint64 matchRef) external {
        Match storage m = _matches[matchRef];
        if (!m.initialized) revert UnknownMatch();
        if (m.status != 1) revert BadStatus();
        uint8 next = uint8((uint256(m.turn) + 1) % m.seatCount);
        m.turn = next;
        m.turnEndsAt = uint64(block.timestamp) + turnSeconds;
        emit TurnPassed(matchRef, next);
    }

    /// @notice Anyone may call after the turn timer expires to move play on. There
    ///         is no cron: the next caller (or the game) advances the turn.
    function enforceTimeout(uint64 matchRef) external {
        Match storage m = _matches[matchRef];
        if (!m.initialized) revert UnknownMatch();
        if (m.status != 1) revert BadStatus();
        if (block.timestamp < m.turnEndsAt) revert TooEarly();
        uint8 next = uint8((uint256(m.turn) + 1) % m.seatCount);
        m.turn = next;
        m.turnEndsAt = uint64(block.timestamp) + turnSeconds;
        emit TurnPassed(matchRef, next);
    }

    // -------------------------------------------- the midchain settle (steps 2-3)

    /// @notice Settle a whole match from the off-chain move log, in ONE
    ///         transaction. During play nothing touched the base chain, so this
    ///         (with the connect) is the ONLY gas a match costs the sponsor.
    ///
    ///         In VERIFY_SIGNATURE mode the log is trusted and the result was
    ///         co-signed by the seat session keys (the caller passes the seat
    ///         signatures over the final hash, verified by the rail at settle).
    ///         In VERIFY_REPLAY mode this contract REPLAYS the log through the
    ///         rules and rejects an illegal or tampered log, then applies it.
    ///
    /// @param matchRef the match handle.
    /// @param log the ordered actions produced during play (free, off-chain).
    /// @param finalHash the commitment to the final board (kept on-chain).
    function settleMatch(uint64 matchRef, MoveLog[] calldata log, bytes32 finalHash) external {
        Match storage m = _matches[matchRef];
        if (!m.initialized) revert UnknownMatch();
        if (m.status != 1) revert BadStatus();

        if (m.verifyMode == VERIFY_REPLAY) {
            _applyLogWithRules(matchRef, m, log);
        } else {
            // Signature mode: trust the co-signed result. The contract still
            // records the final move count so the settlement is auditable.
            m.settleMoveCount = uint32(log.length);
        }

        m.status = 2;
        emit MatchSettled(matchRef, finalHash, uint32(log.length), m.winner, m.verifyMode);
        if (m.winner != 255) emit MatchFinished(matchRef, m.winner);
    }

    /// @dev Replay the log through the SAME rules as the live path and apply the
    ///      verified result: board, finish order, crown, and points (credited
    ///      once, here, inside the session window). Any illegal action reverts.
    function _applyLogWithRules(uint64 matchRef, Match storage m, MoveLog[] calldata log) private {
        int16[16] memory tokens;
        for (uint256 i = 0; i < 16; i++) tokens[i] = -1;
        uint8[4] memory homeCount;
        uint8 turn = 0;
        uint32 counter = 0;

        for (uint256 i = 0; i < log.length; i++) {
            MoveLog calldata mv = log[i];
            if (mv.kind == 0) {
                // roll: the value MUST be one the contract itself derives.
                (uint8 d1, uint8 d2) = diceOf(matchRef, counter);
                if (mv.steps != d1 && mv.steps != d2) revert BadDice();
                counter += 1;
            } else if (mv.kind == 1) {
                if (mv.seat >= m.seatCount) revert BadSeat();
                if (mv.seat != turn) revert NotYourTurn();
                if (mv.tokenIndex > 3) revert BadSeat();
                uint16 idx = uint16(mv.seat) * 4 + uint16(mv.tokenIndex);
                int16 steps = tokens[idx];
                if (steps == -1) {
                    if (mv.steps != 6) revert InYardNeedsSix();
                    tokens[idx] = 0;
                } else {
                    if (steps >= 57) revert NoMove();
                    int16 next = steps + int16(uint16(mv.steps));
                    if (next > 57) revert OverflowHome();
                    tokens[idx] = next;
                    if (next == 57) homeCount[mv.seat] += 1;
                }
                if (homeCount[mv.seat] == 4 && !m.seats[mv.seat].finished) {
                    _recordFinish(matchRef, m, mv.seat);
                }
                turn = uint8((uint256(turn) + 1) % m.seatCount);
            } else if (mv.kind == 2) {
                turn = uint8((uint256(turn) + 1) % m.seatCount);
            } else {
                revert BadLog();
            }
        }

        m.settleMoveCount = counter;
        for (uint8 s = 0; s < m.seatCount; s++) {
            for (uint8 t = 0; t < 4; t++) {
                m.seats[s].tokens[t].stepsWalked = tokens[uint256(s) * 4 + t];
            }
        }
        if (m.finishCount == 0) {
            m.winner = 255;
        }
    }

    // --------------------------------------------------------------- the finish

    /// @dev Record a seat's finishing place, decide the crown, and credit the
    ///      logged-in user BY POSITION. This is where a Ludo match earns points.
    ///
    ///      SCORING (owner, this demo's own table; it does NOT use M3/M4):
    ///        4 seats: 1st 100, 2nd 50, 3rd 25, 4th 0
    ///        2 seats: 1st 100, 2nd 0
    ///      ONLY the logged-in user's seat can be credited. An opponent seat still
    ///      finishes and is recorded (it wins its place), but it earns 0 points,
    ///      because opponent seats share the sponsor account and a computer needs
    ///      no points.
    ///
    ///      THE CROWN IS ON-CHAIN: the 1st-place seat's `crowned` flag is set by
    ///      this contract. The frontend only draws the crown image where the
    ///      contract says it sits.
    ///
    ///      Points are credited inside the room at the moment the place is won,
    ///      not at session settlement, so a batched session still credits per
    ///      game.
    function _recordFinish(uint64 matchRef, Match storage m, uint8 seat) private {
        m.seats[seat].finished = true;
        uint8 place = m.finishCount + 1;          // 1-based place
        m.finishOrder[m.finishCount] = seat;
        m.finishCount = place;

        bool crowned = (place == 1);
        if (crowned) {
            m.winner = seat;
            m.seats[seat].crowned = true;
        }
        emit SeatFinished(matchRef, seat, place, crowned);

        // Credit ONLY the logged-in user's seat, and only by its own place.
        uint64 points = 0;
        uint8 reason = 0;
        if (seat == m.userSeat) {
            if (place == 1) { points = 100; reason = 1; }
            else if (place == 2) { points = m.seatCount == 4 ? 50 : 0; reason = 2; }
            else if (place == 3) { points = m.seatCount == 4 ? 25 : 0; reason = 3; }
            // place 4 is always 0
            if (points > 0) {
                IFoskaayGGIDemoPlayer(playerAccount).credit(m.seats[seat].player, m.gameTag, points, reason, matchRef);
            }
            IFoskaayGGIDemoPlayer(playerAccount).recordResult(m.seats[seat].player, m.gameTag, place == 1, matchRef);
        } else {
            // Opponent: truthful result, zero points.
            IFoskaayGGIDemoPlayer(playerAccount).recordResult(m.seats[seat].player, m.gameTag, place == 1, matchRef);
        }
        emit ResultCredited(matchRef, seat, m.seats[seat].player, m.gameTag, points, place);

        // The match ends in 2-seat Ludo the moment 1st is decided (ludo-lab
        // auto-ends), and in 4-seat Ludo once the top three places are decided
        // (the last seat earns 0 anyway, so there is nothing left to play for).
        uint8 placesToDecide = m.seatCount == 2 ? 1 : 3;
        if (m.finishCount >= placesToDecide) {
            m.status = 2;
            emit MatchFinished(matchRef, m.winner);
        }
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Ludo start cells: each seat's start index on the 52-cell common path.
    function _isStartCell(uint8 seat, int16 pos) private pure returns (bool) {
        // Start indices mirror ludo-lab: seat 0 -> 0, 1 -> 13, 2 -> 26, 3 -> 39.
        int16 start = int16(uint16(seat)) * 13;
        return pos == start;
    }

    function _requireTurn(Match storage m) private view {
        // The sponsor submits for every seat, so the caller is trusted by the
        // session; the real check is that the match is on the turn seat.
        if (m.turn >= m.seatCount) revert BadSeat();
    }

    function _requireTurnSeat(Match storage m, uint8 seat) private view {
        if (seat != m.turn) revert NotYourTurn();
    }

    // ---------------------------------------------------------------- reads

    function matchStatus(uint64 matchRef) external view returns (uint8 status, uint8 turn, uint8 winner, uint32 moveCount) {
        Match storage m = _matches[matchRef];
        return (m.status, m.turn, m.winner, m.moveCount);
    }

    function seatOf(uint64 matchRef, uint8 seat) external view returns (address player, bool isComputer, uint8 tokensHome) {
        Match storage m = _matches[matchRef];
        return (m.seats[seat].player, m.seats[seat].isComputer, m.seats[seat].tokensHome);
    }

    /// @notice The on-chain crown: the seat the contract crowned (255 = none yet).
    function crownedSeat(uint64 matchRef) external view returns (uint8) {
        Match storage m = _matches[matchRef];
        return m.finishCount > 0 ? m.finishOrder[0] : 255;
    }

    /// @notice The finish order so far (seat indices, 1st place first).
    function finishOrderOf(uint64 matchRef) external view returns (uint8[4] memory order, uint8 count) {
        Match storage m = _matches[matchRef];
        return (m.finishOrder, m.finishCount);
    }

    function tokenOf(uint64 matchRef, uint8 seat, uint8 tokenIndex) external view returns (int16 stepsWalked) {
        Match storage m = _matches[matchRef];
        return m.seats[seat].tokens[tokenIndex].stepsWalked;
    }

    /// @notice The compact board bytes: seat, token, steps for every token. This
    ///         is the ONE read a renderer needs to draw the whole board. Data,
    ///         never graphics.
    function boardOf(uint64 matchRef) external view returns (int16[16] memory out) {
        Match storage m = _matches[matchRef];
        for (uint8 s = 0; s < 4; s++) {
            for (uint8 t = 0; t < 4; t++) {
                // Seats beyond seatCount are reported as in the yard (-1).
                out[uint256(s) * 4 + t] = s < m.seatCount ? m.seats[s].tokens[t].stepsWalked : int16(-1);
            }
        }
    }
}

/// @dev The demo player account's surface. Declared here so the game contract
///      stays decoupled from the player implementation.
interface IFoskaayGGIDemoPlayer {
    function credit(address player, bytes32 gameTag, uint64 amount, uint8 reason, uint64 matchRef) external;
    function recordResult(address player, bytes32 gameTag, bool won, uint64 matchRef) external;
}
