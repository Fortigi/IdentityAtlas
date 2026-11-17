#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The nightly security route (tools/release/SecurityHotfix.Functions.ps1).

.DESCRIPTION
    The git parts run against a throwaway repository with a real hotfix line
    (main, a stable tag, a hotfix tag made of a cherry-pick), and the branch
    the route builds is fed to the real Assert-ReleaseFromMain.ps1 — the same
    checker Cut Hotfix runs — so "the route builds what Cut Hotfix accepts" is
    tested, not assumed.

.USAGE
    Invoke-Pester -Path test/unit/SecurityHotfix.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/SecurityHotfix.Functions.ps1')
    $script:Checker = Join-Path $script:Root 'tools/release/Assert-ReleaseFromMain.ps1'

    function Invoke-TestGit { & git @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }

    # Commits $Lines as $File at a fixed date, returns the SHA.
    function New-TestCommit([string] $File, [string[]] $Lines, [string] $Message, [string] $Date) {
        Set-Content -Path $File -Value $Lines -Encoding ascii
        Invoke-TestGit add $File
        $env:GIT_COMMITTER_DATE = $Date; $env:GIT_AUTHOR_DATE = $Date
        try { Invoke-TestGit commit -q -m $Message } finally { Remove-Item Env:GIT_COMMITTER_DATE, Env:GIT_AUTHOR_DATE }
        (git rev-parse HEAD).Trim()
    }

    # main:    base(v1.0.0) -> feature -> fixA -> fixB -> fixC (conflicts with feature)
    # hotfix:  v1.0.0 -> cherry-pick -x fixA  (tagged v1.0.1)
    function New-TestRepo {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $dir | Out-Null
        Set-Location $dir
        Invoke-TestGit init -q -b main
        Invoke-TestGit config user.email t@example.com
        Invoke-TestGit config user.name tester
        Invoke-TestGit config commit.gpgsign false
        $script:Base = New-TestCommit 'app.txt' @('a1', 'a2', 'a3') 'base' '2026-11-01T10:00:00Z'
        New-TestCommit 'lock.txt' @('x 1.0.0', 'y 2.0.0') 'base lock' '2026-11-01T10:01:00Z' | Out-Null
        Invoke-TestGit tag v1.0.0
        $script:Feature = New-TestCommit 'app.txt' @('a1', 'a2 FEATURE', 'a3') 'feature' '2026-11-02T10:00:00Z'
        $script:FixA = New-TestCommit 'lock.txt' @('x 1.0.1', 'y 2.0.0') 'build: bump x (#10)' '2026-11-03T10:00:00Z'
        $script:FixB = New-TestCommit 'lock.txt' @('x 1.0.1', 'y 2.0.1') 'build: bump y (#11)' '2026-11-04T10:00:00Z'
        $script:FixC = New-TestCommit 'app.txt' @('a1', 'a2 FEATURE patched', 'a3') 'build: bump z (#12)' '2026-11-05T10:00:00Z'
        Invoke-TestGit switch -q -c bugfixes/old-hotfix v1.0.0
        Invoke-TestGit cherry-pick -x $script:FixA
        Invoke-TestGit tag v1.0.1
        Invoke-TestGit switch -q main
    }
}

AfterAll { Set-Location $PSScriptRoot }

