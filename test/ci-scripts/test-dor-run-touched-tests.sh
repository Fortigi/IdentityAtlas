#!/usr/bin/env bash
# Unit tests for run_touched_tests (.github/scripts/dor_build_lib.sh) — the step that decides whether
# a DoR build's regression test is red before the fix and green after it.
#
# The regression: the touched .Tests.ps1 files were joined with SPACES and handed to
# `Invoke-Pester -Path $ps -CI`. -Path takes one value, so with two Pester files the second became a
# stray positional and Pester refused the call without running anything:
#
#     Invoke-Pester: A positional parameter cannot be found that accepts argument
#     'test/unit/EntraIDCrawlerPhases.Tests.ps1'.
#
# The flow reads any non-zero exit as "the fix does not make the regression test pass", so #1216 went
# to Exceptions with a correct fix. It hid until 2026-09-14 because the build pool had no pwsh before.
#
# Real git against a throwaway repo. `pwsh` is a stub on PATH for the argument-shape checks; the
# end-to-end check uses the real pwsh + Pester when this box has them, and says so when it does not.
#
# Usage: bash test/ci-scripts/test-dor-run-touched-tests.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/.github/scripts/dor_build_lib.sh"

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

# ── A repo whose last commit touches two Pester files ───────────────────────
WORK="$TMP/work"
git init --quiet "$WORK"
git -C "$WORK" config user.email t@example.com
git -C "$WORK" config user.name  Test
git -C "$WORK" config core.autocrlf false
echo base > "$WORK/README"; git -C "$WORK" add README; git -C "$WORK" commit --quiet -m base
mkdir -p "$WORK/test/unit"
write_test() {  # $1 = file, $2 = PowerShell boolean the single It asserts
  printf "Describe '%s' { It 'holds' { %s | Should -BeTrue } }\n" "$(basename "$1")" "$2" > "$WORK/$1"
}
write_test test/unit/Alpha.Tests.ps1 '$true'
write_test test/unit/Beta.Tests.ps1  '$true'
git -C "$WORK" add test; git -C "$WORK" commit --quiet -m tests
RANGE="HEAD~1..HEAD"

export ISSUE=1216 REPO=Fortigi/IdentityAtlas WORK
export URL=https://example.invalid HOST=sk-test GH_TOKEN=stub BOARD_TOKEN=stub-token
# shellcheck source=/dev/null
source "$LIB"

echo "DoR build side — run_touched_tests and the Pester path list"
echo

# ── 1. The list itself ──────────────────────────────────────────────────────
assert "one path becomes one quoted element" "'a.Tests.ps1'" \
  "$(printf 'a.Tests.ps1\n' | pester_path_list)"
assert "two paths become a comma-separated array, not two arguments" "'a.Tests.ps1','b.Tests.ps1'" \
  "$(printf 'a.Tests.ps1\nb.Tests.ps1\n' | pester_path_list)"
assert "a single quote in a path is doubled, not left to end the literal" "'it''s.Tests.ps1'" \
  "$(printf "it's.Tests.ps1\n" | pester_path_list)"
assert "blank lines add no empty element" "'a.Tests.ps1'" \
  "$(printf '\na.Tests.ps1\n\n' | pester_path_list)"

# ── 2. What pwsh is actually asked to run ───────────────────────────────────
# A stub records the -Command it receives. Both touched files must reach -Path as ONE array.
STUB="$TMP/stub-bin"; mkdir -p "$STUB"
cat > "$STUB/pwsh" <<EOF
#!/usr/bin/env bash
printf '%s' "\$3" > "$TMP/pwsh-command"
EOF
chmod +x "$STUB/pwsh"
rc=0; PATH="$STUB:$PATH" run_touched_tests "$RANGE" || rc=$?
assert "with a passing stub, the run reports all passed" 0 "$rc"
assert "Invoke-Pester gets both files as a single -Path array" \
  "Invoke-Pester -Path 'test/unit/Alpha.Tests.ps1','test/unit/Beta.Tests.ps1' -CI" \
  "$(cat "$TMP/pwsh-command")"

# ── 3. End to end, against the real Pester ──────────────────────────────────
# The assertion that discriminates: the unfixed library fails check (a) with a parameter-binding
# error even though both tests pass. (b) keeps the fix from turning every run green.
if command -v pwsh >/dev/null 2>&1 \
   && pwsh -NoProfile -Command 'if (Get-Module -ListAvailable Pester | Where-Object { $_.Version.Major -ge 5 }) { exit 0 } else { exit 1 }' >/dev/null 2>&1; then
  rc=0; run_touched_tests "$RANGE" || rc=$?
  assert "(a) two passing Pester files: the run passes" 0 "$rc"
  assert "(a) …and Pester did not refuse the call" no \
    "$(grep -q 'positional parameter' /tmp/unit.log && echo yes || echo no)"

  write_test test/unit/Beta.Tests.ps1 '$false'
  git -C "$WORK" commit --quiet -am 'break beta'
  rc=0; run_touched_tests "HEAD~2..HEAD" || rc=$?
  assert "(b) one failing Pester file among two: the run fails" 1 "$rc"
else
  echo "  SKIP  real-Pester checks: no pwsh with Pester 5+ on this box"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
