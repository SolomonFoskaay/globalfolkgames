// scripts/m6-affiliate-harness.mjs
// M6 harness: prove the on-chain affiliate ledger end to end on devnet.
// Uses a fresh random affiliate wallet (never writes to a real account owner);
// referral = the owner's test wallet. Records earned + forfeited periods, a
// payout, then reads the ledger back. Run: node scripts/m6-affiliate-harness.mjs
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  handleRecordAffiliatePeriod, handleAffiliatePayout, readAffiliateLedger,
  affiliateAccountPda,
} from './affiliate-relay.mjs';
import './load-env.mjs';

async function main() {
  const affiliate = Keypair.generate().publicKey.toBase58();
  const referral = '42Xs2owrBnKsZXDfVbzxEGG3b2b3QDm3WD4uHujgSjew';
  console.log('affiliate (fresh, no owner data):', affiliate);
  console.log('affiliate PDA:', affiliateAccountPda(affiliate).toBase58());

  const period = 202608;
  console.log('\n1) record EARNED month (15% of $3 = 45 USD cents)');
  let r = await handleRecordAffiliatePeriod({ affiliate, referral, period, usdCents: 45, eligibility: 0 });
  console.log('   sig', String(r.sig).slice(0, 20));

  console.log('\n2) duplicate same period should error (idempotency)');
  try {
    await handleRecordAffiliatePeriod({ affiliate, referral, period, usdCents: 45, eligibility: 0 });
    console.log('   FAIL: did not reject duplicate');
  } catch (e) { console.log('   ok duplicate rejected:', e.message.slice(0, 60)); }

  console.log('\n3) record FORFEITED month (inactive affiliate) next period');
  let r2 = await handleRecordAffiliatePeriod({ affiliate, referral, period: 202609, usdCents: 45, eligibility: 2 });
  console.log('   sig', String(r2.sig).slice(0, 20));

  console.log('\n4) payout 45 cents (pending -> paid)');
  let r3 = await handleAffiliatePayout({ affiliate, usdCents: 45, payoutRef: 9001 });
  console.log('   sig', String(r3.sig).slice(0, 20));

  console.log('\n5) read ledger back');
  const ledger = await readAffiliateLedger(affiliate);
  console.log('   lifetime', ledger && ledger.lifetimeUsdCents, 'pending', ledger && ledger.pendingUsdCents,
    'paid', ledger && ledger.paidUsdCents, 'forfeited', ledger && ledger.forfeitedUsdCents, 'entries', ledger && ledger.entryCount);
  if (ledger && ledger.lifetimeUsdCents === 45 && ledger.pendingUsdCents === 0 && ledger.paidUsdCents === 45 && ledger.forfeitedUsdCents === 45) {
    console.log('\nPASS');
  } else {
    console.log('\nCHECK: ledger totals', JSON.stringify(ledger));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });