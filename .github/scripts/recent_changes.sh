#!/usr/bin/env bash
# What changed on the checked-out branch since a point in time: the nightly docs and
# test-coverage reviews hand this to Claude as "the last 24 hours".
#
# Writes <out-dir>/recent_commits.txt (one "- <sha> <subject>" per non-merge commit)
# and <out-dir>/changed_files.txt (paths changed since <since>).
#
# Exit codes:
#   0  commits found, files listed
#   3  no commits since <since>: nothing to review
#   1  commits found but no changed files: the diff is broken, fail loudly
#
# Why not `git diff HEAD@{24 hours ago} HEAD`: that is a REFLOG lookup, and a fresh
# CI checkout has a one-entry reflog. Git answers with that entry — HEAD itself —
# so the diff was empty on every run and both reviews skipped every night as "only
# non-source files changed". The base here comes from commit history instead: the
# newest commit made before <since>.
#
# Usage: recent_changes.sh <since (anything git --since accepts)> <out-dir>
set -euo pipefail

since="${1:?usage: recent_changes.sh <since> <out-dir>}"
out="${2:?usage: recent_changes.sh <since> <out-dir>}"
mkdir -p "$out"

git log --since="$since" --pretty=format:"- %h %s" --no-merges HEAD > "$out/recent_commits.txt"
if [ ! -s "$out/recent_commits.txt" ]; then
  : > "$out/changed_files.txt"
  echo "No commits since $since — nothing to review"
  exit 3
fi

base="$(git rev-list -1 --before="$since" HEAD)"
if [ -z "$base" ]; then
  # Every commit is inside the window: diff against the empty tree.
  base="$(git hash-object -t tree /dev/null)"
fi
git diff --name-only "$base" HEAD > "$out/changed_files.txt"

if [ ! -s "$out/changed_files.txt" ]; then
  echo "::error::Found commits since $since but no changed files against base $base — the diff is broken, not empty."
  exit 1
fi
echo "Commits since $since: $(grep -c '' "$out/recent_commits.txt"); files changed since ${base:0:12}: $(grep -c '' "$out/changed_files.txt")"
