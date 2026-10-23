#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    tools/release/Assert-ReleaseFromMain.ps1 refuses releases of code that is
    not on main yet.

.DESCRIPTION
    Every case runs the real script against a throwaway git repository with a
    `main` branch, a v1.0.0 tag and a hotfix branch, so it exercises real git
    ancestry, real cherry-pick trailers and real patch-ids — not mocks.

    v6.0.1 was cut from a hotfix branch (a cherry-pick WITHOUT -x of an
    unapproved PR) before the fix reached main; 'refuses a fix that reached main
    only later as a different commit' is that exact shape.

.USAGE
    Invoke-Pester -Path test/unit/AssertReleaseFromMain.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:Checker = Join-Path $root 'tools/release/Assert-ReleaseFromMain.ps1'

    function Invoke-Git { git @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }

    function Set-Lines([string] $File, [string[]] $Lines) {
        Set-Content -Path $File -Value $Lines -Encoding ascii
    }

    # Commits $Lines as app.txt and returns the new commit's SHA.
    function New-Commit([string[]] $Lines, [string] $Message) {
        Set-Lines 'app.txt' $Lines
        Invoke-Git add app.txt
        Invoke-Git commit -q -m $Message
        return (git rev-parse HEAD).Trim()
    }

    # Runs the checker in its own process, as the workflows do.
    function Invoke-Checker([string] $Mode, [string] $Ref) {
        $out = pwsh -NoProfile -File $script:Checker -Mode $Mode -Ref $Ref -Main main 2>&1
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
    }

    # main: base -> v1.0.0 -> feature (unreleased) -> fix (touches line 1).
    # The fix's diff is identical whether applied to main or to v1.0.0.
    $script:Base = @('line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8')
    function New-Repo {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $dir | Out-Null
        Set-Location $dir
        Invoke-Git init -q -b main
        Invoke-Git config user.email t@example.com
        Invoke-Git config user.name tester
        Invoke-Git config commit.gpgsign false
        New-Commit $script:Base 'base' | Out-Null
        Invoke-Git tag v1.0.0
        $feature = $script:Base[0..6] + 'feature'
        New-Commit $feature 'feature on main' | Out-Null
        $fixed = @('line1 FIXED') + $feature[1..7]
        $script:MainFix = New-Commit $fixed 'fix on main (squash of an approved PR)'
    }
}

AfterAll { Set-Location $PSScriptRoot }

Describe 'Assert-ReleaseFromMain -Mode Release' {
    BeforeEach { New-Repo }

    It 'accepts a commit on main' {
        (Invoke-Checker Release main).ExitCode | Should -Be 0
    }

    It 'accepts an older commit on main (a tag cut from history)' {
        (Invoke-Checker Release v1.0.0).ExitCode | Should -Be 0
    }

    It 'refuses a branch commit that is not on main' {
        Invoke-Git checkout -q -b feature/unmerged
        New-Commit ($script:Base + 'extra') 'unmerged work' | Out-Null
        $r = Invoke-Checker Release feature/unmerged
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "::error::.*'feature/unmerged'.*is not on main"
    }

    It 'fails for a ref that does not exist instead of passing' {
        (Invoke-Checker Release no-such-branch).ExitCode | Should -Not -Be 0
    }
}

Describe 'Assert-ReleaseFromMain -Mode Hotfix' {
    BeforeEach {
        New-Repo
        Invoke-Git checkout -q -b bugfixes/hotfix v1.0.0
    }

    It 'accepts a clean cherry-pick -x of a commit on main' {
        Invoke-Git cherry-pick -x $script:MainFix
        $r = Invoke-Checker Hotfix bugfixes/hotfix
        $r.Output | Should -Match '^OK:'
        $r.ExitCode | Should -Be 0
    }

    It 'refuses a cherry-pick without -x (no record of the main commit)' {
        Invoke-Git cherry-pick $script:MainFix
        $r = Invoke-Checker Hotfix bugfixes/hotfix
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "not a 'git cherry-pick -x' of a commit on main"
    }

    # The v6.0.1 shape: fixed on the hotfix branch first; main got its own commit.
    It 'refuses a fix committed on the hotfix branch, even if main has the same change' {
        New-Commit (@('line1 FIXED') + $script:Base[1..7]) 'fix written on the hotfix branch' | Out-Null
        (Invoke-Checker Hotfix bugfixes/hotfix).ExitCode | Should -Be 1
    }

    It 'refuses a -x trailer that points at a commit not on main' {
        Invoke-Git checkout -q -b bugfixes/unapproved main~1
        $unapproved = New-Commit (@('line1 UNREVIEWED') + $script:Base[1..6] + 'feature') 'open PR'
        Invoke-Git checkout -q bugfixes/hotfix
        Invoke-Git cherry-pick -x $unapproved
        $r = Invoke-Checker Hotfix bugfixes/hotfix
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "cherry-picked from $($unapproved.Substring(0, 9)), which is not on main"
    }

    It 'refuses a cherry-pick whose changed lines differ from the main commit' {
        Invoke-Git cherry-pick -x --no-commit $script:MainFix
        Set-Lines 'app.txt' (@('line1 FIXED', 'line2 SNUCK IN') + $script:Base[2..7])
        Invoke-Git add app.txt
        Invoke-Git commit -q -m "fix`n`n(cherry picked from commit $($script:MainFix))"
        $r = Invoke-Checker Hotfix bugfixes/hotfix
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'changes different lines than'
    }

    It 'refuses when one of several commits is unreviewed' {
        Invoke-Git cherry-pick -x $script:MainFix
        New-Commit (@('line1 FIXED') + $script:Base[1..6] + 'tweak') 'extra unreviewed tweak' | Out-Null
        $r = Invoke-Checker Hotfix bugfixes/hotfix
        $r.ExitCode | Should -Be 1
        ([regex]::Matches($r.Output, '::error::')).Count | Should -Be 1
    }

    It 'refuses a hotfix branch with nothing after the tag' {
        $r = Invoke-Checker Hotfix bugfixes/hotfix
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'no commits after v1.0.0'
    }

    # A pre-release tag must not become the base: that would wave through every
    # commit between the last stable release and the rc.
    It 'measures from the latest stable tag, ignoring pre-release tags' {
        Invoke-Git cherry-pick -x $script:MainFix
        Invoke-Git tag v1.0.1
        New-Commit (@('line1 FIXED') + $script:Base[1..6] + 'rc work') 'unreviewed, only in an rc' | Out-Null
        Invoke-Git tag v1.0.2-rc.1
        $r = Invoke-Checker Hotfix bugfixes/hotfix
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "not a 'git cherry-pick -x'"
    }

    It 'refuses a branch with no stable release tag in its history' {
        Invoke-Git checkout -q --orphan bugfixes/orphan
        New-Commit @('x') 'unrelated root' | Out-Null
        $r = Invoke-Checker Hotfix bugfixes/orphan
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'no stable release tag'
    }
}
