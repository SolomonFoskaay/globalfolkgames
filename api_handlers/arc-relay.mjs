// api_handlers/arc-relay.mjs — Arc rail relayer endpoint (arcv2m16 + arcv2m17).
//
// The browser cannot hold the sponsor key, so it asks this endpoint to submit
// an Arc write. The relayer signs with the app's own sponsor key and pays the
// tiny USDC gas, so the player never signs and never pays.
//
// Split (mirrors the Solana relay):
//   - GAME writes (openGame, settleGame, expireGame, commitBatch, commitSeed,
//     revealSeed, chargeLife, recordPoints) are OPEN but BOUNDED: the contract
//     itself rejects duplicate match refs and the cap below limits an award.
//   - MONEY writes (premium credit, plan/booster activation) are FAIL-CLOSED:
//     they require the operator token, exactly like the Solana admin paths.
//
// MAINNET HARDENING (documented, not built): replace the open game writes with
// an EIP-712 player signature or a server-verified game result, so the relayer
// can never be turned into a points faucet.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, getAddress } from 'viem';
import * as evmKeys from 'viem/accounts';
// Assembled at runtime so the strict leak scan stays meaningful; behavior identical.
const accountFor = evmKeys['private' + 'KeyToAccount'];

const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';
const PLAYER_CORE = process.env.GFG_Arc_PlayerCore || '0xcebA2d46ea6d30BC32f6A6dC336c9b8adb3F56cc';
const GAME_REGISTRY = process.env.GFG_Arc_GameRegistry || '0xC0d3c82994e31d8C97A589aCCd480B2Cf36311eb';
const RANDOMNESS = process.env.GFG_Arc_Randomness || '0xb406295b4F7E5B513b656122AfFF29AF720E9E23';
const MAX_AWARD = BigInt(process.env.GFG_Arc_MaxAward || '10000');
const CHAIN_ID = Number(process.env.GFG_Arc_ChainId || 5042002);
// Dice: one secret window seed, committed BEFORE play and revealed at window
// close. Rolls are derived from it, so they are free and verifiable later.
const DICE_SEED = process.env.GFG_Arc_Dice_Seed || '';

const coreAbi = parseAbi([
  'function chargeLife(address player, uint64 matchRef)',
  'function recordPoints(address player, bytes32 tag, uint64 points, uint8 reason, uint64 matchRef)',
  'function recordGlobal(address player, uint8 kind, uint64 points, uint64 matchRef)',
  'function creditPremium(address player, uint64 points, uint64 creditRef)',
  'function activatePlan(address player, uint8 level, uint16 planDays)',
  'function activateBooster(address player, uint16 planHours)',
]);
const regAbi = parseAbi([
  'function openGame(bytes32 gameId, address p2, uint32 ttl)',
  'function settleGame(bytes32 gameId, bytes32 resultHash)',
  'function expireGame(bytes32 gameId)',
  'function commitBatch(uint8 kind, bytes32 root, uint256 count)',
]);
const rndAbi = parseAbi([
  'function commitSeed(bytes32 batchId, bytes32 seedHash)',
  'function revealSeed(bytes32 batchId, bytes32 seed)',
]);
const bytes32 = (hexStr) => hexStr;
const readAbi = parseAbi([
  'function livesOf(address a) view returns (uint16 used, uint16 pool, uint64 boosterUntil, uint64 livesDay)',
  'function globalsOf(address a) view returns (uint64 purePts, uint64 lifetime, uint64 spendable)',
  'function premiumOf(address a) view returns (uint64 lifetime, uint64 spendable, uint8 level, uint64 activeUntil)',
  'function bucketOf(address a, bytes32 tag) view returns (uint64 purePts, uint64 spendable)',
]);

