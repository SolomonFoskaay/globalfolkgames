// scripts/multiplayer-relay.mjs — MULTIPLAYER relay core (M12, AGM-FREE).
//
// Standalone on-chain multiplayer rail: the relay/sponsor signs the one-time
// board create + delegate (base layer, ~0.0003 SOL, idempotent), and every
// board write afterwards runs GASLESS on the MagicBlock ER (session-key or
// sponsor signer, 0 fee). No AGM / order book / P2C anything lives here.
//
// The GAME owns rules/turn order/move meaning; this relay only:
//   - boardStart: create the [gfgboard, game, matchRef] PDA + delegate it to
//     the ER + begin it (status 0->1) when the host starts the match.
//   - boardCommit: gasless ER write of a 32-byte move checkpoint (one per
//     turn), signed by the sponsor signer (player session keys are the future
//     path; today the rail is free, stake 0, sponsor signs).
//   - boardState: read the board facts from its hosting ER region.
//   - boardFinish: write the winner + finished timestamp (gasless ER).
//   - boardJoin/lobby: validate a match code = matchRef, ensure it is still
//     waiting (status 0) so nobody joins a started match.
//
// Every call is soft-fail ({ok, sig?, error?}) and NEVER throws into the game,
// so Solo/free play is unaffected if the rail is down.

import './load-env.mjs';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const BOARD_SEED = Buffer.from('gfgboard');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR_ID = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'); // AS region pin
const MAX_MP = 8;

const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));

export function boardPda(game, matchRef) {
  return PublicKey.findProgramAddressSync([BOARD_SEED, Buffer.from([game]), new BN(matchRef).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}

// ---- idempotent ER onboarding -------------------------------------------------
export async function ensureBoardDelegated(game, matchRef) {
  const pda = boardPda(game, matchRef);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return { pda: pda.toBase58(), delegated: false, why: 'board-not-created-yet' };
  const st = await getDelegationStatus(conn, pda).catch(() => null);
  if (st && st.isDelegated) return { pda: pda.toBase58(), delegated: true, region: st.fqdn || '' };
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM_ID);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM_ID);
  const tx = await prog.methods.delegateBoard(game, new BN(matchRef))
    .accounts({
      payer: sponsor.publicKey,
      bufferBoard: buffer,
      delegationRecordBoard: record,
      delegationMetadataBoard: metadata,
      board: pda,
      ownerProgram: PROGRAM,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: ER_VALIDATOR_ID, isSigner: false, isWritable: false }])
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return { pda: pda.toBase58(), delegated: true, sig };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function boardHostUrl(pda) {
  try {
    const st = await getDelegationStatus(conn, pda);
    if (st && st.fqdn) {
      const u = regionUrlForFqdn(st.fqdn);
      if (u) return u;
    }
  } catch (e) { /* fall through */ }
  return pickErRpcUrl();
}

async function waitBoardPickup(pda, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let url = await boardHostUrl(pda);
  while (Date.now() < deadline) {
    try { url = await boardHostUrl(pda); } catch (e) {}
    try {
      const c = createConnection(url, 'confirmed', 8000);
      const info = await c.getAccountInfo(pda);
      if (info && info.owner.toBase58() === PROGRAM.toBase58() && info.data.length >= 430) return url;
    } catch (e) { /* keep polling */ }
    await sleep(600);
  }
  return url;
}

