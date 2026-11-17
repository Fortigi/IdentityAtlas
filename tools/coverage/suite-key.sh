#!/usr/bin/env bash
# Prints the content key of one coverage suite at a commit: a hash of the git
# tree of every path that can change that suite's coverage — its source, its
# tests, its lockfile, its config.
#
# PR Checks names each suite's uploaded coverage after this key; the post-merge
# docs publisher (coverage.yml) computes the key for main and, when an artifact
# with that exact name exists, publishes it instead of running the suite again.
# Same key = byte-identical inputs = the same coverage, so reuse can never
# publish numbers for different code. Anything else falls back to running it.
#
# Deliberately NOT in any key: docs/ (coverage.yml commits into docs/ on every
# merge, so a key containing it would never match), and the workflow files
# (both workflows run the same npm scripts; a change to HOW a suite runs belongs
# in the scripts/config, which ARE keyed).
#
# Usage: suite-key.sh <api-unit|api-contract|ui> [rev]   (rev defaults to HEAD)
set -euo pipefail

suite="${1:?usage: suite-key.sh <api-unit|api-contract|ui> [rev]}"
rev="${2:-HEAD}"
VERSION=1   # bump to invalidate every stored key (e.g. if the artifact layout changes)

case "$suite" in
  # The API unit suite also runs the desktop worker, scale-dataset, iiq-fixture
  # and crawler discover/configValidation tests, and reads the ontology and the
  # crawler manifests (see app/api/vitest.config.js `include`).
  api-unit)     paths="app/api ontology app/desktop tools/scale-dataset tools/iiq-fixture tools/crawlers" ;;
  # Contract tests run the real app (which loads crawler manifests) on real SQL.
  api-contract) paths="app/api ontology tools/crawlers" ;;
  # UI suite: app/ui plus the crawler wizards and their tests under tools/crawlers.
  ui)           paths="app/ui tools/crawlers" ;;
  *) echo "suite-key.sh: unknown suite '$suite'" >&2; exit 2 ;;
esac

{
  echo "v$VERSION $suite"
  for p in $paths; do
    # The tree hash of the path at <rev>, or a marker when it does not exist.
    printf '%s %s\n' "$p" "$(git rev-parse --verify --quiet "$rev:$p" || echo missing)"
  done
} | sha256sum | cut -c1-20
