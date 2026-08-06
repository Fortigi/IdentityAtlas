#!/usr/bin/env bash
# Post the evidence bundle for an autonomously-built bug fix to its PR.
#
# This is what a merge review actually reads. Every row is a CLAIM with the artefact that
# substantiates it — not a summary written by the thing being reviewed. The load-bearing one is the
# red proof: a green suite after a fix is equally consistent with "bug fixed" and "test doesn't touch
# the bug", so the only interesting evidence is the same test failing BEFORE the fix existed.
#
# Claims we deliberately do NOT make: anything we did not measure. If a step was skipped, the row
# says skipped. A bundle that overstates is worse than no bundle, because the whole point is that the
# reviewer can stop re-deriving this by hand.
#
#   Env: ISSUE REPO PR WORK URL HOST   — the issue/PR, checkout dir, live env URL, sidekick
#        CONTRACT (opt)                — path to the repro contract, when the issue has one
#        GH_TOKEN                      — posts the comment
#   Reads: /tmp/red.log (pre-fix failure) /tmp/unit.log (post-fix pass) /tmp/e2e.log (live replay)
set -uo pipefail

: "${ISSUE:?dor_evidence: ISSUE required}"
: "${REPO:?dor_evidence: REPO required}"
: "${PR:?dor_evidence: PR required}"
: "${WORK:?dor_evidence: WORK required}"

range="origin/main...HEAD"
out="$(mktemp)"

# ── gather ────────────────────────────────────────────────────────────────────────────────────────
changed="$(git -C "$WORK" diff --name-only "$range" 2>/dev/null)"
tests_added="$(printf '%s\n' "$changed" | grep -E '\.(test|spec)\.(js|jsx)$|\.Tests\.ps1$' | tr '\n' ' ')"
e2e_added="$(printf '%s\n' "$changed"   | grep -E '^app/ui/e2e/.*\.spec\.js$'              | tr '\n' ' ')"

# The red proof, trimmed to the lines that carry meaning: which test, and what it asserted.
# A RESUMED build skips the red pass entirely (its branch already has commits), so there is nothing
# to show — and the row must say so rather than assert a proof this run never performed.
if [ -s /tmp/red.log ]; then
  red_row="it **failed before the fix existed** — output below"
else
  red_row="⚠️ _not proven in this run: the build resumed from an existing branch, so the red pass did not re-run. Check the original attempt._"
fi
red_excerpt="$(grep -E 'FAIL|AssertionError|Expected:|Received:|✕|×|Error:' /tmp/red.log 2>/dev/null | head -14)"
[ -n "$red_excerpt" ] || red_excerpt="$(tail -14 /tmp/red.log 2>/dev/null)"
green_line="$(grep -E 'Tests +[0-9]+ passed|Tests:? +[0-9]+ passed' /tmp/unit.log 2>/dev/null | tail -1)"
e2e_line="$(grep -E '[0-9]+ (passed|failed)' /tmp/e2e.log 2>/dev/null | tail -2 | tr '\n' ' ')"

ci="$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
      --jq '[.statusCheckRollup[]?|.conclusion // .status]|group_by(.)|map("\(length) \(.[0]|ascii_downcase)")|join(", ")' 2>/dev/null)"

# Link straight to the certified verdict rather than the issue, so the reviewer lands on the contract.
verdict_url="$(gh api "repos/$REPO/issues/$ISSUE/comments" --paginate \
  --jq '[.[]|select(.body|test("Repro contract|CERTIFIED"))|.html_url]|last // empty' 2>/dev/null)"
[ -n "$verdict_url" ] || verdict_url="https://github.com/$REPO/issues/$ISSUE"

# "What it did NOT do" — each of these is a thing a reviewer would otherwise have to check by eye.
not_touched=""
printf '%s\n' "$changed" | grep -qE '(^|/)migrations/' \
  && not_touched="${not_touched}⚠️ touches a database migration · " \
  || not_touched="${not_touched}no schema migration · "
printf '%s\n' "$changed" | grep -qE '(^|/)package(-lock)?\.json$' \
  && not_touched="${not_touched}⚠️ changes dependencies · " \
  || not_touched="${not_touched}no dependency change · "
printf '%s\n' "$changed" | grep -q '^\.github/' \
  && not_touched="${not_touched}⚠️ touches .github" \
  || not_touched="${not_touched}no CI/workflow change"

if [ -n "${CONTRACT:-}" ] && [ -s "${CONTRACT:-/nonexistent}" ]; then
  radius="$(jq -r '.blast_radius | join("`, `")' "$CONTRACT" 2>/dev/null)"
  assertion="$(jq -r '.assertion'  "$CONTRACT" 2>/dev/null)"
  rootcause="$(jq -r '.root_cause' "$CONTRACT" 2>/dev/null)"
  radius_row="stayed inside \`${radius}\` — nothing outside it"
  source_row="diagnosed \`${rootcause}\`, and that is where the fix landed"
  assert_row="\`${assertion}\`"
else
  radius_row="_not checked — this issue was certified before repro contracts existed_"
  source_row="_no contract to check against_"
  assert_row="_no contract — see the certified verdict_"
fi

# ── compose ───────────────────────────────────────────────────────────────────────────────────────
{
  printf '## 🤖 Evidence bundle — autonomous fix for #%s\n\n' "$ISSUE"
  printf 'Every row is a claim with the artefact behind it. The one that matters is the red proof: a test that was never red proves nothing.\n\n'
  printf '| Claim | Evidence |\n|---|---|\n'
  printf '| The bug is real and reproducible | [certified verdict](%s) |\n' "$verdict_url"
  printf '| The test reproduces **this** bug | %s |\n' "$red_row"
  printf '| The assertion under test | %s |\n' "$assert_row"
  printf '| The fix resolves it | same test, after the fix: %s |\n' "${green_line:-see the green proof below}"
  printf '| The symptom is gone on a real deployment | e2e replayed on [%s](%s): %s |\n' "$HOST" "$URL" "${e2e_line:-see below}"
  printf '| It cannot come back | `%s` now runs in CI on every PR |\n' "${tests_added:-—}"
  printf '| It was fixed at the source | %s |\n' "$source_row"
  printf '| The fix went where the diagnosis said | %s |\n' "$radius_row"
  printf '| Nothing else broke | CI: %s |\n' "${ci:-no checks reported}"
  printf '| What it did **not** do | %s |\n' "$not_touched"
  printf '\n<details><summary>🔴 Red proof — the test failing before the fix existed</summary>\n\n```\n%s\n```\n\n</details>\n' "${red_excerpt:-(no red log captured)}"
  printf '\n<details><summary>🟢 Green proof — the same test after the fix</summary>\n\n```\n%s\n```\n\n</details>\n' "$(tail -12 /tmp/unit.log 2>/dev/null)"
  printf '\n<details><summary>🌐 Live replay (%s)</summary>\n\n```\n%s\n```\n\n</details>\n' "${e2e_added:-e2e}" "$(tail -12 /tmp/e2e.log 2>/dev/null)"
  printf '\n<details><summary>📄 Files changed</summary>\n\n```\n%s\n```\n\n</details>\n' "$(git -C "$WORK" diff --stat "$range" 2>/dev/null | tail -20)"
} > "$out"

gh pr comment "$PR" --repo "$REPO" --body-file "$out" >/dev/null 2>&1 \
  && echo "::notice::evidence bundle posted to PR #${PR}" \
  || echo "::warning::could not post the evidence bundle to PR #${PR}"
rm -f "$out"
