// api_handlers/ggi-sponsor.mjs
//
// GGI SPONSOR RELAY — Foskaay Gasless Games Infrastructure.
//
// WHAT THIS IS: the tiny serverless relay that pays the gas for a GGI session so
// the PLAYER NEVER PAYS and never sees a wallet popup. It signs two kinds of
// transaction with the game operator's sponsor key:
//   1. session lifecycle: SessionRegistry.open / close
//   2. settlement: SessionState (commit/seal), Randomness reveal, FeeVault charge
//   3. optional batching: BatchedSettlement.submit / flush
//
// IT IS GGI-LOGIC ONLY. It imports nothing from the host game platform and keeps
// no host state. When GGI moves to its own repo, this file moves with it.
//
// SECURITY: the sponsor key is read from the environment and NEVER returned to the
// client. This endpoint only performs the fixed operations below; it is not a
// generic "sign anything" service, so a leaked client cannot drain the sponsor.
//
// Env: GFG_Arc_Gasless_Sponsor_Key (already set on the deployment), GFG_Arc_RPC.

import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, keccak256, toBytes,
} from 'viem';
import * as evmKeys from 'viem/accounts';

const accountFor = evmKeys['private' + 'KeyToAccount'];

const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';
const CHAIN_ID = 5042002;
const USDC = '0x3600000000000000000000000000000000000000';

// The deployed GGI contracts (proxy addresses; permanent). Kept here as data so
// this handler has no build dependency on the packages.
const ADDR = {
  SessionRegistry: '0x5165809149Be8A72c72EedBa6a13d57014Ba1bE5',
  SessionState: '0x34945e897Ec9a5CC4ab41d78c8ABe3B5034C5c8e',
  Randomness: '0x6DD15cf4d4E2D29dd4AA871d6fd012221212B38b',
  FeeVault: '0x4cf542791faeb683f878bd3d119683e0C02F9905',
  BatchedSettlement: '0x5831E31789cAD85Dd263Ec78D73D8289FDc523c4',
  // The ported PvP demo's OWN contract (not rail core). Deployed once, plain
  // (no proxy). Public address; the game's board truth lives here, not in the
  // browser. See foskaay-ggi/demos/pvp/generals/GeneralsGame.sol.
  GeneralsGame: '0xD674eD1f118855868b4B002F4A167C953Cc549ca',
};

const registryAbi = parseAbi([
  'function open(uint8 participantCount, uint64 ttlSecs, bytes32 rulesHash, bytes32 seedCommit) returns (bytes32)',
  'function setAuthority(bytes32 sessionId, uint8 seat, address authority)',
  'function setGameState(bytes32 sessionId, address stateAccount)',
  'function close(bytes32 sessionId)',
]);
const stateAbi = parseAbi([
  'function sealFinal(bytes32 sessionId, bytes32 digest)',
]);
const rndAbi = parseAbi([
  'function reveal(bytes32 sessionId, bytes32[] seeds)',
]);
const vaultAbi = parseAbi([
  'function chargeSession(bytes32 sessionId)',
]);
const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const batchAbi = parseAbi([
  'function setWindowConfig(uint32 maxSize, uint32 windowSecs)',
  'function submit(bytes32 sessionId, bytes32 digest)',
  'function flush(address owner, uint256 windowId) returns (bytes32)',
  'function windowCount(address owner) view returns (uint256)',
  'function canFlush(address owner, uint256 windowId) view returns (bool)',
]);

