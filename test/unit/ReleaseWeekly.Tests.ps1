#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    What the weekly release run decides to cut and test (tools/release/ReleaseWeekly.Functions.ps1).

.USAGE
    Invoke-Pester -Path test/unit/ReleaseWeekly.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseRoute.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseWeekly.Functions.ps1')
    # Today's real shape: the newest pre-release (rc of 6.0.0) is behind stable 6.1.1.
    $script:Today = @('v5.9.0-beta.2', 'v6.0.0-rc.1', 'v6.0.0', 'v6.1.0', 'v6.1.1')
}

Describe 'Get-NewestPreRelease' {
    It 'finds none when every pre-release is behind the newest stable (today)' {
        Get-NewestPreRelease $script:Today | Should -BeNullOrEmpty
    }
    It 'finds a beta of the next minor' {
        Get-NewestPreRelease ($script:Today + 'v6.2.0-beta.1') | Should -Be 'v6.2.0-beta.1'
    }
    It 'finds a hotfix beta of the next patch' {
        Get-NewestPreRelease ($script:Today + 'v6.1.2-beta.1') | Should -Be 'v6.1.2-beta.1'
    }
    It 'orders beta numbers as numbers: beta.10 after beta.9' {
        Get-NewestPreRelease ($script:Today + 'v6.2.0-beta.9', 'v6.2.0-beta.10') | Should -Be 'v6.2.0-beta.10'
    }
    It 'orders alpha < beta < rc within one version' {
        Get-NewestPreRelease ($script:Today + 'v6.2.0-rc.1', 'v6.2.0-beta.4', 'v6.2.0-alpha.7') | Should -Be 'v6.2.0-rc.1'
    }
    It 'orders versions numerically: 6.10.0 after 6.9.0' {
        Get-NewestPreRelease ($script:Today + 'v6.9.0-beta.3', 'v6.10.0-beta.1') | Should -Be 'v6.10.0-beta.1'
    }
    It 'drops a pre-release once its own stable release exists' {
        Get-NewestPreRelease ($script:Today + 'v6.2.0-beta.1', 'v6.2.0') | Should -BeNullOrEmpty
    }
    It 'ignores tags that are neither' {
        Get-NewestPreRelease ($script:Today + 'v6.2.0-preview.1', 'edge', 'v6.2.0-beta') | Should -BeNullOrEmpty
    }
}

Describe 'Get-WeeklyPlan' {
    It 'tests an untested beta, with Azure' {
        $p = Get-WeeklyPlan -Tags ($script:Today + 'v6.2.0-beta.1')
        $p.Candidate | Should -Be 'v6.2.0-beta.1'
        $p.Azure | Should -BeTrue
    }
    It 'falls back to edge without Azure once that beta is tested' {
        $p = Get-WeeklyPlan -Tags ($script:Today + 'v6.2.0-beta.1') -Tested 'v6.2.0-beta.1'
        $p.Candidate | Should -Be 'edge'
        $p.Azure | Should -BeFalse
        $p.Reason | Should -BeLike '*v6.2.0-beta.1, was tested before*'
    }
    It 'tests the newer beta when only the older one is tested' {
        (Get-WeeklyPlan -Tags ($script:Today + 'v6.2.0-beta.1', 'v6.2.0-beta.2') -Tested 'v6.2.0-beta.1').Candidate | Should -Be 'v6.2.0-beta.2'
    }
    It 'runs edge without Azure on a run with no candidate (today)' {
        $p = Get-WeeklyPlan -Tags $script:Today
        $p.Candidate | Should -Be 'edge'
        $p.Azure | Should -BeFalse
    }
    It 'tests what a person asked for, Azure included' {
        $p = Get-WeeklyPlan -Tags $script:Today -Override 'v6.1.1'
        $p.Candidate | Should -Be 'v6.1.1'
        $p.Azure | Should -BeTrue
    }
    It 'keeps Azure off when a person asks for edge' {
        (Get-WeeklyPlan -Tags $script:Today -Override 'edge').Azure | Should -BeFalse
    }
    It 'refuses an override that is not a candidate' {
        { Get-WeeklyPlan -Tags $script:Today -Override 'main; rm -rf /' } | Should -Throw '*is not*'
    }
    It 'tests nothing else when the beta route cuts a beta of main this run, even an untested older beta' {
        $p = Get-WeeklyPlan -Tags ($script:Today + 'v6.2.0-beta.1') -BetaRoute
        $p.Candidate | Should -Be ''
        $p.Azure | Should -BeFalse
    }
    It 'still tests what a person asked for on a run where the beta route would run' {
        (Get-WeeklyPlan -Tags $script:Today -Override 'v6.1.1' -BetaRoute).Candidate | Should -Be 'v6.1.1'
    }
}

