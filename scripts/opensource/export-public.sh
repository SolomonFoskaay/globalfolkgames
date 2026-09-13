#!/usr/bin/env bash
# Build a PUBLIC, history-preserving export of this repo.
#
# What it does:
#   1. Clones this repo to a scratch dir (never touches the private repo).
#   2. Runs git-filter-repo to REMOVE only the internal paths listed in
#      private-paths.txt from every commit.
#   3. Leaves a clean tree at $OUT ready to push to the public GitHub repo.
#
# History is preserved: every commit, message, date and author remains, so the
# public repo still shows the project was built over months. Only the file
# blobs listed in private-paths.txt are removed. Commit hashes change (that is
# unavoidable when removing file content), so the public hashes differ from the
# private ones by design.
#
# Requirements: git-filter-repo (pip install git-filter-repo)
# Usage:        bash scripts/opensource/export-public.sh [output-dir]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATHS_FILE="$REPO_ROOT/scripts/opensource/private-paths.txt"
OUT="${1:-$REPO_ROOT/../globalfolkgames-public}"

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "ERROR: git-filter-repo is not installed."
  echo "Install it with:  pip install git-filter-repo"
  echo "  (or: pipx install git-filter-repo)"
  exit 1
fi

if [ -e "$OUT" ]; then
  echo "ERROR: output path already exists: $OUT"
  echo "Remove it or pass a different output dir."
  exit 1
fi

echo "==> Cloning private repo to $OUT (no origin copied)"
git clone --no-local --no-hardlinks "$REPO_ROOT" "$OUT" >/dev/null

echo "==> Stripping internal-only paths from the full history"
git -C "$OUT" filter-repo --force --invert-paths --paths-from-file "$PATHS_FILE"

echo ""
echo "==> Done. Public export ready at: $OUT"
echo ""
echo "Next steps (create a NEW public GitHub repo, do NOT flip the private one):"
echo "  1. cd \"$OUT\""
echo "  2. git remote add origin git@github.com:<you>/globalfolkgames.git"
echo "  3. git push -u origin main"
echo ""
echo "Then point your Vercel production deployment at the public repo, or keep"
echo "deploying the live site from the private repo and let the public repo be"
echo "the community copy. Verify the live site still builds before announcing."
