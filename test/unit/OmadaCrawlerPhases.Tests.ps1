#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the extracted Omada crawler sync phases
    (OmadaCrawler.Phases.ps1).

.DESCRIPTION
    The Start script's Main body is NOT run — only the dot-sourced sibling files
    are. The OData boundary (Invoke-ODataPagedRequest / Invoke-ODataGetRequest),
    entity-set probe (Test-EntitySetAvailable), and ingest boundary
    (Send-IngestBatch) are mocked/stubbed, so no real HTTP is performed; the pure
    shapers in OmadaCrawler.Transform.ps1 run for real. Phases read/write the same
    $Script:phases / $Script:phaseErrors state they do when dot-sourced.

.USAGE
    Invoke-Pester -Path test/unit/OmadaCrawlerPhases.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:omadaRoot = Join-Path $script:repoRoot 'tools\crawlers\omada'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:omadaRoot 'Get-OmadaHelpers.ps1')
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Functions.ps1')
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Transform.ps1')
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Phases.ps1')

    # Script-scope state the phases + shared helpers + shapers read at call time.
    $script:ApiKey     = 'fgc_test'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0
    $script:TypeMappings = @{
        contextTypeToIdentityAtlas  = @{ 'OrgUnit' = 'OrgUnit' }
        identityTypeToIdentityAtlas = @{ Employee = 'User' }
    }
    $script:ResourceCategoryMapping = @(
        @{ category = 'Business Role'; resourceType = 'BusinessRole' }
        @{ category = '';             resourceType = 'Resource' }
    )

    # OData + entity-set probe the phases call — stubs so Pester can Mock them.
    function Invoke-ODataPagedRequest { param([string]$Path, [hashtable]$QueryParams, [int]$PageSize, [int]$MaxRetries) }
    function Invoke-ODataGetRequest   { param([string]$Path, [hashtable]$QueryParams, [int]$MaxRetries, [string]$OverrideBaseUrl) }
    function Test-EntitySetAvailable  { param([string]$Name) $true }

    function Reset-PhaseTestState {
        $script:phases      = [System.Collections.Generic.List[object]]::new()
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:sent        = [System.Collections.Generic.List[object]]::new()
    }
    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{
            Endpoint = $Endpoint
            SystemId = $SystemId
            SyncMode = $SyncMode
            Scope    = $Scope
            Records  = @($Records)
        })
        return @{ inserted = @($Records).Count; updated = 0; deleted = 0 }
    }
    function Get-Sent {
        param([scriptblock]$Where)
        @($script:sent | Where-Object $Where)
    }
}

# ─── Get-OmadaUserGroupMap ──────────────────────────────────────────────────────
Describe 'Get-OmadaUserGroupMap' {
    BeforeEach { Reset-PhaseTestState }

    It 'builds a UId -> DisplayName map from the Usergroup entity set' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Usergroup' } -MockWith {
            @(
                [pscustomobject]@{ UId = 'ug1'; DisplayName = 'Admins' }
                [pscustomobject]@{ UId = 'ug2'; DisplayName = 'Users' }
            )
        }
        $map = Get-OmadaUserGroupMap
        $map['ug1'] | Should -Be 'Admins'
        $map.Count | Should -Be 2
    }

    It 'returns an empty map when the Usergroup entity set is unavailable' {
        Mock Test-EntitySetAvailable -MockWith { $false }
        Mock Invoke-ODataPagedRequest -MockWith { throw 'should not be called' }
        (Get-OmadaUserGroupMap).Count | Should -Be 0
    }
}

