#!/usr/bin/env bash
# DoR build-agent flow (slice D, full Definition-of-Done). Runs ON a dor-build sidekick, invoked by
# dor-build-agent.yml after the value-gate approval. Drives the `claude` CLI directly (so the CI
# fix-retry loop can re-invoke the AI in-process — a `uses:` action can't be looped). Shared deploy /
# e2e / CI / bail helpers live in dor_build_lib.sh.
#
# Definition of Done to reach "Awaiting functional acceptance" (ALL must hold; else fix→retry→Exceptions):
#   1. build completes   2. demo data + resource context plugins loaded   3. feature e2e green on the
#   live env   4. PR opened (incl. docs/changelog)   5. PR CI all green (auto-fix up to 8×).
# For a BUG, two more come FIRST and are not negotiable (docs/process/autonomous-bug-pipeline.md §2.2):
#   0a. the regression test is committed ALONE and proven to FAIL against unfixed code, and
#   0b. the same test passes after the fix. Plus the live-env e2e replay is mandatory — no smoke
#   fallback — because "the app serves" must never be able to stand in for "the symptom is gone".
# Then: comment the issue (URL + build/test summary + PR link) @-mentioning requestor + commenters.
# ANY unrecoverable break → move the issue to the Exceptions column + @-mention maintainers, and stop.
#
#   Env: ISSUE REPO URL HOST                — target issue, owner/repo, this sidekick's N.build URL, hostname
#        CLAUDE_CODE_OAUTH_TOKEN            — Max subscription (auto-picked-up; do NOT pass --bare)
#        GH_TOKEN                           — github.token: git push + gh reads + issue comments/labels
#        BOARD_TOKEN                        — BOT app token: gh pr create + board Status moves
#        WORK                               — the runner checkout dir ($GITHUB_WORKSPACE)
#        DOR_BUILD_MODEL (opt)              — model (default claude-opus-5; Fable is reserved for the spec side)
set -uo pipefail
FLOW_NOUN="build"
source "$(dirname "${BASH_SOURCE[0]}")/dor_build_lib.sh"

# ── Flow ─────────────────────────────────────────────────────────────────────────────────────────
cd "$WORK"
use_bot_remote   # push as the BOT app so the PR's CI actually runs (GITHUB_TOKEN pushes don't trigger it)
# Never let the agent's scratch (.dor/in/*) or the deploy override get committed into the PR.
grep -qxF '.dor/' .git/info/exclude 2>/dev/null || echo '.dor/' >> .git/info/exclude
grep -qxF 'dor-tls.override.yml' .git/info/exclude 2>/dev/null || echo 'dor-tls.override.yml' >> .git/info/exclude
# Consume the trigger label now so dor-resume.yml can re-apply it to re-dispatch a paused build.
gh issue edit "$ISSUE" --repo "$REPO" --remove-label ready-to-build >/dev/null 2>&1 || true
# Flip the board to Building the moment the build starts (i.e. right after the Product Board approved
# the gate) — not only after the PR is created ~15-20 min later, which would leave it wrongly reading
# "Awaiting approval" for the whole implement phase.
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" building 2>/dev/null || true
# Say so on the issue NOW, not after the PR exists. For a bug the PR is opened only after the whole
# red/green proof has run, so the first comment used to arrive 30-45 minutes in — the thread just sat
# silent while the machine worked, which is indistinguishable from the machine being dead. That
# ambiguity is the exact failure that left #370's requestor waiting 19 hours on a loop that had died.
comment_issue "$(printf '🔨 Started — building a fix.%s%s' \
  "$(is_bug && printf ' I reproduce the bug with a failing test first, fix it, then replay it on a live environment; expect ~30 min.' || printf '')" \
  "${RUN_URL:+ · 👀 [follow progress]($RUN_URL)}")"

# Resume-aware: if a branch with real work already exists (a previous run paused on a usage limit),
# continue from it instead of re-implementing from scratch — that is the expensive part we must not
# repeat (and re-running implement would just re-hit the limit).
git fetch origin "$BRANCH" -q 2>/dev/null || true
if git rev-parse --verify -q "origin/$BRANCH" >/dev/null && [ -n "$(git log --oneline "origin/main..origin/$BRANCH" 2>/dev/null)" ]; then
  echo "::notice::resuming from existing branch $BRANCH — skipping implement"
  git checkout -B "$BRANCH" "origin/$BRANCH" || bail "could not check out $BRANCH to resume"
