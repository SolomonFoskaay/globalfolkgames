# @foskaay/ggi-contracts

Solidity interfaces and the **published deployed addresses** for Foskaay Gasless
Games Infrastructure (GGI), for any game that calls the rail directly from its
own contract.

- Overview: **/foskaay-ggi-docs**
- The JS client that does the calls for you: `@foskaay/ggi-sdk`

---

## Interfaces

```solidity
import {ISessionRegistry, ISessionState, IRandomness, IFeeVault} from "@foskaay/ggi-contracts/src/IGgi.sol";
```

The four core contracts, and nothing else:

| Interface | Responsibility |
|---|---|
| `ISessionRegistry` | open/close a session; participant authorities; session keys (scope + expiry) |
| `ISessionState` | accept signed session events (opaque payload + sequence + digest) |
| `IRandomness` | commit-reveal seed(s); derive `hash(seed, counter)` |
| `IFeeVault` | per-session fee; configurable destination |

---

## Deployed addresses (testnet and mainnet, same format)

```js
import { testnet, mainnet, forChain } from '@foskaay/ggi-contracts';

testnet.contracts.SessionRegistry;   // Arc Testnet  (chain id 5042002)
mainnet.contracts.SessionRegistry;   // Arc Mainnet  (chain id 5042) - null until deployed
forChain(5042002).contracts.FeeVault;
```

The full data lives in `deployments/addresses.json`. It is the single source of
truth for addresses; the SDK reads the same file, so the two can never disagree.

### Current status

| Network | Chain id | Status |
|---|---|---|
| Arc Testnet | 5042002 | Deployed |
| Arc Mainnet | 5042 | Not deployed yet (testnet first) |

Mainnet addresses will appear in the same shape once deployment is done. Nothing
in the SDK hardcodes an address, so switching networks is one setting.

---

## License

MIT
