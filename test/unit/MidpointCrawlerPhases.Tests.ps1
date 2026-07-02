#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the extracted midPoint crawler sync phases
    (MidpointCrawler.Phases.ps1).

.DESCRIPTION
    The Start script's Main body is NOT run — only the dot-sourced sibling files
    are. The midPoint boundary (Invoke-MidpointSearch / Invoke-MidpointSearchStream),
    ingest boundary (Send-IngestBatch / Invoke-IngestAPI) and Invoke-RestMethod are
    mocked/stubbed, so no real HTTP is performed; the pure shapers in
    MidpointCrawler.Transform.ps1 and helpers in Invoke-MidpointApi.ps1 run for real.
    Phases read/write the same $Script:phaseErrors / $Script:fetchStats state they
    do when dot-sourced.

.USAGE
    Invoke-Pester -Path test/unit/MidpointCrawlerPhases.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:midpointDir = Join-Path $script:repoRoot 'tools\crawlers\midpoint'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:midpointDir 'Invoke-MidpointApi.ps1')      # Get-Midpoint* helpers + ConvertTo-MapRows
    . (Join-Path $script:midpointDir 'MidpointCrawler.Functions.ps1') # Send-IngestBatch, Add-PhaseError, Write-Step, streams
    . (Join-Path $script:midpointDir 'MidpointCrawler.Transform.ps1')
    . (Join-Path $script:midpointDir 'MidpointCrawler.Phases.ps1')

    $script:ApiKey     = 'fgc_test'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0

    function Reset-PhaseTestState {
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:fetchStats  = [ordered]@{}
        $script:ingestStats = [ordered]@{}
        $script:sent        = [System.Collections.Generic.List[object]]::new()
    }
    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; SystemId = $SystemId; Scope = $Scope; Records = @($Records) })
        return @{ inserted = @($Records).Count; updated = 0; deleted = 0 }
    }
    function Get-Sent {
        param([scriptblock]$Where)
        @($script:sent | Where-Object $Where)
    }
}

# ─── Sync-MidpointSystems ───────────────────────────────────────────────────────
Describe 'Sync-MidpointSystems' {
    BeforeEach { Reset-PhaseTestState }

    It 'registers midPoint + data-holding resources and resolves the system-id map' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'resources' } -MockWith {
            @([pscustomobject]@{ oid = 'res-1'; name = 'AD' }, [pscustomobject]@{ oid = 'res-2'; name = 'EmptyConn' })
        }
        # The shadow scan finds account/entitlement shadows only on res-1.
        Mock Invoke-MidpointSearchStream -MockWith {
            if ($OnPage) { & $OnPage @([pscustomobject]@{ kind = 'account'; oid = 'sh1'; resourceRef = @{ oid = 'res-1' } }) }
            return 1
        }
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith {
            @(
                [pscustomobject]@{ systemType = 'Midpoint'; tenantId = 'https://mp.example.com'; id = 10 }
                [pscustomobject]@{ systemType = 'Midpoint'; tenantId = 'res-1'; id = 11 }
            )
        }

        $r = Sync-MidpointSystems -RestRoot 'https://mp.example.com' -ApiBaseUrl 'https://x/api' -ApiKey 'k'

        $r.midpointSystemId | Should -Be 10
        $r.resourceSystemId['res-1'] | Should -Be 11
        $r.resourceOidToName['res-1'] | Should -Be 'AD'
        # res-2 held no shadows → registered set has only midPoint + res-1.
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Endpoint -eq 'ingest/systems' }
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'throws (critical phase) when the system id cannot be resolved' {
        Mock Invoke-MidpointSearch -MockWith { @() }
        Mock Invoke-MidpointSearchStream -MockWith { 0 }
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith { @() }   # no atlas systems -> id stays 0

        { Sync-MidpointSystems -RestRoot 'https://mp.example.com' -ApiBaseUrl 'https://x/api' -ApiKey 'k' } | Should -Throw
        $script:phaseErrors[0] | Should -BeLike 'Systems:*'
    }
}

# ─── Sync-MidpointOrgs ──────────────────────────────────────────────────────────
Describe 'Sync-MidpointOrgs' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests org contexts and returns the synced-org id set + name map' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'orgs' } -MockWith {
            @(
                [pscustomobject]@{ oid = 'org-root'; name = 'Root' }
                [pscustomobject]@{ oid = 'org-1'; name = 'Sales'; parentOrgRef = @{ oid = 'org-root' } }
            )
        }
        $mapping = ConvertTo-MapRows $null @('orgSubtype', 'contextType')
        $r = Sync-MidpointOrgs -MidpointSystemId 10 -OrgContextMapping $mapping

        (Get-Sent { $_.Endpoint -eq 'ingest/contexts' })[0].Records.Count | Should -Be 2
        $r.syncedOrgIds.Contains('org-1') | Should -BeTrue
        $r.orgOidToName['org-1'] | Should -Be 'Sales'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase error when the org fetch throws' {
        Mock Invoke-MidpointSearch -MockWith { throw 'midPoint 500' }
        Sync-MidpointOrgs -MidpointSystemId 10 -OrgContextMapping (ConvertTo-MapRows $null @('orgSubtype','contextType'))
        $script:phaseErrors[0] | Should -BeLike 'Orgs:*'
    }
}