else
  git checkout -B "$BRANCH" origin/main || bail "could not create branch $BRANCH"
  title="$(gh issue view "$ISSUE" --repo "$REPO" --json title --jq '.title')"

  if is_bug; then
    # The certified contract, if this issue has one. Issues certified before contracts existed still
    # build — they just get the generic prompts and no blast-radius check, and say so.
    CONTRACT=""
    if read_contract > /tmp/contract.json 2>/dev/null && jq -e . /tmp/contract.json >/dev/null 2>&1; then
      CONTRACT=/tmp/contract.json
      echo "::notice::repro contract found (confidence: $(jq -r '.confidence' "$CONTRACT"), tier: $(jq -r '.test_tier' "$CONTRACT"))"
      contract_brief="$(printf '\nThe probe certified this contract — build to it:\n  assertion that must fail then pass: %s\n  root cause: %s\n  expected blast radius: %s\n  test tier: %s\n  reporter path: %s\n' \
        "$(jq -r '.assertion'  "$CONTRACT")" \
        "$(jq -r '.root_cause' "$CONTRACT")" \
        "$(jq -r '.blast_radius | join(", ")' "$CONTRACT")" \
        "$(jq -r '.test_tier'  "$CONTRACT")" \
        "$(jq -r '.repro_path' "$CONTRACT")")"
    else
      contract_brief=""
      echo "::warning::#${ISSUE} carries no repro contract — building without the blast-radius check"
    fi

    # ── 1. RED FIRST ────────────────────────────────────────────────────────────────────────────
    # A test that was never red proves nothing. A green suite after a fix is equally consistent with
    # "bug fixed" and "test doesn't touch the bug" — and the same agent writes both, so the ordering
    # has to be enforced here rather than asked for in a prompt. Pass A produces the test ALONE and
    # the flow proves it fails; only then does pass B get to fix anything.
    run_claude "$(printf 'You are the DoR BUILD agent for IdentityAtlas, working on BUG #%s.
The certified probe packet is .dor/in/spec.json — the issue plus its CERTIFIED comment, which pins
the root cause and drafts the reproducing test. Follow CLAUDE.md and the subdirectory guides.

THIS PASS WRITES THE TEST, AND NOTHING ELSE.
  - Add or extend the automated test that reproduces the reported defect, at the layer the certified
    root cause names (app/api, app/ui, SQL, PowerShell).
  - It MUST fail against the code exactly as it is right now, and fail ON THE REPORTED BEHAVIOUR —
    an assertion about the wrong value, not a missing import and not a syntax error.
  - Do NOT modify, add or delete any production file. Nothing is fixed yet, so assert only against
    the EXISTING public API; if that means the test is a little indirect, that is correct.
  - Do NOT write a Playwright e2e in this pass; that comes with the fix.
Leave your changes in the working tree — do NOT commit, push or open a PR.%s' "$ISSUE" "$contract_brief")" \
      /tmp/impl-test.json "$IMPLEMENT_TURNS"
    case $? in
      0|3) : ;;
      2) pause_and_exit "hit a usage limit while writing the regression test" ;;
      *) bail "the AI errored while writing the regression test (see run log)" ;;
    esac
    git restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
    git add -A
    git diff --cached --quiet && bail "no regression test was produced for #${ISSUE} — a bug fix without a test that reproduces it cannot be verified"
    git commit -q -m "test: reproduce #${ISSUE} (red)" || bail "git commit failed (regression test)"

    # ── 2. PROVE IT RED ─────────────────────────────────────────────────────────────────────────
    run_touched_tests "origin/main...HEAD"
    case $? in
      1) cp /tmp/unit.log /tmp/red.log 2>/dev/null || true
         echo "::notice::red proof OK — the regression test fails against unfixed code"
         # The most informative moment of the whole build: the bug is now demonstrably real, in a
         # test, before anything has been fixed. Worth telling the thread.
         comment_issue "$(printf '🔴 Reproduced — the new regression test fails against today'\''s code:\n\n```\n%s\n```\n\nNow fixing it at the source.' \
           "$(grep -E 'FAIL|AssertionError|Expected:|Received:|✕|×' /tmp/red.log 2>/dev/null | head -6)")" ;;
      0) bail "the regression test PASSES against unfixed code, so it does not reproduce #${ISSUE}. A test that was never red proves nothing about the fix that follows it. Last run: $(tail -c 800 /tmp/unit.log 2>/dev/null)" ;;
      3) bail "the change contains no runnable unit test — only an e2e or no test at all. The red/green proof needs a test that can run before the fix exists." ;;
      4) bail "this change is PowerShell-only and no sidekick has pwsh installed, so the test cannot be proven red here. Install pwsh on the pool (tools/dor/provision-sidekick.sh) or take this one by hand." ;;
      *) bail "could not run the regression test (see the run log)" ;;
    esac

    # ── 3. FIX IT ───────────────────────────────────────────────────────────────────────────────
    run_claude "$(printf 'You are the DoR BUILD agent for IdentityAtlas. The failing regression test for BUG #%s