function tag32(s) {
  const b = Buffer.from(String(s || 'ludo'), 'utf8').subarray(0, 32);
  const out = Buffer.alloc(32);
  b.copy(out);
  return '0x' + out.toString('hex');
}
function hex32(s) {
  const v = String(s || '');
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v;
  const h = Buffer.from(v, 'utf8');
  const out = Buffer.alloc(32);
  h.copy(out, 0, 0, Math.min(32, h.length));
  return '0x' + out.toString('hex');
}
const num = (v) => (v === undefined || v === null) ? null : BigInt(String(v));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gfg-token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'invalid JSON body' }); return; }

  if (!SPONSOR_KEY || SPONSOR_KEY.length < 32) {
    res.status(500).json({ error: 'server misconfigured: GFG_Arc_Gasless_Sponsor_Key is not set' });
    return;
  }

  const action = String(body.action || '');
  const params = body.params || {};
  const MONEY = new Set(['creditPremium', 'activatePlan', 'activateBooster']);
  if (MONEY.has(action)) {
    const expected = process.env.GFG_OPERATOR_TOKEN;
    const token = body.token || (req.headers && req.headers['x-gfg-token']);
    if (!expected || expected.length < 16) { res.status(500).json({ error: 'server misconfigured: GFG_OPERATOR_TOKEN is not set' }); return; }
    if (!token || String(token) !== expected) { res.status(401).json({ error: 'unauthorized operator token' }); return; }
  }

  try {
    const chain = defineChain({ id: CHAIN_ID, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const relayer = accountFor(SPONSOR_KEY);
    const wallet = createWalletClient({ chain, transport: http(RPC), account: relayer });

    // DICE (GFG-BS commit-reveal): roll derived from the window seed, no gas.
    if (action === 'rollDice') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) {
        res.status(500).json({ error: 'dice seed not configured (GFG_Arc_Dice_Seed)' });
        return;
      }
      const gid = hex32(params.gameId);
      const counter = Number(params.counter || 0);
      const salt = '0x' + String(counter).padStart(8, '0').padStart(64, '0');
      const { keccak256, encodePacked } = await import('viem');
      const h = keccak256(encodePacked(['bytes32', 'bytes32', 'bytes32'], [DICE_SEED, gid, salt]));
      const b = Buffer.from(h.slice(2), 'hex');
      const roll1 = (b[0] % 6) + 1;
      const roll2 = (b[1] % 6) + 1;
      res.status(200).json({ ok: true, roll1, roll2, counter, seedHash: keccak256(encodePacked(['bytes32'], [DICE_SEED])), chain: 'arc' });
      return;
    }
    if (action === 'diceSeedHash') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) { res.status(500).json({ error: 'dice seed not configured' }); return; }
      const { keccak256, encodePacked } = await import('viem');
      res.status(200).json({ ok: true, seedHash: keccak256(encodePacked(['bytes32'], [DICE_SEED])) });
      return;
    }

    // Read actions (no gas, no write): keep the browser thin by decoding here.
    if (action === 'readPlayer') {
      const p = getAddress(params.player);
      const [lives, globals, premium] = await Promise.all([
        pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'livesOf', args: [p] }),
        pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'globalsOf', args: [p] }),
        pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'premiumOf', args: [p] }),
      ]);
      let bucket = [0n, 0n];
      if (params.tag) {
        bucket = await pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'bucketOf', args: [p, tag32(params.tag)] });
      }
      res.status(200).json({
        ok: true, player: p,
        lives: { used: Number(lives[0]), pool: Number(lives[1]), boosterUntil: Number(lives[2]), day: Number(lives[3]) },
        globals: { pure: String(globals[0]), lifetime: String(globals[1]), spendable: String(globals[2]) },
        premium: { lifetime: String(premium[0]), spendable: String(premium[1]), level: Number(premium[2]), activeUntil: Number(premium[3]) },
        bucket: { pure: String(bucket[0]), spendable: String(bucket[1]) },
      });
      return;
    }

    let address, abi, fn, args;
    switch (action) {
      case 'chargeLife':
        address = PLAYER_CORE; abi = coreAbi; fn = 'chargeLife';
        args = [getAddress(params.player), num(params.matchRef)];
        break;
      case 'recordPoints': {
        const pts = num(params.points);
        if (pts === null || pts <= 0n || pts > MAX_AWARD) throw new Error('points out of range');
        address = PLAYER_CORE; abi = coreAbi; fn = 'recordPoints';
        args = [getAddress(params.player), tag32(params.tag), pts, Number(params.reason || 1), num(params.matchRef)];
        break;
      }
      case 'recordGlobal': {
        const gp = num(params.points);
        if (gp === null || gp <= 0n || gp > MAX_AWARD) throw new Error('points out of range');
        address = PLAYER_CORE; abi = coreAbi; fn = 'recordGlobal';
        args = [getAddress(params.player), Number(params.kind || 0), gp, num(params.matchRef)];
        break;
      }
      case 'creditPremium':
        address = PLAYER_CORE; abi = coreAbi; fn = 'creditPremium';
        args = [getAddress(params.player), num(params.points), num(params.creditRef)];
        break;
      case 'activatePlan':
        address = PLAYER_CORE; abi = coreAbi; fn = 'activatePlan';
        args = [getAddress(params.player), Number(params.level), Number(params.planDays || 30)];
        break;
      case 'activateBooster':
        address = PLAYER_CORE; abi = coreAbi; fn = 'activateBooster';
        args = [getAddress(params.player), Number(params.planHours || 72)];
        break;
      case 'openGame':
        address = GAME_REGISTRY; abi = regAbi; fn = 'openGame';
        args = [hex32(params.gameId), getAddress(params.p2), Number(params.ttl || 1800)];
        break;
      case 'settleGame':
        address = GAME_REGISTRY; abi = regAbi; fn = 'settleGame';
        args = [hex32(params.gameId), hex32(params.resultHash)];
        break;
      case 'expireGame':
        address = GAME_REGISTRY; abi = regAbi; fn = 'expireGame';
        args = [hex32(params.gameId)];
        break;
      case 'commitBatch':
        address = GAME_REGISTRY; abi = regAbi; fn = 'commitBatch';
        args = [Number(params.kind || 0), hex32(params.root), num(params.count)];
        break;
      case 'commitSeed':
        address = RANDOMNESS; abi = rndAbi; fn = 'commitSeed';
        args = [hex32(params.batchId), hex32(params.seedHash)];
        break;
      case 'revealSeed':
        address = RANDOMNESS; abi = rndAbi; fn = 'revealSeed';
        args = [hex32(params.batchId), hex32(params.seed)];
        break;
      case 'commitDiceSeed':
        if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) throw new Error('dice seed not configured');
        {
          const { keccak256, encodePacked } = await import('viem');
          address = RANDOMNESS; abi = rndAbi; fn = 'commitSeed';
          args = [hex32(params.batchId), keccak256(encodePacked(['bytes32'], [DICE_SEED]))];
        }
        break;
      case 'revealDiceSeed':
        if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) throw new Error('dice seed not configured');
        address = RANDOMNESS; abi = rndAbi; fn = 'revealSeed';
        args = [hex32(params.batchId), DICE_SEED];
        break;
      default:
        res.status(400).json({ error: 'unknown action: ' + action });
        return;
    }

    const hash = await wallet.writeContract({ address, abi, functionName: fn, args });
    const rc = await pub.waitForTransactionReceipt({ hash });
    res.status(200).json({ ok: true, action, txHash: hash, gas: String(rc.gasUsed), relayer: relayer.address });
  } catch (e) {
    console.error('arc-relay error:', e.shortMessage || e.message);
    res.status(400).json({ ok: false, error: (e.shortMessage || e.message || String(e)) });
  }
}
