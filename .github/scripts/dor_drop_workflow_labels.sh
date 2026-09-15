#!/usr/bin/env bash
# Clear every in-flight DoR label from an issue that has reached its terminal state. Called by
# dor-reset.yml when a dor/issue-N PR is merged or closed.
#
# Every one of these is false once the PR is gone. `build-done` is the one that matters: dor-acceptance
# GATES on it, so a shipped issue keeps advertising itself as awaiting functional acceptance and a
# stray comment can still wake the feedback loop. `needs-triage` left over from an Exceptions bail that
# was later resolved makes finished work show up in triage sweeps (#927, #928).
#
# ONE label per call, and only labels the issue actually carries. This used to be a single
# `gh issue edit --remove-label "a,b,c,…"`, and gh rejects the WHOLE call when any name in the list
# does not exist in the repo. `dor-retry` joined the list (#1170) before any issue had ever needed it,
# so no such label existed, every cleanup failed, and `|| true` hid it: every issue merged from
# 2026-09-12 on kept its labels (#1212 still read `state:awaiting-approval` after it shipped).
#
#   Usage: REPO=owner/repo GH_TOKEN=… dor_drop_workflow_labels.sh <issue>
set -uo pipefail

ISSUE="${1:?usage: dor_drop_workflow_labels.sh <issue>}"
REPO="${REPO:?REPO is required}"

WORKFLOW_LABELS="build-done needs-triage ready-to-build dor-stuck dor-retry dor-paused
  state:awaiting-approval state:awaiting-requestor state:awaiting-design state:ready-to-probe
  state:decompose state:blocked-external"

if ! carried="$(gh issue view "$ISSUE" --repo "$REPO" --json labels --jq '.labels[].name' 2>/dev/null)"; then
  echo "::warning::could not read #$ISSUE's labels — its workflow labels were left in place"
  exit 0
fi

for label in $WORKFLOW_LABELS; do
  printf '%s\n' "$carried" | grep -qxF "$label" || continue
  if gh issue edit "$ISSUE" --repo "$REPO" --remove-label "$label" >/dev/null 2>&1; then
    echo "removed $label from #$ISSUE"
  else
    echo "::warning::could not remove $label from #$ISSUE"
  fi
done
exit 0
