#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The shared pieces of the weekly release routes (tools/release/ReleaseRoute.Functions.ps1):
    version numbers, waiting for the images, and what a finished route means.

.USAGE
    Invoke-Pester -Path test/unit/ReleaseRoute.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseRoute.Functions.ps1')
}

Describe 'Versions' {
    It 'is the next patch: <in> -> <out>' -ForEach @(@{ in = 'v6.1.1'; out = '6.1.2' }, @{ in = 'v6.1.9'; out = '6.1.10' }, @{ in = 'v7.0.0'; out = '7.0.1' }) {
        Get-NextPatchVersion $in | Should -Be $out
    }
    It 'refuses a pre-release as the base' { { Get-NextPatchVersion 'v6.2.0-beta.1' } | Should -Throw '*not a stable*' }
    It 'starts at beta.1' { Get-NextBetaVersion -Version '6.1.2' -Tags @('v6.1.1') | Should -Be '6.1.2-beta.1' }
    It 'never reuses the number of a kept beta' { Get-NextBetaVersion -Version '6.1.2' -Tags @('v6.1.2-beta.1', 'v6.1.2-beta.3') | Should -Be '6.1.2-beta.4' }
    It 'ignores betas of other versions, including 6.1.20' {
        Get-NextBetaVersion -Version '6.1.2' -Tags @('v6.1.20-beta.5', 'v6.1.3-beta.2', 'v6.1.2-rc.1') | Should -Be '6.1.2-beta.1'
    }
}

Describe 'Get-RouteOutcome' {
    BeforeAll {
        $script:AllGreen = @{ beta = 'success'; images = 'success'; test = 'success'; release = 'success' }
        function Get-Outcome([hashtable] $Change = @{}, [switch] $DryRun, [switch] $Beta) {
            $r = $script:AllGreen.Clone(); foreach ($k in $Change.Keys) { $r[$k] = $Change[$k] }
            Get-RouteOutcome -Results $r -Promote:(-not $Beta) -DryRun:$DryRun -Beta '6.1.2-beta.1' -Version '6.1.2'
        }
    }
    It 'releases when every stage passed (stable route)' {
        $o = Get-Outcome
        $o.Passed | Should -BeTrue; $o.OpenIssue | Should -BeFalse
        $o.Reason | Should -Be 'v6.1.2 is released.'
    }
    It 'names the first stage that failed: <stage>' -ForEach @(
        @{ stage = 'beta'; text = '*Cut Beta failed for 6.1.2-beta.1*' }
        @{ stage = 'images'; text = '*6.1.2-beta.1 images did not appear*' }
        @{ stage = 'test'; text = '*release test of v6.1.2-beta.1 is red*' }
        @{ stage = 'release'; text = '*Cut Hotfix failed for 6.1.2*' }
    ) {
        $o = Get-Outcome @{ $stage = 'failure' }
        $o.Passed | Should -BeFalse
        $o.Reason | Should -BeLike $text
        $o.OpenIssue | Should -BeTrue
    }
    It 'reports the earliest failure, not a later skip it caused' {
        (Get-Outcome @{ test = 'failure'; release = 'skipped' }).Reason | Should -BeLike '*release test*'
    }
    It 'treats a skipped release after a green test as a failure, not a release' {
        (Get-Outcome @{ release = 'skipped' }).Passed | Should -BeFalse
    }
    It 'does not ask the beta route for a release stage it never has' {
        $o = Get-Outcome @{ release = 'skipped' } -Beta
        $o.Passed | Should -BeTrue
        $o.Reason | Should -Be 'v6.1.2-beta.1 is published and passed the release test.'
    }
    It 'still fails the beta route on a red test' { (Get-Outcome @{ test = 'failure'; release = 'skipped' } -Beta).Passed | Should -BeFalse }
    It 'says where a cancelled run stopped' { (Get-Outcome @{ images = 'cancelled' }).Reason | Should -Be "The run was cancelled at 'images'." }
    It 'passes a dry run whose image wait and test were skipped, and reports nothing' {
        $o = Get-Outcome @{ images = 'skipped'; test = 'skipped' } -DryRun
        $o.Passed | Should -BeTrue; $o.OpenIssue | Should -BeFalse
    }
    It 'does not let a dry run skip a stage that does not need a tag' {
        $o = Get-Outcome @{ beta = 'skipped'; images = 'skipped'; test = 'skipped' } -DryRun
        $o.Passed | Should -BeFalse; $o.OpenIssue | Should -BeFalse
    }
    It 'opens no issue for a failed dry run' { (Get-Outcome @{ beta = 'failure' } -DryRun).OpenIssue | Should -BeFalse }
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

Describe 'Invoke-Git' {
    It 'returns git''s output lines' {
        @(Invoke-Git rev-parse --is-inside-work-tree) | Should -Be @('true')
    }
    It 'throws with git''s message on failure' {
        { Invoke-Git rev-parse --verify no-such-ref-at-all } | Should -Throw '*git rev-parse --verify no-such-ref-at-all failed*'
    }
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
