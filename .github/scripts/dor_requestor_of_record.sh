#!/usr/bin/env bash
# Print the login of an issue's REQUESTOR OF RECORD — the person who owns its intent for the DoR
# pipeline, and therefore the login whose org membership the pipeline gates on.
#
# Normally that is simply the issue author. For an EXTERNAL request accepted through the vouch
# process (docs/process/definition-of-ready.md#external-requests--the-vouch), it is the Fortigi
# member who applied `dor-vouched`: vouching TRANSFERS the requestor role to that member, who then
# answers for the request, while the original author stays subscribed and @-mentioned for updates.
#
#   Usage: dor_requestor_of_record.sh <issue-number>
#   Env:   GH_TOKEN — needs Issues: read (the default GITHUB_TOKEN is enough).
#          OWNER / REPO default to Fortigi/IdentityAtlas; REPO may be owner-qualified.
#
# This script only answers WHO. It deliberately does NOT check org membership — that stays in
# `.github/actions/dor-authorize` (the one place that mints a Members:Read token), so callers keep
# a single membership gate. Consequence: a vouch by someone who is NOT a member resolves to them
# and then FAILS that gate, which is the fail-closed outcome we want.
set -euo pipefail

OWNER="${OWNER:-Fortigi}"
REPO="${REPO:-IdentityAtlas}"
# Accept an owner-qualified REPO (github.repository = "owner/name") so `"$OWNER/$REPO"` below
# doesn't become "owner/owner/name". Same guard as dor_set_status.sh / dor_reconcile.sh.
if [[ "$REPO" == */* ]]; then OWNER="${REPO%%/*}"; REPO="${REPO##*/}"; fi
ISSUE="${1:?usage: dor_requestor_of_record.sh <issue-number>}"
# Exported so the jq filters below can read it as $ENV.VOUCH_LABEL — safer than interpolating a
# shell variable into the filter string.
export VOUCH_LABEL="${VOUCH_LABEL:-dor-vouched}"

# A real user login: alphanumerics and hyphens only. This deliberately rejects two things — an API
# error body (which must never reach the membership gate dressed up as a user) and any app/bot
# actor, whose login carries a "[bot]" suffix. Only a human can vouch, so a bot-applied label must
# not transfer the requestor role.
is_login() { [[ "${1:-}" =~ ^[A-Za-z0-9-]+$ ]]; }

# Author + "is it vouched?" in ONE call. Assigned through an `if` so a failed call is caught —
# `read <<<"$(...)"` would swallow the non-zero status and happily parse the error body.
if ! meta="$(gh api "repos/$OWNER/$REPO/issues/$ISSUE" \
    --jq '[.user.login, ((([.labels[].name] | index($ENV.VOUCH_LABEL)) != null) | tostring)] | @tsv' \
    2>/dev/null)"; then
  echo "::error::dor_requestor_of_record: cannot read issue #${ISSUE}" >&2
  exit 1
fi
read -r author vouched <<<"$meta"

if ! is_login "${author:-}"; then
  echo "::error::dor_requestor_of_record: no usable author login for issue #${ISSUE}" >&2
  exit 1
fi

# Not vouched → the author is the requestor, as always.
if [ "${vouched:-false}" != "true" ]; then
  echo "$author"
  exit 0
fi

# Vouched → the requestor of record is whoever APPLIED the label. Read that from the timeline
# rather than trusting any issue text: only a user with triage permission or above can label, so
# the `labeled` event is a tamper-proof record of a real human decision. `tail -n 1` takes the most
# recent application (the label may have been removed and re-applied by someone else); --paginate
# streams one login per line, so this must NOT use jq's `last` (that would be per-page).
voucher="$(gh api --paginate "repos/$OWNER/$REPO/issues/$ISSUE/timeline" \
  --jq '.[] | select(.event == "labeled" and .label.name == $ENV.VOUCH_LABEL) | .actor.login' \
  2>/dev/null | tail -n 1 || true)"

# Label present but not attributable to a human — no `labeled` event found (timeline truncated or
# an API hiccup), or it was applied by an app/bot. Fall back to the author and let the caller's
# membership gate decide. Never fail open.
if ! is_login "${voucher:-}"; then
  echo "::warning::dor_requestor_of_record: #${ISSUE} carries ${VOUCH_LABEL} but it was not applied by an identifiable human (got '${voucher:-<none>}') — falling back to the author." >&2
  echo "$author"
  exit 0
fi

echo "$voucher"
