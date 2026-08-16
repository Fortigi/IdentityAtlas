#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Scope-completeness guard for PowerShell mutation testing (#684).

.DESCRIPTION
    PSMutant's `mutate` list in .ci/psmutant.config.json is hand-maintained. Nothing
    otherwise stops a NEW crawler file from being added without being wired into
    mutation testing. It would be line-covered but never mutation-tested, and no
    gate would notice (the JS side has this same class of guard:
    assignmentTypes.guard.test.js / resourceTypes.guard.test.js).

    This guard enumerates every eligible crawler file and fails when one is in
    neither the config's `mutate` list nor its reviewed `exclusions` map, forcing a
    conscious decision: mutation-test it, or excuse it with a written reason.

    ELIGIBILITY IS STRUCTURAL, NOT BY FILENAME. Every .ps1 under tools/crawlers/ is
    eligible except:

      * Start-*  — crawler entry points. They run live I/O the moment they are
                   dot-sourced, so they are unreachable by Pester without a tenant.
      * Test-*   — self-test harnesses and test scaffolding, not product code.
      * Seed-*   — data seeders (matches the coverage job's own exclusion).
      * dev/     — development-only tooling; the dispatcher never loads it.

    It used to be a filename pattern instead — '*.Transform/.AppOwners/
    .AppPermissions/.PrincipalRelationships.ps1' plus everything in shared/. That
    is exactly how EntraIDCrawler.AppRoles.ps1 stayed outside mutation scope while
    being pure shaper code (six ConvertTo-*/New-*Record functions): it escaped on a
    naming technicality, and the guard designed to catch that class of omission
    could not see it. A rule keyed on what a file IS beats one keyed on what it was
    named. The same mistake, one layer up, is what kept tools/crawlers/shared/ out
    of the Pester coverage figure — that sweep enumerated crawler directories by
    the presence of crawler.json, and shared/ has none.

    Consequence worth understanding before adding an exclusion: `exclusions` is the
    escape hatch, so it is only as good as its reasons. "Not yet measured" for a
    dozen files is a dumping ground, not a decision. Each entry below names why the
    file cannot or should not be mutated today, specifically enough to be argued
    with.

    Still out of scope entirely (different roots, needing their own eligibility
    definition): tools/powershell-sdk/ and tools/riskscoring/ — the remainder
    of #684.

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

    $toRelative = {
        param($file)
        $file.FullName.Substring($script:repoRoot.Length + 1).Replace('\', '/')
    }

    # Structural eligibility: everything under tools/crawlers/ that is product code.
    # The four exclusions are properties of what the file IS, not of what it was
    # named — see the header for why a name-based rule failed.
    $script:ineligiblePrefixes = 'Start-', 'Test-', 'Seed-'
    $script:candidates = Get-ChildItem -Path (Join-Path $script:repoRoot 'tools' 'crawlers') -Recurse -File -Filter '*.ps1' |
        Where-Object {
            $name = $_.Name
            ($_.FullName -notmatch '[\\/]dev[\\/]') -and
            -not ($script:ineligiblePrefixes | Where-Object { $name.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) })
        } |
        ForEach-Object { & $toRelative $_ } |
        Sort-Object -Unique

    # Kept as a named subset purely so the sanity floor below still asserts the
    # shaper family is being seen — a broken glob must not make the guard vacuous.
    $shaperPattern = '\.(Transform|AppOwners|AppPermissions|PrincipalRelationships|AppRoles)\.ps1$'
    $script:shapers = @($script:candidates | Where-Object { $_ -match $shaperPattern })
    $script:shared  = @($script:candidates | Where-Object { $_ -like 'tools/crawlers/shared/*' })
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