Describe 'Get-ReleaseLineName' {
    It '<tag> -> <line>' -ForEach @(@{ tag = 'v6.1.1'; line = 'release/6.1' }, @{ tag = 'v6.10.0'; line = 'release/6.10' }, @{ tag = 'v7.0.3'; line = 'release/7.0' }) {
        Get-ReleaseLineName $tag | Should -Be $line
    }
    It 'refuses a pre-release' { { Get-ReleaseLineName 'v6.2.0-beta.1' } | Should -Throw '*not a stable*' }
}

Describe 'Get-NextMinorBeta' {
    It 'starts the next minor after the newest stable release (today: 6.2.0-beta.1)' {
        $n = Get-NextMinorBeta $script:Today
        $n.Version | Should -Be '6.2.0-beta.1'
        $n.Previous | Should -Be ''
    }
    It 'continues an existing beta of that minor, numbering as numbers' {
        $n = Get-NextMinorBeta ($script:Today + 'v6.2.0-beta.9', 'v6.2.0-beta.10')
        $n.Version | Should -Be '6.2.0-beta.11'
        $n.Previous | Should -Be 'v6.2.0-beta.10'
    }
    It 'ignores the release line''s patch betas' {
        $n = Get-NextMinorBeta ($script:Today + 'v6.1.2-beta.1', 'v6.1.2-beta.2')
        $n.Version | Should -Be '6.2.0-beta.1'
        $n.Previous | Should -Be ''
    }
    It 'follows a later minor or major a person started by hand' {
        (Get-NextMinorBeta ($script:Today + 'v6.2.0-beta.3', 'v7.0.0-beta.1')).Version | Should -Be '7.0.0-beta.2'
    }
    It 'moves on once that minor is released' {
        $n = Get-NextMinorBeta ($script:Today + 'v6.2.0-beta.4', 'v6.2.0')
        $n.Version | Should -Be '6.3.0-beta.1'
        $n.Previous | Should -Be ''
    }
    It 'orders 6.10 after 6.9' { (Get-NextMinorBeta ($script:Today + 'v6.9.0-beta.1', 'v6.10.0-beta.2')).Version | Should -Be '6.10.0-beta.3' }
    It 'needs a stable release to count from' { { Get-NextMinorBeta @('v1.0.0-beta.1') } | Should -Throw '*No stable*' }
}

