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

    Scope note: this covers two families.

      1. The crawler pure-shaper family (the ConvertTo-* record shapers extracted
         from the entry points for testability).
      2. The shared crawler helper library (tools/crawlers/shared/), excluding
         Start-* entry points and Test-* helpers — this is the ingest/retry/batch
         layer every crawler routes through, and it is deliberately NOT pure. It
         was added because a mutation score measured only over pure shapers reads
         as a suite-wide quality claim while describing the easiest code in the
         tree: the shapers scored ~95% while the retry/batch layer scored 39.7%
         the first time it was measured.

    Broadening further to the SDK / riskscoring / crawler Functions+Phases layers
    needs an eligibility definition for those roots and is tracked as the
    remainder of #684.

.USAGE
    Invoke-Pester -Path test/unit/PSMutationScope.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $cfg = Get-Content (Join-Path $script:repoRoot '.ci' 'psmutant.config.json') -Raw | ConvertFrom-Json
    $script:mutate = @($cfg.mutate)
    $script:testMap = $cfg.tests
    $script:exclusions = @()
    if ($cfg.PSObject.Properties.Name -contains 'exclusions' -and $cfg.exclusions) {
        $script:exclusions = @($cfg.exclusions.PSObject.Properties.Name)
    }

    # Candidate pure-shaper files, by the naming convention the crawler guide
    # mandates for the extracted ConvertTo-* record shapers.
    $shaperPattern = '\.(Transform|AppOwners|AppPermissions|PrincipalRelationships)\.ps1$'
    $toRelative = {
        param($file)
        $file.FullName.Substring($script:repoRoot.Length + 1).Replace('\', '/')
    }
    $script:shapers = Get-ChildItem -Path (Join-Path $script:repoRoot 'tools' 'crawlers') -Recurse -File -Filter '*.ps1' |
        Where-Object { $_.Name -match $shaperPattern } |
        ForEach-Object { & $toRelative $_ } |
        Sort-Object

    # The shared helper library every crawler dot-sources. Start-* files are entry
    # points (they run live I/O on load) and Test-* files are test scaffolding —
    # neither is mutation-testable, so both are out of the eligible set by rule
    # rather than by a hand-maintained exclusion.
    $script:shared = Get-ChildItem -Path (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared') -File -Filter '*.ps1' |
        Where-Object { $_.Name -notlike 'Start-*' -and $_.Name -notlike 'Test-*' } |
        ForEach-Object { & $toRelative $_ } |
        Sort-Object

    $script:candidates = @($script:shapers) + @($script:shared) | Sort-Object -Unique
    $script:shaperPattern = $shaperPattern
}

Describe 'PSMutant scope completeness (#684)' {

    It 'finds at least the known crawler shapers (guard is actually scanning something)' {
        # A sanity floor so a broken glob can't make the guard vacuously pass.
        $script:shapers.Count | Should -BeGreaterOrEqual 8
    }

    It 'finds the shared crawler helper library (guard covers the non-pure layer too)' {
        $script:shared.Count | Should -BeGreaterOrEqual 2
        $script:shared | Should -Contain 'tools/crawlers/shared/Invoke-CrawlerIngest.ps1'
    }

    It 'every eligible crawler file is either mutation-tested or explicitly excluded' {
        $missing = $script:candidates | Where-Object { $_ -notin $script:mutate -and $_ -notin $script:exclusions }
        $missing | Should -BeNullOrEmpty -Because "these files are in neither `mutate` nor `exclusions` in .ci/psmutant.config.json — add them to one: $($missing -join ', ')"
    }

    It 'the config lists no stale entries that no longer exist on disk' {
        foreach ($f in (@($script:mutate) + @($script:exclusions))) {
            (Test-Path (Join-Path $script:repoRoot $f)) | Should -BeTrue -Because "$f is listed in psmutant.config.json but does not exist"
        }
    }

    It 'every mutated file names at least one test suite that exercises it' {
        # A file in `mutate` with no `tests` entry gets measured against whatever
        # the default suite happens to be — the score would look real and mean
        # nothing.
        foreach ($f in $script:mutate) {
            $script:testMap.PSObject.Properties.Name | Should -Contain $f -Because "$f is mutated but has no entry in the config's `tests` map"
            foreach ($t in $script:testMap.$f) {
                (Test-Path (Join-Path $script:repoRoot $t)) | Should -BeTrue -Because "$f maps to test file $t, which does not exist"
            }
        }
    }
}