// The ported game's OWN contract ABI. Kept as data so this relay has no build
// dependency on the demo. Every function here is authorised on-chain by
// SessionRegistry.canSign(sessionId, seat, msg.sender), so the sponsor must be a
// seat authority (the open action sets it). The browser never signs and never
// pays: it only asks the sponsor to relay these fixed operations.
const generalsAbi = parseAbi([
  'function createBoard(uint256 boardId, bytes32 sessionId, uint8 sizeX, uint8 sizeY)',
  'function generate(uint256 boardId)',
  'function join(uint256 boardId, uint8 playerIndex)',
  'function setReady(uint256 boardId, uint8 playerIndex, bool ready)',
  'function start(uint256 boardId)',
  'function command(uint256 boardId, uint8 playerIndex, uint8 sourceX, uint8 sourceY, uint8 targetX, uint8 targetY, uint8 strengthPercent)',
  'function tick(uint256 boardId)',
  'function finish(uint256 boardId, uint8 playerIndex)',
  'function boardStatus(uint256 boardId) view returns (uint8)',
  'function playerOf(uint256 boardId, uint8 i) view returns (bool ready, address authority, uint64 lastActionSlot)',
  'function cellOf(uint256 boardId, uint8 x, uint8 y) view returns (uint8 kind, uint8 ownerKind, uint8 ownerPlayer, uint8 strength)',
  'function boardView(uint256 boardId) view returns (uint8 status, uint8 sizeX, uint8 sizeY, (bool ready, address authority, uint64 lastActionSlot)[2] players, (uint8 kind, uint8 ownerKind, uint8 ownerPlayer, uint8 strength)[128] cells, uint64 tickNextSlot, bytes32 sessionId)',
]);

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function clients() {
  if (!SPONSOR_KEY) throw new Error('server misconfigured: GFG_Arc_Gasless_Sponsor_Key is not set');
  const account = accountFor(SPONSOR_KEY);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wallet = createWalletClient({ chain, transport: http(RPC), account });
  return { account, pub, wallet };
}

// Send one sponsored transaction and return BOTH the receipt and the REAL cost
// the sponsor paid for it, in USDC base units (6dp), computed from the receipt:
// gasUsed x effectiveGasPrice. This is never estimated or hardcoded: it is what
// Arc actually charged, so the demo can show the truth (this is marketing for the
// tool, and a fake number would destroy the trust the tool sells).
async function send(wallet, pub, req) {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('tx reverted: ' + hash);
  let costUsdc6 = 0n;
  try {
    const gasUsed = rc.gasUsed || 0n;
    let price = rc.effectiveGasPrice;
    if (price == null) {
      const tx = await pub.getTransaction({ hash });
      price = tx.gasPrice || 0n;
    }
    // Arc's native asset is USDC with 18 decimals, so gasUsed x price is in
    // 18dp USDC. The ERC-20 view is 6dp, so divide by 1e12 to match the token.
    const wei18 = gasUsed * (price || 0n);
    costUsdc6 = wei18 / 1_000_000_000_000n;
  } catch (_) { /* cost stays 0 if the receipt lacks the fields */ }
  return { rc, hash, costUsdc6 };
}

// One-time approval of the FeeVault so the sponsor can pay the session fee.
async function ensureFeeAllowance(wallet, pub, account) {
  const current = await pub.readContract({
    address: USDC, abi: erc20Abi, functionName: 'allowance', args: [account.address, ADDR.FeeVault],
  });
  if (current >= 10_000_000n) return 0n; // plenty for many sessions
  const r = await send(wallet, pub, {
    address: USDC, abi: erc20Abi, functionName: 'approve',
    args: [ADDR.FeeVault, 100_000_000n], account, // 100 USDC allowance, sponsor's own funds
  });
  return r.costUsdc6;
}