Describe 'Test-ShippedDependencyCommit' {
    BeforeAll {
        function New-Body([string[]] $Types) {
            $deps = $Types | ForEach-Object { "- dependency-name: x`n  dependency-version: 1.0.1`n  dependency-type: $_" }
            "Bumps x.`n`n---`nupdated-dependencies:`n$($deps -join "`n")`n...`n"
        }
    }
    It 'counts <type>' -ForEach @(@{ type = 'direct:production' }, @{ type = 'indirect' }) {
        Test-ShippedDependencyCommit (New-Body @($type)) | Should -BeTrue
    }
    It 'leaves out a commit that only moves development dependencies' {
        Test-ShippedDependencyCommit (New-Body @('direct:development', 'direct:development')) | Should -BeFalse
    }
    It 'counts a group that moves one production dependency among development ones' {
        Test-ShippedDependencyCommit (New-Body @('direct:development', 'direct:production')) | Should -BeTrue
    }
    It 'counts a body without the list, to be safe' { Test-ShippedDependencyCommit 'build: Bump node in /app/api' | Should -BeTrue }
    # The real shape, from #1586 (vite group, a development dependency).
    It 'reads a real Dependabot body' {
        $body = "Bumps the vite group in /app/ui with 1 update.`n`n---`nupdated-dependencies:`n- dependency-name: `"@vitejs/plugin-react`"`n  dependency-version: 6.3.0`n  dependency-type: direct:development`n  update-type: version-update:semver-minor`n  dependency-group: vite`n...`n`nSigned-off-by: dependabot[bot] <support@github.com>"
        Test-ShippedDependencyCommit $body | Should -BeFalse
    }
}

Describe 'Get-StableRoutePlan' {
    BeforeAll {
        function Get-Plan([hashtable] $Change = @{}) {
            $p = @{ Tags = $script:Today; BranchExists = $true; ContainsStable = $true; NewCommits = 2; AttemptedAtHead = @(); TemplatesChanged = $false }
            foreach ($k in $Change.Keys) { $p[$k] = $Change[$k] }
            Get-StableRoutePlan @p
        }
    }
    It 'cuts the next patch of the newest stable, beta first, without Azure' {
        $p = Get-Plan
        $p.Needed | Should -BeTrue
        $p.Line | Should -Be 'release/6.1'
        $p.Version | Should -Be '6.1.2'
        $p.Beta | Should -Be '6.1.2-beta.1'
        $p.Azure | Should -BeFalse
    }
    It 'adds Azure when the templates changed on the line' { (Get-Plan @{ TemplatesChanged = $true }).Azure | Should -BeTrue }
    It 'numbers the beta past an earlier failed attempt' { (Get-Plan @{ Tags = ($script:Today + 'v6.1.2-beta.1') }).Beta | Should -Be '6.1.2-beta.2' }
    It 'does nothing when <why>' -ForEach @(
        @{ why = 'the line does not exist'; change = @{ BranchExists = $false }; text = '*release/6.1 does not exist*' }
        @{ why = 'the stable tag is not on the line'; change = @{ ContainsStable = $false }; text = '*v6.1.1 is not on release/6.1*' }
        @{ why = 'the line has nothing new'; change = @{ NewCommits = 0 }; text = '*nothing that v6.1.1 does not have*' }
        @{ why = 'this exact commit was tried before'; change = @{ AttemptedAtHead = @('v6.1.2-beta.1') }; text = '*not moved since v6.1.2-beta.1*' }
    ) {
        $p = Get-Plan $change
        $p.Needed | Should -BeFalse
        $p.Reason | Should -BeLike $text
    }
    It 'tries the same commit again when a person asks' {
        $p = Get-Plan @{ AttemptedAtHead = @('v6.1.2-beta.1'); Tags = ($script:Today + 'v6.1.2-beta.1'); Retry = $true }
        $p.Needed | Should -BeTrue
        $p.Beta | Should -Be '6.1.2-beta.2'
    }
    It 'does nothing before the first stable release' { (Get-StableRoutePlan -Tags @('v0.1.0-beta.1')).Needed | Should -BeFalse }
}

Describe 'Get-BetaRoutePlan' {
    It 'cuts the first beta of the next minor with the full test, Azure included' {
        $p = Get-BetaRoutePlan -Tags $script:Today -ShippedUpdates 3 -TemplatesChanged $false
        $p.Needed | Should -BeTrue
        $p.Version | Should -Be '6.2.0-beta.1'
        $p.Azure | Should -BeTrue
    }
    It 'leaves Azure out of a later beta when the templates did not change' {
        $p = Get-BetaRoutePlan -Tags ($script:Today + 'v6.2.0-beta.1') -ShippedUpdates 1 -TemplatesChanged $false
        $p.Version | Should -Be '6.2.0-beta.2'
        $p.Azure | Should -BeFalse
    }
    It 'adds Azure to a later beta when the templates changed' {
        (Get-BetaRoutePlan -Tags ($script:Today + 'v6.2.0-beta.1') -ShippedUpdates 1 -TemplatesChanged $true).Azure | Should -BeTrue
    }
    It 'cuts nothing without a Dependabot update of shipped code' {
        $p = Get-BetaRoutePlan -Tags ($script:Today + 'v6.2.0-beta.1') -ShippedUpdates 0 -TemplatesChanged $true
        $p.Needed | Should -BeFalse
        $p.Reason | Should -BeLike '*since v6.2.0-beta.1*'
    }
}

Describe 'Dependabot''s release-line entries' {
    BeforeAll {
        $script:Config = Get-Content -Raw (Join-Path $script:Root '.github/dependabot.yml')
        $script:Sample = "  # ─── The stable release line: release/6.1 ───`n  - package-ecosystem: npm`n    target-branch: `"release/6.1`"`n  - package-ecosystem: docker`n    target-branch: `"release/6.1`"`n"
    }
    It 'the committed file points every entry at one release line' {
        $targets = @([regex]::Matches($script:Config, '(?m)^\s*target-branch:\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
        $targets.Count | Should -Be 1
        $targets[0] | Should -Match '^release/\d+\.\d+$'
        Test-DependabotTargetsLine -Config $script:Config -Line $targets[0] | Should -BeTrue
    }
    # CI checks out without tags; this half needs them, so it only runs where they exist.
    It 'and that line is the newest stable one, when tags are available' {
        $stable = Get-StableTag @(git -C $script:Root tag --list 'v*') | Select-Object -First 1
        if (-not $stable) { Set-ItResult -Skipped -Because 'this checkout has no release tags'; return }
        Test-DependabotTargetsLine -Config $script:Config -Line (Get-ReleaseLineName $stable) | Should -BeTrue
    }
    It 'is not on the line when one entry lags behind' {
        Test-DependabotTargetsLine -Config ($script:Sample + "    target-branch: `"release/6.0`"`n") -Line 'release/6.1' | Should -BeFalse
    }
    It 'is not on the line when there are no entries' { Test-DependabotTargetsLine -Config 'version: 2' -Line 'release/6.1' | Should -BeFalse }
    It 'moves every entry and the heading to the new line' {
        $moved = Set-DependabotReleaseLine -Config $script:Sample -Line 'release/6.2'
        $moved | Should -Not -BeLike '*release/6.1*'
        ([regex]::Matches($moved, 'target-branch: "release/6\.2"')).Count | Should -Be 2
        $moved | Should -BeLike '*The stable release line: release/6.2*'
        Test-DependabotTargetsLine -Config $moved -Line 'release/6.2' | Should -BeTrue
    }
    It 'moves the committed file too' {
        Test-DependabotTargetsLine -Config (Set-DependabotReleaseLine -Config $script:Config -Line 'release/6.2') -Line 'release/6.2' | Should -BeTrue
    }
    It 'throws on a file without release-line entries instead of changing nothing' {
        { Set-DependabotReleaseLine -Config 'version: 2' -Line 'release/6.2' } | Should -Throw '*no release-line entries*'
    }
    It 'refuses a line that is not release/X.Y' { { Set-DependabotReleaseLine -Config $script:Sample -Line 'main' } | Should -Throw '*not a release line*' }
}

Describe 'ConvertTo-RouteOutput' {
    It 'writes a needed route''s version, beta, commit and Azure flag' {
        $o = ConvertTo-RouteOutput -Name stable -Plan @{ Needed = $true; Version = '6.1.2'; Beta = '6.1.2-beta.1'; Azure = $true } -Sha 'abc123' -Keys @('Version', 'Beta')
        @($o.Keys) | Should -Be @('stable_needed', 'stable_version', 'stable_beta', 'stable_sha', 'stable_azure')
        $o.stable_needed | Should -Be 'true'
        $o.stable_version | Should -Be '6.1.2'
        $o.stable_beta | Should -Be '6.1.2-beta.1'
        $o.stable_sha | Should -Be 'abc123'
        $o.stable_azure | Should -Be 'true'
    }
    # A route that is not needed must hand no later job a commit or a version.
    It 'empties everything of a route that is not needed, even when the plan carries values' {
        $o = ConvertTo-RouteOutput -Name beta -Plan @{ Needed = $false; Version = '6.2.0-beta.1'; Azure = $true; Reason = 'x' } -Sha 'abc123'
        $o.beta_needed | Should -Be 'false'
        $o.beta_version | Should -Be ''
        $o.beta_sha | Should -Be ''
        $o.beta_azure | Should -Be 'false'
    }
    It 'reads a missing Azure flag as false' {
        (ConvertTo-RouteOutput -Name beta -Plan @{ Needed = $true; Version = '6.2.0-beta.2' } -Sha 's').beta_azure | Should -Be 'false'
    }
}

Describe 'Format-WeeklySummary' {
    BeforeAll {
        $script:Stable = @{ Needed = $true; Beta = '6.1.2-beta.1'; Version = '6.1.2'; Azure = $false; Reason = 'release/6.1 has 1 commit(s) after v6.1.1' }
        $script:Beta = @{ Needed = $false; Reason = 'no Dependabot update of shipped code on main since v6.2.0-beta.3' }
        $script:Test = @{ Candidate = 'edge'; Azure = $false; Reason = 'early warning' }
    }
    It 'names what each route does and why' {
        $s = (Format-WeeklySummary -Stable $script:Stable -Beta $script:Beta -Test $script:Test) -join "`n"
        $s | Should -BeLike '*Stable route:** v6.1.2-beta.1 then v6.1.2, no Azure. release/6.1 has 1 commit(s) after v6.1.1.*'
        $s | Should -BeLike '*Beta route:** nothing to do. no Dependabot update*'
        # Contains, not -like: a backtick is -like's escape character.
        $s.Contains('- **Test:** `edge`, no Azure. early warning.') | Should -BeTrue
        $s.Contains('**Warning:**') | Should -BeFalse
    }
    It 'says when Azure is included' {
        $b = @{ Needed = $true; Version = '6.2.0-beta.1'; Azure = $true; Reason = 'first beta' }
        (Format-WeeklySummary -Stable $script:Stable -Beta $b -Test @{ Candidate = ''; Reason = 'beta route' }) -join "`n" |
            Should -BeLike '*Beta route:** v6.2.0-beta.1, with Azure.*Test:** nothing else.*'
    }
    It 'warns when Dependabot does not target the line' {
        $s = (Format-WeeklySummary -Stable $script:Stable -Beta $script:Beta -Test $script:Test -LineWarning 'release/6.1') -join "`n"
        $s.Contains('**Warning:** `.github/dependabot.yml` does not point its release-line entries at `release/6.1`') | Should -BeTrue
    }
}

Describe 'Get-TestedMarkerName' {
    It 'names the artifact after the tag' { Get-TestedMarkerName 'v6.2.0-beta.1' | Should -Be 'release-tested-v6.2.0-beta.1' }
    It 'refuses anything else' { { Get-TestedMarkerName 'v6.2.0-beta.1/../x' } | Should -Throw }
}

Describe 'Get-PreReleaseSortKey' {
    It 'refuses a stable tag' { { Get-PreReleaseSortKey 'v6.1.1' } | Should -Throw '*not a pre-release*' }
}