Describe 'Versions and names' {
    It 'is the next patch: <in> -> <out>' -ForEach @(@{ in = 'v6.1.1'; out = '6.1.2' }, @{ in = 'v6.1.9'; out = '6.1.10' }, @{ in = 'v7.0.0'; out = '7.0.1' }) {
        Get-HotfixVersion $in | Should -Be $out
    }
    It 'refuses a pre-release as the base' { { Get-HotfixVersion 'v6.2.0-beta.1' } | Should -Throw '*not a stable*' }
    It 'starts at beta.1' { Get-NextBetaVersion -Version '6.1.2' -Tags @('v6.1.1') | Should -Be '6.1.2-beta.1' }
    It 'never reuses the number of a kept beta' { Get-NextBetaVersion -Version '6.1.2' -Tags @('v6.1.2-beta.1', 'v6.1.2-beta.3') | Should -Be '6.1.2-beta.4' }
    It 'ignores betas of other versions, including 6.1.20' {
        Get-NextBetaVersion -Version '6.1.2' -Tags @('v6.1.20-beta.5', 'v6.1.3-beta.2', 'v6.1.2-rc.1') | Should -Be '6.1.2-beta.1'
    }
    It 'names the branch after the UTC date' {
        Get-SecurityHotfixBranchName -Date ([datetimeoffset]::Parse('2026-11-17T01:30:00+02:00').UtcDateTime) | Should -Be 'bugfixes/security-hotfix-20261116'
    }
    It 'finds kept security-hotfix branches and nothing else' {
        Get-KeptHotfixBranch @('refs/heads/bugfixes/security-hotfix-20261116', 'refs/heads/bugfixes/fix-login', 'refs/heads/security-hotfix-x', 'origin/bugfixes/security-hotfix-20261101') |
            Should -Be @('bugfixes/security-hotfix-20261116', 'bugfixes/security-hotfix-20261101')
    }
}

Describe 'Select-SecurityFix' {
    BeforeAll {
        function New-TestPr([int] $Number, [string] $MergedAt, [string] $Author = 'dependabot[bot]', [string[]] $Labels = @('dependencies', 'security-fix'), [string] $Base = 'main', [string] $Sha = "sha$Number") {
            [pscustomobject]@{
                number = $Number; title = "bump $Number"; author = [pscustomobject]@{ login = $Author }
                labels = @($Labels | ForEach-Object { [pscustomobject]@{ name = $_ } }); baseRefName = $Base; mergedAt = $MergedAt
                mergeCommit = $(if ($Sha) { [pscustomobject]@{ oid = $Sha } } else { $null })
            }
        }
        $script:Since = [datetime]::Parse('2026-11-01T00:00:00Z').ToUniversalTime()
        $script:None = { param($sha) $false }
    }
    It 'keeps a labelled Dependabot PR merged after the release base' {
        (Select-SecurityFix -PullRequests @(New-TestPr 1 '2026-11-02T00:00:00Z') -Since $script:Since -IsInRelease $script:None).Number | Should -Be 1
    }
    It 'drops <why>' -ForEach @(
        @{ why = 'a PR a person opened, even with the label'; pr = { New-TestPr 2 '2026-11-02T00:00:00Z' -Author 'someone' } }
        @{ why = 'a Dependabot PR without the label'; pr = { New-TestPr 3 '2026-11-02T00:00:00Z' -Labels @('dependencies') } }
        @{ why = 'a PR merged before the release base'; pr = { New-TestPr 4 '2026-10-31T23:59:59Z' } }
        @{ why = 'a PR into another branch'; pr = { New-TestPr 5 '2026-11-02T00:00:00Z' -Base 'release/5.9' } }
        @{ why = 'a PR without a merge commit'; pr = { New-TestPr 6 '2026-11-02T00:00:00Z' -Sha '' } }
    ) {
        Select-SecurityFix -PullRequests @(& $pr) -Since $script:Since -IsInRelease $script:None | Should -BeNullOrEmpty
    }
    It 'drops a fix the release already contains' {
        $in = { param($sha) $sha -eq 'sha8' }
        (Select-SecurityFix -PullRequests @((New-TestPr 7 '2026-11-02T00:00:00Z'), (New-TestPr 8 '2026-11-03T00:00:00Z')) -Since $script:Since -IsInRelease $in).Number | Should -Be 7
    }
    It 'returns them in merge order, oldest first' {
        $prs = @((New-TestPr 30 '2026-11-09T00:00:00Z'), (New-TestPr 10 '2026-11-02T00:00:00Z'), (New-TestPr 20 '2026-11-05T00:00:00Z'))
        (Select-SecurityFix -PullRequests $prs -Since $script:Since -IsInRelease $script:None).Number | Should -Be @(10, 20, 30)
    }
}

