#!/usr/bin/env bash
# Unit tests for tools/coverage/suite-key.sh and tools/coverage/fetch-reusable.sh —
# how the post-merge coverage publisher (coverage.yml) reuses the lcov a PR's
# PR Checks run already produced instead of re-running the JS suites.
#
# What must hold, because getting it wrong publishes coverage for different code:
#   - a key changes when ANY input of its suite changes, and only then;
#   - docs/ (which coverage.yml itself commits into) never changes a key;
#   - fetch-reusable.sh treats every unexpected answer as a miss (exit 1), so the
#     caller falls back to running the suite — it never half-reuses.
#
# suite-key cases build throwaway repos; fetch-reusable cases put a stub `gh` on
# PATH. No network.
#
# Usage: bash test/ci-scripts/test-coverage-reuse.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY="$REPO_ROOT/tools/coverage/suite-key.sh"
FETCH="$REPO_ROOT/tools/coverage/fetch-reusable.sh"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL $1"; }
same()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected equal: $2 vs $3)"; fi; }
differ() { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1 (expected different, both $2)"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── suite-key.sh ─────────────────────────────────────────────────────────────
echo "suite-key.sh"
R="$WORK/repo"
mkdir -p "$R"
git -C "$R" init -q
git -C "$R" config user.email t@example.invalid
git -C "$R" config user.name test
git -C "$R" config core.autocrlf false
for f in app/api/src/a.js app/ui/src/b.jsx ontology/core.ttl tools/crawlers/x/crawler.json \
         app/desktop/w.js tools/scale-dataset/s.js tools/iiq-fixture/i.js docs/coverage.md; do
  mkdir -p "$R/$(dirname "$f")"; echo "$f v1" > "$R/$f"
done
commit() { git -C "$R" add -A && git -C "$R" commit -qm "$1"; }
commit base
keys() { (cd "$R" && for s in api-unit api-contract ui; do bash "$KEY" "$s"; done | tr '\n' ' '); }
key()  { (cd "$R" && bash "$KEY" "$1" "${2:-HEAD}"); }

k0="$(keys)"
same "same tree gives the same keys" "$k0" "$(keys)"

base_unit="$(key api-unit)"; base_contract="$(key api-contract)"; base_ui="$(key ui)"
differ "suites never share a key over the same tree" "$base_unit" "$base_contract"
case "$base_unit" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ok "key is 20 lowercase hex chars (safe in an artifact name)" ;;
  *) bad "key is 20 lowercase hex chars, got '$base_unit'" ;;
esac

echo "docs v2" > "$R/docs/coverage.md"; commit docs
same "a docs/ change leaves every key alone" "$k0" "$(keys)"

echo "api v2" > "$R/app/api/src/a.js"; commit api
differ "app/api change moves the api-unit key"     "$base_unit"     "$(key api-unit)"
differ "app/api change moves the api-contract key" "$base_contract" "$(key api-contract)"
same   "app/api change leaves the ui key"          "$base_ui"       "$(key ui)"

ui_before="$(key ui)"; contract_before="$(key api-contract)"; unit_before="$(key api-unit)"
echo "ui v2" > "$R/app/ui/src/b.jsx"; commit ui
differ "app/ui change moves the ui key"           "$ui_before"       "$(key ui)"
same   "app/ui change leaves the api-unit key"    "$unit_before"     "$(key api-unit)"
same   "app/ui change leaves the api-contract key" "$contract_before" "$(key api-contract)"

ui_before="$(key ui)"; contract_before="$(key api-contract)"; unit_before="$(key api-unit)"
echo "crawler v2" > "$R/tools/crawlers/x/crawler.json"; commit crawler
differ "crawler manifest change moves api-unit"     "$unit_before"     "$(key api-unit)"
differ "crawler manifest change moves api-contract" "$contract_before" "$(key api-contract)"
differ "crawler manifest change moves ui"           "$ui_before"       "$(key ui)"

unit_before="$(key api-unit)"; contract_before="$(key api-contract)"
echo "desktop v2" > "$R/app/desktop/w.js"; commit desktop
differ "app/desktop change moves api-unit (its tests run there)" "$unit_before" "$(key api-unit)"
same   "app/desktop change leaves api-contract"                  "$contract_before" "$(key api-contract)"

