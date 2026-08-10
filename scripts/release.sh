#!/usr/bin/env bash
set -euo pipefail

# Cut a release: bump the version across all manifests, then land the bump on
# main via a PR (main is protected against direct pushes) and tag the merged
# tip. The tag push triggers .github/workflows/release.yml, which builds and
# attaches the bundles. Assumes feature commits are already on main.
#
# Requires the gh CLI (authenticated) to open and merge the release PR.
#
# Usage: scripts/release.sh <patch|minor|major|X.Y.Z>

cd "$(dirname "$0")/.."

bump="${1:-}"
[[ -n "$bump" ]] || { echo "usage: $0 <patch|minor|major|X.Y.Z>" >&2; exit 1; }

# In-place file edit that works with both BSD (macOS) and GNU (Linux) sed:
# write through a temp file instead of relying on `sed -i`'s flavor-specific
# argument. The `s///` substitution syntax itself is identical across both.
replace_in() {
  local file="$1" expr="$2" tmp
  tmp=$(mktemp)
  sed "$expr" "$file" >"$tmp" && mv "$tmp" "$file"
}

# Preconditions — fail loudly before touching anything.
branch=$(git symbolic-ref --short HEAD)
[[ "$branch" == "main" ]]                    || { echo "error: not on main (on $branch)" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]]         || { echo "error: working tree not clean" >&2; exit 1; }
command -v gh >/dev/null                      || { echo "error: gh CLI not found (needed to open/merge the release PR)" >&2; exit 1; }
git fetch -q origin main
[[ -z "$(git rev-list HEAD..origin/main)" ]] || { echo "error: behind origin/main — pull first" >&2; exit 1; }

current=$(node -p "require('./package.json').version")

# Resolve the new version from a keyword or an explicit X.Y.Z.
if [[ "$bump" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  new="$bump"
else
  IFS=. read -r maj min pat <<<"$current"
  case "$bump" in
    major) new="$((maj + 1)).0.0" ;;
    minor) new="$maj.$((min + 1)).0" ;;
    patch) new="$maj.$min.$((pat + 1))" ;;
    *) echo "error: bump must be patch|minor|major|X.Y.Z" >&2; exit 1 ;;
  esac
fi

echo "Releasing v$new (from v$current)"

# Bump the three manifests; let each lockfile rewrite from the new manifest
# (cargo metadata for Cargo.lock, npm --package-lock-only for package-lock.json)
# so neither drifts and `npm ci` in CI stays happy.
replace_in package.json              "s/\"version\": \"$current\"/\"version\": \"$new\"/"
replace_in src-tauri/tauri.conf.json "s/\"version\": \"$current\"/\"version\": \"$new\"/"
replace_in src-tauri/Cargo.toml      "s/^version = \"$current\"/version = \"$new\"/"
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 >/dev/null
npm install --package-lock-only --silent

npm run typecheck   # cheap sanity gate before we tag

# main is protected against direct pushes (changes must land via a PR), so put
# the bump on a release branch, open a PR, and merge it — then fast-forward
# local main to the merged tip and tag *that* (its tree equals the bump commit).
relbranch="release-v$new"
git switch -c "$relbranch"
git commit -aqm "Release v$new"
git push -q -u origin "$relbranch"

gh pr create --base main --head "$relbranch" \
  --title "Release v$new" \
  --body "Version bump to v$new across all manifests. Tag v$new is pushed on the merged tip to trigger the release build."

# Mergeability can lag a moment after the PR is created; retry briefly.
merged=
for i in 1 2 3 4 5; do
  if gh pr merge "$relbranch" --merge --delete-branch; then merged=1; break; fi
  echo "PR not mergeable yet (attempt $i/5); retrying in 5s…" >&2
  sleep 5
done
[[ -n "$merged" ]] || { echo "error: could not merge $relbranch — merge it manually, then: git switch main && git pull && git tag v$new && git push origin v$new" >&2; exit 1; }

# Fast-forward local main to the merged tip and tag it.
git switch main
git fetch -q origin main
git merge -q --ff-only origin/main
git branch -qD "$relbranch" 2>/dev/null || true
git tag "v$new"
git push origin "v$new"

echo "Pushed v$new → https://github.com/Ed-Barnes937/CC-GUI/actions/workflows/release.yml"
