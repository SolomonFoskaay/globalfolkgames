// @foskaay/ggi-contracts — deployed addresses, testnet + mainnet.
//
// Usage:
//   const { testnet, mainnet, forChain } = require('@foskaay/ggi-contracts');
//   const addrs = forChain(5042002).contracts.SessionRegistry;
const addresses = require('./addresses.json');

module.exports = {
  all: addresses,
  testnet: addresses.testnet,
  mainnet: addresses.mainnet,
  forChain(chainId) {
    const id = Number(chainId);
    if (id === addresses.testnet.chainId) return addresses.testnet;
    if (id === addresses.mainnet.chainId) return addresses.mainnet;
    throw new Error('GGI: no deployment for chain id ' + id);
  },
  isDeployed(chainId, contractName) {
    try {
      const net = module.exports.forChain(chainId);
      return Boolean(net.contracts[contractName]);
    } catch (_) {
      return false;
    }
  },
};