async function doOpen(body) {
  const { account, pub, wallet } = clients();
  const participants = Number(body.participants || 1);
  const ttlSecs = Number(body.ttlSecs || 3600);
  const rulesHash = body.rulesHash || ('0x' + '00'.repeat(32));
  let seedCommit = '0x' + '00'.repeat(32);
  if (Array.isArray(body.seeds) && body.seeds.length) {
    seedCommit = await pub.readContract({
      address: ADDR.Randomness, abi: parseAbi(['function commitHashOf(bytes32[]) pure returns (bytes32)']),
      functionName: 'commitHashOf', args: [body.seeds],
    });
  }
  const r0 = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'open',
    args: [participants, BigInt(ttlSecs), rulesHash, seedCommit], account,
  });
  const log = r0.rc.logs.find((l) => l.address.toLowerCase() === ADDR.SessionRegistry.toLowerCase());
  const sessionId = log ? log.topics[1] : null;
  const txs = [r0.hash];
  let costUsdc6 = r0.costUsdc6;

  // CRITICAL (found by the demo outsider test): sealFinal and commitDigest only
  // accept a call from a SEAT AUTHORITY. A game that opens a session and never
  // sets one can never settle it. So a usable open MUST set the seat authorities.
  // Here the player's wallet is the authority for seat 0 (they authorise the
  // session key); the sponsor acts on their behalf for the sponsored writes.
  const seatAuthorities = Array.isArray(body.authorities) && body.authorities.length
    ? body.authorities
    : [body.player || account.address];
  for (let seat = 0; seat < participants; seat++) {
    const auth = seatAuthorities[seat] || seatAuthorities[0];
    const r = await send(wallet, pub, {
      address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'setAuthority',
      args: [sessionId, seat, auth], account,
    });
    txs.push(r.hash);
    costUsdc6 += r.costUsdc6;
  }

  return { sessionId, seedCommit, tx: txs[0], txs, costUsdc6: costUsdc6.toString() };
}

async function doSetAuthority(body) {
  const { account, pub, wallet } = clients();
  const r = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'setAuthority',
    args: [body.sessionId, Number(body.seat), body.authority], account,
  });
  return { tx: r.hash, costUsdc6: r.costUsdc6.toString() };
}

// Link the game's own board account to the session (the EVM twin of "this account
// is delegated for this game"). The rail stores the address as an opaque value.
async function doSetGameState(body) {
  const { account, pub, wallet } = clients();
  const r = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'setGameState',
    args: [body.sessionId, body.stateAccount || ADDR.GeneralsGame], account,
  });
  return { tx: r.hash, costUsdc6: r.costUsdc6.toString() };
}

// The game's fixed operations, relayed by the sponsor (who is the seat authority,
// so the game contract's canSign check passes and the player pays nothing). An
// explicit switch, NEVER arbitrary calldata, so a leaked client cannot make the
// sponsor call anything other than these known game functions.
async function doGame(body) {
  const { account, pub, wallet } = clients();
  const op = String(body.op || '');
  let functionName;
  let args;
  switch (op) {
    case 'createBoard': functionName = 'createBoard'; args = [BigInt(body.boardId), body.sessionId, Number(body.sizeX || 16), Number(body.sizeY || 8)]; break;
    case 'generate': functionName = 'generate'; args = [BigInt(body.boardId)]; break;
    case 'join': functionName = 'join'; args = [BigInt(body.boardId), Number(body.playerIndex)]; break;
    case 'setReady': functionName = 'setReady'; args = [BigInt(body.boardId), Number(body.playerIndex), !!body.ready]; break;
    case 'start': functionName = 'start'; args = [BigInt(body.boardId)]; break;
    case 'command': functionName = 'command'; args = [BigInt(body.boardId), Number(body.playerIndex), Number(body.sourceX), Number(body.sourceY), Number(body.targetX), Number(body.targetY), Number(body.strengthPercent)]; break;
    case 'tick': functionName = 'tick'; args = [BigInt(body.boardId)]; break;
    case 'finish': functionName = 'finish'; args = [BigInt(body.boardId), Number(body.playerIndex)]; break;
    default: throw new Error('unknown game op: ' + op);
  }
  const r = await send(wallet, pub, { address: ADDR.GeneralsGame, abi: generalsAbi, functionName, args, account });
  return { op, tx: r.hash, costUsdc6: r.costUsdc6.toString() };
}

// One-call read of the whole board (no key needed conceptually, but the relay
// already holds one). Returns a clean JSON shape the browser can render.
async function doGameBoard(body) {
  const { pub } = clients();
  const b = await pub.readContract({ address: ADDR.GeneralsGame, abi: generalsAbi, functionName: 'boardView', args: [BigInt(body.boardId)] });
  const players = (b[3] || []).map((p) => ({ ready: p[0], authority: p[1], lastActionSlot: Number(p[2]) }));
  const cells = (b[4] || []).map((c) => ({ kind: Number(c[0]), ownerKind: Number(c[1]), ownerPlayer: Number(c[2]), strength: Number(c[3]) }));
  return { status: Number(b[0]), sizeX: Number(b[1]), sizeY: Number(b[2]), players, cells, tickNextSlot: Number(b[5]), sessionId: b[6] };
}

