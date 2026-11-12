#!/usr/bin/env bash
# Open or refresh one pull request per PowerShell module whose pin is behind the
# gallery. Called by .github/workflows/ps-module-updates.yml; tested by
# test/ci-scripts/test-ps-module-update-prs.sh.
#
# Input: $UPDATES, the JSON Update-PinnedModule.ps1 -List prints:
#   [{"Name":"PSMutant","From":"0.5.0","To":"0.9.2","Spent":["0.9.1 -- reason"]}, ...]
# Pushes deps/psmodule-<name> to `origin` and opens or retitles its PR with `gh`.
# For PSMutant it also starts ps-mutation.yml on that branch (with $ACTIONS_TOKEN),
# because mutation testing never runs on a pull request by itself.
set -euo pipefail

PWSH="${PWSH:-pwsh}"
PIN_FILE=.ci/powershell-modules.json

# Committer identity per command, never written to the repository's config.
BOT=(-c "user.name=github-actions[bot]" -c "user.email=github-actions[bot]@users.noreply.github.com")

pinned_on_branch() {  # $1 branch, $2 module -> that branch's pin, or empty
  # MSYS_NO_PATHCONV: Git Bash on Windows would rewrite "<ref>:<path>" as a path list.
  MSYS_NO_PATHCONV=1 git show "origin/$1:$PIN_FILE" 2>/dev/null | jq -r --arg m "$2" '.modules[$m].version // empty'
}

pr_body() {  # $1 name, $2 from, $3 to, $4 spent (JSON array)
  echo "Moves the pinned **$1** from $2 to $3 in \`$PIN_FILE\`."
  echo
  echo "Release notes: https://www.powershellgallery.com/packages/$1/$3"
  if [ "$(jq 'length' <<<"$4")" -gt 0 ]; then
    echo
    echo "The move passes these held-back versions, and drops them from \`skip\`. Check the reason no longer applies:"
    jq -r '.[] | "- " + .' <<<"$4"
  fi
  if [ "$1" = "PSMutant" ]; then
    echo
    echo "Mutation testing does not run on pull requests; a **PowerShell mutation testing** run was started on this branch. Its score is this branch's and is not published."
  fi
  echo
  echo "Opened by \`.github/workflows/ps-module-updates.yml\`."
}

# Read the list on fd 3: git, gh and pwsh inside the loop may read stdin, and
# would swallow the modules after the first.
while IFS= read -r u <&3; do
  name="$(jq -r .Name <<<"$u")"; from="$(jq -r .From <<<"$u")"; to="$(jq -r .To <<<"$u")"
  spent="$(jq -c '.Spent // []' <<<"$u")"
  branch="deps/psmodule-$(tr '[:upper:]' '[:lower:]' <<<"$name")"
  title="ci: bump $name from $from to $to"

  git fetch --quiet origin main
  # Drop the tracking ref first: if the branch is gone from origin (its PR merged
  # or closed), a stale copy would read as "already up to date" and skip the push.
  git update-ref -d "refs/remotes/origin/$branch" 2>/dev/null || true
  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null || true

  if [ "$(pinned_on_branch "$branch" "$name")" = "$to" ]; then
    echo "$name: $branch already moves the pin to $to"
  else
    git checkout --quiet -B "$branch" origin/main
    "$PWSH" -NoProfile -File tools/psmodules/Update-PinnedModule.ps1 -Name "$name" -Version "$to"
    mkdir -p changes
    fragment="changes/psmodule-$(tr '[:upper:]' '[:lower:]' <<<"$name").md"
    echo "- Upgraded the PowerShell CI module $name from $from to $to." > "$fragment"
    git add "$PIN_FILE" "$fragment"
    git "${BOT[@]}" commit --quiet -m "$title"
    git push --quiet --force origin "$branch"
    echo "$name: pushed $branch at $to"

    if [ "$name" = "PSMutant" ]; then
      GH_TOKEN="${ACTIONS_TOKEN:-$GH_TOKEN}" gh workflow run ps-mutation.yml --ref "$branch"
    fi
  fi

  number="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
  if [ -n "$number" ]; then
    gh pr edit "$number" --title "$title" --body-file <(pr_body "$name" "$from" "$to" "$spent") >/dev/null
    echo "$name: refreshed PR #$number"
  else
    gh pr create --base main --head "$branch" --title "$title" --body-file <(pr_body "$name" "$from" "$to" "$spent") >/dev/null
    echo "$name: opened a PR"
  fi
done 3< <(jq -c ".[]" <<<"$UPDATES")