Describe 'Git: what a release already contains' {
    BeforeEach { New-TestRepo }

    It 'a commit that is an ancestor of the tag is in the release' {
        Test-CommitInRelease -Commit $script:Base -StableTag v1.0.1 -Main main | Should -BeTrue
    }
    It 'a main commit cherry-picked onto the hotfix line is in the release' {
        Test-CommitInRelease -Commit $script:FixA -StableTag v1.0.1 -Main main | Should -BeTrue
    }
    It 'a main commit not cherry-picked is not' {
        Test-CommitInRelease -Commit $script:FixB -StableTag v1.0.1 -Main main | Should -BeFalse
    }
    It 'the release base of a hotfix tag is where it left main, not the hotfix commit' {
        Get-ReleaseBaseDate -StableTag v1.0.1 -Main main | Should -Be ([datetime]::Parse('2026-11-01T10:01:00Z').ToUniversalTime())
    }
}

Describe 'Git: building the hotfix branch' {
    BeforeEach { New-TestRepo }

    It 'cherry-picks each fix with -x, in order, and Cut Hotfix''s checker accepts it' {
        New-SecurityHotfixBranch -StableTag v1.0.1 -Branch bugfixes/security-hotfix-20261117 -Fixes @([pscustomobject]@{ Number = 11; Title = 'bump y'; Commit = $script:FixB })
        git branch --show-current | Should -Be 'bugfixes/security-hotfix-20261117'
        (git log -1 --format=%B) -join "`n" | Should -BeLike "*(cherry picked from commit $($script:FixB))*"
        @(git rev-list v1.0.1..HEAD).Count | Should -Be 1
        pwsh -NoProfile -File $script:Checker -Mode Hotfix -Ref HEAD -Main main | Out-Null
        $LASTEXITCODE | Should -Be 0
    }
    It 'names the PR that conflicts and leaves no half-done cherry-pick behind' {
        $fixes = @(
            [pscustomobject]@{ Number = 11; Title = 'bump y'; Commit = $script:FixB }
            [pscustomobject]@{ Number = 12; Title = 'bump z'; Commit = $script:FixC }   # needs `feature`, which v1.0.1 lacks
        )
        { New-SecurityHotfixBranch -StableTag v1.0.1 -Branch bugfixes/security-hotfix-20261117 -Fixes $fixes } | Should -Throw '*#12*conflicts*'
        Test-Path (Join-Path (git rev-parse --git-dir) 'CHERRY_PICK_HEAD') | Should -BeFalse
        git status --porcelain | Should -BeNullOrEmpty
    }
}

Describe 'Get-SecurityRouteOutcome' {
    BeforeAll {
        $script:AllGreen = @{ branch = 'success'; beta = 'success'; images = 'success'; test = 'success'; hotfix = 'success' }
        function Get-Outcome([hashtable] $Change = @{}, [switch] $DryRun) {
            $r = $script:AllGreen.Clone(); foreach ($k in $Change.Keys) { $r[$k] = $Change[$k] }
            Get-SecurityRouteOutcome -Results $r -DryRun:$DryRun -Beta '6.1.2-beta.1' -Version '6.1.2' -BranchReason 'Cherry-picking #12 conflicts.'
        }
    }
    It 'releases and deletes the branch when every stage passed' {
        $o = Get-Outcome
        $o.Passed | Should -BeTrue; $o.DeleteBranch | Should -BeTrue; $o.OpenIssue | Should -BeFalse
        $o.Reason | Should -Be 'v6.1.2 is released.'
    }
    It 'names the first stage that failed: <stage>' -ForEach @(
        @{ stage = 'branch'; text = '*Cherry-picking #12 conflicts.*' }
        @{ stage = 'beta'; text = '*Cut Beta failed for 6.1.2-beta.1*' }
        @{ stage = 'images'; text = '*6.1.2-beta.1 images did not appear*' }
        @{ stage = 'test'; text = '*release test of 6.1.2-beta.1 is red*' }
        @{ stage = 'hotfix'; text = '*Cut Hotfix failed for 6.1.2*' }
    ) {
        $o = Get-Outcome @{ $stage = 'failure' }
        $o.Passed | Should -BeFalse
        $o.Reason | Should -BeLike $text
        $o.DeleteBranch | Should -BeFalse
        $o.OpenIssue | Should -BeTrue
    }
    It 'reports the earliest failure, not a later skip it caused' {
        (Get-Outcome @{ test = 'failure'; hotfix = 'skipped' }).Reason | Should -BeLike '*release test*'
    }
    It 'treats a skipped hotfix after a green test as a failure, not a release' {
        $o = Get-Outcome @{ hotfix = 'skipped' }
        $o.Passed | Should -BeFalse; $o.DeleteBranch | Should -BeFalse
    }
    It 'says where a cancelled run stopped' { (Get-Outcome @{ images = 'cancelled' }).Reason | Should -Be "The run was cancelled at 'images'." }
    It 'passes a dry run whose image wait and test were skipped, and deletes and reports nothing' {
        $o = Get-Outcome @{ images = 'skipped'; test = 'skipped' } -DryRun
        $o.Passed | Should -BeTrue; $o.DeleteBranch | Should -BeFalse; $o.OpenIssue | Should -BeFalse
    }
    It 'does not let a dry run skip a stage that does not need a tag' {
        $o = Get-Outcome @{ beta = 'skipped'; images = 'skipped'; test = 'skipped' } -DryRun
        $o.Passed | Should -BeFalse; $o.OpenIssue | Should -BeFalse
    }
    It 'opens no issue for a failed dry run' { (Get-Outcome @{ branch = 'failure' } -DryRun).OpenIssue | Should -BeFalse }
}

