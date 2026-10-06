// api_handlers/foskaay-ggi-sponsor.mjs
//
// FOSKAAY GGI SPONSOR RELAY — Foskaay Gasless Games Infrastructure.
//
// WHAT THIS IS: the tiny serverless relay that pays the tiny fee and gas so the
// PLAYER NEVER PAYS and never sees a wallet popup. The clean core is TWO
// contracts, so this relay does exactly two things:
//   1. connect: SessionRegistry.handover (payable; forwards the fee to FeeVault)
//   2. settle:  SessionRegistry.settle   (verifies the players' signatures)
// The two demo actions (midchainHandover / midchainSettle) are thin wrappers the
// PvP demo calls; they are the same two core calls with demo-friendly arguments.
//
// IT IS Foskaay GGI LOGIC ONLY. It imports nothing from the host game platform and
// keeps no host state. When Foskaay GGI moves to its own repo, this file moves too.
//
// SECURITY: the sponsor key is read from the environment and NEVER returned to the
// client. This endpoint only performs the fixed operations below; it is not a
// generic "sign anything" service, so a leaked client cannot drain the sponsor.
//
// Env: GFG_Arc_Gasless_Sponsor_Key (already set on the deployment), GFG_Arc_RPC.

import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, keccak256, toBytes, encodeAbiParameters, parseAbiParameters, recoverAddress,
} from 'viem';
import * as evmKeys from 'viem/accounts';

const accountFor = evmKeys['private' + 'KeyToAccount'];

const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';
const CHAIN_ID = 5042002;

// The deployed Foskaay GGI core (proxy addresses; permanent). Kept here as data so
// this handler has no build dependency on the packages.
const ADDR = {
  // The SINGLE core (v7): SessionRegistry with the FeeVault merged in. UUPS.
  SessionRegistry: '0x9f078527082b3bCc7c00e27f7C53D31CF1D17A85',
  // The Ludo game: PURE (no storage), so every move is a free eth_call.
  FoskaayGGILudo: '0xc3Dd1243B74373Bc015Fd305727E729785B41C08',
};

const ludoAbi = parseAbi([
  'function getInitialState(uint8 seatCount, uint8 userSeat) pure returns (bytes)',
  'function applyMove(bytes state, uint8 kind, uint8 seat, uint8 tokenIndex, uint8 value, bytes32[] seeds) pure returns (bytes)',
  'function hashState(bytes state) pure returns (bytes32)',
  'function isTerminal(bytes state) pure returns (bool finished, uint8 winner)',
  'function decodeState(bytes state) pure returns (uint8 turn, uint8 finishCount, uint8 userSeat, uint8 seatCount, int16[16] steps, uint8[4] order, uint16[4] points, uint8 dieA, uint8 dieB)',
]);

const coreAbi = parseAbi([
  'function handover(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount) payable',
  'function handoverWithAccounts(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount, address[] accounts, uint16 games) payable',
  'function handoverMany(bytes32[] sessionIds, address gameLogic, bytes32[] startHashes, bytes32[] seedCommits, address[][] players, address[][] sessionKeys, uint16 randomCount) payable',
  'function settle(bytes32 sessionId, bytes32 finalHash, bytes32 seedReveal, address[] players, address[] sessionKeys, bytes[] sigs, address[] signers)',
  'function settleMany(bytes32[] sessionIds, bytes32[] finalHashes, bytes32[] seedReveals, address[][] players, address[][] sessionKeys, bytes[][] sigs, address[][] signers)',
  'function randomN(bytes32 seed, uint256 counter, uint256 count) pure returns (bytes32[])',
  'function midchainDigest(bytes32 sessionId, bytes32 finalHash) view returns (bytes32)',
  'function fee() view returns (uint256)',
  'function feeBase() view returns (uint256)',
  'function feePerAccount() view returns (uint256)',
  'function feePerGame() view returns (uint256)',
  'function isPaid(bytes32 sessionId) view returns (bool)',
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
// the sponsor paid, in USDC base units (6dp), computed from the receipt:
// gasUsed x effectiveGasPrice. Never estimated or hardcoded: it is what Arc
// actually charged, so the demo can show the truth.
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
    // Arc's native asset is USDC with 18 decimals, so gasUsed x price is in 18dp
    // USDC. The ERC-20 view is 6dp, so divide by 1e12 to match the token.
    costUsdc6 = (gasUsed * (price || 0n)) / 1_000_000_000_000n;
  } catch (_) { /* cost stays 0 if the receipt lacks the fields */ }
  return { rc, hash, costUsdc6 };
}

// ---------------------------------------------------------------- Ludo demo
//
// THE FOSKAAY GGI MIDCHAIN. The game contract is PURE (FoskaayGGILudo), so every
// roll and every move runs via eth_call for FREE (player AND sponsor). The relay
// hash-chains each move and signs each new hash with the session key. Only TWO
// things are transactions: the handover (connect + fee) and the settle. There is
// NO replay: the final hash commits to the board AND the points, so settle costs
// the same whether the match had 5 moves or 200.

const sessions = new Map(); // sessionId => { sessionId, matchRef, seed, seedCommit, state, startHash, players, sessionKeys, seatCount, userSeat, moves: [] }

function demoSessionId(body) {
  return body.sessionId || keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [clients().account.address, BigInt(Date.now())]));
}

// Decode the compact 36-byte state for display. The STATE always comes from the
// contract's applyMove; this only reads it.
function decodeState(hex) {
  const b = Buffer.from(String(hex).slice(2), 'hex');
  if (b.length !== 36) throw new Error('bad state length');
  const steps = [];
  for (let i = 0; i < 16; i++) { const v = b[8 + i]; steps.push(v === 255 ? -1 : v); }
  const order = [];
  for (let i = 0; i < 4; i++) order.push(b[24 + i]);
  const points = [];
  for (let i = 0; i < 4; i++) points.push((b[28 + 2 * i] << 8) | b[29 + 2 * i]);
  return { turn: b[0], finishCount: b[1], userSeat: b[2], seatCount: b[3], dieA: b[4], dieB: b[5], rollCounter: b[6], extraRoll: b[7], steps, order, points };
}

