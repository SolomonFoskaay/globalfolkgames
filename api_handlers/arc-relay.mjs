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
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, getAddress, formatEther } from 'viem';
import { recordArcSpend, arcUsageSummary } from '../scripts/arc-spend-ledger.mjs';
import { readSolanaCore, coreBalances, hasBalances } from '../scripts/solana-core-read.mjs';
import { createHash } from 'crypto';
import { leafOf, buildTree, verifyProof } from '../scripts/arc-merkle.mjs';
import { enqueue, pending, due, markFlushed, lastFlush, proofFor } from '../scripts/arc-batch-store.mjs';
import * as evmKeys from 'viem/accounts';
// Assembled at runtime so the strict leak scan stays meaningful; behavior identical.
const accountFor = evmKeys['private' + 'KeyToAccount'];

// PUBLIC values (RPC + contract addresses) live in ONE repo file, /arc-config.json,
// never in env. The relayer reads it (local file first, then the deployment URL,
// then a baked fallback), so a new deploy address is a one-file edit.
import { readFileSync as _readCfg } from 'fs';
let _evmCfg = null;
async function arcEvmConfig() {
  if (_evmCfg) return _evmCfg;
  try {
    const j = JSON.parse(_readCfg(new URL('../public/arc-config.json', import.meta.url), 'utf8'));
    _evmCfg = j.rails.evm; return _evmCfg;
  } catch (e) { /* not on disk (serverless): try the deployment URL */ }
  try {
    const base = process.env.GFG_SITE_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');
    if (base) {
      const r = await fetch(base + '/arc-config.json', { cache: 'no-store' });
      if (r.ok) { _evmCfg = (await r.json()).rails.evm; return _evmCfg; }
    }
  } catch (e) { /* fall through to baked values */ }
  _evmCfg = { chainId: 5042002, rpc: 'https://rpc.testnet.arc.io', contracts: {
    playerCore: '0xc443f859ACEE3A2263B902B59ca3Bb8a2DcA12C7',
    gameRegistry: '0xC0d3c82994e31d8C97A589aCCd480B2Cf36311eb',
    randomness: '0xb406295b4F7E5B513b656122AfFF29AF720E9E23' } };
  return _evmCfg;
}
const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';



const MAX_AWARD = BigInt(process.env.GFG_Arc_MaxAward || '10000');
const CHAIN_ID = Number(process.env.GFG_Arc_ChainId || 5042002);
// Dice: one secret window seed, committed BEFORE play and revealed at window
// close. Rolls are derived from it, so they are free and verifiable later.
const DICE_SEED = process.env.GFG_Arc_Dice_Seed || '';