# ─── Sync-MidpointRefreshViews ──────────────────────────────────────────────────
Describe 'Sync-MidpointRefreshViews' {
    BeforeEach { Reset-PhaseTestState }

    It 'posts to the refresh-views endpoint' {
        Mock Invoke-RestMethod -MockWith { @{} }
        Sync-MidpointRefreshViews -ApiBaseUrl 'https://x/api' -ApiKey 'k'
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Uri -match '/ingest/refresh-views' }
    }

    It 'soft-fails (no throw) when refresh-views errors' {
        Mock Invoke-RestMethod -MockWith { throw 'refresh 500' }
        { Sync-MidpointRefreshViews -ApiBaseUrl 'https://x/api' -ApiKey 'k' } | Should -Not -Throw
    }
}

# ─── Get-MidpointArchetypeLabels ────────────────────────────────────────────────
Describe 'Get-MidpointArchetypeLabels' {
    BeforeEach { Reset-PhaseTestState }

    It 'builds an oid -> labels map from the archetype catalog' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'archetypes' } -MockWith {
            @([pscustomobject]@{ oid = 'arch-1'; name = 'application-role'; displayName = 'Application Role' })
        }
        $labels = Get-MidpointArchetypeLabels
        @($labels['arch-1']) | Should -Contain 'application-role'
        @($labels['arch-1']) | Should -Contain 'Application Role'
    }

    It 'returns an empty map (soft-fail) when the catalog fetch throws' {
        Mock Invoke-MidpointSearch -MockWith { throw 'midPoint 500' }
        (Get-MidpointArchetypeLabels).Count | Should -Be 0
    }
}

# ─── Sync-MidpointResources ─────────────────────────────────────────────────────
Describe 'Sync-MidpointResources' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'buckets roles + services by resourceType and returns the synced-id state' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'roles' } -MockWith {
            @([pscustomobject]@{ oid = 'role-1'; name = 'admin'; displayName = 'Administrator' })
        }
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'services' } -MockWith {
            @([pscustomobject]@{ oid = 'svc-1'; name = 'email'; displayName = 'Email' })
        }
        $mapping = ConvertTo-MapRows $null @('archetype', 'subtype', 'resourceType')
        $r = Sync-MidpointResources -MidpointSystemId 10 -ArchetypeMapping $mapping

        (Get-Sent { $_.Scope.resourceType -eq 'BusinessRole' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.resourceType -eq 'Service' })[0].Records.Count | Should -Be 1
        @($r.allRoles).Count | Should -Be 1
        $r.syncedResourceIds.Contains('role-1') | Should -BeTrue
        $r.syncedResourceIds.Contains('svc-1') | Should -BeTrue
        $r.resourceOidToType['role-1'] | Should -Be 'BusinessRole'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a Roles phase error when the roles fetch throws (services still run)' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'roles' } -MockWith { throw 'roles 500' }
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'services' } -MockWith { @() }
        Sync-MidpointResources -MidpointSystemId 10 -ArchetypeMapping (ConvertTo-MapRows $null @('archetype','subtype','resourceType'))
        $script:phaseErrors | Where-Object { $_ -like 'Roles:*' } | Should -Not -BeNullOrEmpty
    }
}

# ─── Sync-MidpointUsers ─────────────────────────────────────────────────────────
Describe 'Sync-MidpointUsers' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests identities/principals/members and returns the user + shadow-owner maps' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'users' } -MockWith {
            @([pscustomobject]@{ oid = 'u-1'; name = 'alice'; fullName = 'Alice Smith'; linkRef = @(@{ oid = 'sh-1' }) })
        }
        $mapping = ConvertTo-MapRows $null @('userType', 'principalType')
        $r = Sync-MidpointUsers -MidpointSystemId 10 -OrgOidToName @{} -IdentityTypeMapping $mapping

        (Get-Sent { $_.Endpoint -eq 'ingest/identities' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/principals' -and $_.Scope.principalType -eq 'User' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/identity-members' })[0].Records.Count | Should -Be 1
        @($r.allUsers).Count | Should -Be 1
        $r.userOidToName['u-1'] | Should -Be 'Alice Smith'
        $r.shadowOidToUserOid['sh-1'] | Should -Be 'u-1'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a Users phase error when the users fetch throws' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'users' } -MockWith { throw 'users 500' }
        Sync-MidpointUsers -MidpointSystemId 10 -OrgOidToName @{} -IdentityTypeMapping (ConvertTo-MapRows $null @('userType','principalType'))
        $script:phaseErrors[0] | Should -BeLike 'Users:*'
    }
}
