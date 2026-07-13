#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Scope-completeness guard for PowerShell mutation testing (#684).

.DESCRIPTION
    PSMutant's `mutate` list in .ci/psmutant.config.json is hand-maintained. Nothing
    otherwise stops a NEW pure record-shaper — a *.Transform.ps1, or one of the
    extracted *.AppOwners/*.AppPermissions/*.PrincipalRelationships shapers — from
    being added without being wired into mutation testing. It would be line-covered
    but never mutation-tested, and no gate would notice (the JS side has this same
    class of guard: assignmentTypes.guard.test.js / resourceTypes.guard.test.js).

    This guard enumerates every crawler pure-shaper file and fails when one is in
    neither the config's `mutate` list nor its reviewed `exclusions` map. A new
    shaper then forces a conscious decision: mutation-test it, or excuse it with a
    reason in exclusions.

    Scope note: this covers the crawler pure-shaper family (the ConvertTo-* record
    shapers extracted from the entry points for testability) — the same set the
    config already mutates. Broadening the eligible set to the SDK / riskscoring /
    crawler Functions+Phases layers needs an eligibility definition for those roots
    and is tracked as the remainder of #684.

.USAGE
    Invoke-Pester -Path test/unit/PSMutationScope.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $cfg = Get-Content (Join-Path $script:repoRoot '.ci' 'psmutant.config.json') -Raw | ConvertFrom-Json
    $script:mutate = @($cfg.mutate)
    $script:exclusions = @()
    if ($cfg.PSObject.Properties.Name -contains 'exclusions' -and $cfg.exclusions) {
        $script:exclusions = @($cfg.exclusions.PSObject.Properties.Name)
    }

    # Candidate pure-shaper files, by the naming convention the crawler guide
    # mandates for the extracted ConvertTo-* record shapers.
    $shaperPattern = '\.(Transform|AppOwners|AppPermissions|PrincipalRelationships)\.ps1$'
    $script:candidates = Get-ChildItem -Path (Join-Path $script:repoRoot 'tools' 'crawlers') -Recurse -File -Filter '*.ps1' |
        Where-Object { $_.Name -match $shaperPattern } |
        ForEach-Object { $_.FullName.Substring($script:repoRoot.Length + 1).Replace('\', '/') } |
        Sort-Object
    $script:shaperPattern = $shaperPattern
}

Describe 'PSMutant scope completeness (#684)' {

    It 'finds at least the known crawler shapers (guard is actually scanning something)' {
        # A sanity floor so a broken glob can't make the guard vacuously pass.
        $script:candidates.Count | Should -BeGreaterOrEqual 8
    }

    It 'every crawler pure-shaper is either mutation-tested or explicitly excluded' {
        $missing = $script:candidates | Where-Object { $_ -notin $script:mutate -and $_ -notin $script:exclusions }
        $missing | Should -BeNullOrEmpty -Because "these pure-shaper files are in neither `mutate` nor `exclusions` in .ci/psmutant.config.json — add them to one: $($missing -join ', ')"
    }

    It 'the config lists no stale shaper entries that no longer exist on disk' {
        foreach ($f in (@($script:mutate) + @($script:exclusions))) {
            if ($f -match $script:shaperPattern) {
                (Test-Path (Join-Path $script:repoRoot $f)) | Should -BeTrue -Because "$f is listed in psmutant.config.json but does not exist"
            }
        }
    }
}