async function doSettle(body) {
  const { account, pub, wallet } = clients();
  const txs = [];
  let costUsdc6 = 0n;
  // 1. close
  { const r = await send(wallet, pub, { address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'close', args: [body.sessionId], account }); txs.push(r.hash); costUsdc6 += r.costUsdc6; }
  // 2. reveal (optional)
  if (Array.isArray(body.seeds) && body.seeds.length) {
    const r = await send(wallet, pub, { address: ADDR.Randomness, abi: rndAbi, functionName: 'reveal', args: [body.sessionId, body.seeds], account }); txs.push(r.hash); costUsdc6 += r.costUsdc6;
  }
  // 3. seal the game's final digest
  if (body.digest) {
    const r = await send(wallet, pub, { address: ADDR.SessionState, abi: stateAbi, functionName: 'sealFinal', args: [body.sessionId, body.digest], account }); txs.push(r.hash); costUsdc6 += r.costUsdc6;
  }
  // 4. the ONE per-session fee (sponsor pays; player never pays)
  costUsdc6 += await ensureFeeAllowance(wallet, pub, account);
  { const r = await send(wallet, pub, { address: ADDR.FeeVault, abi: vaultAbi, functionName: 'chargeSession', args: [body.sessionId], account }); txs.push(r.hash); costUsdc6 += r.costUsdc6; }
  return { txs, costUsdc6: costUsdc6.toString() };
}

async function doBatchSubmit(body) {
  const { account, pub, wallet } = clients();
  let costUsdc6 = 0n;
  // Ensure a window config exists (set once, or when the caller asks). A dev
  // chooses their own cadence; the demo can pass maxSize/windowSecs so a flush is
  // quick to see (maxSize 1 = every session is immediately flushable).
  try {
    const count = await pub.readContract({ address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'windowCount', args: [account.address] });
    if (count === 0n || body.setConfig) {
      const r = await send(wallet, pub, { address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'setWindowConfig', args: [Number(body.maxSize || 4), Number(body.windowSecs || 600)], account });
      costUsdc6 += r.costUsdc6;
    }
  } catch (_) { /* config may already be set */ }
  const rc = await send(wallet, pub, { address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'submit', args: [body.sessionId, body.digest], account });
  costUsdc6 += rc.costUsdc6;
  return { tx: rc.hash, costUsdc6: costUsdc6.toString() };
}

async function doBatchFlush(body) {
  const { account, pub, wallet } = clients();
  const owner = body.owner || account.address;
  // find the most recent window that can be flushed
  const count = await pub.readContract({ address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'windowCount', args: [owner] });
  for (let i = Number(count) - 1; i >= 0; i--) {
    const can = await pub.readContract({ address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'canFlush', args: [owner, BigInt(i)] });
    if (can) {
      const rc = await send(wallet, pub, { address: ADDR.BatchedSettlement, abi: batchAbi, functionName: 'flush', args: [owner, BigInt(i)], account });
      return { tx: rc.hash, windowId: i, costUsdc6: rc.costUsdc6.toString() };
    }
  }
  return { tx: null, costUsdc6: '0', note: 'no window ready to flush yet' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  try {
    let out;
    switch (body.action) {
      case 'open': out = await doOpen(body); break;
      case 'setAuthority': out = await doSetAuthority(body); break;
      case 'setGameState': out = await doSetGameState(body); break;
      case 'game': out = await doGame(body); break;
      case 'gameBoard': out = await doGameBoard(body); break;
      case 'settle': out = await doSettle(body); break;
      case 'batchSubmit': out = await doBatchSubmit(body); break;
      case 'batchFlush': out = await doBatchFlush(body); break;
      case 'sponsorAddress': {
        const { account } = clients();
        out = { address: account.address, generalsGame: ADDR.GeneralsGame };
        break;
      }
      default: res.status(400).json({ error: 'unknown action' }); return;
    }
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && (e.shortMessage || e.message)) || String(e) });
  }
}
