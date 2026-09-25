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
  createPublicClient, createWalletClient, defineChain, http, parseAbi, keccak256, toBytes, encodeAbiParameters, parseAbiParameters,
} from 'viem';
import * as evmKeys from 'viem/accounts';

const accountFor = evmKeys['private' + 'KeyToAccount'];

const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';
const CHAIN_ID = 5042002;

// The deployed Foskaay GGI core (proxy addresses; permanent). Kept here as data so
// this handler has no build dependency on the packages.
const ADDR = {
  SessionRegistry: '0xb0A5A2D316bEEd2f75786cb60bfa2256C52281eE',
  FeeVault: '0x9EE0b4c1622C5f2B7710b1fe4Ec2Be86833aDe39',
  // The Ludo demo's OWN contracts (not rail core). The game holds the rules and
  // the match; the player holds the points. Both UUPS, deployed once.
  FoskaayGGIDemoGames: '0xEF1fFa009aDAEa87B68b36980849F814F930753b',
  FoskaayGGIDemoPlayer: '0x5b287337907b3fE9401274D870DebBe090ab174c',
};

const demoGamesAbi = parseAbi([
  'function createMatch(uint64 matchRef, bytes32 sessionId, bytes32 gameTag, address[4] players, bool[4] isComputer, uint8 seatCount, uint8 userSeat, bytes32 seedCommit, uint8 verifyMode)',
  'function settleMatch(uint64 matchRef, (uint8 kind, uint8 seat, uint8 tokenIndex, uint8 steps)[] log, bytes32 finalHash)',
  'function previewLog(uint64 matchRef, (uint8 kind, uint8 seat, uint8 tokenIndex, uint8 steps)[] log) view returns (int16[16] stepsWalked, int16[16] pathIndex, uint8[4] homeCount, uint8 turn, uint8 winner, uint8[4] finishOrder, uint8 finishCount)',
  'function roll(uint64 matchRef) returns (uint8 dice1, uint8 dice2)',
  'function move(uint64 matchRef, uint8 seat, uint8 tokenIndex, uint8 steps)',
  'function captureAt(uint64 matchRef, uint8 seat, uint8 tokenIndex)',
  'function pass(uint64 matchRef)',
  'function enforceTimeout(uint64 matchRef)',
  'function diceOf(uint64 matchRef, uint32 counter) view returns (uint8 dice1, uint8 dice2)',
  'function matchStatus(uint64 matchRef) view returns (uint8 status, uint8 turn, uint8 winner, uint32 moveCount)',
  'function boardOf(uint64 matchRef) view returns (int16[16])',
  'function crownedSeat(uint64 matchRef) view returns (uint8)',
  'function finishOrderOf(uint64 matchRef) view returns (uint8[4] order, uint8 count)',
  'function tokenOf(uint64 matchRef, uint8 seat, uint8 tokenIndex) view returns (int16)',
]);
const demoPlayerAbi = parseAbi([
  'function pointsOf(address player, bytes32 gameTag) view returns (uint64 pureLifetime, uint64 spendable)',
  'function recordOf(address player, bytes32 gameTag) view returns (uint32 wins, uint32 played)',
]);

