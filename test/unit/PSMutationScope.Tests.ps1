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

    THE OTHER ROOTS. tools/powershell-sdk/ (86 files) and tools/riskscoring/ (17)
    used to be invisible here, and that is a subtler version of the same bug: the
    guard reported "every eligible file is mutation-tested or excluded with a
    reason", which reads as a claim about the PowerShell tree while describing one
    directory. Zero unknown files and 103 unlooked-at files produced the same green
    tick. A guard scoped to a directory cannot tell you what is outside it.

    Their eligibility rule is deliberately NOT the crawler rule:

      * Every .ps1 in both roots is eligible. They are function libraries — one
        function per file, no load-time side effects, and nothing dot-sources a
        sibling on load, so all of it is reachable from Pester.
      * The Start-/Test-/Seed- prefix exclusions are NOT applied. In tools/crawlers/
        `Test-*` means a self-test harness; in an SDK it is the standard PowerShell
        verb for a predicate, and Test-FGDistinguishedName / Test-FGSecureConfigValue
        are ordinary product code — exactly the pure functions mutation testing is
        best at. Carrying the crawler rule across would have excluded real code on a
        naming technicality, which is the mistake this file already exists to
        prevent.

    103 files cannot be triaged at once, and 102 exclusion entries reading "not yet
    measured" would be the dumping ground warned about below. Instead they are
    grandfathered in .ci/psmutant-scope-baseline.json, the same shape as the
    coverage/filesize/complexity baselines: the list may only shrink, and a NEW file
    in those roots cannot join it silently — the guard fails it, forcing the same
    decision a new crawler file already requires.

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

    # ── The SDK / risk-scoring roots ────────────────────────────────────────────
    # Every .ps1 is eligible; see the header for why the crawler prefix rules are
    # deliberately not carried across.
    $script:otherRoots = 'tools/powershell-sdk', 'tools/riskscoring'
    $script:otherCandidates = $script:otherRoots |
        ForEach-Object { Join-Path $script:repoRoot $_ } |
        Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem -Path $_ -Recurse -File -Filter '*.ps1' } |
        ForEach-Object { & $toRelative $_ } |
        Sort-Object -Unique

    $baselinePath = Join-Path $script:repoRoot '.ci' 'psmutant-scope-baseline.json'
    $script:grandfathered = @()
    if (Test-Path $baselinePath) {
        $script:grandfathered = @((Get-Content $baselinePath -Raw | ConvertFrom-Json).grandfathered)
    }
    $script:decided = @($script:mutate) + @($script:exclusions)
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

    It 'sees the SDK and risk-scoring roots at all (the gap this guard used to have)' {
        # A floor, not a target. If a path typo or a moved directory made this
        # enumeration empty, every assertion below would pass vacuously and the
        # guard would go back to reporting completeness over one directory.
        $script:otherCandidates.Count | Should -BeGreaterThan 90
        $script:otherCandidates | Should -Contain 'tools/powershell-sdk/graph/Invoke-FGGetPage.ps1'
        @($script:otherCandidates | Where-Object { $_ -like 'tools/riskscoring/*' }).Count |
            Should -BeGreaterThan 10
    }

    It 'counts Test-* in these roots as product code, not as test scaffolding' {
        # tools/crawlers/ treats Test-* as a self-test harness. Here it is the
        # standard PowerShell verb for a predicate. Carrying the crawler rule across
        # would drop real functions on a naming technicality — the exact failure
        # this guard was written to stop.
        $script:otherCandidates | Should -Contain 'tools/powershell-sdk/helpers/Test-FGDistinguishedName.ps1'
    }

    It 'every SDK / risk-scoring file is mutated, excluded, or explicitly grandfathered' {
        $missing = $script:otherCandidates |
            Where-Object { $_ -notin $script:decided -and $_ -notin $script:grandfathered }
        $missing | Should -BeNullOrEmpty -Because "these files are in neither psmutant.config.json (`mutate`/`exclusions`) nor .ci/psmutant-scope-baseline.json — mutation-test one, excuse it with a reason, or (last resort) grandfather it: $($missing -join ', ')"
    }

    It 'the grandfathered list holds no file that has since been decided' {
        # Leaving a file in both places lets it look deferred while it is actually
        # measured, so the backlog would never appear to shrink.
        $both = $script:grandfathered | Where-Object { $_ -in $script:decided }
        $both | Should -BeNullOrEmpty -Because "these are both grandfathered and decided in psmutant.config.json — remove them from .ci/psmutant-scope-baseline.json: $($both -join ', ')"
    }

    It 'the grandfathered list holds no file that no longer exists' {
        $stale = $script:grandfathered | Where-Object { -not (Test-Path (Join-Path $script:repoRoot $_)) }
        $stale | Should -BeNullOrEmpty -Because "these are grandfathered in .ci/psmutant-scope-baseline.json but are gone from disk: $($stale -join ', ')"
    }

    It 'grandfathering covers only the SDK / risk-scoring roots, never a crawler file' {
        # The crawler layer has a real rule and a reviewed exclusions map. Letting a
        # crawler file slip into the backlog would route around it.
        $strays = $script:grandfathered | Where-Object { $_ -notin $script:otherCandidates }
        $strays | Should -BeNullOrEmpty -Because "only tools/powershell-sdk/ and tools/riskscoring/ may be grandfathered: $($strays -join ', ')"
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