# ─── Sync-OmadaResources ────────────────────────────────────────────────────────
Describe 'Sync-OmadaResources' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'uploads resource records and returns the raw resources' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Usergroup' } -MockWith { @() }
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Resource' } -MockWith {
            @(
                [pscustomobject]@{ UId = 'r1'; NAME = 'Role One'; ROLECATEGORY = [pscustomobject]@{ Value = 'Business Role' } }
                [pscustomobject]@{ UId = 'r2'; NAME = 'Perm Two';  ROLECATEGORY = [pscustomobject]@{ Value = 'Permission' } }
            )
        }
        $returned = Sync-OmadaResources -SystemId 3 -OmadaSystemMap @{} -AllOmadaSystems @()

        $sent = Get-Sent { $_.Endpoint -eq 'ingest/resources' }
        $sent[0].Records.Count | Should -Be 2
        $sent[0].SystemId | Should -Be 3   # all fall to __main__ -> SystemId
        @($returned).Count | Should -Be 2
        @($returned).UId | Should -Contain 'r1'
        ($script:phases | Where-Object { $_.name -eq 'Resources' }).status | Should -Be 'ok'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the Resource entity set is unavailable' {
        Mock Test-EntitySetAvailable -MockWith { $false }
        Sync-OmadaResources -SystemId 1 -OmadaSystemMap @{} -AllOmadaSystems @()
        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'Resources:*'
    }

    It 'records a phase failure when the resource fetch throws' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Usergroup' } -MockWith { @() }
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Resource' } -MockWith { throw 'OData 500' }
        Sync-OmadaResources -SystemId 1 -OmadaSystemMap @{} -AllOmadaSystems @()
        $script:phaseErrors[0] | Should -BeLike 'Resources:*'
    }
}

# ─── Sync-OmadaEntitlements ─────────────────────────────────────────────────────
Describe 'Sync-OmadaEntitlements' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'extracts CHILDROLES into Contains relationships' {
        $resources = @(
            [pscustomobject]@{ UId = 'parent1'; CHILDROLES = @([pscustomobject]@{ UId = 'child1' }, [pscustomobject]@{ UId = 'child2' }) }
            [pscustomobject]@{ UId = 'leaf'; CHILDROLES = $null }
        )
        Sync-OmadaEntitlements -SystemId 2 -AllResources $resources

        $sent = Get-Sent { $_.Scope.relationshipType -eq 'Contains' }
        $sent[0].Records.Count | Should -Be 2
        $sent[0].Records[0].parentResourceId | Should -Be 'parent1'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'skips (records 0) when resources were not synced' {
        Sync-OmadaEntitlements -SystemId 1 -AllResources $null
        (Get-Sent { $_.Scope.relationshipType -eq 'Contains' }).Count | Should -Be 0
        ($script:phases | Where-Object { $_.name -eq 'Entitlements' }).records.relationships | Should -Be 0
    }

    It 'records a phase failure when the ingest throws' {
        Mock Send-IngestBatch -MockWith { throw 'ingest 500' }
        Sync-OmadaEntitlements -SystemId 1 -AllResources @([pscustomobject]@{ UId = 'p'; CHILDROLES = @([pscustomobject]@{ UId = 'c' }) })
        $script:phaseErrors[0] | Should -BeLike 'Entitlements:*'
    }
}

# ─── Sync-OmadaRefreshViews ─────────────────────────────────────────────────────
Describe 'Sync-OmadaRefreshViews' {
    BeforeEach { Reset-PhaseTestState }

    It 'calls the refresh-views ingest endpoint' {
        Mock Invoke-IngestAPI -MockWith { @{} }
        Sync-OmadaRefreshViews
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Endpoint -eq 'ingest/refresh-views' }
    }

    It 'soft-fails when the refresh endpoint throws' {
        Mock Invoke-IngestAPI -MockWith { throw 'refresh 500' }
        { Sync-OmadaRefreshViews } | Should -Not -Throw
    }
}

# ─── Sync-OmadaContexts ─────────────────────────────────────────────────────────
Describe 'Sync-OmadaContexts' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests orgunit contexts and returns the synced context id set' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Orgunit' } -MockWith {
            @(
                [pscustomobject]@{ UId = 'ou-root'; NAME = 'Root' }
                [pscustomobject]@{ UId = 'ou-1'; NAME = 'Sales'; PARENTOU = [pscustomobject]@{ UId = 'ou-root' } }
            )
        }
        $cot = @(@{ entitySet = 'Orgunit'; contextType = 'OrgUnit' })
        $synced = Sync-OmadaContexts -SystemId 1 -ContextObjectTypes $cot

        (Get-Sent { $_.Endpoint -eq 'ingest/contexts' })[0].Records.Count | Should -Be 2
        $synced.Contains('ou-1') | Should -BeTrue
        $synced.Count | Should -Be 2
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when every context type fails' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Orgunit' } -MockWith { throw 'OData 500' }
        Sync-OmadaContexts -SystemId 1 -ContextObjectTypes @(@{ entitySet = 'Orgunit'; contextType = 'OrgUnit' })
        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'Contexts:*'
    }
}

