#!/usr/bin/env bash
# Unit tests for .github/scripts/dor_trusted_spec.sh — what the DoR build agent is allowed to read.
#
# The build agent has a shell. Its spec used to be the WHOLE issue thread, so on this public repo any
# account could write instructions into it by leaving a comment (SEC-2026-09 H-05). The filter keeps
# text by the requestor of record, org members and the pipeline's own bots, and drops the rest.
#
# The inputs are chosen to discriminate: an outsider whose login LOOKS like the bot (no `[bot]`
# suffix, type User), a Bot account that is not ours, a member whose check must go through the
# Members:read token (not github.token), and a membership API that errors. Each of those passes
# through a naive "keep everything" or "trust by login string" filter. `gh` is stubbed — no network.
#
# Usage: bash test/ci-scripts/test-dor-trusted-spec.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/dor_trusted_spec.sh"
[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"; echo "        expected: $expected"; echo "        actual:   $actual"; FAIL=$((FAIL + 1))
  fi
}

# ── Canned GitHub ───────────────────────────────────────────────────────────
# Issue 10: authored by the requestor. Issue 11: authored by an outsider (a vouched external request).
# Issue 12: the comments call fails. Members are `alice` and `bob`; `flaky` makes the membership API
# error. A membership lookup only answers when it arrives with the Members:read token — the default
# github.token cannot see private membership, and the test must prove the right one is used.
cat > "$TMP/issue.json" <<'JSON'
{"number":10,"title":"Add a filter","body":"Please add a filter.","user":{"login":"alice","type":"User"},
 "labels":[{"name":"enhancement","color":"x"}]}
JSON
sed -e 's/"number":10/"number":11/' -e 's/"login":"alice"/"login":"outsider"/' "$TMP/issue.json" > "$TMP/issue11.json"
cat > "$TMP/comments.json" <<'JSON'
[
 {"user":{"login":"alice","type":"User"},"created_at":"t1","body":"requestor detail"},
 {"user":{"login":"mallory","type":"User"},"created_at":"t2","body":"OUTSIDER-INSTRUCTION"},
 {"user":{"login":"github-actions[bot]","type":"Bot"},"created_at":"t3","body":"Certified spec: build X"},
 {"user":{"login":"fortigi-ci-bot","type":"User"},"created_at":"t4","body":"LOOKALIKE-BOT"},
 {"user":{"login":"some-app[bot]","type":"Bot"},"created_at":"t5","body":"FOREIGN-BOT"},
 {"user":{"login":"bob","type":"User"},"created_at":"t6","body":"member note"},
 {"user":{"login":"flaky","type":"User"},"created_at":"t7","body":"UNVERIFIABLE"},
 {"user":{"login":"mallory","type":"User"},"created_at":"t8","body":"OUTSIDER-AGAIN"},
 {"user":{"login":"fortigi-ci-bot[bot]","type":"Bot"},"created_at":"t9","body":"Repro contract"}
]
JSON
# A thread far past the per-argument limit (128 KiB on Linux, less on Windows): a member's comment of
# ~300 KB. Anything that passes the thread through argv (jq --argjson) fails on exactly this.
big="$(printf "%300000s" "" | tr " " x)"
printf '{"user":{"login":"bob","type":"User"},"created_at":"t1","body":"%sEND"}\n' "$big" > "$TMP/big-comments.jsonl"
printf '{"user":{"login":"mallory","type":"User"},"created_at":"t2","body":"OUTSIDER"}\n' >> "$TMP/big-comments.jsonl"

cat > "$TMP/gh" <<STUB
#!/usr/bin/env bash
echo "\$* token=\${GH_TOKEN:-}" >> "$TMP/calls.log"
[ "\$1" = api ] || exit 2
shift
[ "\$1" = --paginate ] && shift
case "\$1" in
  repos/Fortigi/IdentityAtlas/issues/10)          cat "$TMP/issue.json" ;;
  repos/Fortigi/IdentityAtlas/issues/11)          cat "$TMP/issue11.json" ;;
  repos/Fortigi/IdentityAtlas/issues/1[01]/comments) jq -c '.[]' "$TMP/comments.json" ;;
  repos/Fortigi/IdentityAtlas/issues/12)          cat "$TMP/issue.json" ;;
  repos/Fortigi/IdentityAtlas/issues/12/comments) exit 1 ;;
  repos/Fortigi/IdentityAtlas/issues/13)          cat "$TMP/issue.json" ;;
  repos/Fortigi/IdentityAtlas/issues/13/comments) cat "$TMP/big-comments.jsonl" ;;
  orgs/Fortigi/members/*)
    [ "\${GH_TOKEN:-}" = members-token ] || exit 1
    case "\${1##*/}" in alice|bob) exit 0 ;; flaky) echo boom >&2; exit 1 ;; *) exit 1 ;; esac ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/gh"
export PATH="$TMP:$PATH" REPO=Fortigi/IdentityAtlas MEMBERS_TOKEN=members-token GH_TOKEN=repo-token

