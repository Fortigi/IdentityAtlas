#!/usr/bin/env bash
# Makes a failed SCHEDULED workflow visible: opens a GitHub issue for it, or adds
# a comment to the one already open. Nobody watches a weekly job's run list — the
# JS and PowerShell mutation workflows failed every Monday for weeks while the
# docs page kept showing their last good scores.
#
# One open issue per workflow (matched by exact title), so a job that keeps
# failing builds one thread of runs instead of a pile of duplicates. Closing the
# issue once the workflow is green again is left to a human on purpose: that is
# the moment someone confirms the scores are trustworthy again.
#
# Usage: scheduled_failure_issue.sh <workflow-name> <run-url>
# Needs: gh (authenticated with `issues: write`), GITHUB_REPOSITORY.
set -euo pipefail

workflow="${1:?usage: scheduled_failure_issue.sh <workflow-name> <run-url>}"
run_url="${2:?usage: scheduled_failure_issue.sh <workflow-name> <run-url>}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
title="Scheduled workflow failing: $workflow"

existing="$(gh issue list --repo "$repo" --state open --search "\"$title\" in:title" \
  --json number,title --jq "[.[] | select(.title == \"$title\")][0].number // empty")"

body="The scheduled run failed: $run_url

Until this is fixed, whatever this workflow publishes is stale. Close this issue once a run passes again."

if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$repo" --body "Failed again: $run_url"
  echo "Commented on #$existing"
else
  gh issue create --repo "$repo" --title "$title" --body "$body"
fi
