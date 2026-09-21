# Contract Addresses — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It is NON-NEGOTIABLE.

## The rule

**Whenever a contract address changes, the SAME commit must update every
occurrence of the old address across the project.** A stale address is a silent
outage: reads hit a dead contract, writes go nowhere, and the UI shows zeros.

## Where addresses live (update ALL of these)

1. `public/arc-config.json` — the SINGLE public source the site + relayer read.
2. `api_handlers/arc-relay.mjs` — the baked fallback object (used if the config
   file cannot be fetched server-side).
3. Any `dashboard/*.html` card that displays or links the address.
4. Any `scripts/*.mjs` that hardcodes the address (test/proof scripts).
5. `evm/README.md` — the deployed-address notes.
6. `public/changelog/architecture.json` module detail that names it.

## Contract archive (never lose an address)

Every contract ever deployed MUST be recorded in the Arc dashboard
`/dashboard/arc.html` **Contract archive** section, with: name, address, status
(active/superseded/retired), and a one-line reason. When you replace a contract:

- Mark the old one `superseded` or `retired` with the date and reason.
- Add the new one as `active`.
- The **Contracts (Arc Testnet)** card shows ONLY active contracts, so it can
  never display something dead.

## Never

- Never leave an old address in code after a redeploy.
- Never point the active card at a contract that is no longer used.
- Never delete an archived address: the archive is the memory of the project.

## Grep check before commit

Run a search for every previously known address and confirm each hit is either
the current one or intentionally inside the archive/history:

```
grep -rn "0x<oldAddress>" --include=*.js --include=*.json --include=*.html --include=*.mjs .
```

If an old address appears outside `public/changelog/tests.json` (historical
evidence) or the dashboard archive, STOP and fix it before committing.
