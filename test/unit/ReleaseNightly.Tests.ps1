#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    What the nightly release run decides to test (tools/release/ReleaseNightly.Functions.ps1).

.USAGE
    Invoke-Pester -Path test/unit/ReleaseNightly.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseNightly.Functions.ps1')
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

Describe 'Get-NightlyPlan' {
    It 'tests an untested beta, with Azure' {
        $p = Get-NightlyPlan -Tags ($script:Today + 'v6.2.0-beta.1')
        $p.Candidate | Should -Be 'v6.2.0-beta.1'
        $p.Azure | Should -BeTrue
    }
    It 'falls back to edge without Azure once that beta is tested' {
        $p = Get-NightlyPlan -Tags ($script:Today + 'v6.2.0-beta.1') -Tested 'v6.2.0-beta.1'
        $p.Candidate | Should -Be 'edge'
        $p.Azure | Should -BeFalse
        $p.Reason | Should -BeLike '*v6.2.0-beta.1, was tested before*'
    }
    It 'tests the newer beta when only the older one is tested' {
        (Get-NightlyPlan -Tags ($script:Today + 'v6.2.0-beta.1', 'v6.2.0-beta.2') -Tested 'v6.2.0-beta.1').Candidate | Should -Be 'v6.2.0-beta.2'
    }
    It 'runs edge without Azure on a night with no candidate (today)' {
        $p = Get-NightlyPlan -Tags $script:Today
        $p.Candidate | Should -Be 'edge'
        $p.Azure | Should -BeFalse
    }
    It 'tests what a person asked for, Azure included' {
        $p = Get-NightlyPlan -Tags $script:Today -Override 'v6.1.1'
        $p.Candidate | Should -Be 'v6.1.1'
        $p.Azure | Should -BeTrue
    }
    It 'keeps Azure off when a person asks for edge' {
        (Get-NightlyPlan -Tags $script:Today -Override 'edge').Azure | Should -BeFalse
    }
    It 'refuses an override that is not a candidate' {
        { Get-NightlyPlan -Tags $script:Today -Override 'main; rm -rf /' } | Should -Throw '*is not*'
    }
}

Describe 'Get-TestedMarkerName' {
    It 'names the artifact after the tag' { Get-TestedMarkerName 'v6.2.0-beta.1' | Should -Be 'release-tested-v6.2.0-beta.1' }
    It 'refuses anything else' { { Get-TestedMarkerName 'v6.2.0-beta.1/../x' } | Should -Throw }
}

Describe 'Get-PreReleaseSortKey' {
    It 'refuses a stable tag' { { Get-PreReleaseSortKey 'v6.1.1' } | Should -Throw '*not a pre-release*' }
}
