#!/usr/bin/env bash
# Print the stable release tag that the tag being cut FOLLOWS — the baseline for
# a release's changelog slice, its "Full Changelog" link and its dependency
# delta. Prints nothing when there is no earlier stable release.
#
# Usage:  bash .github/scripts/release_prev_tag.sh v5.10.1
#
# Why this is shared rather than inline in each workflow: cut-release.yml and
# cut-hotfix.yml each grew their own version of it, and they disagreed.
#
#   * cut-release took the GLOBALLY latest stable tag. Correct while releases
#     only ever move forward from main, but wrong the moment a maintained
#     release line exists: cutting 5.10.1 from release/5.10 after main has
#     already tagged v5.11.0 would diff against v5.11.0 and describe the patch
#     as removing every feature in 5.11.
#   * cut-hotfix scoped the search to the same major.minor series (v5.10.*).
#     Right for a patch, but it finds nothing when the tag being cut is the
#     first of its series, and an empty baseline silently drops the changelog
#     slice and the Full Changelog link.
#
# One rule covers both: the highest stable tag STRICTLY BELOW the version being
# cut. For 5.10.1 that is v5.10.0 even when v5.11.0 exists; for a fresh 5.10.0
# it falls back to v5.9.1; for the very first release it is empty.
#
# Pre-releases are never a baseline — a beta is a snapshot on the way to the
# stable it precedes, so diffing against one would report a subset of the work.
set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: $0 <tag-being-cut>" >&2
  exit 2
fi

# The tag being cut is normally already created by the time this runs; adding it
# here and de-duplicating means the ordering works either way.
{
  git tag --list 'v*' | grep -vE 'beta|rc|alpha' || true
  printf '%s\n' "$TAG"
} | sort -V -u | grep -F -x -B1 "$TAG" | head -1 | grep -F -x -v "$TAG" || true
