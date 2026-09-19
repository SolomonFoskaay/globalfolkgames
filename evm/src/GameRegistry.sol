// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// GameRegistry — arcv2m16 (EVM rail, Phase 0).
///
/// The whole game does not live on-chain. Only the START and the END are
/// confirmed here: a game opens with a deadline, settles once, and an abandoned
/// game can be expired by anyone after its deadline so the tree never grows
/// unbounded. Batch roots let ONE transaction commit the results of MANY games,
/// which is what keeps the per-game cost tiny.
contract GameRegistry {
    struct Game {
        address p1;
        address p2;
        uint64 startAt;
        uint64 deadline;
        bytes32 resultHash; // 0 = not settled
        bool expired;
    }

    /// Hard ceiling for any game's time to live (seconds).
    uint32 public immutable maxTtl;

    mapping(bytes32 => Game) private _games;

    /// Latest batched roots (Phase 3 verifies a per-game Merkle proof against these).
    bytes32 public lastOpenRoot;
    bytes32 public lastSettleRoot;
    // Window state per kind (0 = open, 1 = settle). The LEAVES are the chain's
    // own events (derived with getLogs); these fields record the finalized root,
    // how many leaves it covers, and the block range, so the window is
    // restart-safe and fully verifiable from the chain alone. No off-chain store.
    mapping(uint8 => bytes32) public windowRoot;
    mapping(uint8 => uint256) public windowCount;
    mapping(uint8 => uint256) public windowFromBlock;
    mapping(uint8 => uint256) public windowToBlock;
    event WindowFinalized(uint8 indexed kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock);
    /// Same as WindowFinalized but records the SPONSOR GAS the app paid for this
    /// window (wei), so all spend accounting is on-chain and auditable. No file,
    /// no indexer, no off-chain store.
    event WindowFinalizedGas(uint8 indexed kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock, uint256 sponsorGasWei, uint256 timestamp);

    event GameOpened(bytes32 indexed gameId, address indexed p1, address indexed p2, uint64 startAt, uint64 deadline);
    event GameSettled(bytes32 indexed gameId, bytes32 resultHash);
    event GameExpired(bytes32 indexed gameId);
    event BatchCommitted(uint8 indexed kind, bytes32 root, uint256 count);

    constructor(uint32 maxTtl_) {
        require(maxTtl_ > 0, "ttl");
        maxTtl = maxTtl_;
    }

    /// Start a game. `msg.sender` is player one; `p2` is the opponent.
    function openGame(bytes32 gameId, address p2, uint32 ttl) external {
        require(_games[gameId].p1 == address(0), "exists");
        require(p2 != address(0), "p2");
        require(ttl > 0 && ttl <= maxTtl, "ttl");
        uint64 startAt = uint64(block.timestamp);
        uint64 deadline = startAt + ttl;
        _games[gameId] = Game(msg.sender, p2, startAt, deadline, bytes32(0), false);
        emit GameOpened(gameId, msg.sender, p2, startAt, deadline);
    }

    /// Finish a game: only a player, only once, only if not expired.
    function settleGame(bytes32 gameId, bytes32 resultHash) external {
        Game storage g = _games[gameId];
        require(g.p1 != address(0), "no game");
        require(!g.expired, "expired");
        require(g.resultHash == bytes32(0), "settled");
        require(msg.sender == g.p1 || msg.sender == g.p2, "not player");
        require(resultHash != bytes32(0), "result");
        g.resultHash = resultHash;
        emit GameSettled(gameId, resultHash);
    }

    /// Permissionless cleanup: after the deadline an abandoned game is closed.
    function expireGame(bytes32 gameId) external {
        Game storage g = _games[gameId];
        require(g.p1 != address(0), "no game");
        require(g.resultHash == bytes32(0), "settled");
        require(!g.expired, "expired");
        require(block.timestamp > g.deadline, "too soon");
        g.expired = true;
        emit GameExpired(gameId);
    }

    /// One transaction records the root of many games. kind 0 = opens, 1 = settles.
    function commitBatch(uint8 kind, bytes32 root, uint256 count) external {
        require(kind <= 1, "kind");
        require(root != bytes32(0), "root");
        require(count > 0, "count");
        if (kind == 0) lastOpenRoot = root;
        else lastSettleRoot = root;
        emit BatchCommitted(kind, root, count);
    }

    /// Finalize a settlement window: one transaction records the Merkle root of
    /// every leaf in [fromBlock, toBlock]. Anyone can recompute the leaves from
    /// the chain's events and check the root, so no off-chain state is trusted.
    /// Idempotent-by-range: a range already covered cannot be finalized twice.
    function finalizeWindow(uint8 kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock) external {
        require(kind <= 1, "kind");
        require(root != bytes32(0), "root");
        require(count > 0, "count");
        require(toBlock >= fromBlock, "range");
        require(fromBlock > windowToBlock[kind] || windowToBlock[kind] == 0, "already finalized");
        windowRoot[kind] = root;
        windowCount[kind] = count;
        windowFromBlock[kind] = fromBlock;
        windowToBlock[kind] = toBlock;
        if (kind == 0) lastOpenRoot = root; else lastSettleRoot = root;
        emit WindowFinalized(kind, root, count, fromBlock, toBlock);
    }

    /// Finalize a window AND record the sponsor gas paid for it (chain-only
    /// accounting). Same idempotent range guard. Additive: finalizeWindow stays.
    function finalizeWindowGas(uint8 kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock, uint256 sponsorGasWei) external {
        require(kind <= 1, "kind");
        require(root != bytes32(0), "root");
        require(count > 0, "count");
        require(toBlock >= fromBlock, "range");
        require(fromBlock > windowToBlock[kind] || windowToBlock[kind] == 0, "already finalized");
        windowRoot[kind] = root;
        windowCount[kind] = count;
        windowFromBlock[kind] = fromBlock;
        windowToBlock[kind] = toBlock;
        if (kind == 0) lastOpenRoot = root; else lastSettleRoot = root;
        emit WindowFinalizedGas(kind, root, count, fromBlock, toBlock, sponsorGasWei, block.timestamp);
    }

    function gameState(bytes32 gameId)
        external
        view
        returns (address p1, address p2, uint64 startAt, uint64 deadline, bytes32 resultHash, bool expired)
    {
        Game storage g = _games[gameId];
        return (g.p1, g.p2, g.startAt, g.deadline, g.resultHash, g.expired);
    }
}