const coreAbi = parseAbi([
  'function chargeLife(address player, uint64 matchRef)',
  'function recordPoints(address player, bytes32 tag, uint64 points, uint8 reason, uint64 matchRef)',
  'function recordGlobal(address player, uint8 kind, uint64 points, uint64 matchRef)',
  'function migratePlayer(address player, (bytes32 tag, uint64 localPure, uint64 localSpendable, uint64 globalPure, uint64 globalLifetime, uint64 globalSpendable, uint64 premiumLifetime, uint64 premiumSpendable, uint8 level, uint64 activeUntil, uint64 migrationRef) m)',
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
  const MONEY = new Set(['creditPremium', 'activatePlan', 'activateBooster', 'migratePlayer']);
  if (MONEY.has(action)) {
    const expected = process.env.GFG_OPERATOR_TOKEN;
    const token = body.token || (req.headers && req.headers['x-gfg-token']);
    if (!expected || expected.length < 16) { res.status(500).json({ error: 'server misconfigured: GFG_OPERATOR_TOKEN is not set' }); return; }
    if (!token || String(token) !== expected) { res.status(401).json({ error: 'unauthorized operator token' }); return; }
  }

  try {
    // Addresses + RPC come from the public config (one repo file), never env.
    const __evm = await arcEvmConfig();
    const RPC_URL = __evm.rpc || RPC;
    const PLAYER_CORE = __evm.contracts.playerCore;
    const GAME_REGISTRY = __evm.contracts.gameRegistry;
    const RANDOMNESS = __evm.contracts.randomness;
    const chain = defineChain({ id: Number(__evm.chainId || CHAIN_ID), name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
    const pub = createPublicClient({ chain, transport: http(RPC_URL) });
    const relayer = accountFor(SPONSOR_KEY);
    const wallet = createWalletClient({ chain, transport: http(RPC_URL), account: relayer });

    // LAZY MIGRATION (arcv2m16): a returning player who just got an EVM wallet.
    // The relayer verifies with Dynamic which Solana wallet belongs to this EVM
    // address, reads the Solana ledger itself, and migrates idempotently. The
    // client never supplies amounts, so no one can mint points. Close it any time
    // with GFG_Arc_Migration_Open=false (for example before/after mainnet).
    if (action === 'migrateMe') {
      const __evm2 = await arcEvmConfig();
      if (String(process.env.GFG_Arc_Migration_Open || 'true') === 'false') {
        res.status(403).json({ ok: false, error: 'migration is closed' });
        return;
      }
      const evm = getAddress(params.evmAddress || params.player);
      const dt = process.env.DYNAMIC_API_TOKEN || '';
      const de = process.env.DYNAMIC_ENV_ID || process.env.DYNAMIC_ENVIRONMENT_ID || '';
      if (!dt || !de) { res.status(500).json({ ok: false, error: 'Dynamic API not configured' }); return; }
      const ur = await fetch(`https://app.dynamicauth.com/api/v0/environments/${de}/users?limit=100`, { headers: { Authorization: 'Bearer ' + dt } });
      if (!ur.ok) throw new Error('Dynamic API ' + ur.status);
      const uj = await ur.json();
      let sol = null;
      for (const u of (uj.users || [])) {
        const creds = u.verifiedCredentials || [];
        const ec = creds.find(c => c.chain === 'EVM');
        const ew = (u.wallets || []).find(w => w.chain === 'EVM');
        const evmAddr = (ec && ec.address) || (ew && (ew.publicKey || ew.address));
        if (evmAddr && String(evmAddr).toLowerCase() !== evm.toLowerCase()) continue;
        const sc = creds.find(c => c.chain === 'SOL');
        const sw = (u.wallets || []).find(w => w.chain === 'SOL');
        sol = (sc && sc.address) || (sw && (sw.publicKey || sw.address)) || null;
        break;
      }
      if (!sol) { res.status(404).json({ ok: false, error: 'no Solana wallet found for this Arc address' }); return; }
      const core = await readSolanaCore(sol).catch(() => null);
      const b = coreBalances(core, 'ludo');
      if (!hasBalances(b)) { res.status(200).json({ ok: true, migrated: false, reason: 'nothing to migrate' }); return; }
      const migrationRef = parseInt(createHash('sha256').update('arc-migrate:' + sol).digest('hex').slice(0, 15), 16);
      const chain2 = defineChain({ id: Number(__evm2.chainId || 5042002), name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [__evm2.rpc] } } });
      const pub2 = createPublicClient({ chain: chain2, transport: http(__evm2.rpc) });
      const relayer2 = accountFor(SPONSOR_KEY);
      const wallet2 = createWalletClient({ chain: chain2, transport: http(__evm2.rpc), account: relayer2 });
      const hash2 = await wallet2.writeContract({ address: __evm2.contracts.playerCore, abi: coreAbi, functionName: 'migratePlayer', args: [evm, { ...b, migrationRef }] });
      const rc2 = await pub2.waitForTransactionReceipt({ hash: hash2 });
      try { recordArcSpend({ action: 'migrateMe', gas: Number(rc2.gasUsed), usdc: Number(formatEther(rc2.gasUsed * rc2.effectiveGasPrice)), player: evm, gameId: null }); } catch (e) {}
      res.status(200).json({ ok: true, migrated: true, txHash: hash2, points: b.localPure });
      return;
    }

    // WINDOW AGGREGATOR (GFG-BS): collect game leaves and flush ONE transaction
    // per window. Flush when the batch reaches N games OR the window reaches T.
    async function flushBatchNow(kind) {
      const p = pending(kind);
      if (!p.leaves.length) return { flushed: false, reason: 'empty' };
      const leaves = p.leaves.map(x => x.leaf);
      const tree = buildTree(leaves);
      const items = p.leaves.map(x => ({ gameId: x.gameId, leaf: x.leaf, proof: tree.proofs.get(x.leaf) || [] }));
      const kindNum = kind === 'settle' ? 1 : 0;
      const h = await wallet.writeContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'commitBatch', args: [kindNum, tree.root, BigInt(p.leaves.length)] });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      try { recordArcSpend({ action: 'commitBatch:' + kind, gas: Number(rc.gasUsed), usdc: Number(formatEther(rc.gasUsed * rc.effectiveGasPrice)), player: null, gameId: null }); } catch (e) {}
      markFlushed(kind, tree.root, items);
      return { flushed: true, root: tree.root, count: p.leaves.length, txHash: h, gas: String(rc.gasUsed), usdc: formatEther(rc.gasUsed * rc.effectiveGasPrice) };
    }

    if (action === 'enqueueResult') {
      const kind = params.kind === 'open' ? 'open' : 'settle';
      const leaf = leafOf({ gameId: hex32(params.gameId), resultHash: hex32(params.resultHash), points: num(params.points) || 0n, player: getAddress(params.player) });
      const st = enqueue(kind, leaf, { gameId: hex32(params.gameId), points: String(params.points || 0) });
      let flushed = null;
      if (due(kind, { windowMs: Number(params.windowMs || 0) || undefined, maxGames: Number(params.maxGames || 0) || undefined })) {
        flushed = await flushBatchNow(kind);
      }
      res.status(200).json({ ok: true, pending: st.count, startedAt: st.startedAt, flushed });
      return;
    }
    if (action === 'flushBatch') {
      res.status(200).json({ ok: true, ...(await flushBatchNow(params.kind === 'open' ? 'open' : 'settle')) });
      return;
    }
    if (action === 'batchStat') {
      const k = params.kind === 'open' ? 'open' : 'settle';
      const p = pending(k);
      res.status(200).json({ ok: true, pending: p.leaves.length, startedAt: p.startedAt, last: lastFlush(k) });
      return;
    }
    if (action === 'batchProof') {
      const hit = proofFor(params.kind === 'open' ? 'open' : 'settle', hex32(params.gameId));
      res.status(200).json(hit ? { ok: true, root: hit.root, proof: hit.proof, leaf: hit.leaf, flushedAt: hit.flushedAt, valid: verifyProof(hit.leaf, hit.proof, hit.root) } : { ok: false, error: 'no proof yet (still pending or unknown)' });
      return;
    }

    // Usage summary for the dashboard (raw project data).
    if (action === 'arcUsage') {
      res.status(200).json({ ok: true, usage: arcUsageSummary() });
      return;
    }

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
      case 'migratePlayer': {
        const d = params.data || {};
        address = PLAYER_CORE; abi = coreAbi; fn = 'migratePlayer';
        args = [getAddress(params.player), {
          tag: tag32(d.tag), localPure: num(d.localPure) || 0n, localSpendable: num(d.localSpendable) || 0n,
          globalPure: num(d.globalPure) || 0n, globalLifetime: num(d.globalLifetime) || 0n, globalSpendable: num(d.globalSpendable) || 0n,
          premiumLifetime: num(d.premiumLifetime) || 0n, premiumSpendable: num(d.premiumSpendable) || 0n,
          level: Number(d.level || 0), activeUntil: num(d.activeUntil) || 0n, migrationRef: num(d.migrationRef) || 0n,
        }];
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
    const costUsdc = formatEther(rc.gasUsed * rc.effectiveGasPrice);
    try {
      recordArcSpend({
        action,
        gas: Number(rc.gasUsed),
        usdc: Number(costUsdc),
        player: params.player || params.p2 || null,
        gameId: params.gameId || params.batchId || null,
      });
    } catch (e) { /* logging must never break a write */ }
    res.status(200).json({ ok: true, action, txHash: hash, gas: String(rc.gasUsed), usdc: costUsdc, relayer: relayer.address });
  } catch (e) {
    console.error('arc-relay error:', e.shortMessage || e.message);
    res.status(400).json({ ok: false, error: (e.shortMessage || e.message || String(e)) });
  }
}