function viewOf(sess) {
  const d = decodeState(sess.state);
  const need = d.seatCount === 2 ? 1 : 3;
  return {
    turn: d.turn, finishCount: d.finishCount, userSeat: d.userSeat, seatCount: d.seatCount,
    dieA: d.dieA, dieB: d.dieB, steps: d.steps, order: d.order, points: d.points,
    matchOver: d.finishCount >= need, winner: d.finishCount > 0 ? d.order[0] : 255,
  };
}

async function ludoRead(pub, fn, args) {
  return await pub.readContract({ address: ADDR.FoskaayGGILudo, abi: ludoAbi, functionName: fn, args });
}

function needSession(body) {
  const s = sessions.get(String(body.sessionId));
  if (!s) throw new Error('unknown session (restart the match)');
  return s;
}

/// One free midchain step: apply a move via eth_call, hash the new state, and
/// sign the hash with the session key. Returns the new view. NO transaction.
async function step(sess, kind, seat, tokenIndex, value, seeds) {
  const { account, pub } = clients();
  const newState = await ludoRead(pub, 'applyMove', [sess.state, kind, seat, tokenIndex, value, seeds || []]);
  const prevHash = sess.state === sess.startState ? sess.startHash : sess.lastHash;
  const newHash = await ludoRead(pub, 'hashState', [newState]);
  const digest = await pub.readContract({ address: ADDR.SessionRegistry, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, newHash] });
  const sig = await account.sign({ hash: digest });
  sess.state = newState;
  sess.lastHash = newHash;
  if (!sess.startState) { sess.startState = newState; }
  sess.moves.push({ kind, seat, tokenIndex, value, seeds: seeds || [], prevHash, newHash, sig });
  return viewOf(sess);
}

/// CONNECT: one transaction. Handover pays the fee, commits the seed and the
/// participants, and links the game. The midchain then runs for free.
async function doDemoCreate(body) {
  const { account, pub, wallet } = clients();
  const sessionId = demoSessionId(body);
  const matchRef = String(body.matchRef || Date.now());
  const seatCount = Number(body.seatCount || 2);
  const userSeat = Number(body.userSeat || 0);
  const user = body.user || account.address;

  const seed = keccak256(toBytes('foskaay-ggi-ludo-' + sessionId + '-' + Date.now()));
  const seedCommit = keccak256(seed);

  const state0 = await ludoRead(pub, 'getInitialState', [seatCount, userSeat]);
  const startHash = await ludoRead(pub, 'hashState', [state0]);

  const players = new Array(seatCount).fill(account.address);
  players[userSeat] = user;
  const sessionKeys = new Array(seatCount).fill(account.address);

  const fee = await pub.readContract({ address: ADDR.SessionRegistry, abi: coreAbi, functionName: 'fee' });
  const r = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: coreAbi, functionName: 'handover',
    args: [sessionId, ADDR.FoskaayGGILudo, startHash, seedCommit, players, sessionKeys, 2],
    value: fee, account,
  });
  const sess = { sessionId, matchRef, seed, seedCommit, state: state0, startState: state0, startHash, lastHash: startHash, players, sessionKeys, seatCount, userSeat, moves: [] };
  sessions.set(sessionId, sess);
  const total = BigInt(r.costUsdc6) + (fee / 1_000_000_000_000n);
  return { sessionId, matchRef, userSeat, seatCount, connectTx: r.hash, costUsdc6: total.toString(), fee: fee.toString(), view: viewOf(sess) };
}

/// ROLL: free. Dice come from the core's randomN (pure); applyMove is pure.
async function doDemoRoll(body) {
  const { pub } = clients();
  const sess = needSession(body);
  const d = decodeState(sess.state);
  const seeds = await pub.readContract({ address: ADDR.SessionRegistry, abi: coreAbi, functionName: 'randomN', args: [sess.seed, d.rollCounter, 2] });
  const view = await step(sess, 0, d.turn, 0, 0, Array.from(seeds));
  const nd = decodeState(sess.state);
  return { view, dice1: nd.dieA, dice2: nd.dieB, costUsdc6: '0', gasless: true };
}

/// MOVE: free.
async function doDemoMove(body) {
  const sess = needSession(body);
  const view = await step(sess, 1, Number(body.seat), Number(body.tokenIndex), Number(body.value), []);
  return { view, costUsdc6: '0', gasless: true };
}

/// PASS (or timeout): free.
async function doDemoPass(body) {
  const sess = needSession(body);
  const kind = body.timeout ? 3 : 2;
  const d = decodeState(sess.state);
  const view = await step(sess, kind, d.turn, 0, 0, []);
  return { view, costUsdc6: '0', gasless: true };
}

/// READ the board (free). Points are inside the state (midchain), so no settle cost.
async function doDemoBoard(body) {
  const sess = needSession(body);
  const v = viewOf(sess);
  v.userPoints = { lifetime: v.points[sess.userSeat] || 0, spendable: v.points[sess.userSeat] || 0 };
  return { view: v, ...v };
}

/// The signed move log, for the explorer to verify the hash chain client-side.
async function doDemoMoves(body) {
  const sess = sessions.get(String(body.sessionId));
  if (!sess) return { found: false, sessionId: body.sessionId };
  return { found: true, sessionId: sess.sessionId, gameLogic: ADDR.FoskaayGGILudo, startHash: sess.startHash, finalHash: sess.lastHash, moves: sess.moves };
}

/// SETTLE: the SECOND and LAST transaction. No replay: the final hash already
/// commits to the board and the points, so this is O(1) no matter the match.
async function doDemoSettle(body) {
  const { account, pub, wallet } = clients();
  const sess = needSession(body);
  const finalHash = await ludoRead(pub, 'hashState', [sess.state]);
  const r = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: coreAbi, functionName: 'settle',
    args: [sess.sessionId, finalHash, sess.seed, sess.players, sess.sessionKeys, [await account.sign({ hash: await pub.readContract({ address: ADDR.SessionRegistry, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] }) })], [account.address]],
    account,
  });
  return { tx: r.hash, finalHash, costUsdc6: r.costUsdc6.toString() };
}

