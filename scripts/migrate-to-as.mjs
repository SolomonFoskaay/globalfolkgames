// scripts/migrate-to-as.mjs
// Moves an already-delegated DICE PDA off the flaky US ER region onto AS.
//
// WHY (proven, see scripts/lab/migrate-probe.mjs, temp/deleted):
//   - An account's ER state lives on EXACTLY ONE region: the validator the
//     relay/delegator pinned it to via remaining_accounts. All pre-2026-08-18
//     accounts are pinned to the US validator (MUS3hc9...).
//   - The client previously rotated US OUT of its ER endpoint list, so rolls
//     were submitted to AS/EU while the account lived on US -> the VRF
//     callback landed on US, unseen by the AS/EU poll -> "Timeout waiting for
//     callback result" (reproduced in E3: roll on AS of a US-pinned account
//     NEVER landed).
//   - Region-aware targeting (src/magicblock-vrf.js) fixed the client: every
//     write+poll now resolves the account's hosting region from the Router and
//     targets it. That made US-pinned accounts work WHILE US answers, but US
//     intermittently returns "-32005 client temporarily banned".
//   - The durable fix is to RE-PIN accounts to a healthy region (AS). Re-pinning
//     is NOT possible directly (the delegation program rejects a re-delegate on
//     an already-delegated account: DlpError 27 DelegationRecordAlreadyInitialized).
//     The ONLY path for the DICE PDA (which is what game rolls need) is:
//       1. undelegate on the region hosting it (our program's `undelegate`
//          instruction; any payer, including the sponsor, may sign - the
//          player_authority is NOT a signer),
//       2. re-delegate via the SAME relay production uses (now pins AS).
//     Proven end-to-end in migrate-probe.mjs: after migration the roll callback
//     lands on AS.
//
// SCOPE LIMITATION (documented): the program only has an `undelegate` variant
// for the DICE PDA. The POINTS / RESULT / GLOBAL PDAs have NO undelegate and
// direct re-delegate is rejected, so they CANNOT be re-pinned without a program
// upgrade (addutive undelegate_points/result/global instructions). They keep
// working through region-aware targeting on their current region while it
// answers, and the base layer always retains their bytes (no data loss). This
// script therefore migrates dice PDAs only.
//
// Safety (see .opencode/rules/solana-upgrade-safety.md):
//   - No account data is created/deleted: undelegate commits the ER state back
//     to the base layer (the account's bytes persist there), re-delegate
//     re-hosts those same bytes on AS.
//   - Idempotent: accounts already on AS are skipped; non-delegated accounts
//     are skipped (the relay pins AS on their next use).
//   - Run while the target account is idle (not mid-roll).
//
// Usage:
//   node scripts/migrate-to-as.mjs                # house (sponsor) dice only
//   node scripts/migrate-to-as.mjs --player <pk>  # one player's dice
//   node scripts/migrate-to-as.mjs --all          # every delegated player in
//                                                 #   the spend ledger + house
//
// Env: sponsor key via GFG_Gasless_Sponsor_Keypair (Vercel) or
// ~/.config/solana/id.json (local), exactly like the delegate relay.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { recordSpend } from './spend-ledger.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const V_AS = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const MP = new PublicKey('Magic11111111111111111111111111111111111111');
const MC = new PublicKey('MagicContext1111111111111111111111111111111');
const PLAYER_SEED = Buffer.from('gfgplayerd');
const BASE_URL = baseRpcUrl();
const AS_MARKER = 'devnet-as';
const PICKUP_WAIT_MS = 15000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function dicePdaFor(player) {
  return PublicKey.findProgramAddressSync([PLAYER_SEED, player.toBytes()], PROGRAM_ID)[0];
}

function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { ts.forEach(t => t.partialSign(kp)); return ts; },
  };
}

async function waitPickup(conn, pda) {
  const deadline = Date.now() + PICKUP_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const info = await conn.getAccountInfo(pda);
      if (info && info.data.length > 0) return true;
    } catch (e) { /* keep polling */ }
    await sleep(600);
  }
  return false;
}

async function waitDelegation(baseConn, pda, target) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const st = await getDelegationStatus(baseConn, pda).catch(() => null);
    if (st && st.isDelegated === target) return st;
    await sleep(900);
  }
  return null;
}

// Re-delegate ONLY the player's dice PDA to the AS validator (sponsor signs).
// Bypasses handleDelegate's multi-PDA spend budget: the account already exists
// (owner = our program after undelegate), so this is a single `delegate` step.
async function reDelegateDiceToAs(baseConn, player, dice) {
  const sponsor = loadSponsor();
  const prog = new Program(idl, new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), dice.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), dice.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), dice.toBytes()], DELEGATION_PROGRAM);
  const tx = await prog.methods.delegate()
    .accounts({
      payer: sponsor.publicKey,
      playerAuthority: player,
      player: dice,
      bufferPlayer: buffer,
      delegationRecordPlayer: record,
      delegationMetadataPlayer: metadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }])
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
  await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
  await sleep(3000);
  const after = await waitDelegation(baseConn, dice, true);
  return { sig, after };
}