same "an explicit rev keys that commit, not HEAD" "$base_ui" "$(key ui HEAD~5)"

mkdir -p "$WORK/empty"; git -C "$WORK/empty" init -q
git -C "$WORK/empty" -c user.email=t@e.invalid -c user.name=t commit -q --allow-empty -m e
missing="$(cd "$WORK/empty" && bash "$KEY" ui)"
differ "a tree without the suite's paths still keys, distinctly" "$base_ui" "$missing"

set +e
(cd "$R" && bash "$KEY" nope >/dev/null 2>&1); rc=$?
set -e
same "an unknown suite exits 2" 2 "$rc"

# ── fetch-reusable.sh ────────────────────────────────────────────────────────
echo "fetch-reusable.sh"
BIN="$WORK/bin"; mkdir -p "$BIN"
# Stub gh. STUB_API = stdout of `gh api` (already jq-filtered, as gh would print);
# STUB_API_RC its exit code; STUB_LCOV = content `gh run download` writes
# (unset = write nothing); STUB_DL_RC its exit code. Every call is logged.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  api) printf '%s' "${STUB_API:-}"; exit "${STUB_API_RC:-0}" ;;
  run)
    dir=""; while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dir="$2"; shift; done
    if [ "${STUB_DL_RC:-0}" != 0 ]; then exit "$STUB_DL_RC"; fi
    if [ -n "${STUB_LCOV+x}" ]; then printf '%s' "$STUB_LCOV" > "$dir/lcov.info"; fi
    exit 0 ;;
esac
exit 99
STUB
chmod +x "$BIN/gh"
export STUB_LOG="$WORK/gh.log" GITHUB_REPOSITORY=acme/widgets

run_fetch() { # <case-dir> → sets rc
  set +e
  PATH="$BIN:$PATH" bash "$FETCH" cov-ui-abc "$1" >/dev/null 2>&1; rc=$?
  set -e
}

: > "$STUB_LOG"
D="$WORK/hit"
STUB_API=4242 STUB_LCOV=$'SF:a.js\nend_of_record\n' run_fetch "$D"
same "a live artifact is reused (exit 0)" 0 "$rc"
if [ -s "$D/lcov.info" ] && grep -q 'SF:a.js' "$D/lcov.info"; then ok "its lcov.info lands in the dest dir"; else bad "its lcov.info lands in the dest dir"; fi
if grep -q 'repos/acme/widgets/actions/artifacts?name=cov-ui-abc' "$STUB_LOG"; then ok "it looks the artifact up by exact name in this repo"; else bad "it looks the artifact up by exact name ($(cat "$STUB_LOG"))"; fi
if grep -q '^run download 4242 --repo acme/widgets --name cov-ui-abc' "$STUB_LOG"; then ok "it downloads from the run that uploaded it"; else bad "it downloads from the run that uploaded it ($(cat "$STUB_LOG"))"; fi

: > "$STUB_LOG"
STUB_API='' run_fetch "$WORK/none"
same "no live artifact is a miss (exit 1)" 1 "$rc"
if grep -q '^run ' "$STUB_LOG"; then bad "a miss does not try to download"; else ok "a miss does not try to download"; fi

STUB_API='' STUB_API_RC=1 run_fetch "$WORK/apifail"
same "an API error is a miss, not a failure" 1 "$rc"

STUB_API=4242 STUB_DL_RC=1 STUB_LCOV=x run_fetch "$WORK/dlfail"
same "a failed download is a miss" 1 "$rc"
if [ -e "$WORK/dlfail/lcov.info" ]; then bad "a failed download leaves no lcov.info"; else ok "a failed download leaves no lcov.info"; fi

STUB_API=4242 STUB_LCOV='' run_fetch "$WORK/emptylcov"
same "an empty lcov.info is a miss (never publish 0%)" 1 "$rc"
if [ -e "$WORK/emptylcov/lcov.info" ]; then bad "an empty lcov.info is not placed"; else ok "an empty lcov.info is not placed"; fi

STUB_API=4242 run_fetch "$WORK/nolcov"   # STUB_LCOV unset: download writes nothing
same "an artifact without lcov.info is a miss" 1 "$rc"

echo
echo "coverage-reuse: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