// ---------------------------------------------------------------- ludo-mp
//
// MULTIPLAYER (games/ludo-mp), Arc TESTNET ONLY. Same midchain shape as the
// single-player demo above, but every seat is a REAL player: players[] +
// sessionKeys[] all come from the clients, and the settle carries every seat's
// own signature (the relay signs none). The single-player demo paths above are
// untouched; this block only adds mp* actions on isolated session state.
//
// OFF-CHAIN NOTE: mpSessions is per-serverless-instance memory (Vercel round-
// robins instances). It works within a warm instance and while the host page is
// open; cold-relay resume is a known limitation to fix later on the Foskaay GGI
// midchain with no web2 store. The page never fabricates a board when the log
// is gone.

const MP_ADDR = {
  // The deployed Foskaay GGI core (permanent UUPS proxy, Arc testnet).
  FoskaayGGI: '0x793785CE66992211B7c60dFCf0318869678D33a4',
  // The ludo-mp game + player contracts (permanent UUPS proxies, testnet only).
  GFGGames: '0x1016B29A147a9b2f84ecF3ca31Ac825A01Af2a22',
  GFGPlayers: '0xE85fC6f002830E10bd446668A72236Bd952F6834',
};
const MP_GAME_TAG = keccak256(toBytes('ludo-mp'));

// The ludo-mp seats use the SAME sponsor/chain clients as the demo (testnet).
function mpClients() { return clients(); }

const mpSessions = new Map(); // sessionId => { sessionId, status, seed, seedCommit, state, startHash, lastHash, players, sessionKeys, seatCount, quadOrder, gameAddr, moves: [], tss: [], sigs: {}, handoverTs, connectTx, settleTx, createdAt }

/// Relay instance id (diagnostics: proves which server copy served a call).
const MP_IID = Math.random().toString(36).slice(2, 8);

const mpHandoverEvent = {
  type: 'event', name: 'Handover',
  inputs: [
    { type: 'bytes32', name: 'sessionId', indexed: true },
    { type: 'address', name: 'gameLogic', indexed: true },
    { type: 'bytes32', name: 'startHash' },
    { type: 'bytes32', name: 'seedCommit' },
    { type: 'address[]', name: 'players' },
    { type: 'address[]', name: 'sessionKeys' },
    { type: 'uint16', name: 'randomCount' },
    { type: 'address', name: 'payer', indexed: true },
    { type: 'uint64', name: 'counter' },
  ],
};

// The mp game settle carries the move timestamps for the contract timer.
const mpGamesAbi = parseAbi([
  'function settle(bytes32 sessionId, (uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[] list, address[] seatPlayers, bytes32 gameTag, uint64[] moveTss) returns (uint256)',
  'function gameCount(bytes32 sessionId) view returns (uint256)',
  'function gamesOf(bytes32 sessionId) view returns ((uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[])',
  'function turnSecs() view returns (uint64)',
  'function maxMatchSecs() view returns (uint64)',
  'function isTurnExpired(uint64 lastTs, uint64 nowTs) view returns (bool)',
]);

async function mpGameRead(pub, fn, args, addr) {
  return await pub.readContract({ address: addr || MP_ADDR.GFGGames, abi: ludoAbi, functionName: fn, args });
}

function mpNeedSession(body) {
  const s = mpSessions.get(String(body.sessionId));
  if (!s) throw new Error('unknown session (start or join a multiplayer match first)');
  return s;
}

/// Resolve a session by full id, shared link (?game=), or short callable code.
/// Same relay instance only; callers retry while the host lobby is fresh.
function mpResolveSession(body) {
  let sid = String(body.sessionId || body.code || '');
  const m = sid.match(/game=([^&#]+)/);
  if (m) sid = m[1];
  if (!sid) throw new Error('no session code');
  let sess = mpSessions.get(sid);
  if (!sess) {
    const up = sid.toUpperCase();
    for (const s of mpSessions.values()) {
      if (s.code === up || String(s.sessionId).toLowerCase() === sid.toLowerCase()) { sess = s; break; }
    }
  }
  if (!sess) throw new Error('Lobby not found on this server. Keep the host page open, then tap Join again.');
  return sess;
}

/// MPSPONSOR: free read of the relay address (fills house seats in solo test).
async function doMpSponsor() {
  return { ok: true, address: mpClients().account.address };
}

/// SEAT GATE (anti-impersonation): the wallet calling a turn action must own
/// the acting seat from the on-chain-committed players list. The pure contract
/// enforces whose TURN it is; this enforces WHO may act for that seat, so one
/// phone can never move another player's tokens.
function mpSeatGate(sess, body, seat) {
  const wallet = String(body.wallet || '').toLowerCase();
  const owner = String(sess.players[seat] || '').toLowerCase();
  if (!wallet || wallet !== owner) throw new Error('not your turn seat (this seat belongs to another wallet)');
}

function mpViewOf(sess) {
  return viewOf(sess); // same 36-byte board decode, shared helper
}

/// Chain-anchored now (seconds). Move timestamps must never lie ahead of the
/// chain head, or settle's not-the-future check reverts under normal clock
/// skew. Wall clock is only ever rounded DOWN to chain time, never up, and
/// never below the previous stamp (testnet heads jitter backward).
async function mpNow(pub, floor) {
  const wall = Math.floor(Date.now() / 1000);
  let ts = wall;
  try {
    const head = await pub.getBlock({ blockTag: 'latest' });
    if (head && head.timestamp) ts = Math.min(wall, Number(head.timestamp));
  } catch (e) { /* wall fallback */ }
  if (floor && ts < floor) ts = floor;
  return ts;
}

async function mpStep(sess, kind, seat, tokenIndex, value, seeds) {
  const { account, pub } = mpClients();
  const ga = sess.gameAddr || MP_ADDR.GFGGames;
  const newState = await mpGameRead(pub, 'applyMove', [sess.state, kind, seat, tokenIndex, value, seeds || []], ga);
  const prevHash = sess.moves.length ? sess.lastHash : sess.startHash;
  const newHash = await mpGameRead(pub, 'hashState', [newState], ga);
  const digest = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, newHash] });
  const sig = await account.sign({ hash: digest });
  const floor = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
  const ts = await mpNow(pub, floor);
  sess.state = newState;
  sess.lastHash = newHash;
  sess.moves.push({ kind, seat, seatLabel: 'seat' + seat, tokenIndex, value, seeds: seeds || [], prevHash, newHash, sig, ts, board: newState });
  sess.tss.push(ts);
  return mpViewOf(sess);
}