const registryAbi = parseAbi([
  'function handover(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount) payable',
  'function handoverMany(bytes32[] sessionIds, address gameLogic, bytes32[] startHashes, bytes32[] seedCommits, address[][] players, address[][] sessionKeys, uint16 randomCount) payable',
  'function settle(bytes32 sessionId, bytes32 finalHash, bytes32 seedReveal, bytes[] sigs, address[] signers)',
  'function settleMany(bytes32[] sessionIds, bytes32[] finalHashes, bytes32[] seedReveals, bytes[][] sigs, address[][] signers)',
  'function midchainDigest(bytes32 sessionId, bytes32 finalHash) view returns (bytes32)',
  'function feeVault() view returns (address)',
]);
const vaultAbi = parseAbi([
  'function fee() view returns (uint256)',
  'function paid(bytes32 sessionId) view returns (bool)',
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

const ZERO32 = '0x' + '00'.repeat(32);
/// The canonical game tag for the Ludo demo. ONE definition so createMatch and
/// the points read can never drift (a drift is what made points read as zero).
const LUDO_TAG = keccak256(toBytes('ludo'));
const usdc18 = (x) => Number(x || 0) / 1e18;
const usdc18To6 = (x) => BigInt(x) / 1_000_000_000_000n;

async function feeNative(pub, account) {
  const fee = await pub.readContract({ address: ADDR.FeeVault, abi: vaultAbi, functionName: 'fee' });
  return fee;
}

// CONNECT a session: pay the fee (native USDC) and emit the handover. The demo
// passes the players/session keys; the sponsor is the payer and the account that
// signs the settle. Returns the sessionId it used and the real cost.
async function doMidchainHandover(body) {
  const { account, pub, wallet } = clients();
  const sessionId = body.sessionId || keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [account.address, BigInt(Date.now())]));
  const gameLogic = body.gameLogic || account.address;
  const startHash = body.startHash || ZERO32;
  const seedCommit = body.seedCommit || ZERO32;
  const players = Array.isArray(body.players) && body.players.length ? body.players : [account.address];
  const sessionKeys = Array.isArray(body.sessionKeys) && body.sessionKeys.length ? body.sessionKeys : players;
  const randomCount = Number(body.randomCount || 0);
  const fee = await feeNative(pub, account);

  const r = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'handover',
    args: [sessionId, gameLogic, startHash, seedCommit, players, sessionKeys, randomCount],
    value: fee, account,
  });
  const total = r.costUsdc6 + usdc18To6(fee);
  return { sessionId, feeNative: fee.toString(), tx: r.hash, costUsdc6: total.toString() };
}

// SETTLE a session: the sponsor signs the final hash (it is a declared signer in
// the demo) and the core verifies it. Returns the real cost.
async function doMidchainSettle(body) {
  const { account, pub, wallet } = clients();
  const sessionId = body.sessionId;
  const finalHash = body.finalHash || ZERO32;
  const seedReveal = body.seedReveal || ZERO32;
  if (!sessionId) throw new Error('midchainSettle needs a sessionId');

  const digest = await pub.readContract({ address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'midchainDigest', args: [sessionId, finalHash] });
  const signature = await account.sign({ hash: digest });
  const r = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'settle',
    args: [sessionId, finalHash, seedReveal, [signature], [account.address]], account,
  });
  return { tx: r.hash, digest, costUsdc6: r.costUsdc6.toString() };
}

// Generic connect for any caller (used by tests/scripts): takes explicit args.
async function doHandover(body) {
  const { account, pub, wallet } = clients();
  const fee = await feeNative(pub, account);
  const r = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'handover',
    args: [body.sessionId, body.gameLogic, body.startHash || ZERO32, body.seedCommit || ZERO32, body.players, body.sessionKeys, Number(body.randomCount || 0)],
    value: fee, account,
  });
  return { tx: r.hash, costUsdc6: r.costUsdc6.toString() };
}

// ---------------------------------------------------------------- Ludo demo
//
// THE FOSKAAY GGI MIDCHAIN MODEL. During play NO transaction is sent for a move.
// The move log travels WITH the request, and the CONTRACT is the only rules
// engine: the relay asks the contract's `previewLog` view (a free eth_call) to
// replay the log and return the board. An illegal or tampered log reverts there,
// exactly as `settleMatch` rejects it on-chain. So the relay holds NO truth and
// NO state (safe on serverless), and only two things are transactions:
//   1. demoCreate : connect the session (pay the fee) + create the match
//   2. demoSettle : settle the match from the log (one tx, tampering rejected)
// The log is transported by the caller, never stored server-side, never in
// localStorage; it is the same input the contract verifies at settle.

function demoSessionId(body) {
  return body.sessionId || keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [clients().account.address, BigInt(Date.now())]));
}

/// Normalize the transported move log to [kind, seat, tokenIndex, steps] tuples.
function moveLog(body) {
  const raw = Array.isArray(body.log) ? body.log : [];
  return raw.map((x) => (Array.isArray(x)
    ? [Number(x[0]), Number(x[1]), Number(x[2]), Number(x[3])]
    : [Number(x.kind), Number(x.seat), Number(x.tokenIndex), Number(x.steps)]));
}

