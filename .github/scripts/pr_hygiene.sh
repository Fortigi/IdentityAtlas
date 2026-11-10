#!/usr/bin/env bash
# PR Hygiene gate (pr.yml 'PR Hygiene'): a code change ships with a test that is
# about that code, and with a changelog fragment.
#
# Reads the changed file list (one path per line) on stdin.
#   SKIP_HYGIENE=true  the 'skip-hygiene' label: report what would block, pass.
# Exit 0 = OK or bypassed, 1 = blocked.
#
# "A test about that code" (review item A13): at least one changed test must be
# named after a changed source file. Before this, ANY changed test satisfied the
# gate, so touching an unrelated test made an untested change pass. Names are
# compared case-insensitively with punctuation removed, within
# the same area (API, UI, PowerShell), and meet when:
#   - equal        useSavedMatrixNaming.js   ~ useSavedMatrixNaming.test.js
#                  access-review-adoption.js ~ accessReviewAdoption.test.js
#                  PeoplePicker.helpers.js   ~ PeoplePicker.mount.test.jsx  (first-dot stem)
#                  EntraIDCrawler.Phases.ps1 ~ test/unit/EntraIDCrawlerPhases.Tests.ps1
#   - contained    recentChanges/timeline.js ~ userTimelineSoftDelete.contract.test.js
#                  lib/principalActivity.js  ~ reports/activity.test.js
#                  (6+ characters, so "index" or "model" can't relate everything)
#   - the test is named after the source's folder
#                  routes/crawlers/selfService.js ~ routes/crawlers.routes.test.js
#
# Sharing a FOLDER is deliberately not enough. Measured on the 150 PRs merged
# before this change: every one still passes on names alone, while pairing each
# PR's code with ANOTHER PR's tests is blocked 48 times in 59 with folders
# ignored, and only 37 with them -- routes/ and components/ hold hundreds of
# files, so "same folder" related almost anything. The miss that remains is a
# generic name shared across folders (a model.js and an unrelated model.test.js).
set -euo pipefail

CHANGED="$(cat)"
echo "Changed files:"; printf '%s\n' "${CHANGED}" | sed 's/^/  /'

# Product (non-test) source that ought to be covered by a test.
# .sql = schema migrations (cover with a contract test); .mjs = the desktop
# build/launcher scripts.
CODE=$(printf '%s\n' "${CHANGED}" | grep -E \
  -e '^app/api/src/.*\.js$' \
  -e '^app/api/src/.*\.sql$' \
  -e '^app/.*\.mjs$' \
  -e '^app/ui/src/.*\.(js|jsx)$' \
  -e '^tools/.*\.ps1$' \
  -e '^setup/docker/.*\.ps1$' \
  | grep -vE '\.(test|spec)\.(js|jsx)$' \
  | grep -vE '\.Tests\.ps1$' || true)

# Anything that counts as a test.
TESTS=$(printf '%s\n' "${CHANGED}" | grep -E \
  -e '\.(test|spec)\.(js|jsx)$' \
  -e '^app/ui/e2e/' \
  -e '^test/' \
  -e '\.Tests\.ps1$' \
  -e '/Test-[^/]+\.ps1$' \
  -e '/Start-Mock[^/]+\.ps1$' || true)

FRAGMENT=$(printf '%s\n' "${CHANGED}" | grep -E '^changes/.*\.md$' || true)

# Pure string operations below, no subshells: a large PR pairs every changed
# source with every changed test.

# norm <text> -> $N: lower-cased, punctuation removed.
norm() { N="${1,,}"; N="${N//[^[:alnum:]]/}"; }

# keys_of <path> -> $K1 (first-dot stem) and $K2 (whole name minus its
# extension), both normalised. Test markers need no stripping: the first-dot
# stem drops them (foo.mount.test.jsx -> foo), and containment covers the rest
# (EntraIDCrawler.Phases.ps1 ~ EntraIDCrawlerPhases.Tests.ps1).
keys_of() {
  local base="${1##*/}"
  norm "${base%%.*}"; K1="$N"
  norm "${base%.*}"; K2="$N"
}

# area_of <path> -> $A: which test suite can exercise it. A UI change is not
# tested by an API test, however alike their names.
area_of() {
  case "$1" in
    app/api/*) A=api ;; app/ui/*) A=ui ;; app/desktop/*) A=desktop ;;
    tools/crawlers/*/*.js|tools/crawlers/*/*.jsx) A=ui ;;
    *) A=ps ;;
  esac
}

dir_of() { if [[ "$1" == */* ]]; then D="${1%/*}"; else D="."; fi; }

