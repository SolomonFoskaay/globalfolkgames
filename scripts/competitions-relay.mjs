// scripts/competitions-relay.mjs — M7 COMPETITION RELAY (server-side,
// sponsor-signed, base-layer admin writes). Mirrors affiliate-relay: the
// sponsor (admin/creator) signs every competition lifecycle write on-chain so
// the framework is authoritative + auditable. Instances live at
// [gfgcomp2, creator, seq]; winner records at [gfgwin, comp, rank].
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import bs58 from 'bs58';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const COMP2_SEED = Buffer.from('gfgcomp2');
const GFGWIN_SEED = Buffer.from('gfgwin');
const BASE = baseRpcUrl();

export function compPda(creator, seq) {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32LE(Number(seq) >>> 0, 0);
  return PublicKey.findProgramAddressSync([COMP2_SEED, new PublicKey(creator).toBytes(), seqBuf], PROGRAM)[0];
}
export function winPda(comp, rank) {
  return PublicKey.findProgramAddressSync([GFGWIN_SEED, new PublicKey(comp).toBytes(), Buffer.from([Number(rank)])], PROGRAM)[0];
}

async function sponsorProgram() {
  const sponsor = loadSponsor();
  const conn = createConnection(BASE, 'confirmed');
  const provider = new AnchorProvider(conn, {
    publicKey: sponsor.publicKey,
    signTransaction: async (t) => { t.partialSign(sponsor); return t; },
    signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
  }, { commitment: 'confirmed', skipPreflight: true });
  return { sponsor, conn, program: new Program(idl, provider) };
}

