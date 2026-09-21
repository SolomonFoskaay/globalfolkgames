GlobalFolkGames BS — placeholder files

Every file listed here is intentionally empty of logic. It exists only so Step 2 onward has a
known home. Do NOT add logic to any of these without the owner's per-step approval.

src/SessionState.sol        - Step 2: accept signed session events; sequence numbers; digest
src/Randomness.sol          - Step 3: commit-reveal seed(s); derive hash(seed, counter)
src/BatchWindow.sol         - Step 3: Merkle root per window; per-session proof
src/ParticipantAccount.sol  - Step 4: ONE account per player; append-only value slots (PlayerCore law)
src/FeeVault.sol            - Step 4: rail fee collection; configurable destination / escrow
src/verifiers/LudoVerifier.sol - Step 5: the Ludo referee (replays moves; decides a dispute)
test/                       - Foundry tests, written alongside each step
packages/sdk/               - @globalfolkgames/bs-sdk (built once the contracts are stable)
packages/contracts/         - @globalfolkgames/bs-contracts (interfaces + deployed addresses)

Build order and the two laws (no game concepts; one account per player) are in ../README.md
and ../../docs/globalfolkgames-bs-spec.md.
