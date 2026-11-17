<#
.SYNOPSIS
    Refuses a release whose code has not already landed on main.

.DESCRIPTION
    main only takes commits through an approved, CI-green pull request, so "on
    main" is what "reviewed" means here. The cut-* workflows call this before they
    create a tag; a failure stops the release before anything is published.

      -Mode Release   (Cut Release, Cut Beta)
          The commit to tag must be on main.

      -Mode Hotfix    (Cut Hotfix, and Cut Beta of the release line)
          The branch starts at a stable release tag. Every commit after that tag
          must be one of:
            * on main itself;
            * a `git cherry-pick -x` of a commit on main that changes exactly the
              same lines. A conflict resolved while cherry-picking changes lines
              no reviewer saw, so it is refused too;
            * a Dependabot dependency update merged into the release line
              (release/X.Y for a vX.Y.* tag).

    The Dependabot case is the one exception to "main first" (agreed Nov 2026),
    so the stable line gets its library updates every week. Those updates cannot
    be cherry-picked from main: a week after v6.1.1, 10 of 12 conflicted in the
    lockfiles. The exception is narrow: authored by Dependabot, merged through a
    GitHub pull request, on that release branch, changing only package.json /
    package-lock.json of app/api and app/ui and the Dockerfiles, and within
    those only dependency versions, npm registry tarballs and FROM lines.

    v6.0.1 was cut from a hotfix branch whose PR had not been approved yet,
    because nothing checked this. Workflows load this script from their own
    commit (GITHUB_WORKFLOW_SHA), never from the ref being released, so a branch
    cannot ship an edited copy that lets itself through. That is also why this is
    one file: the workflows copy it alone, so it cannot dot-source a helper.

.EXAMPLE
    pwsh tools/release/Assert-ReleaseFromMain.ps1 -Mode Hotfix -Ref origin/release/6.1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Release', 'Hotfix')][string] $Mode,
    [Parameter(Mandatory)][string] $Ref,
    [string] $Main = 'origin/main',
    # Release lines are <prefix>X.Y. Tests pass 'release/' for a local repository.
    [string] $ReleaseBranchPrefix = 'origin/release/'
)

$ErrorActionPreference = 'Stop'

$DependabotEmail = '49699333+dependabot[bot]@users.noreply.github.com'
$GitHubMergeEmail = 'noreply@github.com'
$ManifestPattern = '^app/(api|ui)/package\.json$'
$LockfilePattern = '^app/(api|ui)/package-lock\.json$'
$DockerfilePattern = '^(app/(api|ui)/Dockerfile|setup/docker/Dockerfile\.[A-Za-z0-9-]+)$'
$DependencySections = @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')
$PlainVersion = '^[\^~]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'

function Resolve-Commit([string] $Name) {
    $sha = git rev-parse --verify --quiet "$Name^{commit}"
    if ($LASTEXITCODE -ne 0 -or -not $sha) { throw "'$Name' is not a commit in this repository." }
    return "$sha".Trim()
}

function Test-Ancestor([string] $Commit, [string] $Of) {
    git merge-base --is-ancestor $Commit $Of 2>$null
    return $LASTEXITCODE -eq 0
}

function Test-OnMain([string] $Commit, [string] $MainSha) { Test-Ancestor $Commit $MainSha }

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

function Get-ReleaseLineBranch([string] $Tag) {
    if ($Tag -notmatch '^v(\d+)\.(\d+)\.\d+$') { return $null }
    return "$ReleaseBranchPrefix$($Matches[1]).$($Matches[2])"
}

function Get-CherryPickProblem([string] $Commit, [string] $Source, [string] $MainSha) {
    $short = $Commit.Substring(0, 9)
    git cat-file -e "$Source^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not (Test-OnMain $Source $MainSha)) {
        return "$short was cherry-picked from $($Source.Substring(0, 9)), which is not on main."
    }
    if ((Get-ChangedLinesId $Commit) -ne (Get-ChangedLinesId $Source)) {
        return "$short changes different lines than $($Source.Substring(0, 9)) on main (conflict resolved by hand?)."
    }
    return $null
}

# ── The Dependabot exception ────────────────────────────────────────────────

# The +/- lines of one file in one commit, without the +++/--- headers.
function Get-ChangedLines([string] $Commit, [string] $File) {
    @(git show -U0 --format= $Commit -- $File | Where-Object { $_ -match '^[+-]' -and $_ -notmatch '^(\+\+\+|---) ' })
}

function Get-JsonAt([string] $Commit, [string] $File) {
    $text = git show "${Commit}:$File" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    ($text -join "`n") | ConvertFrom-Json
}

# Everything outside the dependency sections, as one comparable string.
function Get-ManifestSkeleton($Json) {
    $copy = $Json | ConvertTo-Json -Depth 100 | ConvertFrom-Json
    foreach ($section in $DependencySections) { $copy.PSObject.Properties.Remove($section) }
    $copy | ConvertTo-Json -Depth 100 -Compress
}