Describe 'Waiting for the beta images' {
    It 'asks ghcr.io anonymously for the manifest of the tag' {
        Mock Invoke-RestMethod { [pscustomobject]@{ token = 'anon' } }
        Mock Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
        Test-ImagePublished -Image 'fortigi/identity-atlas' -Tag '6.1.2-beta.1' | Should -BeTrue
        Should -Invoke Invoke-RestMethod -ParameterFilter { $Uri -eq 'https://ghcr.io/token?scope=repository:fortigi/identity-atlas:pull' }
        Should -Invoke Invoke-WebRequest -ParameterFilter { $Method -eq 'Head' -and $Uri -eq 'https://ghcr.io/v2/fortigi/identity-atlas/manifests/6.1.2-beta.1' -and $Headers.Authorization -eq 'Bearer anon' }
    }
    It 'is false for a tag that is not there yet' {
        Mock Invoke-RestMethod { [pscustomobject]@{ token = 'anon' } }
        Mock Invoke-WebRequest { [pscustomobject]@{ StatusCode = 404 } }
        Test-ImagePublished -Image 'fortigi/identity-atlas' -Tag 'x' | Should -BeFalse
    }
    It 'waits for all three images, not just the first' {
        Mock Test-ImagePublished { $Image -ne 'fortigi/identity-atlas-report-generator' }
        Mock Start-Sleep {}
        { Wait-ImagePublished -Tag '6.1.2-beta.1' -TimeoutSec 1 } | Should -Throw '*6.1.2-beta.1 images*'
    }
    It 'returns once all three are there' {
        Mock Test-ImagePublished { $true }
        { Wait-ImagePublished -Tag '6.1.2-beta.1' -TimeoutSec 5 } | Should -Not -Throw
        Should -Invoke Test-ImagePublished -Times 3 -Exactly
    }
    It 'waits for the images docker-publish pushes' {
        $publish = Get-Content (Join-Path $script:Root '.github/workflows/docker-publish.yml') -Raw
        foreach ($image in Get-ReleaseImage) { $publish | Should -BeLike "*/$image`"*" }
    }
}

Describe 'Invoke-Git gets only flags PowerShell passes on' {
    # Invoke-Git is an advanced function: a short flag that starts a common
    # parameter (-d = -Debug, -v = -Verbose …) would be taken by PowerShell and
    # never reach git — `push origin -d <branch>` would push instead of delete.
    It 'no call passes a short flag that collides with a common parameter' {
        $hits = Get-ChildItem (Join-Path $script:Root 'tools/release') -Filter '*.ps1' |
            Select-String -Pattern 'Invoke-Git\b.*\s-(d|v|e|w|i|o|p)[a-z]*\b' -CaseSensitive:$false |
            Where-Object { $_.Line -notmatch '^\s*#' }
        @($hits | ForEach-Object { "$($_.Filename):$($_.LineNumber)" }) | Should -BeNullOrEmpty
    }
}
