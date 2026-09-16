#!/usr/bin/env bash
# Unit tests for the DoR reconcile sweep's SELF-HEALING decisions (.github/scripts/dor_reconcile.sh).
#
# Everything else the sweep does is reporting, which a human reads and sanity-checks. These two
# functions are the only part of the DoR pipeline that acts on its own judgement: waiting_verdict
# decides whether a parked issue really has a person on the hook, and try_redispatch spends real
# model budget re-driving the agent when it decides one does not. A wrong "answered" therefore costs
# a duplicate comment and a probe run on an issue nobody was waiting for, and a broken budget check
# can re-drive an issue for ever — which is the failure this whole mechanism exists to prevent, since
# the outage behind it was ~10 agent runs starting in the same minute and exhausting the model quota.
#
# The functions are lifted OUT of the script under test rather than copied, so a rename or a
# signature change fails here instead of quietly testing a stale duplicate. `gh` is stubbed; no
# network, no tokens, no writes.
#
# Usage: bash test/ci-scripts/test-dor-reconcile-selfheal.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/dor_reconcile.sh"
[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Canned GitHub, keyed on the issue number. `gh issue view N` streams the true/false "is this an
# agent comment?" column that waiting_verdict's --jq program produces; `gh api …/issues/N/timeline`
# answers with the count of prior dor-retry labellings that try_redispatch reads its budget from.
cat > "$TMP/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = api ]; then
  n="$(printf '%s\n' "$2" | sed -n 's#.*/issues/\([0-9]*\)/timeline#\1#p')"
  case "$n" in 201) echo 3 ;; 204) echo not-a-number ;; *) echo 0 ;; esac
  exit 0
fi
[ "${1:-}" = label ] && exit 0
if [ "${1:-}" = issue ] && [ "${2:-}" = edit ]; then
  # #203 is the issue whose label write is refused; only the --add-label half fails.
  case " $* " in *" --add-label "*) [ "$3" = 203 ] && exit 1 ;; esac
  exit 0
fi
case "${3:-}" in
  100) : ;;                             # no comments at all
  101) printf 'true\n' ;;               # agent only
  102) printf 'true\nfalse\n' ;;        # agent, then a human replied
  103) printf 'true\nfalse\ntrue\n' ;;  # ...and the agent came back
  104) printf 'false\nfalse\n' ;;       # humans only, none identifiable as the agent
  105) printf 'false\ntrue\nfalse\n' ;; # human, agent, human
  106) exit 1 ;;                        # the API call itself fails
esac
STUB
chmod +x "$TMP/gh"; PATH="$TMP:$PATH"

# The globals the two functions close over, then the functions themselves.
OWNER=Fortigi; REPO=IdentityAtlas; RETRY_MAX=3; RETRY_CAP=3
exceptions=""; ex_keys=""; redispatched=0
eval "$(sed -n '/^add_ex() {/,/^}/p'          "$SCRIPT")"
eval "$(sed -n '/^waiting_verdict() {/,/^}/p' "$SCRIPT")"
eval "$(sed -n '/^try_redispatch() {/,/^}/p'  "$SCRIPT")"
for fn in add_ex waiting_verdict try_redispatch; do
  declare -F "$fn" >/dev/null || { echo "could not lift $fn out of dor_reconcile.sh — renamed?" >&2; exit 1; }
done

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
no() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n         %s\n' "$1" "$2"; }

verdict() {  # <issue> <expected> <description>
  local got; got="$(waiting_verdict "$1")"
  [ "$got" = "$2" ] && ok "$3" || no "$3" "got '$got', expected '$2'"
}

echo "waiting_verdict — does this parked issue really have a person on the hook?"
verdict 100 unknown  "no comments at all is not evidence that anything was asked"
verdict 101 waiting  "the agent spoke last, so it is genuinely on a human"
verdict 102 answered "a human replied and the agent never came back"
verdict 103 waiting  "the agent came back after the human"
verdict 104 unknown  "humans only, none identifiable as the agent (a pre-marker thread)"
verdict 105 answered "human, agent, human — still owed a reply"
verdict 106 waiting  "a failed API call must never produce a re-dispatch"

echo
echo "try_redispatch — budget and cap"
run() {  # <issue> <expected marker> <expected counter delta> <description>
  local before="$redispatched" delta
  exceptions=""; try_redispatch "$1" "Awaiting requestor" "the test says so"
  delta=$(( redispatched - before ))
  case "$exceptions" in
    *"$2"*) [ "$delta" -eq "$3" ] && ok "$4" || no "$4" "counter moved by $delta, expected $3" ;;
    *)      no "$4" "expected marker '$2', got: $(printf '%s' "$exceptions" | head -c 140)" ;;
  esac
}
run 200 "🚑" 1 "a fresh issue is re-dispatched, and counts against this sweep's cap"
run 201 "🔁" 0 "an issue that has already used RETRY_MAX is handed to a human instead"
run 204 "🚑" 1 "an unparseable retry count reads as zero, not as a huge number"
run 203 "❌" 0 "a refused label write is reported, and does not count as a dispatch"
redispatched="$RETRY_CAP"
run 202 "🚑" 0 "once the sweep cap is reached, nothing further is dispatched this run"
case "$exceptions" in
  *"budget of ${RETRY_CAP}"*) ok "the deferral message names the budget it hit" ;;
  *) no "the deferral message names the budget it hit" "got: $exceptions" ;;
esac

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