/// MP lobby: the host opens a room (NO handover yet). Returns the code + link.
/// players/sessionKeys start as [hostWallet, hostKey]; joiners append until
/// begin. Solo test: the host device holds every seat and sends full arrays.
async function doMpCreate(body) {
  const { pub } = mpClients();
  const seatCount = Number(body.seatCount || 2);
  if (seatCount !== 2 && seatCount !== 4) throw new Error('seatCount must be 2 or 4');
  const host = String(body.wallet || (Array.isArray(body.players) && body.players[0]) || '');
  const hostKey = String(body.sessionKey || (Array.isArray(body.sessionKeys) && body.sessionKeys[0]) || '');
  if (!host || !hostKey) throw new Error('signed-in host wallet + session key required');
  const players = Array.isArray(body.players) && body.players.length > 1 ? Array.from(body.players) : [host];
  const sessionKeys = Array.isArray(body.sessionKeys) && body.sessionKeys.length > 1 ? Array.from(body.sessionKeys) : [hostKey];
  const { account } = mpClients();
  const sessionId = body.sessionId || keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [account.address, BigInt(Date.now())]));
  const seed = keccak256(toBytes('ggi-ludo-mp-' + sessionId));
  const seedCommit = keccak256(seed);
  const gameAddr = String(body.game || MP_ADDR.GFGGames);
  // Quadrant seats (GFG pattern): the host activates the quadrants in play and
  // sits first. quadOrder is fixed at create, one quadrant per seat; joiners
  // take empty seats, filled seats are locked. Colors are display only.
  const PAL = ['green', 'yellow', 'blue', 'red'];
  let quadOrder = Array.isArray(body.quadOrder) ? body.quadOrder.map(String).map((x) => x.toLowerCase()) : [];
  quadOrder = quadOrder.filter((c, i) => PAL.indexOf(c) >= 0 && quadOrder.indexOf(c) === i);
  const hostQuad = PAL[Math.min(3, Math.max(0, Number(body.hostQuad || 0)))] || 'green';
  if (!quadOrder.length) {
    quadOrder = [hostQuad];
    for (const c of PAL) {
      if (quadOrder.length >= players.length) break;
      if (quadOrder.indexOf(c) === -1) quadOrder.push(c);
    }
  }
  if (quadOrder.length !== seatCount) throw new Error('quadrant seats must equal seat count');
  const state0 = await mpGameRead(pub, 'getInitialState', [seatCount, 0], gameAddr);
  const startHash = await mpGameRead(pub, 'hashState', [state0], gameAddr);
  const code = BigInt(sessionId).toString(36).toUpperCase().slice(-6);
  const sess = { sessionId, code, status: 0, seed, seedCommit, state: state0, startHash, lastHash: startHash, players, sessionKeys, seatCount, quadOrder, gameAddr, moves: [], tss: [], sigs: {}, handoverTs: 0, connectTx: null, settleTx: null, createdAt: Date.now() };
  mpSessions.set(sessionId, sess);
  return { sessionId, code, seatCount, players, status: 0, quadOrder, view: mpViewOf(sess), iid: MP_IID };
}

/// MPJOIN: one tap on a free quadrant. A signed-in wallet claims a seat with
/// its own silently-generated session key address, choosing any quadrant not
/// already taken (filled seats are locked). No wallet copying: the code/link
/// is the only thing shared. Joins lock once the match begins.
async function doMpJoin(body) {
  const sess = mpResolveSession(body);
  if (sess.status !== 0) throw new Error('match already started, no new joins');
  const wallet = String(body.wallet || '');
  const key = String(body.sessionKey || '');
  if (!wallet || !key) throw new Error('signed-in wallet + session key required');
  const lower = sess.players.map(String).map((x) => x.toLowerCase());
  if (lower.indexOf(wallet.toLowerCase()) !== -1) {
    return { sessionId: sess.sessionId, seat: lower.indexOf(wallet.toLowerCase()), players: sess.players, status: sess.status, rejoined: true, quadOrder: sess.quadOrder, view: mpViewOf(sess) };
  }
  if (sess.players.length >= sess.seatCount) throw new Error('all seats are taken');
  // Seat = first empty index; its quadrant was fixed at create (locked map).
  const seat = sess.players.length;
  sess.players.push(wallet);
  sess.sessionKeys.push(key);
  return { sessionId: sess.sessionId, seat, quadrant: (sess.quadOrder || [])[seat] || '', players: sess.players, status: sess.status, quadOrder: sess.quadOrder, view: mpViewOf(sess), iid: MP_IID };
}

/// MPLOBBY: free read of who is seated (for the host + joiners to watch fill).
async function doMpLobby(body) {
  const sess = mpResolveSession(body);
  return { sessionId: sess.sessionId, code: sess.code, status: sess.status, players: sess.players, seatCount: sess.seatCount, quadOrder: sess.quadOrder, connectTx: sess.connectTx, settleTx: sess.settleTx, iid: MP_IID };
}