// Migrate ONE player's dice PDA US -> AS. Returns a summary object.
export async function migratePlayerDice(playerPubkey, { baseConn } = {}) {
  const player = new PublicKey(playerPubkey);
  const conn = baseConn || createConnection(BASE_URL, 'confirmed');
  const dice = dicePdaFor(player);

  const st = await getDelegationStatus(conn, dice).catch(() => null);
  if (st && st.isDelegated && st.fqdn && st.fqdn.includes(AS_MARKER)) {
    return { player: player.toBase58(), dice: dice.toBase58(), currentRegion: st.fqdn, status: 'SKIP already AS' };
  }

  if (st && st.isDelegated) {
    // 1) Undelegate on the hosting region (sponsor signs; player_authority is
    //    not a signer). Must be sent to the region the account lives on.
    const host = regionUrlForFqdn(st.fqdn);
    if (!host) return { player: player.toBase58(), dice: dice.toBase58(), currentRegion: st.fqdn, status: 'SKIP unmapped region fqdn' };
    console.log(`[migrate] ${player.toBase58().slice(0, 8)} dice ${dice.toBase58().slice(0, 8)} is on ${host} - undelegating on that region...`);
    const hostConn = createConnection(host, 'processed', 30000, { backoffMs: [400, 800, 1200, 1800, 2500] });
    await waitPickup(hostConn, dice);
    const hostProg = new Program(idl, new AnchorProvider(hostConn, mkWallet(loadSponsor()), { commitment: 'processed', skipPreflight: true }));
    let undelegateSig = null;
    try {
      const tx = await hostProg.methods.undelegate()
        .accounts({ payer: loadSponsor().publicKey, playerAuthority: player, player: dice, magicProgram: MP, magicContext: MC })
        .transaction();
      tx.feePayer = loadSponsor().publicKey;
      undelegateSig = await sendMagicTx(hostConn, tx, [loadSponsor()], { skipPreflight: true });
      await hostConn.confirmTransaction({ signature: undelegateSig }, 'processed');
    } catch (e) {
      return { player: player.toBase58(), dice: dice.toBase58(), currentRegion: host, status: `FAIL undelegate: ${(e.message || '').slice(0, 140)}` };
    }
    await waitDelegation(conn, dice, false);
    console.log(`  undelegate ${undelegateSig} -> isDelegated=false`);
  }

  await waitDelegation(conn, dice, false);
  await sleep(3000);

  // 2) Re-delegate the dice to AS (sponsor signs, one `delegate` step).
  const sponsor = loadSponsor();
  const balanceBefore = await conn.getBalance(sponsor.publicKey).catch(() => null);
  const rd = await reDelegateDiceToAs(conn, player, dice);
  const balanceAfter = await conn.getBalance(sponsor.publicKey).catch(() => null);
  const spent = Math.max(0, (balanceBefore ?? balanceAfter) - balanceAfter);
  if (spent > 0) {
    // Honest ops accounting: the re-pin is a migration cost borne by the
    // sponsor, not player onboarding, so it lands as a `migration` event
    // attributed to the player WITHOUT bumping their onboarding cap map
    // (recording it there would block the relay's next real onboard for them).
    recordSpend(player.toBase58(), spent, { category: 'migration', steps: 1, capExempt: true });
    console.log(`  re-delegate spent ${(spent / 1e9).toFixed(6)} SOL (migration, cap-exempt)`);
  }
  const nowAs = !!(rd.after && rd.after.isDelegated && rd.after.fqdn && rd.after.fqdn.includes(AS_MARKER));
  return {
    player: player.toBase58(),
    dice: dice.toBase58(),
    status: nowAs ? 'MIGRATED -> AS' : `CHECK after: ${(rd.after && rd.after.fqdn) || 'no fqdn'}`,
    undelegateSig: rd.sig,
    fqdn: (rd.after && rd.after.fqdn) || null,
  };
}

function spendLedgerPlayers() {
  try {
    const ledger = JSON.parse(readFileSync(join(process.cwd(), '.gfg-spend-ledger.json'), 'utf8'));
    const set = new Set();
    for (const pk of Object.keys(ledger.players || {})) set.add(pk);
    for (const ev of (ledger.events || [])) if (ev.player) set.add(ev.player);
    return [...set];
  } catch (e) {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sponsor = loadSponsor();
  const targets = [sponsor.publicKey.toBase58()]; // house always

  const pIdx = args.indexOf('--player');
  if (pIdx !== -1) targets.push(args[pIdx + 1]);
  if (args.includes('--all')) {
    for (const pk of spendLedgerPlayers()) if (!targets.includes(pk)) targets.push(pk);
  }

  const baseConn = createConnection(BASE_URL, 'confirmed');
  const results = [];
  for (const pk of targets) {
    try { results.push(await migratePlayerDice(pk, { baseConn })); }
    catch (e) { results.push({ player: pk, status: `ERROR ${(e.message || '').slice(0, 140)}` }); }
  }
  console.log('\n===== MIGRATION SUMMARY =====');
  for (const r of results) console.log(`- ${r.player.slice(0, 8)}.. ${r.dice ? r.dice.slice(0, 8) + '..' : ''} ${r.status}`);
}

if (process.argv[1] && process.argv[1].endsWith('migrate-to-as.mjs')) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}