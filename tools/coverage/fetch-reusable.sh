#!/usr/bin/env bash
# Downloads the coverage file stored under an exact artifact name — one uploaded
# by any PR Checks run whose inputs hashed to the same key (see suite-key.sh) —
# into <dest-dir>. Exit 0 = reused; exit 1 = no usable artifact, run the suite.
#
# Never fails the caller on an API hiccup: anything unexpected is a miss, and a
# miss only costs the time of running the suite, never correctness.
#
# Usage: fetch-reusable.sh <artifact-name> <dest-dir>
# Needs: gh (authenticated, `actions: read`), GITHUB_REPOSITORY.
set -uo pipefail

name="${1:?usage: fetch-reusable.sh <artifact-name> <dest-dir>}"
dest="${2:?usage: fetch-reusable.sh <artifact-name> <dest-dir>}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

# Newest first; skip expired ones. The name already encodes the content, so any
# live match is as good as any other.
run_id="$(gh api "repos/$repo/actions/artifacts?name=$name&per_page=10" \
  --jq '[.artifacts[] | select(.expired == false)][0].workflow_run.id // empty' 2>/dev/null)"
if [ -z "$run_id" ]; then
  echo "reuse: no live artifact named $name"
  exit 1
fi

tmp="$(mktemp -d)"
if ! gh run download "$run_id" --repo "$repo" --name "$name" --dir "$tmp" >/dev/null 2>&1; then
  echo "reuse: found $name in run $run_id but could not download it"
  rm -rf "$tmp"; exit 1
fi
if [ ! -s "$tmp/lcov.info" ]; then
  echo "reuse: $name from run $run_id has no lcov.info"
  rm -rf "$tmp"; exit 1
fi
mkdir -p "$dest"
mv "$tmp/lcov.info" "$dest/lcov.info"
rm -rf "$tmp"
echo "reuse: $name <- run $run_id"