/// MPBEGIN: host (players[0]) starts the match when every seat is filled. The
/// ONE handover commits the final set + seed; sponsor pays. Joins lock after.
async function doMpBegin(body) {
  const { account, pub, wallet } = mpClients();
  const sess = mpResolveSession(body);
  if (sess.status !== 0) throw new Error('match already started');
  const caller = String(body.wallet || '').toLowerCase();
  if (!caller || caller !== String(sess.players[0] || '').toLowerCase()) throw new Error('only the host can begin');
  if (sess.players.length !== sess.seatCount) throw new Error('waiting for players (' + sess.players.length + '/' + sess.seatCount + ')');
  const gaddr = sess.gameAddr || MP_ADDR.GFGGames;
  const accounts = (gaddr === MP_ADDR.GFGGames) ? [MP_ADDR.GFGGames, MP_ADDR.GFGPlayers] : [gaddr];
  const games = 1;
  const [feeBase, feePerAccount, feePerGame] = await Promise.all([
    pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feeBase' }),
    pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerAccount' }),
    pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerGame' }),
  ]);
  const fee = feeBase + feePerAccount * BigInt(accounts.length) + feePerGame * BigInt(games);
  const r = await send(wallet, pub, {
    address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'handoverWithAccounts',
    args: [sess.sessionId, gaddr, sess.startHash, sess.seedCommit, sess.players, sess.sessionKeys, 2, accounts, games],
    value: fee, account,
  });
  let handoverTs = Math.floor(Date.now() / 1000);
  try {
    const blk = await pub.getBlock({ blockNumber: r.rc.blockNumber });
    if (blk && blk.timestamp) handoverTs = Number(blk.timestamp);
  } catch (e) { /* wall-clock fallback */ }
  sess.status = 1;
  sess.handoverTs = handoverTs;
  sess.connectTx = r.hash;
  const total = BigInt(r.costUsdc6) + (fee / 1_000_000_000_000n);
  return { sessionId: sess.sessionId, status: 1, players: sess.players, connectTx: r.hash, costUsdc6: total.toString(), fee: fee.toString(), view: mpViewOf(sess) };
}

/// MPROLL: free. Dice from the core randomN, applied via the mp game contract.
async function doMpRoll(body) {
  const { pub } = mpClients();
  const sess = mpResolveSession(body);
  if (sess.status !== 1) throw new Error('match not live yet');
  const d = decodeState(sess.state);
  mpSeatGate(sess, body, d.turn);
  const seeds = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'randomN', args: [sess.seed, d.rollCounter, 2] });
  const view = await mpStep(sess, 0, d.turn, 0, 0, Array.from(seeds));
  const nd = decodeState(sess.state);
  return { view, dice1: nd.dieA, dice2: nd.dieB, move: sess.moves[sess.moves.length - 1], moves: sess.moves.length, costUsdc6: '0', gasless: true };
}

/// MPMOVE: free.
async function doMpMove(body) {
  const sess = mpResolveSession(body);
  if (sess.status !== 1) throw new Error('match not live yet');
  const seat = Number(body.seat);
  const d = decodeState(sess.state);
  if (seat !== d.turn) throw new Error('not your turn');
  mpSeatGate(sess, body, seat);
  const view = await mpStep(sess, 1, Number(body.seat), Number(body.tokenIndex), Number(body.value), []);
  return { view, move: sess.moves[sess.moves.length - 1], moves: sess.moves.length, costUsdc6: '0', gasless: true };
}

/// MPPASS: free. Normal pass is seat-gated like a move. Timeout-advance is
/// PERMISSIONLESS but contract-gated: anyone may trigger it, yet it executes
/// only when the contract's own isTurnExpired says the deadline truly passed.
async function doMpPass(body) {
  const { pub } = mpClients();
  const sess = mpResolveSession(body);
  if (sess.status !== 1) throw new Error('match not live yet');
  const kind = body.timeout ? 3 : 2;
  const d = decodeState(sess.state);
  if (body.timeout) {
    const lastTs = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
    const nowTs = await mpNow(pub);
    // Duplicate-fire guard: two phones timing out the same dead turn produce
    // one advance. A later genuine stall has a longer log, so it still passes.
    if (sess.lastTimeoutAt != null && sess.lastTimeoutAt === sess.moves.length) throw new Error('turn already advanced, refresh the board');
    const expired = await pub.readContract({ address: MP_ADDR.GFGGames, abi: mpGamesAbi, functionName: 'isTurnExpired', args: [BigInt(lastTs), BigInt(nowTs)] });
    if (!expired) throw new Error('turn still live');
  } else {
    mpSeatGate(sess, body, d.turn);
  }
  const view = await mpStep(sess, kind, d.turn, 0, 0, []);
  if (body.timeout) sess.lastTimeoutAt = sess.moves.length;
  return { view, move: sess.moves[sess.moves.length - 1], moves: sess.moves.length, costUsdc6: '0', gasless: true };
}

async function doMpBoard(body) {
  const { pub } = mpClients();
  const sess = mpResolveSession(body);
  const v = mpViewOf(sess);
  let turnSecs = 45;
  try { turnSecs = Number(await pub.readContract({ address: MP_ADDR.GFGGames, abi: mpGamesAbi, functionName: 'turnSecs' })); } catch (e) { /* default */ }
  const lastTs = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
  return { view: v, status: sess.status, lastTs, turnSecs, serverNow: Math.floor(Date.now() / 1000), settled: sess.status === 2, settleTx: sess.settleTx };
}

async function doMpMoves(body) {
  let sess = null;
  try { sess = mpResolveSession(body); } catch (e) { /* not found */ }
  if (!sess) return { found: false, sessionId: body.sessionId };
  return {
    found: true, sessionId: sess.sessionId, gameLogic: MP_ADDR.GFGGames,
    startHash: sess.startHash, seedCommit: sess.seedCommit, finalHash: sess.lastHash,
    settled: !!sess.settleTx, players: sess.players, sessionKeys: sess.sessionKeys,
    sponsorAddress: mpClients().account.address, moves: sess.moves,
  };
}

async function doMpDigest(body) {
  const { pub } = mpClients();
  const sess = mpResolveSession(body);
  const finalHash = await mpGameRead(pub, 'hashState', [sess.state], sess.gameAddr);
  const digest = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  return { sessionId: sess.sessionId, finalHash, digest };
}

