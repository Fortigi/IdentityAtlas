#!/usr/bin/env bash
# Unit tests for the DoR reconcile sweep's per-issue triage (.github/scripts/dor_reconcile.sh).
#
# The sweep is the only thing that notices a build whose sidekick died mid-flight — the flow dies
# with the box, so it never reaches its own error handling. That detector (💀, #963) was unreachable
# for its entire target population for weeks (#995): the "no `state:*` label" branch `continue`d
# before the liveness check, and the build side deliberately runs without a state label. Nothing
# tested this file, which is why it shipped shadowed and stayed that way.
#
# Approach: put a stub `gh` on PATH that serves fixtures and records writes, then run the REAL
# script end to end and assert on the health-report body it produces. No network, no tokens.
#
# Usage: bash test/ci-scripts/test-dor-reconcile-liveness.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/dor_reconcile.sh"

PASS=0
FAIL=0

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"
    echo "        expected to find: $needle"
    echo "        in: $(printf '%s' "$haystack" | head -c 400)"
    FAIL=$((FAIL + 1))
  fi
}

assert_lacks() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  FAIL  $desc"
    echo "        did NOT expect: $needle"
    echo "        in: $(printf '%s' "$haystack" | head -c 400)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  fi
}

# ── The stub ────────────────────────────────────────────────────────────────
# Dispatches on the argument shape of each call the script makes, serving files from $FIX and
# appending every write to $FIX/writes.log so a test can assert on what reached the issue.
make_stub() {
  local dir="$1"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
log() { printf '%s\n' "$*" >> "$FIX/writes.log"; }
case "$args" in
  # Board snapshot: "<number>\t<OPEN|CLOSED>\t<Status>"
  "api graphql"*)                     cat "$FIX/board.tsv" ;;
  # Live DoR workflow runs — display_title lines, one per run.
  *"actions/runs?status="*)           cat "$FIX/live_runs.txt" ;;
  # has_live_run's title lookup — `gh issue view <num> --repo … --json title`, so the number is $3.
  "issue view"*"--json title"*)       sed -n "s/^$3\t//p" "$FIX/titles.tsv" ;;
  # The open-issue walk. The script's own --jq is bypassed: we serve the TSV it expects.
  *"--state open --label dor-stuck"*) cat "$FIX/marked.txt" 2>/dev/null || true ;;
  *"--state open --label"*"--limit 201"*) cat "$FIX/issues.tsv" ;;
  *"--state closed --label"*)         : ;;   # no closed issues claiming a sidekick
  *"--state all --limit 100"*)        : ;;   # no health issue yet -> the script creates one
  "pr list"*)                         : ;;   # no open PR (zombie check)
  "issue create"*)                    log "CREATE_BODY: $*" ;;
  "issue comment"*)                   log "COMMENT: $*" ;;
  "issue edit"*)                      log "EDIT: $*" ;;
  *)                                  : ;;
esac
exit 0
STUB
  chmod +x "$dir/bin/gh"
}

# Run the real sweep against one fixture set; echo the health-report body it tried to publish.
run_sweep() {
  local fix="$1"
  FIX="$fix" PATH="$fix/bin:$PATH" \
    OWNER=Fortigi REPO=IdentityAtlas PROJECT_ID=PVT_test GH_TOKEN=stub LABEL=enhancement \
    bash "$SCRIPT" >/dev/null 2>&1 || true
  # The body is multi-line, so take the CREATE_BODY line and everything after it — a plain grep
  # would return only the report's first line and every assertion below would vacuously fail.
  sed -n '/^CREATE_BODY: /,$p' "$fix/writes.log" 2>/dev/null || true
}

# Build a fixture dir. $2 = board Status, $3 = minutes since the issue was updated,
# $4 = "live" to make a run look alive for it.
scenario() {
  local dir="$1" status="$2" upd_min="$3" live="${4:-}"
  local now created updated
  now="$(date -u +%s)"
  created=$(( now - 3600 * 1000 ))          # ancient: opened ~42 days ago, like #370
  updated=$(( now - 60 * upd_min ))
  rm -rf "$dir"; mkdir -p "$dir"
  make_stub "$dir"
  : > "$dir/writes.log"
  printf '370\tOPEN\t%s\n' "$status"                       > "$dir/board.tsv"
  printf '370\tCollapse managed resources\n'               > "$dir/titles.tsv"
  # number, created, updated, needs_vouch, sk_label, state_label — state_label EMPTY, as the
  # build side always leaves it.
  printf '370\t%s\t%s\tfalse\tsk:sk3\t\n' "$created" "$updated" > "$dir/issues.tsv"
  if [ "$live" = "live" ]; then
    printf 'Collapse managed resources\n'                  > "$dir/live_runs.txt"
  else
    : > "$dir/live_runs.txt"
  fi
  printf '%s' "$dir"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "DoR reconcile — died-sidekick liveness"
echo

# ── 1. THE regression (#995): Building + no live run must be flagged 💀 ──────
# Pre-fix this emitted the 🕳️ un-routed line instead, because the label-less branch `continue`d
# before the liveness check ever ran.
out="$(run_sweep "$(scenario "$TMP/dead" 'Building' 40)")"
assert_contains "a dead Building issue is flagged as a died sidekick" "💀 #370" "$out"
assert_contains "…and is told to re-dispatch, not that the agent never ran" "re-dispatch it" "$out"
assert_lacks    "…and is NOT mis-reported as un-routed" "🕳️ #370" "$out"
assert_contains "the issue itself gets marked dor-stuck" "add-label dor-stuck" \
  "$(cat "$TMP/dead/writes.log")"
assert_contains "…and commented on directly" "died mid-flight" \
  "$(cat "$TMP/dead/writes.log")"

# ── 2. A build that IS alive must stay quiet ────────────────────────────────
out="$(run_sweep "$(scenario "$TMP/alive" 'Building' 40 live)")"
assert_lacks "a live build is not reported dead" "💀 #370" "$out"
assert_lacks "a live build is not reported un-routed either" "🕳️ #370" "$out"

# ── 3. Genuinely un-routed still flagged ────────────────────────────────────
# No state label AND no board Status: nothing owns it, so the original 🕳️ rule must survive.
out="$(run_sweep "$(scenario "$TMP/unrouted" '' 600)")"
assert_contains "an issue nothing owns is still flagged un-routed" "🕳️ #370" "$out"

# ── 4. Un-routed age is measured from the last update, not from creation ────
# Same ancient creation date, but touched 60 min ago and UNROUTED_HOURS defaults to 6. Pre-fix this
# reported "after 1000h" purely because the issue was opened in June.
out="$(run_sweep "$(scenario "$TMP/fresh" '' 60)")"
assert_lacks "a recently-updated issue is not flagged on its creation age" "🕳️ #370" "$out"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
