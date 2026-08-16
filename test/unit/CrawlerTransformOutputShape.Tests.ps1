#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Cross-crawler output-shape contract for the pure transform record-shapers.

.DESCRIPTION
    A fixture-based, credential-free stand-in for the deep tenant test: instead of
    running a crawler against a live tenant, it dot-sources every crawler's
    *.Transform.ps1 and EXECUTES the assignment-/resource-emitting shapers on canned
    input, then asserts the emitted records carry only legal shapes.

    This complements the existing guards rather than duplicating them:
      • the JS guards (assignmentTypes/assignmentTypeSchema/resourceTypes.guard.test.js)
        STATICALLY scan the crawler source for retired literals;
      • migration 054's CHECK rejects them at the DB write path;
      • this test proves the transforms, when actually run, EMIT only the legal set —
        catching a computed/conditional path a source scan can miss, and a new shaper
        whose own unit test forgot to assert its assignmentType.

    assignmentType is a CLOSED vocabulary — {Direct, Indirect, Eligible}; ownership,
    governance and the old source-detail types collapse to these (data model v3.1).
    resourceType is OPEN, but the two renamed Entra literals (EntraGroup -> Group,
    EntraRole -> EntraDirectoryRole, migration 052) must never reappear.

.USAGE
    Invoke-Pester -Path test/unit/CrawlerTransformOutputShape.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $crawlers = Join-Path $script:repoRoot 'tools' 'crawlers'
    # Entra's transform is split across files (file-length ratchet) — ConvertTo-*
    # shapers call helpers in Functions.ps1 / AppOwners.ps1, so dot-source the full
    # set exactly as EntraIDCrawlerTransform.Tests.ps1 does.
    . (Join-Path $crawlers 'entra-id' 'EntraIDCrawler.Functions.ps1')
    . (Join-Path $crawlers 'entra-id' 'EntraIDCrawler.Transform.ps1')
    . (Join-Path $crawlers 'entra-id' 'EntraIDCrawler.AppRoles.ps1')
    . (Join-Path $crawlers 'entra-id' 'EntraIDCrawler.AppOwners.ps1')
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'helpers' 'Get-FGServicePrincipalType.ps1')
    . (Join-Path $crawlers 'midpoint' 'MidpointCrawler.Transform.ps1')
    . (Join-Path $crawlers 'omada'    'OmadaCrawler.Transform.ps1')
    . (Join-Path $crawlers 'csv'      'CSVCrawler.Transform.ps1')
    . (Join-Path $crawlers 'azure-rm' 'AzureRMCrawler.Transform.ps1')

    $script:LEGAL_ASSIGNMENT   = @('Direct', 'Indirect', 'Eligible')
    $script:RETIRED_RESOURCE   = @('EntraGroup', 'EntraRole')

    # Collect the assignmentType values a shaper emits, tolerating a single record,
    # an array, or a { resources; assignments; relationships } bag.
    function Get-AssignmentTypes {
        param($Output)
        $recs = @()
        foreach ($o in @($Output)) {
            if ($null -eq $o) { continue }
            if ($o.assignments -or $o.resources) { $recs += @($o.assignments) }
            else { $recs += $o }
        }
        @($recs | Where-Object { $_ -and $null -ne $_.assignmentType } | ForEach-Object { $_.assignmentType })
    }
}

Describe 'Crawler transform output contract — assignmentType is always legal' {
    It 'CSV — ConvertTo-CsvAssignmentRecord emits only the legal set' {
        $idx = @{ Res = 0; User = 1; Type = 2 }
        foreach ($t in @('Direct', 'Indirect', 'Eligible', '')) {
            $rec = ConvertTo-CsvAssignmentRecord -Row @('r1', 'u1', $t) -Idx $idx -SystemId 2
            $rec.assignmentType | Should -BeIn $script:LEGAL_ASSIGNMENT
        }
    }

    It 'Entra — ConvertTo-EntraGroupOwnership emits legal assignments + non-retired resources' {
        $out = ConvertTo-EntraGroupOwnership -RawOwners @(
            @{ groupId = 'g1'; principalId = 'u1' }
            @{ groupId = 'g2'; principalId = 'u1' }
        ) -GroupNameById @{ g1 = 'Sales'; g2 = 'Eng' }
        (Get-AssignmentTypes $out) | Should -Not -BeNullOrEmpty
        foreach ($a in Get-AssignmentTypes $out) { $a | Should -BeIn $script:LEGAL_ASSIGNMENT }
        $out.resources | ForEach-Object { $_.resourceType | Should -Not -BeIn $script:RETIRED_RESOURCE }
    }

    It 'Midpoint — entitlement + governance assignments are legal' {
        (New-MidpointEntitlementAssignmentRecord -EntitlementOid 'e1' -OwnerOid 'u1' -ViaAccount 's9').assignmentType `
            | Should -BeIn $script:LEGAL_ASSIGNMENT
        (New-MidpointGovernanceAssignmentRecord -ResourceId 'r1' -PrincipalId 'u1' -ResourceType 'BusinessRole' -Grant 'direct').assignmentType `
            | Should -BeIn $script:LEGAL_ASSIGNMENT
    }

    It 'Omada — role assignment is legal' {
        $item = [pscustomobject]@{ VALIDFROM = '2026-01-01'; VALIDTO = '2026-12-31' }
        (New-OmadaRoleAssignmentRecord -ResourceUid 'res-1' -PrincipalId 'usr-1' -RoleAssignment $item).assignmentType `
            | Should -BeIn $script:LEGAL_ASSIGNMENT
    }

    It 'Azure RM — role grant is legal' {
        $a = [pscustomobject]@{ name = 'ra1'; properties = [pscustomobject]@{ principalId = 'p1' } }
        (New-AzureGrantRecord -CapResId 'cap1' -Assignment $a -PrincipalType 'User').assignmentType `
            | Should -BeIn $script:LEGAL_ASSIGNMENT
    }

    It 'the union of every emitted assignmentType is a subset of the legal set (never a retired type)' {
        $idx  = @{ Res = 0; User = 1; Type = 2 }
        $azA  = [pscustomobject]@{ name = 'ra1'; properties = [pscustomobject]@{ principalId = 'p1' } }
        $emitted = @()
        $emitted += (ConvertTo-CsvAssignmentRecord -Row @('r1', 'u1', 'Eligible') -Idx $idx -SystemId 2).assignmentType
        $emitted += Get-AssignmentTypes (ConvertTo-EntraGroupOwnership -RawOwners @(@{ groupId = 'g1'; principalId = 'u1' }) -GroupNameById @{ g1 = 'Sales' })
        $emitted += (New-MidpointEntitlementAssignmentRecord -EntitlementOid 'e1' -OwnerOid 'u1' -ViaAccount 's9').assignmentType
        $emitted += (New-MidpointGovernanceAssignmentRecord -ResourceId 'r1' -PrincipalId 'u1' -ResourceType 'BusinessRole' -Grant 'direct').assignmentType
        $emitted += (New-OmadaRoleAssignmentRecord -ResourceUid 'res-1' -PrincipalId 'usr-1' -RoleAssignment ([pscustomobject]@{ VALIDFROM = '2026-01-01' })).assignmentType
        $emitted += (New-AzureGrantRecord -CapResId 'cap1' -Assignment $azA -PrincipalType 'User').assignmentType

        $illegal = @($emitted | Where-Object { $_ -and $_ -notin $script:LEGAL_ASSIGNMENT }) | Sort-Object -Unique
        $illegal | Should -BeNullOrEmpty
    }
}