async function send(conn, sponsor, tx) {
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

// ---- competition lifecycle -------------------------------------------------
export async function createCompetition({ creator = null, seq, name, games, tierBits, requireAll = 0, entryCost, entryFamilies, startsAt, endsAt, poolUsdCents, poolPoints, winnerCount, prizeShares, redemption = 0, payoutMode = 0 }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.createCompetition(
    new BN(seq), name, Buffer.from(games || []), tierBits, requireAll,
    new BN(entryCost), entryFamilies, new BN(startsAt), new BN(endsAt),
    new BN(poolUsdCents), new BN(poolPoints), winnerCount, (prizeShares || []).map(s => new BN(s)),
    redemption, payoutMode,
  ).accounts({ payer: sponsor.publicKey, competition: pda, systemProgram: SystemProgram.programId }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function closeCompetition({ creator = null, seq }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.closeCompetition(new BN(seq)).accounts({ authority, competition: pda }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function cancelCompetition({ creator = null, seq }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.cancelCompetition(new BN(seq)).accounts({ authority, competition: pda }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function recordCompetitionWinner({ creator = null, seq, rank, player }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const comp = compPda(authority, seq);
  const winner = winPda(comp, rank);
  const tx = await program.methods.recordCompetitionWinner(new BN(seq), new BN(rank), new PublicKey(player))
    .accounts({ authority, competition: comp, winner, systemProgram: SystemProgram.programId }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), winner: winner.toBase58() };
}

export async function settleCompetition({ creator = null, seq }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.settleCompetition(new BN(seq)).accounts({ authority, competition: pda }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function markWinnerPaid({ creator = null, seq, rank }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const comp = compPda(authority, seq);
  const winner = winPda(comp, rank);
  const tx = await program.methods.markWinnerPaid(new BN(seq), new BN(rank)).accounts({ authority, competition: comp, winner }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), winner: winner.toBase58() };
}

// ---- reads -----------------------------------------------------------------
function compDisc() {
  return bs58.encode(createHash('sha256').update('account:CompetitionInstance').digest().subarray(0, 8));
}
export function decodeCompetition(d) {
  return {
    version: d.length >= 9 ? d[8] : 0,
    creator: d.length >= 41 ? bs58.encode(d.subarray(9, 41)) : '',
    seq: d.length >= 45 ? d.readUInt32LE(41) : 0,
    name: d.length >= 69 ? Buffer.from(d.subarray(45, 69)).toString('utf8').replace(/\0+$/, '') : '',
    games: Array.from(d.subarray(69, 69 + 4)).filter(x => x !== 0),
    gameCount: d.length >= 74 ? d[73] : 0,
    tierBits: d.length >= 75 ? d[74] : 0,
    requireAll: d.length >= 76 ? d[75] : 0,
    entryCost: d.length >= 84 ? Number(d.readBigUInt64LE(76)) : 0,
    entryFamilies: d.length >= 85 ? d[84] : 0,
    startsAt: d.length >= 93 ? Number(d.readBigInt64LE(85)) : 0,
    endsAt: d.length >= 101 ? Number(d.readBigInt64LE(93)) : 0,
    poolUsdCents: d.length >= 109 ? Number(d.readBigUInt64LE(101)) : 0,
    poolPoints: d.length >= 117 ? Number(d.readBigUInt64LE(109)) : 0,
    winnerCount: d.length >= 118 ? d[117] : 0,
    prizeShares: Array.from({ length: d.length >= 146 ? Math.min(d[117] || 0, 16) : 0 }, (_, i) => d.readUInt32LE(118 + i * 4)),
    redemption: d.length >= 183 ? d[182] : 0,
    payoutMode: d.length >= 184 ? d[183] : 0,
    status: d.length >= 185 ? d[184] : 0,
    settledTs: d.length >= 193 ? Number(d.readBigInt64LE(185)) : 0,
  };
}
export function decodeWinner(d) {
  return {
    version: d.length >= 9 ? d[8] : 0,
    comp: d.length >= 41 ? bs58.encode(d.subarray(9, 41)) : '',
    rank: d.length >= 42 ? d[41] : 0,
    player: d.length >= 74 ? bs58.encode(d.subarray(42, 74)) : '',
    points: d.length >= 82 ? Number(d.readBigUInt64LE(74)) : 0,
    usdCents: d.length >= 90 ? Number(d.readBigUInt64LE(82)) : 0,
    status: d.length >= 91 ? d[90] : 0,
    paidTs: d.length >= 99 ? Number(d.readBigInt64LE(91)) : 0,
  };
}

export async function getCompetition({ creator, seq }) {
  const conn = createConnection(BASE, 'confirmed');
  const pda = compPda(creator, seq);
  const info = await conn.getAccountInfo(pda);
  if (!info || !info.data) return null;
  return { pda: pda.toBase58(), ...decodeCompetition(info.data) };
}

export async function listCompetitions({ creator } = {}) {
  const disc = compDisc();
  const regions = ['https://api.devnet.solana.com', BASE, 'https://devnet-as.magicblock.app/'];
  const filters = [{ memcmp: { offset: 0, bytes: disc } }];
  if (creator) filters.push({ memcmp: { offset: 9, bytes: creator } });
  for (const url of regions) {
    try {
      const body = {
        jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
        params: [PROGRAM.toBase58(), { encoding: 'base64', filters }],
      };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const arr = (j && j.result) || [];
      return arr.map(a => {
        const d = Buffer.from(a.account.data[0], 'base64');
        return { pda: a.pubkey, ...decodeCompetition(d) };
      }).sort((x, y) => (x.seq || 0) - (y.seq || 0));
    } catch (e) { /* try next region */ }
  }
  return [];
}

export async function getWinners({ creator, seq }) {
  const conn = createConnection(BASE, 'confirmed');
  const comp = compPda(creator, seq);
  const list = [];
  const max = 16;
  for (let rank = 1; rank <= max; rank++) {
    const pda = winPda(comp, rank);
    const info = await conn.getAccountInfo(pda);
    if (!info || !info.data) continue;
    list.push({ pda: pda.toBase58(), ...decodeWinner(info.data) });
  }
  return list;
}