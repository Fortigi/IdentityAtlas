<#
.SYNOPSIS
    Refuses a release whose code has not already landed on main.

.DESCRIPTION
    main only takes commits through an approved, CI-green pull request, so "on
    main" is what "reviewed" means here. The cut-* workflows call this before they
    create a tag; a failure stops the release before anything is published.

      -Mode Release   (Cut Release, Cut Beta)
          The commit to tag must be on main.

      -Mode Hotfix    (Cut Hotfix)
          The branch starts at a stable release tag. Every commit after that tag
          must either be on main itself, or be a `git cherry-pick -x` of a commit
          on main that changes exactly the same lines. A conflict resolved while
          cherry-picking changes lines no reviewer saw, so it is refused too.

    v6.0.1 was cut from a hotfix branch whose PR had not been approved yet,
    because nothing checked this. Workflows load this script from their own
    commit (GITHUB_WORKFLOW_SHA), never from the ref being released, so a branch
    cannot ship an edited copy that lets itself through.

.EXAMPLE
    pwsh tools/release/Assert-ReleaseFromMain.ps1 -Mode Hotfix -Ref origin/bugfixes/fix-foo
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Release', 'Hotfix')][string] $Mode,
    [Parameter(Mandatory)][string] $Ref,
    [string] $Main = 'origin/main'
)

$ErrorActionPreference = 'Stop'

function Resolve-Commit([string] $Name) {
    $sha = git rev-parse --verify --quiet "$Name^{commit}"
    if ($LASTEXITCODE -ne 0 -or -not $sha) { throw "'$Name' is not a commit in this repository." }
    return "$sha".Trim()
}

function Test-OnMain([string] $Commit, [string] $MainSha) {
    git merge-base --is-ancestor $Commit $MainSha
    return $LASTEXITCODE -eq 0
}

# Identity of the lines a commit adds and removes, ignoring context and line
# numbers, so a clean cherry-pick onto an older base still matches its source.
function Get-ChangedLinesId([string] $Commit) {
    $id = git show -U0 --format= $Commit | git patch-id --stable
    return "$id".Split(' ')[0]
}

function Get-CherryPickSource([string] $Commit) {
    $message = (git log -1 --format=%B $Commit) -join "`n"
    $found = [regex]::Matches($message, '\(cherry picked from commit ([0-9a-f]{40})\)')
    if ($found.Count -eq 0) { return $null }
    return $found[$found.Count - 1].Groups[1].Value
}

function Get-HotfixBaseTag([string] $Sha) {
    $tag = git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*-*' $Sha 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $tag) { return $null }
    return "$tag".Trim()
}

function Get-HotfixCommitProblem([string] $Commit, [string] $MainSha) {
    if (Test-OnMain $Commit $MainSha) { return $null }
    $short = $Commit.Substring(0, 9)
    $source = Get-CherryPickSource $Commit
    if (-not $source) {
        return "$short is not on main and is not a 'git cherry-pick -x' of a commit on main."
    }
    git cat-file -e "$source^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not (Test-OnMain $source $MainSha)) {
        return "$short was cherry-picked from $($source.Substring(0, 9)), which is not on main."
    }
    if ((Get-ChangedLinesId $Commit) -ne (Get-ChangedLinesId $source)) {
        return "$short changes different lines than $($source.Substring(0, 9)) on main (conflict resolved by hand?)."
    }
    return $null
}

function Get-HotfixProblems([string] $Sha, [string] $MainSha) {
    $tag = Get-HotfixBaseTag $Sha
    if (-not $tag) { return @("no stable release tag (vX.Y.Z) in the history of the hotfix branch; branch it from one.") }
    $commits = @(git rev-list --reverse "$tag..$Sha")
    if ($commits.Count -eq 0) { return @("the hotfix branch has no commits after $tag.") }
    return @($commits | ForEach-Object { Get-HotfixCommitProblem $_ $MainSha } | Where-Object { $_ })
}

$mainSha = Resolve-Commit $Main
$sha = Resolve-Commit $Ref

$problems = if ($Mode -eq 'Release') {
    if (Test-OnMain $sha $mainSha) { @() } else { @("$($sha.Substring(0, 9)) ('$Ref') is not on main.") }
} else {
    Get-HotfixProblems $sha $mainSha
}

if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Output "::error::$p" }
    Write-Output 'A release may only contain code already merged to main through an approved PR.'
    Write-Output 'Hotfix: merge the fix to main first, then: git checkout -b bugfixes/<name> vX.Y.Z && git cherry-pick -x <main commit>'
    exit 1
}
Write-Output "OK: everything in '$Ref' is on main ($Mode)."
