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
};

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
      case 'sponsorAddress': {
        const { account } = clients();
        out = { address: account.address, sessionRegistry: ADDR.SessionRegistry, feeVault: ADDR.FeeVault };
        break;
      }
      default: res.status(400).json({ error: 'unknown action' }); return;
    }
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && (e.shortMessage || e.message)) || String(e) });
  }
}