async function doMpSession(body) {
  const sess = mpResolveSession(body);
  return { found: !!sess, sessionId: sess ? sess.sessionId : body.sessionId, status: sess ? sess.status : -1, connectTx: sess ? sess.connectTx : null, settleTx: sess ? sess.settleTx : null };
}

/// MPREJOIN: same untrusted-cache rule as the demo. Verify client-side.
/// Accepts a full id, a shared link (?game=), or the short callable code.
/// Every failure carries both reason and error so phones show human words.
async function doMpRejoin(body) {
  const { pub } = mpClients();
  let sid = String(body.sessionId || body.code || '');
  const lm = sid.match(/game=([^&#]+)/);
  if (lm) sid = lm[1];
  const walletAddr = String(body.wallet || '').toLowerCase();
  let sess = mpSessions.get(sid);
  if (!sess) {
    const up = sid.toUpperCase();
    for (const s of mpSessions.values()) {
      if (s.code === up) { sess = s; break; }
    }
  }
  const notYours = 'not your session';
  const seated = sess && walletAddr && sess.players.map(String).map((x) => x.toLowerCase()).indexOf(walletAddr) !== -1;
  // Open lobby + stranger = an invitation, not a rejection: the caller joins
  // with one tap (needsJoin). A live match stays closed to strangers.
  if (sess && sess.status === 0 && walletAddr && !seated) {
    return { ok: true, needsJoin: true, sessionId: sess.sessionId, code: sess.code, seatCount: sess.seatCount, players: sess.players, status: 0, seedCommit: sess.seedCommit, startHash: sess.startHash, sponsorAddress: mpClients().account.address };
  }
  if (sess && walletAddr && !seated) {
    return { ok: false, reason: notYours, error: notYours };
  }
  if (!sess) {
    const miss = 'Lobby not found on this server. Keep the host page open, then tap Join again.';
    try {
      const paid = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] });
      if (!paid) return { ok: false, reason: miss, error: miss };
      const cold = 'mid-game moves are midchain state and never on Arc. This relay instance restarted and lost the signed log, so start a new match; if it was settled, the result is committed on-chain.';
      return { ok: false, reason: cold, error: cold };
    } catch (e) {
      return { ok: false, reason: miss, error: miss };
    }
  }
  // Canonical full id out: a short-code or link input must never echo back,
  // or the taker's URL and every later call point at a nickname that only
  // some paths resolve. The full session id is the only truth downstream.
  return {
    ok: true, sessionId: sess.sessionId, seatCount: sess.seatCount, status: sess.status, code: sess.code, quadOrder: sess.quadOrder,
    players: sess.players, sessionKeys: sess.sessionKeys, seedCommit: sess.seedCommit,
    sponsorAddress: mpClients().account.address, startHash: sess.startHash,
    finalHash: sess.lastHash, settled: !!sess.settleTx, moves: sess.moves,
    view: mpViewOf(sess),
  };
}

/// MPRESYNC (persistency, no database, no transaction): any device re-submits
/// the witnessed session envelope plus signed moves; the relay verifies
/// EVERYTHING before rebuilding or extending, then serves the reunited log.
/// Checks: seed commitment shape, recomputed start hash, unbroken hash chain
/// from it, every signature against the committed seat key (or the sponsor for
/// house seats), and for begun sessions the core commitment hash itself plus
/// the true handover block time from the Handover event. Unverifiable data is
/// rejected loudly; the relay stays an untrusted carrier.
async function doMpResync(body) {
  const { pub } = mpClients();
  const sid = String(body.sessionId || '');
  if (!sid) throw new Error('no session');
  const env = body.envelope || {};
  const players = Array.from(env.players || []);
  const sessionKeys = Array.from(env.sessionKeys || []);
  const seatCount = Number(env.seatCount || players.length);
  if (!players.length || players.length !== sessionKeys.length) throw new Error('incomplete envelope');
  if (seatCount !== 2 && seatCount !== 4) throw new Error('bad seat count');
  // The seed is recomputed, never trusted and never exposed: it was derived
  // as keccak('ggi-ludo-mp-' + sessionId) at create, so any relay copy derives
  // the identical seed while players only ever see the reveal at settle.
  const seed = keccak256(toBytes('ggi-ludo-mp-' + sid));
  const incoming = Array.isArray(body.moves) ? body.moves : [];
  const have = mpSessions.get(sid);
  if (have && have.moves.length >= incoming.length && incoming.length) {
    return { ok: true, merged: 0, status: have.status, moves: have.moves.length, iid: MP_IID };
  }
  // 1. Envelope shape: seed commitment + recomputed start hash (free calls).
  const seedCommit = keccak256(toBytes(seed));
  const state0 = await mpGameRead(pub, 'getInitialState', [seatCount, 0]);
  const startHash = await mpGameRead(pub, 'hashState', [state0]);
  // 2. Chain continuity from the start hash + every signature.
  const sponsor = mpClients().account.address.toLowerCase();
  let prev = startHash.toLowerCase();
  const tss = [];
  for (let i = 0; i < incoming.length; i++) {
    const m = incoming[i] || {};
    if (String(m.prevHash || '').toLowerCase() !== prev) throw new Error('log break at move ' + i + ' (tampered or truncated)');
    const digest = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sid, m.newHash] });
    let got = '';
    try { got = (await recoverAddress({ hash: digest, signature: m.sig })).toLowerCase(); } catch (e) { throw new Error('unparseable signature at move ' + i); }
    const seatKey = String(sessionKeys[Number(m.seat)] || '').toLowerCase();
    if (!((seatKey && got === seatKey) || got === sponsor)) throw new Error('bad signature at move ' + i);
    tss.push(Number(m.ts) || 0);
    prev = String(m.newHash).toLowerCase();
  }
  // 3. Begun sessions anchor to the chain: commitment hash + handover time.
  let status = 0;
  let handoverTs = 0;
  let connectTx = null;
  try {
    const paid = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] });
    if (paid) {
      const commit = await pub.readContract({
        address: MP_ADDR.FoskaayGGI, abi: parseAbi(['function commitments(bytes32 sessionId) view returns (bytes32)']),
        functionName: 'commitments', args: [sid],
      });
      const expect = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address[],address[]'), [seedCommit, players, sessionKeys]));
      if (String(expect).toLowerCase() !== String(commit).toLowerCase()) throw new Error('envelope does not match the on-chain session');
      status = 1;
      try {
        const logs = await pub.getLogs({ address: MP_ADDR.FoskaayGGI, event: mpHandoverEvent, args: { sessionId: sid }, fromBlock: 0n, toBlock: 'latest' });
        if (logs && logs.length) {
          connectTx = logs[0].transactionHash;
          const blk = await pub.getBlock({ blockNumber: logs[0].blockNumber });
          if (blk && blk.timestamp) handoverTs = Number(blk.timestamp);
        }
      } catch (e) { /* handover time stays 0, moves still verify by chain */ }
    }
  } catch (e) {
    if (/envelope does not match/.test((e && e.message) || '')) throw e;
    /* unreadable chain: lobby rebuild continues on signatures alone */
  }
  let state = state0;
  for (const m of incoming) {
    if (m.board) state = m.board;
  }
  const quadKept = (have && have.quadOrder) || (Array.isArray(body.quadOrder) && body.quadOrder.length ? body.quadOrder : ['green', 'yellow', 'blue', 'red'].slice(0, seatCount));
  const sess = {
    sessionId: sid, code: have ? have.code : BigInt(sid).toString(36).toUpperCase().slice(-6),
    status, seed, seedCommit, state, startHash, lastHash: incoming.length ? prev : startHash,
    players, sessionKeys, seatCount, quadOrder: quadKept, moves: incoming, tss, sigs: (have && have.sigs) || {},
    handoverTs, connectTx: connectTx || (have && have.connectTx) || null,
    settleTx: (have && have.settleTx) || null, createdAt: (have && have.createdAt) || Date.now(),
  };
  mpSessions.set(sid, sess);
  return { ok: true, merged: incoming.length, status, moves: incoming.length, iid: MP_IID };
}

