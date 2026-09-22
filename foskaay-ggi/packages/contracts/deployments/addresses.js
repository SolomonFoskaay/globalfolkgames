// @foskaay/ggi-contracts — deployed addresses, testnet + mainnet.
//
// This is the runtime source. addresses.json holds the same values for tooling
// that prefers JSON; keep the two in sync (addresses.json is the canonical copy
// written by the deploy script).
//
// Note: the data is declared as a plain object (not a JSON import) so it works
// in every bundler and Node version without import-assertion syntax.

export const addresses = {
  note: 'PUBLIC deployed addresses for Foskaay Gasless Games Infrastructure (GGI). Addresses and endpoints only, safe to serve. Never put secrets here.',
  testnet: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    usdcDecimals: 6,
    contracts: {
      SessionRegistry: '0x46A34743e8210F5C8C574b7CbEe1C1cb5Ca63bE5',
      SessionState: '0xf464d11660bFC091481D2D688FeaD97447f69E43',
      Randomness: '0x50CD0A75ca6412f751BEb6E7E4d48da2D5aea6Db',
      FeeVault: '0xDf400D629425289229eE563A1460137139FAd6bd',
    },
    deployedAt: '2026-09-22',
  },
  mainnet: {
    name: 'Arc Mainnet',
    chainId: 5042,
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    usdcDecimals: 6,
    contracts: {
      SessionRegistry: null,
      SessionState: null,
      Randomness: null,
      FeeVault: null,
    },
    deployedAt: null,
    note: 'Not deployed yet. Testnet first. Addresses appear here in the same format once deployed.',
  },
};

export default addresses;
