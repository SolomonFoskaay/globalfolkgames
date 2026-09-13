# Open-sourcing GlobalFolkGames (history-preserving)

This folder holds the safe, non-destructive way to publish the code.

## The rule

The **private repo keeps everything, forever.** The **public repo keeps every
commit, message, date and author** (the months of real work are the proof), but
a small set of internal-only files is removed from the published history.

We never rewrite the private repo and we never silently delete anything.

## What gets removed

See `private-paths.txt`. In short:

- the unfixed-weakness and anti-abuse playbook (`security-queue.md`)
- internal strategy and launch runbooks
- internal agent process docs (`AGENTS.md`, `.opencode/`)

Everything else ships: the games, the on-chain program, the ER/gasless SDK,
the universal modules, the relay, the public pages. Only files that are NOT
served to the live site are removed, so the public repo still builds exactly
like production.

## How to run the export

```bash
pip install git-filter-repo      # once
bash scripts/opensource/export-public.sh /path/to/globalfolkgames-public
```

It clones the private repo to a scratch directory, strips only the listed
paths from every commit, and leaves a ready-to-push tree. It never touches the
private repo.

Then create a **new** public GitHub repo and push the export to it. Do not flip
the private repo's visibility in place: that would publish the stripped files
from history with no way back.

## Secrets

No private key, seed phrase, `.env`, or keypair was ever committed (verified
across the full history). A public key or program id is not a secret. The only
thing that must stay private is the actual key material, which lives in env and
local keypair files that are gitignored.