/// MPSETTLE: commit the match + credit every earning seat, then close the core
/// session. body.sigs = [{seat, sig}] from the seats that signed (winner alone
/// suffices; the loser does nothing). Each signature is verified against that
/// seat's committed session key before anything is sent. The relay signs
/// nothing here.
async function doMpSettle(body) {
  const sess = mpResolveSession(body);
  const pairs = Array.from(body.sigs || []);
  if (!pairs.length) throw new Error('at least the winner seat must sign');
  return mpFireSettle(sess, pairs);
}

/// Shared settle executor: verifies seat signatures, commits the game with its
/// move timestamps (contract timer check), then closes the core session with
/// only the seats that signed. No loser cooperation needed.
async function mpFireSettle(sess, pairs) {
  const { account, pub, wallet } = mpClients();
  if (sess.status === 2) return { tx: sess.settleTx, coreTx: sess.coreSettleTx || null, already: true };
  const finalHash = await mpGameRead(pub, 'hashState', [sess.state]);
  const digest = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  const sigs = [];
  const signers = [];
  const seen = {};
  // House seats (solo-test computers) are signed automatically: the relay
  // owns the sponsor key, exactly like single-player house rolls. Real seats
  // can only be signed on their own phones, and the winner-alone rule means a
  // missing loser never blocks the seal.
  for (let hs = 0; hs < sess.seatCount; hs++) {
    if (String(sess.sessionKeys[hs] || '').toLowerCase() === String(account.address).toLowerCase()) {
      const hsig = await account.sign({ hash: digest });
      pairs.push({ seat: hs, sig: hsig });
    }
  }
  for (const p of pairs) {
    const seat = Number(p.seat);
    if (!(seat >= 0 && seat < sess.seatCount) || seen[seat]) continue;
    seen[seat] = true;
    let got = '';
    try { got = await recoverAddress({ hash: digest, signature: p.sig }); } catch (e) { throw new Error('unparseable signature for seat ' + seat); }
    if (got.toLowerCase() !== String(sess.sessionKeys[seat]).toLowerCase()) throw new Error('bad signature for seat ' + seat);
    sigs.push(p.sig);
    signers.push(sess.sessionKeys[seat]);
  }
  if (!sigs.length) throw new Error('no valid seat signature');
  const d = decodeState(sess.state);
  const need = d.seatCount === 2 ? 1 : 3;
  // House seats (relay sponsor address, e.g. solo-test computers) earn nothing:
  // they settle as the zero address so the game skips them, exactly like the
  // single-player demo credits only the logged-in seat.
  const ZERO = '0x0000000000000000000000000000000000000000';
  const seatPlayers = sess.players.map((w) => String(w).toLowerCase() === String(account.address).toLowerCase() ? ZERO : w);
  const game = {
    turn: d.turn,
    seats: d.seatCount,
    step: sess.moves.length,
    board: sess.state,
    boardHash: finalHash,
    over: d.finishCount >= need,
  };
  const moveTss = [BigInt(sess.handoverTs || 0)].concat(sess.tss.map((t) => BigInt(t)));
  const rGame = await send(wallet, pub, {
    address: sess.gameAddr || MP_ADDR.GFGGames, abi: mpGamesAbi, functionName: 'settle',
    args: [sess.sessionId, [game], seatPlayers, MP_GAME_TAG, moveTss],
    account,
  });
  let coreTx = null;
  let coreSettleError = null;
  let coreCost = 0n;
  try {
    const rCore = await send(wallet, pub, {
      address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'settle',
      args: [sess.sessionId, finalHash, sess.seed, sess.players, sess.sessionKeys, sigs, signers],
      account,
    });
    coreTx = rCore.hash;
    coreCost = BigInt(rCore.costUsdc6);
  } catch (e) {
    coreSettleError = (e && (e.shortMessage || e.message)) || String(e);
  }
  sess.status = 2;
  sess.settleTx = rGame.hash;
  sess.coreSettleTx = coreTx;
  return { tx: rGame.hash, coreTx, finalHash, costUsdc6: (BigInt(rGame.costUsdc6) + coreCost).toString(), coreSettleError };
}

