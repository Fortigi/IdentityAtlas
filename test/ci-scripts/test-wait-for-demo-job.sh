#!/usr/bin/env bash
# Unit tests for .github/scripts/wait_for_demo_job.sh, the demo-data loader in
# pr-integration.yml.
#
# The regression this guards (#1642): two of three copies of the poll loop
# exited 0 when the demo job failed or never finished, so the step went green
# and Playwright failed later on an empty database. Each case below drives the
# script with a fake curl and checks the exit code AND the message, so a loop
# that "passes" by exiting early or late is caught. The last case pins that the
# workflow no longer carries an inline copy of the loop.
#
# Usage: bash test/ci-scripts/test-wait-for-demo-job.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/wait_for_demo_job.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/pr-integration.yml"

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
has() { case "$2" in *"$1"*) echo yes ;; *) echo no ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fake curl. A POST prints $FAKE_POST. A GET prints the next line of
# $TMP/statuses as a job record ("-" = curl fails) and repeats the last line
# once the list runs out. Every GET is counted in $TMP/gets.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "POST" ] && { printf '%s' "$FAKE_POST"; exit 0; }; done
n=$(( $(cat "$FAKE_DIR/gets" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_DIR/gets"
line=$(sed -n "${n}p" "$FAKE_DIR/statuses"); [ -z "$line" ] && line=$(tail -n 1 "$FAKE_DIR/statuses")
[ "$line" = "-" ] && exit 22
printf '{"id":"job-1","status":"%s"}' "$line"
EOF
chmod +x "$TMP/bin/curl"

# run <post-response> <polls> <status...>: runs the script with 0 s polls and
# sets CODE, OUT and GETS (how many times the job was fetched).
run() {
  local post="$1" polls="$2"; shift 2
  printf '%s\n' "$@" > "$TMP/statuses"
  rm -f "$TMP/gets"
  set +e
  OUT="$(PATH="$TMP/bin:$PATH" FAKE_DIR="$TMP" FAKE_POST="$post" bash "$SCRIPT" http://api "$polls" 0 2>&1)"
  CODE=$?
  set -e
  GETS="$(cat "$TMP/gets" 2>/dev/null || echo 0)"
}
QUEUED='{"id":"job-1","status":"queued"}'

echo "job completes"
run "$QUEUED" 40 queued running completed
assert "completed: exits 0" 0 "$CODE"
assert "stops polling at the first 'completed'" 3 "$GETS"
assert "reports the elapsed time" yes "$(has 'Demo job completed after' "$OUT")"
assert "no error annotation" no "$(has '::error::' "$OUT")"

echo "job fails"
run "$QUEUED" 40 running failed
assert "failed: exits 1" 1 "$CODE"
assert "fails at once instead of burning the budget" 3 "$GETS"   # 2 polls + 1 dump
assert "names the status" yes "$(has '::error::Demo job failed' "$OUT")"
assert "dumps the job record" yes "$(has '"status":"failed"' "$OUT")"

echo "job cancelled"
run "$QUEUED" 40 cancelled
assert "cancelled: exits 1" 1 "$CODE"
assert "names the status" yes "$(has '::error::Demo job cancelled' "$OUT")"

echo "job never finishes"
run "$QUEUED" 5 queued running
assert "timeout: exits 1" 1 "$CODE"
assert "uses the whole poll budget, then dumps" 6 "$GETS"
assert "says it timed out with the last status" yes "$(has 'timed out after 0s (last status: running)' "$OUT")"
assert "never claims success" no "$(has 'completed after' "$OUT")"

echo "status endpoint unreachable"
run "$QUEUED" 3 -
assert "unreachable: exits 1" 1 "$CODE"
assert "last status is unknown" yes "$(has 'last status: unknown' "$OUT")"

echo "a transient fetch error is not fatal"
run "$QUEUED" 10 - running completed
assert "recovers and exits 0" 0 "$CODE"

echo "job cannot be queued"
run '' 40 completed
assert "empty POST response: exits 1" 1 "$CODE"
assert "says it could not queue" yes "$(has '::error::Failed to queue demo job' "$OUT")"
assert "never polls" 0 "$GETS"
run '{"error":"nope"}' 40 completed
assert "response without an id: exits 1" 1 "$CODE"

echo "workflow uses the shared script"
assert "pr-integration.yml has no inline demo-job poll loop" 0 \
  "$(grep -c 'jobType": "demo"' "$WORKFLOW" || true)"
assert "all three demo loads call the script" 3 \
  "$(grep -c 'bash .github/scripts/wait_for_demo_job.sh' "$WORKFLOW" || true)"
assert "integration and e2e re-run when the script changes" 2 \
  "$(grep -c "^ *- '.github/scripts/wait_for_demo_job.sh'" "$WORKFLOW" || true)"

echo
echo "wait_for_demo_job: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