function Get-SectionProblem($Before, $After, [string] $Section) {
    $old = $Before.PSObject.Properties[$Section]
    $new = $After.PSObject.Properties[$Section]
    if (-not $old -and -not $new) { return $null }
    if (-not $old -or -not $new) { return "adds or removes '$Section'" }
    $oldNames = @($old.Value.PSObject.Properties.Name | Sort-Object)
    $newNames = @($new.Value.PSObject.Properties.Name | Sort-Object)
    if (($oldNames -join ',') -ne ($newNames -join ',')) { return "adds or removes a dependency in '$Section'" }
    foreach ($p in $new.Value.PSObject.Properties) {
        if ($p.Value -ne $old.Value.$($p.Name) -and "$($p.Value)" -notmatch $PlainVersion) {
            return "sets $($p.Name) to '$($p.Value)', which is not a plain version"
        }
    }
    return $null
}

# package.json: only the versions inside the dependency sections may change.
function Get-ManifestProblem([string] $Commit, [string] $File) {
    $before = Get-JsonAt "$Commit^" $File
    $after = Get-JsonAt $Commit $File
    if ($null -eq $before -or $null -eq $after) { return "creates or deletes $File" }
    if ((Get-ManifestSkeleton $before) -ne (Get-ManifestSkeleton $after)) { return "changes $File outside its dependency lists" }
    foreach ($section in $DependencySections) {
        $problem = Get-SectionProblem $before $after $section
        if ($problem) { return "$problem ($File)" }
    }
    return $null
}

# package-lock.json: every package it adds must come from the npm registry.
function Get-LockfileProblem([string] $Commit, [string] $File) {
    $foreign = @(Get-ChangedLines $Commit $File | Where-Object {
            $_ -match '^\+\s*"resolved":' -and $_ -notmatch '^\+\s*"resolved":\s*"https://registry\.npmjs\.org/'
        })
    if ($foreign.Count) { return "resolves a package outside registry.npmjs.org in $File" }
    return $null
}

# Dockerfile: only FROM lines.
function Get-DockerfileProblem([string] $Commit, [string] $File) {
    $other = @(Get-ChangedLines $Commit $File | Where-Object { $_ -notmatch '^[+-]\s*FROM\s' })
    if ($other.Count) { return "changes more than a FROM line in $File" }
    return $null
}

function Get-DependencyFileProblem([string] $Commit, [string] $File) {
    if ($File -match $ManifestPattern) { return Get-ManifestProblem $Commit $File }
    if ($File -match $LockfilePattern) { return Get-LockfileProblem $Commit $File }
    if ($File -match $DockerfilePattern) { return Get-DockerfileProblem $Commit $File }
    return "changes $File, which is not a dependency file"
}

function Get-DependencyUpdateProblem([string] $Commit, [string] $BaseTag) {
    $short = $Commit.Substring(0, 9)
    $committer = (git log -1 --format=%ce $Commit) -join ''
    if ($committer -ne $GitHubMergeEmail) { return "$short is Dependabot's but was not merged through a GitHub pull request." }
    $branch = Get-ReleaseLineBranch $BaseTag
    git rev-parse --verify --quiet "$branch^{commit}" *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Ancestor $Commit $branch)) {
        return "$short is Dependabot's but is not on $branch, the release line of $BaseTag."
    }
    $files = @(git diff-tree --no-commit-id --name-only -r $Commit)
    if ($files.Count -eq 0) { return "$short (Dependabot) changes no files." }
    foreach ($file in $files) {
        $problem = Get-DependencyFileProblem $Commit $file
        if ($problem) { return "$short (Dependabot) $problem." }
    }
    return $null
}

function Test-DependabotCommit([string] $Commit) {
    ((git log -1 --format=%ae $Commit) -join '') -eq $DependabotEmail
}

# ── Per commit ──────────────────────────────────────────────────────────────

function Get-HotfixCommitProblem([string] $Commit, [string] $MainSha, [string] $BaseTag) {
    if (Test-OnMain $Commit $MainSha) { return $null }
    $source = Get-CherryPickSource $Commit
    if ($source) { return Get-CherryPickProblem $Commit $source $MainSha }
    if (Test-DependabotCommit $Commit) { return Get-DependencyUpdateProblem $Commit $BaseTag }
    return "$($Commit.Substring(0, 9)) is not on main, not a 'git cherry-pick -x' of a commit on main, and not a Dependabot update of the release line."
}

function Get-HotfixProblems([string] $Sha, [string] $MainSha) {
    $tag = Get-HotfixBaseTag $Sha
    if (-not $tag) { return @("no stable release tag (vX.Y.Z) in the history of the hotfix branch; branch it from one.") }
    $commits = @(git rev-list --reverse "$tag..$Sha")
    if ($commits.Count -eq 0) { return @("the hotfix branch has no commits after $tag.") }
    return @($commits | ForEach-Object { Get-HotfixCommitProblem $_ $MainSha $tag } | Where-Object { $_ })
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
    Write-Output 'A release may only contain code already merged to main through an approved PR (or a Dependabot update of the release line).'
    Write-Output 'Fix: merge the fix to main first, then cherry-pick it with -x onto the release line: a PR into release/X.Y with one `git cherry-pick -x <main commit>`.'
    exit 1
}
Write-Output "OK: everything in '$Ref' is on main, a clean cherry-pick of main, or a Dependabot update of the release line ($Mode)."
