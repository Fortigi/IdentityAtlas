#!/usr/bin/env bash
# Unit tests for .github/scripts/recent_changes.sh — the "last 24 hours" the nightly
# docs and test-coverage reviews are handed.
#
# The regression this guards: both reviews diffed `HEAD@{24 hours ago}..HEAD`. That is
# a reflog lookup, and a fresh CI checkout has a one-entry reflog, so git resolved it
# to HEAD itself, the diff was empty, and every night both reviews concluded "only
# non-source files changed" and skipped. The decisive case below therefore runs in a
# FRESH CLONE — in the repo the commits were made in, the reflog would hide the bug.
#
# Each case builds a throwaway repo with back-dated commits. No network.
#
# Usage: bash test/ci-scripts/test-recent-changes.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/recent_changes.sh"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; echo "       expected: $2"; echo "       actual:   $3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NOW=$(date -u +%s)
iso() { date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ'; }
SINCE="$(iso $((NOW - 24 * 3600)))"

# commit <repo> <hours-ago> <file> [message]
commit() {
  local when; when="$(iso $((NOW - $2 * 3600)))"
  mkdir -p "$1/$(dirname "$3")"; echo "$3 @ $2h" >> "$1/$3"
  git -C "$1" add -A
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git -C "$1" commit -qm "${4:-change $3}"
}
newrepo() { git init -q "$1"; git -C "$1" config user.email t@example.invalid; git -C "$1" config user.name t; git -C "$1" config core.autocrlf false; }
run() { # <repo> → rc, files, commits
  set +e; (cd "$1" && bash "$SCRIPT" "$SINCE" "$WORK/out" >/dev/null 2>&1); rc=$?; set -e
  files="$(tr '\n' ' ' < "$WORK/out/changed_files.txt" | sed 's/ $//')"
  commits="$(grep -c '' "$WORK/out/recent_commits.txt" || true)"
}

echo "recent_changes.sh"

# ── The regression: a fresh clone, many commits in the window ────────────────
O="$WORK/origin"; newrepo "$O"
commit "$O" 72 app/api/old.js
commit "$O" 30 docs/before-window.md
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do commit "$O" $((20 - i)) "app/api/f$i.js"; done
commit "$O" 1 app/ui/late.jsx
git clone -q "$O" "$WORK/clone"
run "$WORK/clone"
check "fresh clone: commits in the window are found" 0 "$rc"
check "fresh clone: lists all 13 in-window commits (more than the old HEAD~10 fallback)" 13 "$commits"
expected="app/api/f1.js app/api/f10.js app/api/f11.js app/api/f12.js app/api/f2.js app/api/f3.js app/api/f4.js app/api/f5.js app/api/f6.js app/api/f7.js app/api/f8.js app/api/f9.js app/ui/late.jsx"
check "fresh clone: changed files are exactly the in-window ones" "$expected" "$files"

# ── Files touched both before and inside the window ──────────────────────────
R="$WORK/both"; newrepo "$R"
commit "$R" 50 app/api/a.js
commit "$R" 40 docs/old.md
commit "$R" 5 app/api/a.js
run "$R"
check "a file changed in the window is listed even if it also changed before" "app/api/a.js" "$files"

# ── Nothing in the window ────────────────────────────────────────────────────
R="$WORK/quiet"; newrepo "$R"
commit "$R" 48 app/api/a.js
commit "$R" 30 app/api/b.js
run "$R"
check "no commits in the window exits 3 (nothing to review)" 3 "$rc"
check "no commits in the window writes an empty file list" "" "$files"

# ── Whole history inside the window (no commit before it) ────────────────────
R="$WORK/young"; newrepo "$R"
commit "$R" 3 app/api/a.js
commit "$R" 2 README.md
run "$R"
check "a repo younger than the window diffs against the empty tree" "README.md app/api/a.js" "$files"

# ── Merge commits are not listed, but what they bring in is ──────────────────
R="$WORK/merge"; newrepo "$R"
commit "$R" 40 base.txt
git -C "$R" checkout -qb side
commit "$R" 4 side/s.js
git -C "$R" checkout -q -
commit "$R" 3 main/m.js
GIT_COMMITTER_DATE="$(iso $((NOW - 7200)))" git -C "$R" merge -q --no-edit side
run "$R"
check "merge commits are left out of the commit list" 2 "$commits"
check "files brought in by a merge are listed" "main/m.js side/s.js" "$files"

# ── Commits but an empty diff: fail loudly, never report "nothing changed" ───
R="$WORK/empty"; newrepo "$R"
commit "$R" 30 app/api/a.js
when="$(iso $((NOW - 3600)))"
GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git -C "$R" commit -q --allow-empty -m "empty"
run "$R"
check "commits with no changed files exit 1, not a silent skip" 1 "$rc"

set +e; bash "$SCRIPT" >/dev/null 2>&1; rc=$?; set -e
check "missing arguments are a usage error" 1 "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"

echo
echo "recent-changes: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