# ─── Sync-OmadaIdentities ───────────────────────────────────────────────────────
Describe 'Sync-OmadaIdentities' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests person-type identities and returns the lookup + in-table set' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Identity' } -MockWith {
            @(
                [pscustomobject]@{ UId = 'id-1'; IDENTITYID = 'ID-1'; FIRSTNAME = 'Alice'; LASTNAME = 'Smith'; IDENTITYTYPE = [pscustomobject]@{ Value = 'Employee' } }
                [pscustomobject]@{ UId = 'id-2'; IDENTITYID = 'ID-2'; FIRSTNAME = 'Bob'; LASTNAME = 'Ng'; IDENTITYTYPE = [pscustomobject]@{ Value = 'Contractor' } }
            )
        }
        $r = Sync-OmadaIdentities -SystemId 1 -IdentityTypesForIdentityTable @('Employee')

        # Only the Employee lands in the Identities table.
        (Get-Sent { $_.Endpoint -eq 'ingest/identities' })[0].Records.Count | Should -Be 1
        $r.identityLookup['ID-1'].uid | Should -Be 'id-1'
        $r.identityLookup.Count | Should -Be 2
        $r.identityUidInIdentitiesTable.Contains('id-1') | Should -BeTrue
        $r.identityUidInIdentitiesTable.Contains('id-2') | Should -BeFalse
        @($r.allIdentities).Count | Should -Be 2
    }

    It 'records a phase failure when the Identity entity set is unavailable' {
        Mock Test-EntitySetAvailable -MockWith { $false }
        $r = Sync-OmadaIdentities -SystemId 1 -IdentityTypesForIdentityTable @('Employee')
        $script:phaseErrors[0] | Should -BeLike 'Identities:*'
        $r.identityLookup.Count | Should -Be 0
    }
}

# ─── Get-OmadaAccountLookups (pure) ─────────────────────────────────────────────
Describe 'Get-OmadaAccountLookups' {

    It 'builds userName->uid and identityUid->[userUids], skipping inactive accounts' {
        $lookup = @{ 'ID-1' = @{ uid = 'id-1'; identityType = 'Employee' } }
        $accounts = @(
            [pscustomobject]@{ UId = 'acc-1'; UserName = 'alice'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }
            [pscustomobject]@{ UId = 'acc-2'; UserName = 'alice2'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }
            [pscustomobject]@{ UId = 'acc-3'; UserName = 'ghost'; Inactive = $true }
        )
        $r = Get-OmadaAccountLookups -AllAccounts $accounts -IdentityLookup $lookup

        $r.userNameToUid['alice'] | Should -Be 'acc-1'
        $r.userNameToUid.ContainsKey('ghost') | Should -BeFalse
        @($r.identityUidToUserUids['id-1']) | Should -Be @('acc-1','acc-2')
    }
}

# ─── Sync-OmadaAccounts ─────────────────────────────────────────────────────────
Describe 'Sync-OmadaAccounts' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests accounts bucketed by principalType and returns account lookups' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/User' } -MockWith {
            @(
                [pscustomobject]@{ UId = 'acc-1'; UserName = 'alice'; FIRSTNAME = 'Alice'; LASTNAME = 'Smith'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }
            )
        }
        $lookup = @{ 'ID-1' = @{ uid = 'id-1'; identityType = 'Employee' } }
        $r = Sync-OmadaAccounts -SystemId 4 -IdentityLookup $lookup

        (Get-Sent { $_.Endpoint -eq 'ingest/principals' -and $_.Scope.principalType -eq 'User' })[0].Records.Count | Should -Be 1
        @($r.allAccounts).Count | Should -Be 1
        $r.userNameToUid['alice'] | Should -Be 'acc-1'
        @($r.identityUidToUserUids['id-1']) | Should -Be @('acc-1')
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the account fetch throws' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/User' } -MockWith { throw 'OData 500' }
        Sync-OmadaAccounts -SystemId 1 -IdentityLookup @{}
        $script:phaseErrors[0] | Should -BeLike 'Accounts:*'
    }
}