# Each changed test's directory and keys, computed once.
T_PATH=(); T_AREA=(); T_K1=(); T_K2=()
while IFS= read -r t; do
  [ -n "$t" ] || continue
  keys_of "$t"; area_of "$t"
  T_PATH+=("$t"); T_AREA+=("$A"); T_K1+=("$K1"); T_K2+=("$K2")
done <<<"$TESTS"

# Keys shorter than this only match exactly; containment on "index" or "model"
# would relate almost anything.
MIN_CONTAINED=6

# Does one key relate to another: equal, or the longer one contains a long-enough shorter one.
keys_meet() {
  [ -n "$1" ] && [ -n "$2" ] || return 1
  [ "$1" = "$2" ] && return 0
  if [ ${#1} -ge $MIN_CONTAINED ] && [[ "$2" == *"$1"* ]]; then return 0; fi
  if [ ${#2} -ge $MIN_CONTAINED ] && [[ "$1" == *"$2"* ]]; then return 0; fi
  return 1
}

related() {
  local src="$1" sdir sk1 sk2 dk sarea i j
  dir_of "$src"; sdir="$D"
  keys_of "$src"; sk1="$K1"; sk2="$K2"
  norm "${sdir##*/}"; dk="$N"
  area_of "$src"; sarea="$A"
  for i in "${!T_PATH[@]}"; do
    [ "${T_AREA[$i]}" = "$sarea" ] || continue
    MATCH="$src ~ ${T_PATH[$i]}"
    for j in "${T_K1[$i]}" "${T_K2[$i]}"; do
      # Named after the source's folder: routes/crawlers/selfService.js ~ routes/crawlers.routes.test.js
      if [ -n "$j" ] && [ "$j" = "$dk" ]; then MATCH="$MATCH (named after its folder)"; return 0; fi
      # Same or contained name: timeline.js ~ userTimelineSoftDelete.contract.test.js
      if keys_meet "$j" "$sk1" || keys_meet "$j" "$sk2"; then MATCH="$MATCH (name)"; return 0; fi
    done
  done
  return 1
}

REASONS=""
add_reason() { REASONS="${REASONS}${REASONS:+$'\n'}$1"; }

if [ -n "${CODE}" ]; then
  if [ -z "${TESTS}" ]; then
    add_reason "Source code changed but no test files were added or modified. Add or extend a test: *.test.js (API), app/ui/e2e/*.spec.js (UI), *.Tests.ps1 (Pester unit), or Test-*.ps1 (crawler integration)."
  else
    any=0
    while IFS= read -r src; do
      if related "$src"; then any=1; echo "Test for the change: $MATCH"; break; fi
    done <<<"${CODE}"
    if [ "$any" -eq 0 ]; then
      add_reason "Tests changed, but none is about the code that changed: no changed test is named after a changed source file (or its folder). Changed code: $(printf '%s' "${CODE}" | tr '\n' ' ')- extend the test for one of those files."
    fi
  fi
  if [ -z "${FRAGMENT}" ]; then
    add_reason "Code changed but no changelog fragment found. Add a bullet to changes/<branch>.md (never edit CHANGES.md)."
  else
    # shellcheck disable=SC2086  # one path per fragment, none with spaces
    if ! grep -qE '^[[:space:]]*[-*][[:space:]]+[^[:space:]]' ${FRAGMENT}; then
      add_reason "A changelog fragment exists but has no bullet line. Add at least one '- ...' bullet describing the change to: ${FRAGMENT}"
    fi
  fi
else
  echo "No product code changed — tests/changelog not required."
fi

if [ -n "${REASONS}" ]; then
  if [ "${SKIP_HYGIENE:-}" = "true" ]; then
    echo "::warning::PR hygiene requirements NOT met, but BYPASSED via the 'skip-hygiene' label. The following would otherwise block merge:"
    printf '%s\n' "${REASONS}" | sed 's/^/  - /'
    echo "This bypass is intentional and is now recorded in this job's log rather than the job being silently skipped."
    exit 0
  fi
  while IFS= read -r reason; do echo "::error::PR hygiene: ${reason}"; done <<<"${REASONS}"
  echo "If this change genuinely needs neither, a maintainer can add the 'skip-hygiene' label."
  exit 1
fi
echo "PR hygiene OK."