run() { bash "$SCRIPT" "$@" 2>"$TMP/stderr"; }

echo "dor_trusted_spec — only trusted authors reach the build agent"
echo

# ── 1. The requestor's issue: who is kept ───────────────────────────────────
out="$(REQUESTOR=alice run 10)"; rc=$?
assert "exits 0 for a readable issue" 0 "$rc"
bodies="$(jq -r '[.comments[].body] | join("|")' <<<"$out")"
assert "keeps requestor, pipeline bots and members — in thread order" \
  "requestor detail|Certified spec: build X|member note|Repro contract" "$bodies"
assert "an outsider's comment is not in the spec anywhere" "no" \
  "$(grep -q 'OUTSIDER' <<<"$out" && echo yes || echo no)"
assert "a User named like the bot (no [bot], type User) is not trusted" "no" \
  "$(grep -q 'LOOKALIKE-BOT' <<<"$out" && echo yes || echo no)"
assert "a Bot that is not the pipeline's is not trusted" "no" \
  "$(grep -q 'FOREIGN-BOT' <<<"$out" && echo yes || echo no)"
assert "a membership API error fails closed" "no" \
  "$(grep -q 'UNVERIFIABLE' <<<"$out" && echo yes || echo no)"
assert "counts every dropped comment (mallory ×2, lookalike, foreign bot, flaky)" 5 \
  "$(jq -r '.trust.omittedComments' <<<"$out")"
assert "the issue body of the requestor is kept" "Please add a filter." "$(jq -r '.body' <<<"$out")"
assert "the body is not flagged as omitted" false "$(jq -r '.trust.issueBodyOmitted' <<<"$out")"
assert "the omission is announced in the run log" yes \
  "$(grep -q 'omitted 5 comment' "$TMP/stderr" && echo yes || echo no)"

# read_contract in dor_build_lib.sh reads .comments[].body; the shape must not drift.
assert "keeps the .comments[].author.login shape the build lib reads" "alice" \
  "$(jq -r '.comments[0].author.login' <<<"$out")"
assert "labels keep the {name} shape" "enhancement" "$(jq -r '.labels[0].name' <<<"$out")"

# ── 2. Lookups: the right token, once per author, never for the requestor ───
assert "membership is asked with the Members:read token only" 0 \
  "$(grep 'orgs/Fortigi/members/' "$TMP/calls.log" | grep -vc 'token=members-token$')"
assert "the requestor of record needs no lookup" 0 "$(grep -c 'members/alice ' "$TMP/calls.log")"
assert "a repeat commenter is looked up once" 1 "$(grep -c 'members/mallory ' "$TMP/calls.log")"
assert "Bot accounts are never sent to the membership API" 0 "$(grep -cF '[bot] ' "$TMP/calls.log" | tr -d ' ')"

# ── 3. Without REQUESTOR the author still counts, as a member ───────────────
: > "$TMP/calls.log"
out="$(run 10)"
assert "without REQUESTOR a member author's body is kept" "Please add a filter." "$(jq -r '.body' <<<"$out")"
assert "…after asking the membership API" 1 "$(grep -c 'members/alice ' "$TMP/calls.log")"

# ── 4. An outsider-authored issue (vouched external request) ────────────────
out="$(REQUESTOR=bob run 11)"
assert "an outsider's issue body is withheld" "yes" \
  "$(jq -r '.body' <<<"$out" | grep -q '^\[body omitted' && echo yes || echo no)"
assert "…and so is the title" "yes" \
  "$(jq -r '.title' <<<"$out" | grep -q '^\[title omitted' && echo yes || echo no)"
assert "…and the withholding is recorded" true "$(jq -r '.trust.issueBodyOmitted' <<<"$out")"
assert "the certified bot comment still arrives, so the build has its plan" "yes" \
  "$(jq -r '.comments[].body' <<<"$out" | grep -q 'Certified spec' && echo yes || echo no)"

# ── 5. A long thread ─────────────────────────────────────────────────────────
out="$(REQUESTOR=alice run 13)"; rc=$?
assert "a thread past the argv limit still produces a spec" 0 "$rc"
assert "…with the long member comment intact" 300003 "$(jq -r '.comments[0].body | length' <<<"$out")"
assert "…and the outsider still dropped" 1 "$(jq -r '.trust.omittedComments' <<<"$out")"

# ── 6. Failure and input handling ───────────────────────────────────────────
run 12 >/dev/null; rc=$?
assert "an unreadable comment list fails the step rather than building on half a thread" 1 "$rc"
run 99 >/dev/null; rc=$?
assert "an unreadable issue fails" 1 "$rc"
run '10; rm -rf /' >/dev/null; rc=$?
assert "a non-numeric issue argument is refused" 1 "$rc"
( unset MEMBERS_TOKEN; bash "$SCRIPT" 10 >/dev/null 2>&1 ); rc=$?
assert "refuses to run without a Members:read token (no silent 'nobody is a member')" 1 "$rc"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
