// @foskaay/ggi-contracts-sdk — deployed addresses, testnet + mainnet.
//
// This is the runtime source. addresses.json holds the same values for tooling
// that prefers JSON; keep the two in sync (addresses.json is the canonical copy
// written by the deploy script).
//
// Note: the data is declared as a plain object (not a JSON import) so it works
// in every bundler and Node version without import-assertion syntax.

export const addresses = {
  note: 'PUBLIC deployed addresses for Foskaay Gasless Games Infrastructure (Foskaay GGI). Addresses and endpoints only, safe to serve. Never put secrets here.',
  testnet: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    usdcDecimals: 6,
    contracts: {
      SessionRegistry: '0x5165809149Be8A72c72EedBa6a13d57014Ba1bE5',
      SessionState: '0x34945e897Ec9a5CC4ab41d78c8ABe3B5034C5c8e',
      Randomness: '0x6DD15cf4d4E2D29dd4AA871d6fd012221212B38b',
      FeeVault: '0x4cf542791faeb683f878bd3d119683e0C02F9905',
      BatchedSettlement: '0x5831E31789cAD85Dd263Ec78D73D8289FDc523c4',
    },
    upgradeable: true,
    pattern: 'UUPS proxies (ERC1967). These addresses are permanent: an upgrade swaps the logic behind them and never moves the address or strands data.',
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