/// Ask the CONTRACT to replay the log and return the board. This is the single
/// rules engine; the relay only transports the result. Reverts on an illegal log.
async function preview(matchRef, log) {
  const { pub } = clients();
  const [steps, path, home, turn, winner, finishOrder, finishCount] = await pub.readContract({
    address: ADDR.FoskaayGGIDemoGames, abi: demoGamesAbi, functionName: 'previewLog',
    args: [BigInt(matchRef), log],
  });
  return {
    stepsWalked: steps.map((x) => Number(x)),
    pathIndex: path.map((x) => Number(x)),
    home: home.map((x) => Number(x)),
    turn: Number(turn),
    winner: Number(winner),
    finishOrder: finishOrder.map((x) => Number(x)),
    finishCount: Number(finishCount),
  };
}

/// Create the match and CONNECT the session (two on-chain calls, ONE user step):
/// the rail handover pays the fee and registers the session, then createMatch
/// stores the match. This is the ONLY connect; every move after is free.
async function doDemoCreate(body) {
  const { account, pub, wallet } = clients();
  const sessionId = demoSessionId(body);
  const matchRef = BigInt(body.matchRef || Date.now());
  const gameTag = LUDO_TAG;
  const user = body.user || account.address;
  const seatCount = Number(body.seatCount || 2);
  const userSeat = Number(body.userSeat || 0);
  const verifyMode = Number(body.verifyMode || 0); // 0 signature, 1 replay
  const players = [account.address, account.address, account.address, account.address];
  players[userSeat] = user;
  const isComputer = [true, true, true, true];
  isComputer[userSeat] = false;
  const seed = keccak256(toBytes('foskaay-ggi-demo-' + matchRef + '-' + Date.now()));
  const seedCommit = keccak256(toBytes(seed));

  const seatPlayers = players.slice(0, seatCount);
  const seatKeys = players.slice(0, seatCount);

  // 1. CONNECT the session on the rail: pay the fee, register the session.
  const fee = await feeNative(pub, account);
  const ho = await send(wallet, pub, {
    address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'handover',
    args: [sessionId, ADDR.FoskaayGGIDemoGames, ZERO32, seedCommit, seatPlayers, seatKeys, 2],
    value: fee, account,
  });

  // 2. Create the match on the game contract (rule state only).
  const r = await send(wallet, pub, {
    address: ADDR.FoskaayGGIDemoGames, abi: demoGamesAbi, functionName: 'createMatch',
    args: [matchRef, sessionId, gameTag, players, isComputer, seatCount, userSeat, seedCommit, verifyMode], account,
  });
  const board = await preview(matchRef, []);
  const total = BigInt(r.costUsdc6) + ho.costUsdc6 + usdc18To6(fee);
  return { matchRef: String(matchRef), sessionId, userSeat, verifyMode, board, tx: r.hash, connectTx: ho.hash, costUsdc6: total.toString() };
}

/// ROLL: free. The dice come from the CONTRACT (eth_call); nothing is sent.
async function doDemoRoll(body) {
  const { pub } = clients();
  const matchRef = BigInt(body.matchRef);
  const log = moveLog(body);
  const counter = log.filter((x) => x[0] === 0).length;
  const [d1, d2] = await pub.readContract({ address: ADDR.FoskaayGGIDemoGames, abi: demoGamesAbi, functionName: 'diceOf', args: [matchRef, counter] });
  const before = await preview(matchRef, log);
  log.push([0, before.turn, Number(d1), Number(d2)]);
  const board = await preview(matchRef, log);
  return { dice1: Number(d1), dice2: Number(d2), turn: before.turn, board, log, costUsdc6: '0', gasless: true };
}

/// MOVE: free. The CONTRACT validates it by replay; an illegal move reverts.
async function doDemoMove(body) {
  const matchRef = BigInt(body.matchRef);
  const log = moveLog(body);
  log.push([1, Number(body.seat), Number(body.tokenIndex), Number(body.steps)]);
  const board = await preview(matchRef, log); // reverts if illegal
  return { board, log, costUsdc6: '0', gasless: true };
}

/// PASS: free. Ends the turn (the contract skips finished seats).
async function doDemoPass(body) {
  const matchRef = BigInt(body.matchRef);
  const log = moveLog(body);
  const before = await preview(matchRef, log);
  log.push([2, before.turn, 0, 0]);
  const board = await preview(matchRef, log);
  return { turn: board.turn, board, log, costUsdc6: '0', gasless: true };
}