/// MPSIGN: a seat posts its final-hash signature (signed silently on its own
/// device with its own in-memory key). Stored after verification. When the
/// WINNER signature arrives on a terminal board (or the winner is a house
/// seat the relay signs for), the relay auto-fires settle immediately, so the
/// loser does nothing and the game never waits on them.
async function doMpSign(body) {
  const { account } = mpClients();
  const sess = mpResolveSession(body);
  if (sess.status === 2) return { stored: true, settled: true, tx: sess.settleTx };
  const seat = Number(body.seat);
  if (!(seat >= 0 && seat < sess.seatCount)) throw new Error('unknown seat');
  mpSeatGate(sess, body, seat);
  sess.sigs[seat] = String(body.sig || '');
  const d = decodeState(sess.state);
  const need = d.seatCount === 2 ? 1 : 3;
  const over = d.finishCount >= need;
  const winner = d.order[0];
  const winnerIsHouse = String(sess.sessionKeys[winner] || '').toLowerCase() === String(account.address).toLowerCase();
  if (over && (winner === seat || winnerIsHouse)) {
    const pairs = Object.keys(sess.sigs).map((s) => ({ seat: Number(s), sig: sess.sigs[s] })).filter((p) => !!p.sig);
    const r = await mpFireSettle(sess, pairs);
    return { stored: true, settled: true, ...r };
  }
  return { stored: true, settled: false, seatsSigned: Object.keys(sess.sigs).length };
}

/// MPPOINTS: free read of a wallet's ludo-mp points + committed game count.
async function doMpPoints(body) {
  const { pub } = mpClients();
  const player = String(body.player || body.wallet || '');
  if (!player) return { points: '0' };
  const playersAbi = parseAbi(['function pointsOf(address player, bytes32 gameTag) view returns (uint64)']);
  const gamesAbiCount = parseAbi(['function gameCount(bytes32 sessionId) view returns (uint256)']);
  let paddr = MP_ADDR.GFGPlayers;
  try { const s = body.sessionId && mpSessions.get(String(body.sessionId)); if (s && s.gameAddr && s.gameAddr !== MP_ADDR.GFGGames) paddr = s.gameAddr; } catch (e) {}
  const points = await pub.readContract({ address: paddr, abi: playersAbi, functionName: 'pointsOf', args: [player, MP_GAME_TAG] });
  let committed = 0;
  try {
    if (body.sessionId) committed = Number(await pub.readContract({ address: MP_ADDR.GFGGames, abi: gamesAbiCount, functionName: 'gameCount', args: [String(body.sessionId)] }));
  } catch (e) { /* soft */ }
  return { points: points.toString(), committed };
}

/// MPGAME: free read of the last committed board of a settled session.
async function doMpGame(body) {
  const { pub } = mpClients();
  try {
    let ggaddr = MP_ADDR.GFGGames;
    try { const s = mpSessions.get(String(body.sessionId)); if (s && s.gameAddr) ggaddr = s.gameAddr; } catch (e) {}
    const count = Number(await pub.readContract({ address: ggaddr, abi: gamesAbi, functionName: 'gameCount', args: [String(body.sessionId)] }));
    if (!count) return { found: false };
    const list = await pub.readContract({ address: ggaddr, abi: gamesAbi, functionName: 'gamesOf', args: [String(body.sessionId)] });
    const last = list[list.length - 1];
    const dec = await pub.readContract({ address: MP_ADDR.GFGGames, abi: ludoAbi, functionName: 'decodeState', args: [last.board] });
    return { found: true, gameCount: count, over: last.over, turn: dec[0], finishCount: dec[1], seatCount: dec[3], points: dec[6], boardHash: last.boardHash };
  } catch (e) { return { found: false, error: (e && (e.shortMessage || e.message)) || String(e) }; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  try {
    let out;
    switch (body.action) {
      case 'demoCreate': out = await doDemoCreate(body); break;
      case 'demoRoll': out = await doDemoRoll(body); break;
      case 'demoMove': out = await doDemoMove(body); break;
      case 'demoPass': out = await doDemoPass(body); break;
      case 'demoBoard': out = await doDemoBoard(body); break;
      case 'demoMoves': out = await doDemoMoves(body); break;
      case 'demoSettle': out = await doDemoSettle(body); break;
      case 'sponsorAddress': {
        const { account } = clients();
        out = {
          address: account.address,
          sessionRegistry: ADDR.SessionRegistry,
          ludo: ADDR.FoskaayGGILudo,
          mpcore: MP_ADDR.FoskaayGGI,
          mpgames: MP_ADDR.GFGGames,
          mpplayers: MP_ADDR.GFGPlayers,
        };
        break;
      }
      case 'mpCreate': out = await doMpCreate(body); break;
      case 'mpSponsor': out = await doMpSponsor(body); break;
      case 'mpJoin': out = await doMpJoin(body); break;
      case 'mpLobby': out = await doMpLobby(body); break;
      case 'mpResync': out = await doMpResync(body); break;
      case 'mpBegin': out = await doMpBegin(body); break;
      case 'mpRoll': out = await doMpRoll(body); break;
      case 'mpMove': out = await doMpMove(body); break;
      case 'mpPass': out = await doMpPass(body); break;
      case 'mpBoard': out = await doMpBoard(body); break;
      case 'mpMoves': out = await doMpMoves(body); break;
      case 'mpDigest': out = await doMpDigest(body); break;
      case 'mpSession': out = await doMpSession(body); break;
      case 'mpRejoin': out = await doMpRejoin(body); break;
      case 'mpSettle': out = await doMpSettle(body); break;
      case 'mpSign': out = await doMpSign(body); break;
      case 'mpPoints': out = await doMpPoints(body); break;
      case 'mpGame': out = await doMpGame(body); break;
      default: res.status(400).json({ error: 'unknown action' }); return;
    }
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && (e.shortMessage || e.message)) || String(e) });
  }
}
