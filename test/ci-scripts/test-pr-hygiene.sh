#!/usr/bin/env bash
# Unit tests for .github/scripts/pr_hygiene.sh, the PR Hygiene gate.
#
# The regression this guards (review item A13): any changed test satisfied
# "tests added", so touching an unrelated test let an untested change through.
# Each rule that relates a test to the code gets a case that meets it and a
# near-miss that must not.
#
# Usage: bash test/ci-scripts/test-pr-hygiene.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/pr_hygiene.sh"

PASS=0
FAIL=0
assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"; echo "        expected: $expected"; echo "        actual:   $actual"; FAIL=$((FAIL + 1))
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/changes"
printf -- '- Fixed a thing\n' > "$TMP/changes/ok.md"
printf 'just prose\n' > "$TMP/changes/empty.md"

# gate <SKIP_HYGIENE> <paths...> -> exit code in CODE, output in OUT
gate() {
  local skip="$1"; shift
  set +e
  OUT="$(cd "$TMP" && printf '%s\n' "$@" | SKIP_HYGIENE="$skip" bash "$SCRIPT" 2>&1)"
  CODE=$?
  set -e
}
verdict() { gate false "$@"; echo "$CODE"; }
F=changes/ok.md

echo "a test about the code"
assert "same name"                       0 "$(verdict app/api/src/lib/foo.js app/api/src/lib/foo.test.js $F)"
assert "first-dot stem (helpers ~ mount)" 0 "$(verdict app/ui/src/c/PeoplePicker.helpers.js app/ui/src/c/PeoplePicker.mount.test.jsx $F)"
assert "PowerShell phases ~ Pester file" 0 "$(verdict tools/crawlers/entra-id/EntraIDCrawler.Phases.ps1 test/unit/EntraIDCrawlerPhases.Tests.ps1 $F)"
assert "contract test elsewhere"         0 "$(verdict app/api/src/lib/crawlerJobQueue.js app/api/contract-tests/crawlerJobQueue.contract.test.js $F)"
assert "name contained (6+ chars)"       0 "$(verdict app/api/src/routes/recentChanges/timeline.js app/api/contract-tests/userTimelineSoftDelete.contract.test.js $F)"
assert "...either way round"             0 "$(verdict app/api/src/lib/principalActivity.js app/api/src/reports/activity.test.js $F)"
assert "punctuation ignored"             0 "$(verdict app/api/src/lib/access-review-adoption.js app/api/src/lib/accessReviewAdoption.test.js $F)"
assert "case ignored"                    0 "$(verdict tools/crawlers/foo/Start-FooCrawler.ps1 test/unit/start-foocrawler.Tests.ps1 $F)"
assert "whole name when the stem is short" 0 "$(verdict app/api/src/routes/users.helpers.js app/api/src/routes/usersHelpers.test.js $F)"
assert "test named after the folder"     0 "$(verdict app/api/src/routes/crawlers/selfService.js app/api/src/routes/crawlers.routes.test.js $F)"
assert "one related pair is enough"      0 "$(verdict app/api/src/a/alpha.js app/api/src/b/bravo.js app/api/src/b/bravo.test.js $F)"
gate false app/api/src/lib/foo.js app/api/src/lib/foo.test.js $F
assert "names the pair it accepted"      yes "$(grep -q 'Test for the change: app/api/src/lib/foo.js ~ app/api/src/lib/foo.test.js (name)' <<<"$OUT" && echo yes || echo no)"

echo "an unrelated test"
assert "different name, different folder" 1 "$(verdict app/api/src/lib/foo.js app/api/src/routes/bar.test.js $F)"
assert "same folder alone is not enough"  1 "$(verdict app/api/src/routes/admin.js app/api/src/routes/openapi.drift.test.js $F)"
assert "a short name is not contained"    1 "$(verdict app/api/src/lib/index.js app/api/src/lib/reindexer.test.js $F)"
assert "6 chars contained, 5 not: model"  1 "$(verdict app/api/src/x/model.js app/api/src/y/modeler.test.js $F)"
assert "a UI change is not tested by an API test" 1 "$(verdict app/ui/src/components/reports/Report.jsx app/api/src/reports/Report.test.js $F)"
gate false app/api/src/lib/foo.js app/api/src/routes/bar.test.js $F
assert "says which code had no test"     yes "$(grep -q 'none is about the code that changed.*app/api/src/lib/foo.js' <<<"$OUT" && echo yes || echo no)"

echo "the rest of the gate"
assert "code with no test at all"        1 "$(verdict app/api/src/lib/foo.js $F)"
assert "no fragment"                     1 "$(verdict app/api/src/lib/foo.js app/api/src/lib/foo.test.js)"
assert "a fragment with no bullet"       1 "$(verdict app/api/src/lib/foo.js app/api/src/lib/foo.test.js changes/empty.md)"
assert "docs only needs nothing"         0 "$(verdict docs/x.md)"
assert "a Pester file is a test, not code" 0 "$(verdict tools/pester/Foo.Tests.ps1)"
assert "an integration harness tests itself" 0 "$(verdict tools/crawlers/scim/Test-ScimCrawler.ps1 $F)"
gate true app/api/src/lib/foo.js app/api/src/routes/bar.test.js
assert "skip-hygiene passes"             0 "$CODE"
assert "...and records what it waived"   yes "$(grep -q "BYPASSED via the 'skip-hygiene' label" <<<"$OUT" && grep -q 'none is about the code' <<<"$OUT" && echo yes || echo no)"

echo
echo "pr-hygiene: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