is already committed on this branch, and it currently FAILS. Now make it pass.

  - Fix at the SOURCE, not the surface: the layer that PRODUCES the wrong value (crawler / ingest /
    schema / matview / API), never a client-side patch over a data-model gap. The certified root
    cause in .dor/in/spec.json names it.
  - Do NOT weaken, skip or delete the committed test, and do not change what it asserts.
  - ALSO add or extend a Playwright e2e under app/ui/e2e/ that walks the reporter path from the
    packet. This is required: it is replayed against the deployed fix on a live environment, and a
    bug fix without one cannot be verified.
  - Update any docs the change affects and add the changelog fragment changes/dor-issue-%s.md
    (user-facing bullets). NEVER edit CHANGES.md or setup/IdentityAtlas.psd1. Do NOT touch .github/.
Leave your changes in the working tree — do NOT commit, push or open a PR.%s' "$ISSUE" "$ISSUE" "$contract_brief")" \
      /tmp/impl.json "$IMPLEMENT_TURNS"
    case $? in
      0|3) : ;;
      2) pause_and_exit "hit a usage limit during the fix" ;;
      *) bail "the AI fix step errored (see run log)" ;;
    esac
    git restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
    git add -A
    git diff --cached --quiet && bail "the AI produced no fix for #${ISSUE} (the regression test is still red)"
    git commit -q -m "$title (#${ISSUE})" || bail "git commit failed"

    # ── 4. PROVE IT GREEN ───────────────────────────────────────────────────────────────────────
    run_touched_tests "origin/main...HEAD" \
      || bail "the fix does not make the regression test pass. Last run: $(tail -c 800 /tmp/unit.log 2>/dev/null)"
    echo "::notice::green proof OK — the same test now passes"

    # ── 5. CONFORMANCE ──────────────────────────────────────────────────────────────────────────
    # The fix landing outside the radius the probe predicted means the diagnosis was wrong or the
    # scope crept. Neither is something another AI pass should paper over, so it stops here.
    # Size ceiling. A "bug fix" that rewrites ten production files is a refactor wearing a bug's
    # clothes — and under autonomy nobody chose to start it. Tests, docs, changelog fragments and the
    # .ci ratchet baselines are exempt: shipping MORE test than fix is exactly what we want, and the
    # baselines are a consequence of the change rather than part of it.
    prod_files="$(git diff --name-only origin/main...HEAD \
                  | grep -vE '\.(test|spec)\.(js|jsx)$|\.Tests\.ps1$|^changes/|^docs/|^\.ci/|package-lock\.json$' | wc -l)"
    # Field-based, not a regex over the whole line: numstat is "adds<TAB>dels<TAB>path", and a
    # pattern that depends on a literal tab surviving an edit is a bug waiting to happen.
    prod_lines="$(git diff --numstat origin/main...HEAD \
                  | awk -F'\t' '$3 !~ /\.(test|spec)\.(js|jsx)$|\.Tests\.ps1$|package-lock\.json$/ &&
                                $3 !~ /^(changes|docs|\.ci)\// {a+=$1; d+=$2} END {print a+d+0}')"
    if [ "${prod_files:-0}" -gt "${MAX_FIX_FILES:-10}" ] || [ "${prod_lines:-0}" -gt "${MAX_FIX_LINES:-400}" ]; then
      bail "this fix changed ${prod_files} production files / ${prod_lines} lines, past the ${MAX_FIX_FILES:-10}-file / ${MAX_FIX_LINES:-400}-line ceiling for a bug fix. That is refactor-sized: a human should decide whether it is the right change before it goes further."
    fi
    echo "::notice::size OK — ${prod_files} production files, ${prod_lines} lines"

    if [ -n "$CONTRACT" ]; then
      outside="$(blast_radius_violations "$CONTRACT" "origin/main...HEAD")"
      [ -n "$outside" ] && bail "the fix reached outside the certified blast radius ($(jq -r '.blast_radius | join(", ")' "$CONTRACT")) and touched: $(printf '%s' "$outside" | tr '\n' ' '). Either the root cause was mis-diagnosed or the scope grew — a human should look before this goes further."
      echo "::notice::blast-radius conformance OK"
    fi
  else
    # Features keep the single implement pass: their acceptance criteria are not a defect that can be
    # demonstrated failing first.
    run_claude "$(cat "$WORK/.dor/in/prompt.txt")" /tmp/impl.json "$IMPLEMENT_TURNS"
    case $? in
      0|3) : ;;   # 3 = ran out of turns; proceed with what it produced (the no-changes guard below catches an empty result)
      2) pause_and_exit "hit a usage limit during implement" ;;
      *) bail "the AI implement step errored (see run log)" ;;
    esac

    # .github is restored from HEAD, not origin/main. The restore exists to undo MODEL tampering, and
    # HEAD is already trusted for that — a bot commit never contains .github, precisely because of
    # this restore. Restoring from a MOVING main instead made every bot branch COMMIT a snapshot of CI
    # as it was at build time: #978 is carrying #976 and #977 that way, and a long-lived branch can
    # then conflict with, or partially revert, CI changes made after it started.
    git restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
    git add -A
    git diff --cached --quiet && bail "the AI produced no changes"
    git commit -q -m "$title (#${ISSUE})" || bail "git commit failed"
  fi
  push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH" || bail "could not push $BRANCH"
