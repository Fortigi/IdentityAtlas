#!/usr/bin/env bash
# Unit tests for .github/scripts/ps_module_update_prs.sh -- the half of
# ps-module-updates.yml that turns "the gallery has a newer version" into one
# pull request per module.
#
# Runs the real script against a throwaway git remote. `gh` is a stub that logs
# its calls and answers `pr list` from a fixture; `pwsh` is a stub that moves the
# pin with jq, as Update-PinnedModule.ps1 -Name -Version does (that script's own
# logic is covered by test/unit/PinnedModules.Tests.ps1). No network.
#
# Usage: bash test/ci-scripts/test-ps-module-update-prs.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/ps_module_update_prs.sh"
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

PASS=0
FAIL=0
check() {  # $1 description, $2 expected, $3 actual
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1))
  else echo "  FAIL  $1"; echo "        expected: $(printf '%q' "$2")"; echo "        actual:   $(printf '%q' "$3")"; FAIL=$((FAIL + 1)); fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FIX="$TMP/fix"; mkdir -p "$FIX" "$TMP/bin"

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/gh.log"
if [ "$1 $2" = "pr list" ]; then cat "$FIX/open_pr" 2>/dev/null || true; fi
if [ "$1 $2" = "pr create" ] || [ "$1 $2" = "pr edit" ]; then
  prev=""; for a in "$@"; do [ "$prev" = "--body-file" ] && cat "$a" > "$FIX/body"; prev="$a"; done
fi
STUB
cat > "$TMP/bin/pwsh" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -Name) n="$2"; shift;; -Version) v="$2"; shift;; esac; shift; done
f=.ci/powershell-modules.json
jq --arg n "$n" --arg v "$v" '.modules[$n].version = $v | del(.modules[$n].skip)' "$f" > "$f.new" && mv "$f.new" "$f"
STUB
chmod +x "$TMP/bin/gh" "$TMP/bin/pwsh"
export PATH="$TMP/bin:$PATH"

# A remote whose main pins PSComplexity 0.5.1 and PSMutant 0.5.0, and a clone of it.
git init --quiet --bare "$TMP/origin.git"
# The Windows form of the path, for calls made with path conversion off (Git Bash only).
ORIGIN_WIN="$TMP/origin.git"; command -v cygpath >/dev/null && ORIGIN_WIN="$(cygpath -m "$ORIGIN_WIN")"
git clone --quiet "$TMP/origin.git" "$TMP/work" 2>/dev/null
cd "$TMP/work"
git config user.name t; git config user.email t@t
git checkout --quiet -b main
mkdir -p .ci changes tools/psmodules
echo '{"modules":{"PSComplexity":{"version":"0.5.1"},"PSMutant":{"version":"0.5.0","skip":{"0.9.1":"refuses the run"}}}}' > .ci/powershell-modules.json
touch tools/psmodules/Update-PinnedModule.ps1
git add -A; git commit --quiet -m init; git push --quiet origin main

run() {  # $1 updates JSON
  : > "$FIX/gh.log"; rm -f "$FIX/body"
  git checkout --quiet main
  UPDATES="$1" GH_TOKEN=x bash "$SCRIPT" > "$FIX/out" 2>&1 || { cat "$FIX/out"; return 1; }
}
remote_pin() { MSYS_NO_PATHCONV=1 git --git-dir="$ORIGIN_WIN" show "$1:.ci/powershell-modules.json" | jq -r ".modules.$2.version"; }

echo "A module behind the gallery gets a branch and a new PR"
run '[{"Name":"PSComplexity","From":"0.5.1","To":"0.7.1","Spent":[]}]'
check "branch pins the new version"        "0.7.1" "$(remote_pin deps/psmodule-pscomplexity PSComplexity)"
check "other modules are untouched"        "0.5.0" "$(remote_pin deps/psmodule-pscomplexity PSMutant)"
check "a changelog fragment rides along"   "- Upgraded the PowerShell CI module PSComplexity from 0.5.1 to 0.7.1." \
  "$(MSYS_NO_PATHCONV=1 git --git-dir="$ORIGIN_WIN" show deps/psmodule-pscomplexity:changes/psmodule-pscomplexity.md)"
check "a PR is created against main"       "1" "$(grep -c '^pr create --base main --head deps/psmodule-pscomplexity --title ci: bump PSComplexity from 0.5.1 to 0.7.1' "$FIX/gh.log")"
check "no mutation run for PSComplexity"   "0" "$(grep -c '^workflow run' "$FIX/gh.log" || true)"

echo "The same version again, with its PR open: nothing is pushed"
before="$(git --git-dir="$TMP/origin.git" rev-parse deps/psmodule-pscomplexity)"
echo 41 > "$FIX/open_pr"
run '[{"Name":"PSComplexity","From":"0.5.1","To":"0.7.1","Spent":[]}]'
check "branch head unchanged"              "$before" "$(git --git-dir="$TMP/origin.git" rev-parse deps/psmodule-pscomplexity)"
check "no second PR"                       "0" "$(grep -c '^pr create' "$FIX/gh.log" || true)"
check "the open PR is refreshed"           "1" "$(grep -c '^pr edit 41 ' "$FIX/gh.log")"

echo "A newer release moves the open PR's branch instead of opening another"
run '[{"Name":"PSComplexity","From":"0.5.1","To":"0.8.0","Spent":[]}]'
check "branch moved to the newer version"  "0.8.0" "$(remote_pin deps/psmodule-pscomplexity PSComplexity)"
check "branch is still one commit on main" "1" "$(git --git-dir="$TMP/origin.git" rev-list --count main..deps/psmodule-pscomplexity)"
check "the open PR is retitled"            "1" "$(grep -c '^pr edit 41 --title ci: bump PSComplexity from 0.5.1 to 0.8.0' "$FIX/gh.log")"
rm -f "$FIX/open_pr"

echo "A PSMutant bump starts mutation testing on its branch and quotes the skip it passes"
run '[{"Name":"PSMutant","From":"0.5.0","To":"0.9.2","Spent":["0.9.1 -- refuses the run"]}]'
check "branch pins the new version"        "0.9.2" "$(remote_pin deps/psmodule-psmutant PSMutant)"
check "mutation run started on the branch" "1" "$(grep -c '^workflow run ps-mutation.yml --ref deps/psmodule-psmutant$' "$FIX/gh.log")"
check "PR body quotes the passed skip"     "1" "$(grep -c '^- 0.9.1 -- refuses the run$' "$FIX/body")"

echo "Two modules in one run get two branches"
git --git-dir="$TMP/origin.git" branch -D deps/psmodule-pscomplexity deps/psmodule-psmutant >/dev/null
run '[{"Name":"PSComplexity","From":"0.5.1","To":"0.7.1","Spent":[]},{"Name":"PSMutant","From":"0.5.0","To":"0.9.2","Spent":[]}]'
check "PSComplexity branch alone moves PSComplexity" "0.5.0" "$(remote_pin deps/psmodule-pscomplexity PSMutant)"
check "PSMutant branch alone moves PSMutant"         "0.5.1" "$(remote_pin deps/psmodule-psmutant PSComplexity)"
check "two PRs"                                      "2" "$(grep -c '^pr create' "$FIX/gh.log")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
