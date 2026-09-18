// scripts/arc-sponsor-wallet.mjs — create the Arc sponsor/relayer key SAFELY.
//
// Mirrors the Solana ~/.config/solana/id.json pattern:
//   - writes ~/.config/gfg/arc-sponsor.json  (mode 600, outside the repo)
//   - prints ONLY the public address + the file path (never the key value)
//
// Usage:  node scripts/arc-sponsor-wallet.mjs
// Then, to paste the key into Vercel env (GFG_Arc_Gasless_Sponsor_Key):
//   cat ~/.config/gfg/arc-sponsor.json
//
// The file's secret field is named "key" (0x + 64 hex). No secret value is ever
// written into the repo, printed by value, or committed.
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { generatePrivateKey as newKey, privateKeyToAccount as accountFor } from 'viem/accounts';

const dir = join(homedir(), '.config', 'gfg');
const file = join(dir, 'arc-sponsor.json');

if (existsSync(file)) {
  console.error('Refusing to overwrite an existing wallet:', file);
  console.error('Move or delete it first if you really want a new one.');
  process.exit(1);
}

const hexKey = newKey();
const address = accountFor(hexKey).address;

mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify({
  address,
  key: hexKey,
  network: 'arc-testnet',
  role: 'gasless-sponsor-relayer',
  created: new Date().toISOString(),
}, null, 2) + '\n', { mode: 0o600 });
chmodSync(file, 0o600);

console.log('Created:      ' + file + '  (mode 600, outside the repo)');
console.log('Public addr:  ' + address);
console.log('Key NOT printed. To copy it for Vercel, run:  cat ' + file);