fi

# 2. Open the PR (BOT token — GITHUB_TOKEN can't create PRs here).
pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  pr=$(GH_TOKEN="$BOARD_TOKEN" gh pr create --repo "$REPO" --base main --head "$BRANCH" \
        --title "$(gh issue view "$ISSUE" --repo "$REPO" --json title --jq '.title')" \
        --body "$(printf 'Closes #%s\n\nBuilt autonomously by the DoR build agent from the approved spec. Functional-test env: %s\n\nDo not merge until CI is green and the requestor has accepted.' "$ISSUE" "$URL")" \
      | grep -oE '[0-9]+$') || bail "could not open the PR"
fi
claim_sidekick "$pr"   # ~/.dor-reservation + the sk:<label> that reset/feedback dispatch off
# (board was already moved to Building at the start of the run) — now post the PR + follow link.
comment_issue "$(printf '🔨 Building (PR #%s) — I'\''ll comment when it'\''s ready to test.%s' "$pr" "${RUN_URL:+ · 👀 [follow progress]($RUN_URL)}")"

# 3-5. Verify: deploy+seed → e2e on live env → CI green. Fix + retry up to MAX_ATTEMPTS (else Exceptions).
verify_loop "$pr"

# 6. All criteria met → move to Awaiting functional acceptance + notify requestor & commenters.
touch "${RUNNER_TEMP:-/tmp}/dor-done"   # tell the workflow's fresh-token reconcile step this succeeded
gh issue edit "$ISSUE" --repo "$REPO" --add-label build-done --remove-label state:awaiting-approval >/dev/null 2>&1 || true
# Best-effort: on a >1h build the BOARD_TOKEN (minted at job start, 1h life) may have expired. The
# build-done LABEL above is canonical for the acceptance workflow; the board column is reconciled by
# the workflow's always-run fresh-token step. So this is NOT fatal — the notify below must still run.
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" build-done 2>/dev/null \
  || echo "::warning::board move failed (BOT token likely expired on a long build) — label is set; the fresh-token step reconciles the column"

summary=$(jq -r '.result // empty' /tmp/impl.json 2>/dev/null | head -c 1200)
[ "${#summary}" -lt 25 ] && summary="$(changed_summary origin/main...HEAD)"   # terse output → describe from the diff
[ -n "$summary" ] || summary="Implemented the approved spec; unit tests and the feature e2e on the live env pass."
comment_issue "$(printf '%s — ✅ built and ready to test.\n\n🔗 **Test:** %s   ·   📦 **PR:** #%s\n\n%s\n\nReply with anything that'\''s off, or **`approved`** to send it to merge.' "$(issue_mentions)" "$URL" "$pr" "$summary")"
# The PR gets the evidence bundle rather than a one-line assertion of success: this is the artefact
# the merge review reads, and every claim in it carries the run output behind it. Bugs only — a
# feature has no red proof to show, and a bundle with half its rows missing teaches reviewers to
# skim. (Best-effort: a reporting failure must never fail a build that actually passed.)
if is_bug; then
  PR="$pr" CONTRACT="${CONTRACT:-}" bash "$SCRIPTS/dor_evidence.sh" || echo "::warning::evidence bundle step failed"
else
  gh pr comment "$pr" --repo "$REPO" --body "🤖 Built + verified on **${HOST}** (e2e + CI green) → ${URL}" >/dev/null 2>&1 || true
fi
echo "::notice::#${ISSUE} built + verified → Awaiting functional acceptance (PR #${pr}, ${URL})"