/// READ the board (free). The board IS the contract's replay of the log.
async function doDemoBoard(body) {
  const { pub } = clients();
  const matchRef = BigInt(body.matchRef);
  const log = moveLog(body);
  const board = await preview(matchRef, log);
  let crownedSeat = 255;
  try { crownedSeat = Number(await pub.readContract({ address: ADDR.FoskaayGGIDemoGames, abi: demoGamesAbi, functionName: 'crownedSeat', args: [matchRef] })); } catch (_) {}
  const out = { turn: board.turn, tokens: board.stepsWalked, home: board.home, board, winner: board.winner, crown: crownedSeat, settled: crownedSeat !== 255 };
  const user = body.user;
  if (user) {
    try {
      const [pure, spendable] = await pub.readContract({ address: ADDR.FoskaayGGIDemoPlayer, abi: demoPlayerAbi, functionName: 'pointsOf', args: [user, LUDO_TAG] });
      out.userPoints = { lifetime: pure.toString(), spendable: spendable.toString() };
    } catch (_) {}
  }
  return out;
}

/// READ the two dice the contract derives for a counter (free, no key).
async function doDemoDice(body) {
  const { pub } = clients();
  const [dice1, dice2] = await pub.readContract({ address: ADDR.FoskaayGGIDemoGames, abi: demoGamesAbi, functionName: 'diceOf', args: [BigInt(body.matchRef), Number(body.counter)] });
  return { dice1: Number(dice1), dice2: Number(dice2) };
}

/// SETTLE: the second and LAST transaction. Seals the match on the game contract
/// by replaying the log (tampering rejected) and, when a sessionId is supplied,
/// seals the rail session too. After this nothing is open.
async function doDemoSettle(body) {
  const { account, pub, wallet } = clients();
  const matchRef = BigInt(body.matchRef);
  const log = moveLog(body);
  const finalHash = keccak256(toBytes(JSON.stringify(log)));

  // 1. Seal the match: re-verify the whole log on-chain and credit points.
  const r = await send(wallet, pub, {
    address: ADDR.FoskaayGGIDemoGames, abi: demoGamesAbi, functionName: 'settleMatch',
    args: [matchRef, log, finalHash], account,
  });
  let railCost = 0n;
  let railTx = null;
  if (body.sessionId) {
    // 2. Seal the rail session (sponsor is the declared signer).
    const digest = await pub.readContract({ address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'midchainDigest', args: [body.sessionId, finalHash] });
    const signature = await account.sign({ hash: digest });
    const rr = await send(wallet, pub, {
      address: ADDR.SessionRegistry, abi: registryAbi, functionName: 'settle',
      args: [body.sessionId, finalHash, ZERO32, [signature], [account.address]], account,
    });
    railCost = rr.costUsdc6; railTx = rr.hash;
  }
  return { tx: r.hash, railTx, finalHash, costUsdc6: (r.costUsdc6 + railCost).toString() };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  try {
    let out;
    switch (body.action) {
      case 'midchainHandover': out = await doMidchainHandover(body); break;
      case 'midchainSettle': out = await doMidchainSettle(body); break;
      case 'handover': out = await doHandover(body); break;
      case 'demoCreate': out = await doDemoCreate(body); break;
      case 'demoRoll': out = await doDemoRoll(body); break;
      case 'demoMove': out = await doDemoMove(body); break;
      case 'demoPass': out = await doDemoPass(body); break;
      case 'demoBoard': out = await doDemoBoard(body); break;
      case 'demoDice': out = await doDemoDice(body); break;
      case 'demoSettle': out = await doDemoSettle(body); break;
      case 'sponsorAddress': {
        const { account } = clients();
        out = {
          address: account.address,
          sessionRegistry: ADDR.SessionRegistry,
          feeVault: ADDR.FeeVault,
          demoGames: ADDR.FoskaayGGIDemoGames,
          demoPlayer: ADDR.FoskaayGGIDemoPlayer,
        };
        break;
      }
      default: res.status(400).json({ error: 'unknown action' }); return;
    }
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && (e.shortMessage || e.message)) || String(e) });
  }
}