async function boardSignerSend(method, pda, opts = {}) {
  try {
    const url = opts.regionUrl || (await waitBoardPickup(pda));
    const connEr = createConnection(url, 'confirmed');
    const bh = await connEr.getLatestBlockhash('confirmed');
    const tx = await method.transaction();
    tx.feePayer = sponsor.publicKey;
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.partialSign(sponsor);
    const sig = await connEr.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connEr.confirmTransaction({ signature: sig }, 'confirmed');
    return { ok: true, sig };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ---- actions ------------------------------------------------------------------

// Create + delegate + begin a match. `players` may be empty/partial: the board
// program requires >=2 players, and create happens before joiners are known, so
// the creator's seat is filled with the sponsor as a placeholder (real seat
// identity/locking is a later milestone). begin is skipped here; it happens on
// the host's "Start Match" via boardStart_match.
export async function boardCreate({ game, matchRef, seats, stakeUsdCents, turnSecs, maxMatchSecs }) {
  try {
    const pda = boardPda(game, matchRef);
    const info = await conn.getAccountInfo(pda).catch(() => null);
    let created = false;
    if (!info) {
      const seatCount = Math.min(MAX_MP, Math.max(2, Number(seats) || 2));
      const list = [];
      for (let i = 0; i < seatCount; i++) list.push(sponsor.publicKey);
      const tx = await prog.methods.startMatch(game, new BN(matchRef), list, seatCount, new BN(stakeUsdCents || 0), new BN(turnSecs || 60), new BN(maxMatchSecs || 3600))
        .accounts({ payer: sponsor.publicKey, board: pda, systemProgram: SystemProgram.programId }).transaction();
      tx.feePayer = sponsor.publicKey;
      await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }).then(async (sig) => { await conn.confirmTransaction({ signature: sig }, 'confirmed'); });
      created = true;
    }
    const d = await ensureBoardDelegated(game, matchRef);
    if (!d.delegated) await sleep(1200);
    return { ok: true, pda: pda.toBase58(), matchRef, created, delegated: !!d.delegated };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Host pressed "Start Match": flip status 0 -> 1 (one-time, base path like begin).
export async function boardBegin({ game, matchRef }) {
  try {
    const pda = boardPda(game, matchRef);
    const st = await boardState({ game, matchRef });
    if (st && st.ok && st.status !== 0) return { ok: true, note: 'already-started', pda: pda.toBase58() };
    const meth = prog.methods.beginMatch(game, new BN(matchRef)).accounts({ signer: sponsor.publicKey, board: pda });
    const tx = await meth.transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
    return { ok: true, sig, started: true, pda: pda.toBase58() };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Validate a code (matchRef digest) still accepts joiners: board exists + status 0.
export async function boardJoin({ game, matchRef }) {
  try {
    const st = await boardState({ game, matchRef });
    if (!st || !st.ok) return { ok: false, error: 'no open match with that code' };
    if (st.status !== 0) return { ok: false, error: 'match already started - no new joins' };
    return { ok: true, matchRef: st.match_ref, pda: st.pda, seats: st.seats };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function boardCommit({ game, matchRef, seat, moveCommit, regionUrl }) {
  try {
    const pda = boardPda(game, matchRef);
    const method = prog.methods.commitMove(game, new BN(matchRef), seat, Array.isArray(moveCommit) ? moveCommit : toBytes32(moveCommit))
      .accounts({ signer: sponsor.publicKey, board: pda });
    return await boardSignerSend(method, pda, { regionUrl });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function boardFinish({ game, matchRef, winnerSeat, regionUrl }) {
  try {
    const pda = boardPda(game, matchRef);
    const method = prog.methods.finishMatch(game, new BN(matchRef), winnerSeat)
      .accounts({ signer: sponsor.publicKey, board: pda });
    return await boardSignerSend(method, pda, { regionUrl });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function boardState({ game, matchRef }) {
  try {
    const pda = boardPda(game, matchRef);
    const url = await boardHostUrl(pda);
    const c = createConnection(url, 'confirmed');
    const info = await c.getAccountInfo(pda).catch(() => null);
    if (!info) return { ok: false, error: 'board not found' };
    const d = info.data;
    if (d.length < 430) return { ok: false, error: 'board too small' };
    const playerCount = d[275];
    const players = [];
    for (let i = 0; i < Math.min(MAX_MP, playerCount); i++) {
      const s = d.subarray(19 + i * 32, 51 + i * 32);
      if (s.every(b => b === 0)) continue;
      try { players.push(new PublicKey(s).toBase58()); } catch (e) {}
    }
    return {
      ok: true,
      pda: pda.toBase58(),
      version: d[8],
      game: d[9],
      match_ref: Number(d.readBigUInt64LE(10)),
      status: d[18],
      players,
      player_count: d[275],
      seats: d[276],
      stake_usd_cents: Number(d.readBigUInt64LE(277)),
      seat_pot_usd_cents: Number(d.readBigUInt64LE(285)),
      turn_secs: Number(d.readBigUInt64LE(293)),
      max_match_secs: Number(d.readBigUInt64LE(301)),
      started_at: Number(d.readBigInt64LE(309)),
      move_count: Number(d.readBigUInt64LE(381)),
      winner_seat: d[429],
      region: url,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function toBytes32(hexOrStr) {
  const out = new Uint8Array(32);
  const s = String(hexOrStr || '');
  let hex = s.startsWith('0x') ? s.slice(2) : s;
  for (let i = 0; i < Math.min(32, hex.length / 2); i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  }
  return Array.from(out);
}

// ---- public dispatch (used by api_handlers/multiplayer.mjs) -------------------
export async function dispatch(action, b) {
  switch (action) {
    case 'create': return boardCreate({ game: Number(b.game), matchRef: Number(b.matchRef), seats: Number(b.seats), stakeUsdCents: Number(b.stakeUsdCents) || 0, turnSecs: Number(b.turnSecs) || 60, maxMatchSecs: Number(b.maxMatchSecs) || 3600 });
    case 'begin': return boardBegin({ game: Number(b.game), matchRef: Number(b.matchRef) });
    case 'join': return boardJoin({ game: Number(b.game), matchRef: Number(b.matchRef) });
    case 'commit': return boardCommit({ game: Number(b.game), matchRef: Number(b.matchRef), seat: Number(b.seat), moveCommit: b.moveCommit, regionUrl: b.regionUrl });
    case 'state': return boardState({ game: Number(b.game), matchRef: Number(b.matchRef) });
    case 'finish': return boardFinish({ game: Number(b.game), matchRef: Number(b.matchRef), winnerSeat: Number(b.winnerSeat), regionUrl: b.regionUrl });
    default: return { ok: false, error: 'unknown multiplayer action: ' + action };
  }
}