#!/usr/bin/env bash
# Unit tests for the two scripts that keep the weekly mutation workflows honest:
#   .github/scripts/mutation_scopes.sh         — the JS matrix, derived from the configs
#   .github/scripts/scheduled_failure_issue.sh — a failed scheduled run opens an issue
#
# The regression behind both: js-mutation.yml listed 9 scopes by hand while 21
# configs existed, so its publish step failed every Monday — and so did
# ps-mutation.yml — for weeks, with nobody told and the docs page showing old scores.
#
# Usage: bash test/ci-scripts/test-mutation-scripts.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCOPES="$REPO_ROOT/.github/scripts/mutation_scopes.sh"
ALERT="$REPO_ROOT/.github/scripts/scheduled_failure_issue.sh"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; echo "       expected: $2"; echo "       actual:   $3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── mutation_scopes.sh ───────────────────────────────────────────────────────
echo "mutation_scopes.sh"
R="$WORK/repo"
mkdir -p "$R/app/api" "$R/app/ui"
for f in api/stryker.auth.config.json api/stryker.matrix.config.json ui/stryker.pilot.config.json \
         api/vitest.stryker.config.js api/stryker.conf.js; do
  echo '{}' > "$R/app/$f"
done

check "one entry per stryker.<name>.config.json, API before UI" \
  '[{"pkg":"api","name":"auth","label":"API auth","config":"stryker.auth.config.json"},{"pkg":"api","name":"matrix","label":"API matrix","config":"stryker.matrix.config.json"},{"pkg":"ui","name":"pilot","label":"UI pilot","config":"stryker.pilot.config.json"}]' \
  "$(bash "$SCOPES" "$R")"

echo '{}' > "$R/app/ui/stryker.roles.config.json"
check "a new config joins the matrix with no other edit" \
  4 "$(bash "$SCOPES" "$R" | grep -o '"name"' | wc -l | tr -d ' ')"

mkdir -p "$WORK/empty/app/api"
check "no configs gives an empty matrix, not invalid JSON" '[]' "$(bash "$SCOPES" "$WORK/empty")"

echo '{}' > "$R/app/api/stryker.bad\"name.config.json"
set +e; bash "$SCOPES" "$R" >/dev/null 2>&1; rc=$?; set -e
check "a config name that would break the JSON is refused (exit 2)" 2 "$rc"
rm "$R/app/api/stryker.bad\"name.config.json"

# The real repo: every config there is in the matrix, and every matrix entry can be
# run — the config file it names exists in its package.
real="$(bash "$SCOPES" "$REPO_ROOT")"
configs=$(ls "$REPO_ROOT"/app/api/stryker.*.config.json "$REPO_ROOT"/app/ui/stryker.*.config.json | wc -l | tr -d ' ')
check "the repo's matrix covers all $configs Stryker configs" "$configs" "$(echo "$real" | grep -o '"config"' | wc -l | tr -d ' ')"
missing=0
while read -r pkg cfg; do [ -f "$REPO_ROOT/app/$pkg/$cfg" ] || missing=$((missing + 1)); done < <(
  echo "$real" | grep -o '"pkg":"[a-z]*","name":"[^"]*","label":"[^"]*","config":"[^"]*"' \
    | sed -E 's/"pkg":"([a-z]*)".*"config":"([^"]*)"/\1 \2/')
check "every matrix entry names a config that exists" 0 "$missing"

# ── scheduled_failure_issue.sh ───────────────────────────────────────────────
echo "scheduled_failure_issue.sh"
BIN="$WORK/bin"; mkdir -p "$BIN"
# Stub gh: `issue list` prints STUB_EXISTING (already jq-filtered); every call is logged.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
if [ "$1 $2" = "issue list" ]; then printf '%s' "${STUB_EXISTING:-}"; fi
exit 0
STUB
chmod +x "$BIN/gh"
export STUB_LOG="$WORK/gh.log" GITHUB_REPOSITORY=acme/widgets
URL=https://github.com/acme/widgets/actions/runs/7

: > "$STUB_LOG"
STUB_EXISTING='' PATH="$BIN:$PATH" bash "$ALERT" "JavaScript mutation testing" "$URL" >/dev/null
check "no open issue: creates one titled after the workflow" 1 \
  "$(grep -c '^issue create --repo acme/widgets --title Scheduled workflow failing: JavaScript mutation testing --body .*actions/runs/7' "$STUB_LOG")"
check "no open issue: does not comment" 0 "$(grep -c '^issue comment' "$STUB_LOG")"

: > "$STUB_LOG"
STUB_EXISTING=42 PATH="$BIN:$PATH" bash "$ALERT" "JavaScript mutation testing" "$URL" >/dev/null
check "an open issue: comments on it with the run link" 1 "$(grep -c "^issue comment 42 --repo acme/widgets --body Failed again: $URL" "$STUB_LOG")"
check "an open issue: does not open a duplicate" 0 "$(grep -c '^issue create' "$STUB_LOG")"

set +e; (unset GITHUB_REPOSITORY; PATH="$BIN:$PATH" bash "$ALERT" w "$URL" >/dev/null 2>&1); rc=$?; set -e
check "without GITHUB_REPOSITORY it fails rather than guessing a repo" 1 "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"

echo
echo "mutation-scripts: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
