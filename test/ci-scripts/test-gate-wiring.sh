#!/usr/bin/env bash
# Asserts that every check which LOOKS like a gate actually is one.
#
# Branch protection requires exactly three contexts — "PR Summary", "CI Passed" and
# "Integration CI Passed" — so a job only gates if it is aggregated into one of the two
# rollups. Four workflows were named "… gate" and required by nothing: diff coverage,
# migration immutability, node version and PowerShell mutation. `CLAUDE.md` described the first
# as a gate; branch protection did not.
#
# They could not simply be added to the required set either: all four filtered on `paths:` at the
# WORKFLOW level, and GitHub leaves a required check that never reports permanently pending — so
# requiring them would have blocked every PR that missed those paths. That is the whole reason
# `pr.yml` has no top-level `paths:` and gates its JOBS instead: one always-reporting rollup can
# then stand for all of them.
#
# So the invariant is structural, and this test pins it:
#   1. every job in pr.yml / pr-integration.yml is aggregated into that file's rollup;
#   2. every workflow that runs on `pull_request` is either one of those two, or is on the
#      allow-list below with a stated reason.
#
# Adding a gate in a new workflow now fails here until someone decides, in review, whether it
# gates. Nothing depends on remembering to update `needs:`.
#
# Deliberately dependency-free (awk/grep, no PyYAML) — the runner guarantees neither.
#
# Usage: bash test/ci-scripts/test-gate-wiring.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WF="$REPO_ROOT/.github/workflows"

PASS=0
FAIL=0

assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"
    echo "        expected: $expected"
    echo "        actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# Top-level job keys: two-space-indented `name:` lines inside the `jobs:` block.
jobs_in() { awk '/^jobs:/{j=1;next} j && /^  [a-z][a-z0-9_-]*:[[:space:]]*$/ {gsub(/[ :]/,""); print}' "$1"; }

# The `needs:` list of one job, in either the block form (`- a`) or the inline form (`[a, b]`).
needs_of() {  # $1 = file, $2 = job key
  awk -v job="  $2:" '
    $0 == job {injob=1; next}
    injob && /^  [a-z]/ {exit}
    injob && /^    needs:/ {
      if ($0 ~ /\[/) { line=$0; gsub(/.*\[|\].*/,"",line); gsub(/,/," ",line); print line; exit }
      inneeds=1; next
    }
    inneeds && /^      - / {gsub(/^      - /,""); print; next}
    inneeds && /^    [a-z]/ {exit}
  ' "$1" | tr ' ' '\n' | grep -v '^$' || true
}

# Jobs in $1 that are neither the rollup, nor excused, nor in the rollup`s needs.
unaggregated() {  # $1 = file, $2 = rollup job key, $3.. = excused job keys
  local file="$1" rollup="$2"; shift 2
  local excused=" $rollup $* "
  local needs; needs=" $(needs_of "$file" "$rollup" | tr '\n' ' ') "
  local job out=""
  while read -r job; do
    [ -n "$job" ] || continue
    case "$excused" in *" $job "*) continue ;; esac
    case "$needs"   in *" $job "*) continue ;; esac
    out="${out}${job} "
  done < <(jobs_in "$file")
  printf '%s' "${out% }"
}

echo "CI gate wiring"
echo

# ── 1. Everything in the two PR workflows is aggregated ─────────────────────
# `pr-summary` is excused because it IS a required context in its own right.
assert "every pr.yml job is aggregated into CI Passed" "" \
  "$(unaggregated "$WF/pr.yml" ci-passed pr-summary)"
assert "every pr-integration.yml job is aggregated into Integration CI Passed" "" \
  "$(unaggregated "$WF/pr-integration.yml" ci-integration-passed)"

# ── 2. No workflow gates a PR from outside those rollups ────────────────────
# Everything that runs on `pull_request` must be listed here. The two aggregated workflows, plus:
#
#   codeql.yml         enforced, but by the ruleset's `code_scanning` rule rather than by a
#                      required status check — which is why its check name must never be renamed.
#   bump-version.yml   acts on merge. Not a gate.
#   dor-deploy.yml     acts on a label. Not a gate.
#   dor-reset.yml      acts on close. Not a gate.
#   sbom-update.yml    acts on merge. Not a gate.
#   diff-coverage.yml  ADVISORY on purpose, for now. It cannot be made blocking while pure-JSX
#                      page shells produce expected reds: v8 does not line-instrument a big JSX
#                      `return`, so a routing or layout edit fails on a line no test can reach.
#                      `app/ui/CLAUDE.md` documents that red as expected, and the exclude set that
#                      would fix it is still open as #725. Only `*/App.jsx` is excluded today.
#                      Requiring it before then would block ordinary UI work. Move it into pr.yml
#                      and into ci-passed's `needs:` once #725 lands.
#
# Add a new PR-triggered workflow and this fails until it is either aggregated or added here with
# a reason. That decision is the point of the test.
ALLOWED="pr.yml pr-integration.yml codeql.yml bump-version.yml dor-deploy.yml dor-reset.yml sbom-update.yml diff-coverage.yml"
unlisted=""
for f in "$WF"/*.yml; do
  grep -qE '^[[:space:]]+pull_request:' "$f" || continue
  b="$(basename "$f")"
  case " $ALLOWED " in *" $b "*) continue ;; esac
  unlisted="${unlisted}${b} "
done
assert "no unlisted workflow runs on pull_request" "" "${unlisted% }"

# ── 3. The heavy weekly jobs stay off pull requests ─────────────────────────
# Mutation testing is far heavier than the unit suite. On PRs it could never be required (see the
# header), so it only ever looked like a gate. Derived over every *-mutation.yml, not listed by
# name: adding a mutation workflow for a third language inherits the rule instead of quietly
# skipping it. The glob must also match something — a rename would otherwise pass vacuously.
found=0
onprs=""
for f in "$WF"/*-mutation.yml; do
  [ -e "$f" ] || continue
  found=$((found + 1))
  grep -qE '^[[:space:]]+pull_request:' "$f" && onprs="${onprs}$(basename "$f") "
done
# Both mutation workflows must be found. Without this, renaming them to something the glob misses
# would make the check below pass over an empty list — green, and testing nothing.
assert "both mutation workflows are matched by the glob" "2" "$found"
assert "no mutation workflow runs on pull_request" "" "${onprs% }"

# ── 4. Anything that commits back to main must survive losing the race ──────
# Several workflows push to main off the SAME merge — bump-version and coverage both do, seconds
# apart. Whichever arrives second is rejected `(fetch first)`, and for bump-version that silently
# dropped a whole version bump: the run went red, the merge was already done, and nothing retried.
# A bare `git push` (no refspec — i.e. pushing the checked-out main) therefore has to be wrapped in
# a rebase-and-retry loop. Derived, not listed: add another one and this fails until it retries.
noretry=""
for f in "$WF"/*.yml; do
  grep -qE '^[[:space:]]*(if )?git push[[:space:]]*(;|then|$)' "$f" || continue
  grep -q 'pull --rebase' "$f" || noretry="${noretry}$(basename "$f") "
done
assert "every workflow that pushes main rebases and retries" "" "${noretry% }"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
