// @foskaay/ggi-sdk address source. Reads the one JSON source of truth and exports
// it as a plain object, so the SDK works in every bundler and Node version.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const addresses = JSON.parse(readFileSync(join(here, 'addresses.json'), 'utf8'));

export default addresses;
