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
        # 'Technical' is here to exercise the branch that handles principal types
        # outside the three built-in ones. Operators can map an Omada identity
        # type to anything via the crawler's typeMappings override (see
        # Merge-TypeMappings), so this is a real configuration, not a synthetic one.
        identityTypeToIdentityAtlas = @{ Employee = 'User'; Technical = 'TechnicalAccount' }
    }
    $script:ResourceCategoryMapping = @(
        @{ category = 'Business Role'; resourceType = 'BusinessRole' }
        @{ category = '';             resourceType = 'Resource' }
    )

    # OData + entity-set probe the phases call — stubs so Pester can Mock them.
    function Invoke-ODataPagedRequest { param([string]$Path, [hashtable]$QueryParams, [int]$PageSize, [int]$MaxRetries) }
    function Invoke-ODataGetRequest   { param([string]$Path, [hashtable]$QueryParams, [int]$MaxRetries, [string]$OverrideBaseUrl) }
    function Test-EntitySetAvailable  { param([string]$Name) $true }
    # OData session helpers the setup functions call.
    function Connect-ODataAPI    { param() }
    function Get-ODataEntitySets { }

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
    # Build a HashSet[string] from values (context-member phases take real sets).
    function New-StrSet {
        param([string[]]$Values)
        $s = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($v in $Values) { $s.Add($v) | Out-Null }
        $s
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
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Endpoint -eq 'ingest/refresh-views' }
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

    It 'uploads a principal whose type is none of the three built-in ones' {
        # Accounts are ingested in three fixed buckets (User / ExternalUser /
        # ServicePrincipal) plus a catch-all for anything an operator's typeMappings
        # override produces. Every fixture here maps to 'User', so the catch-all
        # never ran -- and its guard, read as "more than one", would drop a tenant
        # with a single such account silently: no bucket, no error, no record.
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/User' } -MockWith {
            @(
                [pscustomobject]@{ UId = 'acc-1'; UserName = 'alice'; FIRSTNAME = 'Alice'; LASTNAME = 'Smith'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }
                [pscustomobject]@{ UId = 'acc-2'; UserName = 'svc';   FIRSTNAME = 'Batch'; LASTNAME = 'Runner'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-2' } }
            )
        }
        $lookup = @{
            'ID-1' = @{ uid = 'id-1'; identityType = 'Employee' }
            'ID-2' = @{ uid = 'id-2'; identityType = 'Technical' }
        }

        $r = Sync-OmadaAccounts -SystemId 4 -IdentityLookup $lookup

        (Get-Sent { $_.Scope.principalType -eq 'User' })[0].Records.Count | Should -Be 1
        $other = Get-Sent { $_.Scope.principalType -eq 'TechnicalAccount' }
        $other | Should -HaveCount 1
        $other[0].Records.Count | Should -Be 1
        $other[0].Records[0].externalId | Should -Be 'acc-2'
        @($r.allAccounts).Count | Should -Be 2
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the account fetch throws' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/User' } -MockWith { throw 'OData 500' }
        Sync-OmadaAccounts -SystemId 1 -IdentityLookup @{}
        $script:phaseErrors[0] | Should -BeLike 'Accounts:*'
    }
}

# ─── Sync-OmadaIdentityMembers ──────────────────────────────────────────────────
Describe 'Sync-OmadaIdentityMembers' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests identity-member links for person-type accounts, skipping others' {
        $lookup = @{ 'ID-1' = @{ uid = 'id-1'; identityType = 'Employee' }; 'ID-2' = @{ uid = 'id-2'; identityType = 'Contractor' } }
        $accounts = @(
            [pscustomobject]@{ UId = 'acc-1'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }   # Employee -> kept
            [pscustomobject]@{ UId = 'acc-2'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-2' } }   # Contractor -> not in-table types
            [pscustomobject]@{ UId = 'acc-3' }                                                            # no identity ref -> skip
        )
        Sync-OmadaIdentityMembers -SystemId 1 -AllAccounts $accounts -IdentityLookup $lookup -IdentityTypesForIdentityTable @('Employee')

        (Get-Sent { $_.Endpoint -eq 'ingest/identity-members' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the ingest throws' {
        Mock Send-IngestBatch -MockWith { throw 'ingest 500' }
        Sync-OmadaIdentityMembers -SystemId 1 -AllAccounts @([pscustomobject]@{ UId = 'a'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }) `
            -IdentityLookup @{ 'ID-1' = @{ uid = 'id-1'; identityType = 'Employee' } } -IdentityTypesForIdentityTable @('Employee')
        $script:phaseErrors[0] | Should -BeLike 'IdentityMembers:*'
    }
}

# ─── ContextMembers source collectors (pure) ────────────────────────────────────
Describe 'ContextMembers source collectors' {

    It 'Get-OmadaContextMembersFromAssignments keeps only synced contexts + in-table identities' {
        $synced  = New-StrSet 'ctx1'
        $intable = New-StrSet 'id1'
        $items = @(
            [pscustomobject]@{ CA_IDENTITY = @{ UId = 'id1' }; CA_CONTEXT = @{ UId = 'ctx1' } }   # kept
            [pscustomobject]@{ CA_IDENTITY = @{ UId = 'id1' }; CA_CONTEXT = @{ UId = 'ctxX' } }   # ctx not synced
            [pscustomobject]@{ CA_IDENTITY = @{ UId = 'idX' }; CA_CONTEXT = @{ UId = 'ctx1' } }   # ident not in table
        )
        $r = Get-OmadaContextMembersFromAssignments -Items $items -SyncedContextIds $synced -IdentityUidInIdentitiesTable $intable
        @($r).Count | Should -Be 1
        @($r)[0].contextId | Should -Be 'ctx1'
        @($r)[0].memberId  | Should -Be 'id1'
    }

    It 'Get-OmadaContextMembersFromIdentityFields resolves configured + well-known ref fields' {
        $synced  = New-StrSet 'ou-9'
        $intable = New-StrSet 'id1'
        $identities = @(
            [pscustomobject]@{ UId = 'id1'; OUREF = [pscustomobject]@{ UId = 'ou-9' } }
            [pscustomobject]@{ UId = 'idX'; OUREF = [pscustomobject]@{ UId = 'ou-9' } }   # not in table -> skip
        )
        $r = Get-OmadaContextMembersFromIdentityFields -AllIdentities $identities `
            -ContextObjectTypes @(@{ entitySet = 'Orgunit'; identityField = 'OUREF' }) `
            -WellKnownIdentityContextFields @{} -SyncedContextIds $synced -IdentityUidInIdentitiesTable $intable
        @($r).Count | Should -Be 1
        @($r)[0].memberId | Should -Be 'id1'
    }

    It 'Get-OmadaContextMembersFromEmployment returns empty when Employment is unavailable' {
        Mock Test-EntitySetAvailable -MockWith { $false }
        @(Get-OmadaContextMembersFromEmployment -SyncedContextIds (New-StrSet 'x') -IdentityUidInIdentitiesTable (New-StrSet 'y')).Count | Should -Be 0
    }

    It 'Get-OmadaContextMembersFromEmployment builds links from Employment, filtering unsynced/out-of-table' {
        Mock Test-EntitySetAvailable -MockWith { $true }
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Employment' } -MockWith {
            @(
                [pscustomobject]@{ IDENTITYREF = @{ UId = 'id1' }; OUREF = @{ UId = 'ctx1' } }   # kept
                [pscustomobject]@{ IDENTITYREF = @{ UId = 'idX' }; OUREF = @{ UId = 'ctx1' } }   # identity not in table
                [pscustomobject]@{ IDENTITYREF = @{ UId = 'id1' }; OUREF = @{ UId = 'ctxX' } }   # context not synced
                [pscustomobject]@{ IDENTITYREF = @{ UId = 'id1' } }                               # no OUREF -> skip
            )
        }
        $r = Get-OmadaContextMembersFromEmployment -SyncedContextIds (New-StrSet 'ctx1') -IdentityUidInIdentitiesTable (New-StrSet 'id1')
        @($r).Count | Should -Be 1
        @($r)[0].contextId | Should -Be 'ctx1'
        @($r)[0].memberId  | Should -Be 'id1'
    }

    It 'Get-OmadaContextMembersFromEmployment swallows an OData failure and returns empty' {
        Mock Test-EntitySetAvailable -MockWith { $true }
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Employment' } -MockWith { throw 'OData down' }
        @(Get-OmadaContextMembersFromEmployment -SyncedContextIds (New-StrSet 'ctx1') -IdentityUidInIdentitiesTable (New-StrSet 'id1')).Count | Should -Be 0
    }
}

# ─── Sync-OmadaContextMembers (integration) ─────────────────────────────────────
Describe 'Sync-OmadaContextMembers' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'combines + dedups sources and ingests context-member links' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Contextassignment' } -MockWith {
            @([pscustomobject]@{ CA_IDENTITY = @{ UId = 'id1' }; CA_CONTEXT = @{ UId = 'ctx1' } })
        }
        # Default FIRST, then the specific override. The phase probes several entity
        # sets; with only the filtered mock, the Contextassignment probe matches no
        # filter and has nothing to fall back to, so the whole phase errors out
        # instead of exercising the dedup this test is about.
        Mock Test-EntitySetAvailable -MockWith { $true }
        Mock Test-EntitySetAvailable -ParameterFilter { $Name -eq 'Employment' } -MockWith { $false }
        # Identity fields produce the SAME (ctx1,id1) pair — must dedup to one.
        $identities = @([pscustomobject]@{ UId = 'id1'; OUREF = [pscustomobject]@{ UId = 'ctx1' } })
        Sync-OmadaContextMembers -SystemId 2 -SyncedContextIds (New-StrSet 'ctx1') `
            -IdentityUidInIdentitiesTable (New-StrSet 'id1') -AllIdentities $identities `
            -ContextObjectTypes @(@{ entitySet = 'Orgunit'; identityField = 'OUREF' }) -WellKnownIdentityContextFields @{}

        (Get-Sent { $_.Endpoint -eq 'ingest/context-members' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when Contextassignment is unavailable' {
        Mock Test-EntitySetAvailable -MockWith { $true }
        Mock Test-EntitySetAvailable -ParameterFilter { $Name -eq 'Contextassignment' } -MockWith { $false }
        Sync-OmadaContextMembers -SystemId 1 -SyncedContextIds (New-StrSet 'x') `
            -IdentityUidInIdentitiesTable (New-StrSet 'y') -AllIdentities @() -ContextObjectTypes @() -WellKnownIdentityContextFields @{}
        $script:phaseErrors[0] | Should -BeLike 'ContextMembers:*'
    }
}

# ─── Get-OmadaRoleAssignmentsBySystem (pure) ────────────────────────────────────
Describe 'Get-OmadaRoleAssignmentsBySystem' {

    It 'fans an active role assignment out to every user account of the identity' {
        $items = @(
            [pscustomobject]@{ IDENTITYREF = @{ UId = 'ident1' }; ROLEREF = @{ UId = 'role1' }; ROLEASSNSTATUS = @{ Value = 'Active' } }
            [pscustomobject]@{ IDENTITYREF = @{ UId = 'ident1' }; ROLEREF = @{ UId = 'role2' }; ROLEASSNSTATUS = @{ Value = 'Closed' } }  # skipped
        )
        $fanout = @{ 'ident1' = @('user1', 'user2') }
        $ra = Get-OmadaRoleAssignmentsBySystem -RaItems $items -IdentityUidToUserUids $fanout -OmadaSystemMap @{}

        $ra['__main__'].Count | Should -Be 2   # role1 × (user1, user2); role2 closed
        @($ra['__main__'].principalId | Sort-Object -Unique) | Should -Be @('user1','user2')
    }

    It 'skips assignments for identities with no active user accounts' {
        $items = @([pscustomobject]@{ IDENTITYREF = @{ UId = 'ident1' }; ROLEREF = @{ UId = 'role1' }; ROLEASSNSTATUS = @{ Value = 'Active' } })
        (Get-OmadaRoleAssignmentsBySystem -RaItems $items -IdentityUidToUserUids @{} -OmadaSystemMap @{}).Keys.Count | Should -Be 0
    }

    It 'defaults a missing status to Active and buckets by a mapped connected system' {
        $items = @([pscustomobject]@{ IDENTITYREF = @{ UId = 'ident1' }; ROLEREF = @{ UId = 'role1' }; SYSTEMREF = @{ UId = 'sys-9' } })   # no ROLEASSNSTATUS
        $ra = Get-OmadaRoleAssignmentsBySystem -RaItems $items -IdentityUidToUserUids @{ 'ident1' = @('user1') } -OmadaSystemMap @{ 'sys-9' = 42 }
        $ra.ContainsKey('sys-9') | Should -BeTrue
        $ra['sys-9'].Count | Should -Be 1
    }
}

# ─── ConvertFrom-OmadaCraItem (pure) ────────────────────────────────────────────
Describe 'ConvertFrom-OmadaCraItem' {

    It 'derives a Principal + identity-member + assignment for a connected system' {
        $item = [pscustomobject]@{ System = @{ UId = 'conn' }; Resource = @{ UId = 'res1' }; Identity = @{ UId = 'id1' }
                                   AccountKey = 'acc-k1'; AccountName = 'alice'; ResourceType = @{ DisplayName = 'Account' } }
        $r = ConvertFrom-OmadaCraItem -Item $item -OmadaSystemMap @{ 'conn' = 9 } -SystemId 1 `
            -OmadaIdentitySystemUId 'omada-sys' -UserNameToUid @{} -IdentityUidInIdentitiesTable (New-StrSet 'id1')

        $r.sysKey | Should -Be 'conn'
        $r.principal | Should -Not -BeNullOrEmpty
        $r.identityMember.identityId | Should -Be 'id1'
        $r.assignment | Should -Not -BeNullOrEmpty
    }

    It 'reuses the existing Omada User Principal (no derived principal) for the Omada system' {
        $item = [pscustomobject]@{ System = @{ UId = 'omada-sys' }; Resource = @{ UId = 'res1' }; Identity = @{ UId = 'id1' }
                                   AccountName = 'alice'; ResourceType = @{ DisplayName = 'Role' } }
        $r = ConvertFrom-OmadaCraItem -Item $item -OmadaSystemMap @{} -SystemId 1 `
            -OmadaIdentitySystemUId 'omada-sys' -UserNameToUid @{ 'alice' = 'user-uid-1' } -IdentityUidInIdentitiesTable (New-StrSet 'id1')

        $r.principal | Should -BeNullOrEmpty
        $r.assignment.principalId | Should -Be 'user-uid-1'
    }

    It 'skips a half-populated row that would otherwise resolve all the way through' {
        # The existing guard test uses a row that goes on to fail for a second
        # reason (no account name), so the pair check could be relaxed to "both
        # missing" and the row would still come back null. These two rows resolve
        # completely apart from the one missing half -- so if the check no longer
        # rejects them, a governance assignment is built pointing at a null
        # resource, or held by nobody.
        $identities = New-StrSet 'id1'
        $names = @{ alice = 'user-uid-1' }

        $noRes = [pscustomobject]@{ System = @{ UId = 'omada-sys' }; Identity = @{ UId = 'id1' }; AccountName = 'alice' }
        ConvertFrom-OmadaCraItem -Item $noRes -OmadaIdentitySystemUId 'omada-sys' -UserNameToUid $names -IdentityUidInIdentitiesTable $identities | Should -BeNullOrEmpty

        $noIdent = [pscustomobject]@{ System = @{ UId = 'omada-sys' }; Resource = @{ UId = 'r1' }; AccountName = 'alice' }
        ConvertFrom-OmadaCraItem -Item $noIdent -OmadaIdentitySystemUId 'omada-sys' -UserNameToUid $names -IdentityUidInIdentitiesTable $identities | Should -BeNullOrEmpty
    }

    It 'skips a row with no resource/identity, or an unresolvable Omada account' {
        $noRes = [pscustomobject]@{ System = @{ UId = 'omada-sys' }; Identity = @{ UId = 'id1' } }
        ConvertFrom-OmadaCraItem -Item $noRes -OmadaIdentitySystemUId 'omada-sys' -IdentityUidInIdentitiesTable (New-StrSet 'id1') | Should -BeNullOrEmpty

        $unres = [pscustomobject]@{ System = @{ UId = 'omada-sys' }; Resource = @{ UId = 'r' }; Identity = @{ UId = 'id1' }; AccountName = 'ghost' }
        ConvertFrom-OmadaCraItem -Item $unres -OmadaIdentitySystemUId 'omada-sys' -UserNameToUid @{} -IdentityUidInIdentitiesTable (New-StrSet 'id1') | Should -BeNullOrEmpty
    }
}

# ─── Get-OmadaCraData (streamed) ────────────────────────────────────────────────
Describe 'Get-OmadaCraData' {

    It 'streams pages and folds rows into per-system accumulators' {
        Mock Invoke-ODataGetRequest -MockWith { @() }   # default: empty (ends paging)
        Mock Invoke-ODataGetRequest -ParameterFilter { $QueryParams['$skip'] -eq 0 } -MockWith {
            @([pscustomobject]@{ System = @{ UId = 'conn' }; Resource = @{ UId = 'res1' }; Identity = @{ UId = 'id1' }
                                 AccountKey = 'acc-k1'; AccountName = 'alice'; ResourceType = @{ DisplayName = 'Account' } })
        }
        $data = Get-OmadaCraData -OmadaSystemMap @{ 'conn' = 9 } -SystemId 1 -OmadaIdentitySystemUId 'omada-sys' `
            -UserNameToUid @{} -IdentityUidInIdentitiesTable (New-StrSet 'id1') -BuiltinBaseUrl 'http://x/builtin'

        $data.totalCount | Should -Be 1
        $data.principalsBySys['conn'].Count | Should -Be 1
        $data.identityMembers.Count | Should -Be 1
        $data.assignmentsBySys['conn'].Count | Should -Be 1
    }
}

# ─── Send-OmadaCraDerived / Send-OmadaGovernanceAssignments ─────────────────────
Describe 'Assignment ingest helpers' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'Send-OmadaCraDerived sends deduped principals + identity-members as delta' {
        $craData = @{
            totalCount = 3
            principalsBySys = @{ 'conn' = ([System.Collections.Generic.List[object]]@(
                [pscustomobject]@{ id = 'p1' }, [pscustomobject]@{ id = 'p1' }, [pscustomobject]@{ id = 'p2' })) }
            identityMembers = ([System.Collections.Generic.List[object]]@([pscustomobject]@{ identityId = 'i1'; principalId = 'p1' }))
        }
        Send-OmadaCraDerived -CraData $craData -OmadaSystemMap @{ 'conn' = 9 } -SystemId 1

        (Get-Sent { $_.Endpoint -eq 'ingest/principals' })[0].Records.Count | Should -Be 2   # p1 deduped
        (Get-Sent { $_.Endpoint -eq 'ingest/principals' })[0].SyncMode | Should -Be 'delta'
        (Get-Sent { $_.Endpoint -eq 'ingest/identity-members' }).Count | Should -Be 1
    }

    It 'Send-OmadaGovernanceAssignments combines role + CRA per system, deduped, full-sync governed' {
        $ra = @{ '__main__' = ([System.Collections.Generic.List[object]]@([pscustomobject]@{ principalId = 'u1'; resourceId = 'r1' })) }
        $cra = @{ '__main__' = ([System.Collections.Generic.List[object]]@(
            [pscustomobject]@{ principalId = 'u1'; resourceId = 'r1' },   # dup of the role one
            [pscustomobject]@{ principalId = 'u2'; resourceId = 'r2' })) }
        Send-OmadaGovernanceAssignments -RaBySys $ra -AssignmentsBySys $cra -OmadaSystemMap @{} -SystemId 5

        $sent = Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' }
        $sent[0].Records.Count | Should -Be 2   # (u1,r1) deduped + (u2,r2)
        $sent[0].Scope.governed | Should -BeTrue
        $sent[0].SyncMode | Should -Be 'full'
    }
}

# ─── Sync-OmadaAssignments (integration; regression for the $CaAssignmentsBysD fix) ──
Describe 'Sync-OmadaAssignments' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'runs both sources and records the phase without erroring' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Resourceassignment' } -MockWith {
            @([pscustomobject]@{ IDENTITYREF = @{ UId = 'ident1' }; ROLEREF = @{ UId = 'role1' }; ROLEASSNSTATUS = @{ Value = 'Active' } })
        }
        Mock Invoke-ODataGetRequest -MockWith { @() }
        Mock Invoke-ODataGetRequest -ParameterFilter { $QueryParams['$skip'] -eq 0 } -MockWith {
            @([pscustomobject]@{ System = @{ UId = 'conn' }; Resource = @{ UId = 'res1' }; Identity = @{ UId = 'id1' }
                                 AccountKey = 'acc-k1'; AccountName = 'a'; ResourceType = @{ DisplayName = 'Account' } })
        }
        Sync-OmadaAssignments -SystemId 1 -OmadaSystemMap @{ 'conn' = 9 } -OmadaIdentitySystemUId 'omada-sys' `
            -UserNameToUid @{} -IdentityUidToUserUids @{ 'ident1' = @('user1') } -IdentityUidInIdentitiesTable (New-StrSet 'id1') `
            -BuiltinBaseUrl 'http://x/builtin'

        ($script:phases | Where-Object { $_.name -eq 'Assignments' }).status | Should -Be 'ok'
        (Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' }).Count | Should -BeGreaterThan 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the role-assignment fetch throws' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/Resourceassignment' } -MockWith { throw 'OData 500' }
        Sync-OmadaAssignments -SystemId 1 -OmadaSystemMap @{} -OmadaIdentitySystemUId 'x' -BuiltinBaseUrl 'http://x/builtin' `
            -IdentityUidInIdentitiesTable (New-StrSet 'y')
        $script:phaseErrors[0] | Should -BeLike 'Assignments:*'
    }
}

# ─── Config resolution (pure) ───────────────────────────────────────────────────
Describe 'Omada config resolution' {

    It 'Resolve-OmadaSyncToggles applies defaults + selectedObjects overrides' {
        $c = Resolve-OmadaSyncToggles -RawConfig @{ selectedObjects = @{ assignments = $false; resources = $false } }
        $c.SyncContexts | Should -BeTrue
        $c.SyncAssignments | Should -BeFalse
        $c.SyncResources | Should -BeFalse
        $c.SyncMode | Should -Be 'full'
    }

    It 'Resolve-OmadaSyncToggles turns every phase ON when nothing is configured' {
        # The test above pins three of the nine toggles, two of which it overrides
        # to false -- so six defaults were unasserted. Every one of them defaults
        # ON here (unlike the Entra crawler, where the expensive phases default
        # off), which makes a flipped default especially quiet: the crawler runs,
        # reports success, and simply never syncs that object type. On a FULL sync
        # the ingest side then reconciles the records it did not receive as
        # deletions.
        $c = Resolve-OmadaSyncToggles -RawConfig @{}

        $c.SyncContexts       | Should -BeTrue
        $c.SyncIdentities     | Should -BeTrue
        $c.SyncAccounts       | Should -BeTrue
        $c.SyncContextMembers | Should -BeTrue
        $c.SyncResources      | Should -BeTrue
        $c.SyncEntitlements   | Should -BeTrue
        $c.SyncAssignments    | Should -BeTrue
        $c.SyncCRAs           | Should -BeTrue
        $c.RefreshViews       | Should -BeTrue
        $c.SyncMode           | Should -Be 'full'
    }

    It 'Resolve-OmadaContextObjectTypes defaults to Orgunit and builds the identityField map' {
        $r = Resolve-OmadaContextObjectTypes -Cfg ([pscustomobject]@{})
        @($r.contextObjectTypes)[0].entitySet | Should -Be 'Orgunit'
        $r.contextEntitySetToIdentityField['Orgunit'] | Should -Be 'OUREF'
    }

    It 'Resolve-OmadaResourceCategoryMapping defaults include the catch-all' {
        $m = Resolve-OmadaResourceCategoryMapping -Cfg ([pscustomobject]@{})
        @($m | Where-Object { $_.category -eq '' }).resourceType | Should -Be 'Resource'
    }

    It 'Resolve-OmadaSyncToggles honours _syncMode = delta' {
        (Resolve-OmadaSyncToggles -RawConfig @{ _syncMode = 'delta' }).SyncMode | Should -Be 'delta'
    }

    It 'Resolve-OmadaContextObjectTypes reads custom types, falling back contextType→entitySet and identityField→null' {
        $r = Resolve-OmadaContextObjectTypes -Cfg ([pscustomobject]@{ contextObjectTypes = @(
            [pscustomobject]@{ entitySet = 'Costcenter'; contextType = 'CostCenter'; identityField = 'COSTCENTER' }
            [pscustomobject]@{ entitySet = 'Building' }   # contextType + identityField fall back
        ) })
        $types = @($r.contextObjectTypes)
        ($types | Where-Object { $_.entitySet -eq 'Building' }).contextType   | Should -Be 'Building'
        ($types | Where-Object { $_.entitySet -eq 'Building' }).identityField | Should -BeNullOrEmpty
        $r.contextEntitySetToIdentityField['Costcenter']      | Should -Be 'COSTCENTER'
        $r.contextEntitySetToIdentityField.ContainsKey('Building') | Should -BeFalse
    }

    It 'Resolve-OmadaResourceCategoryMapping reads a custom category mapping' {
        $m = @(Resolve-OmadaResourceCategoryMapping -Cfg ([pscustomobject]@{ resourceCategoryMapping = @(
            [pscustomobject]@{ category = 'App'; resourceType = 'Application' }
            [pscustomobject]@{ }   # category/resourceType fall back to '' / 'Resource'
        ) }))
        ($m | Where-Object { $_.category -eq 'App' }).resourceType | Should -Be 'Application'
        ($m | Where-Object { $_.category -eq '' }).resourceType     | Should -Be 'Resource'
    }

    It 'Resolve-OmadaConfig normalises a root base URL and derives the builtin URL' {
        $cfg = Resolve-OmadaConfig -RawConfig @{} -Cfg ([pscustomobject]@{ baseUrl = 'https://tenant.omada.cloud/' }) -DefaultTypeMappings @{ identityTypesForIdentityTable = @('Employee') }
        $cfg.baseUrl | Should -Be 'https://tenant.omada.cloud/odata/dataobjects'
        $cfg.builtinBaseUrl | Should -Be 'https://tenant.omada.cloud/odata/builtin'
        $cfg.pageSize | Should -Be 100
        $cfg.SyncContexts | Should -BeTrue
    }

    It 'Resolve-OmadaConfig applies its documented defaults' {
        # Two of these have functional effect and are NOT display constants: maxRetries
        # decides how hard the crawler tries before giving up on a transient Omada error,
        # and the session timeout decides when it re-authenticates mid-run. Nothing pinned
        # either, so both could drift silently.
        $c = Resolve-OmadaConfig -RawConfig @{} -Cfg ([pscustomobject]@{ baseUrl = 'https://t.omada.cloud/' }) -DefaultTypeMappings @{}
        $c.apiVersion            | Should -Be 'v14'
        $c.pageSize              | Should -Be 100
        $c.maxRetries            | Should -Be 5
        $c.sessionTimeoutMinutes | Should -Be 30
    }

    It 'Resolve-OmadaConfig honours an explicit maxRetries of ZERO' {
        # The guard is `$null -ne $Cfg.maxRetries`, not a truthiness test, precisely so that
        # 0 -- "do not retry at all" -- survives. Read as a truthiness check, 0 is replaced
        # by the default 5 and an operator who asked for no retries gets five.
        $c = Resolve-OmadaConfig -RawConfig @{} -Cfg ([pscustomobject]@{ baseUrl = 'https://t/'; maxRetries = 0 }) -DefaultTypeMappings @{}
        $c.maxRetries | Should -Be 0
    }

    It 'Resolve-OmadaConfig takes a configured maxRetries over the default' {
        $c = Resolve-OmadaConfig -RawConfig @{} -Cfg ([pscustomobject]@{ baseUrl = 'https://t/'; maxRetries = 9; sessionTimeoutMinutes = 45 }) -DefaultTypeMappings @{}
        $c.maxRetries            | Should -Be 9
        $c.sessionTimeoutMinutes | Should -Be 45
    }

    It 'Resolve-OmadaConfig preserves an explicit /odata/dataobjects path' {
        (Resolve-OmadaConfig -RawConfig @{} -Cfg ([pscustomobject]@{ baseUrl = 'http://srv:8080/odata/dataobjects' }) -DefaultTypeMappings @{}).baseUrl |
            Should -Be 'http://srv:8080/odata/dataobjects'
    }
}

# ─── Setup helpers ──────────────────────────────────────────────────────────────
Describe 'Omada setup helpers' {
    BeforeEach { Reset-PhaseTestState }

    It 'Connect-OmadaSession passes only the provided auth fields to Connect-ODataAPI' {
        Mock Connect-ODataAPI -MockWith { }
        Connect-OmadaSession -Cfg ([pscustomobject]@{ authMethod = 'ApiToken'; apiToken = 'tok' }) -BaseUrl 'http://x' -ApiVersion 'v14' -SessionTimeoutMinutes 30
        Should -Invoke Connect-ODataAPI -Exactly 1
    }

    It 'Connect-OmadaSession forwards username/password + OAuth client + cookie fields' {
        Mock Connect-ODataAPI -MockWith { }
        Connect-OmadaSession -Cfg ([pscustomobject]@{ authMethod = 'OAuth2'; username = 'u'; password = 'p'; clientId = 'cid'; clientSecret = 'sec'; tokenEndpoint = 'https://t'; cookieString = 'ck' }) `
            -BaseUrl 'http://x' -ApiVersion 'v14' -SessionTimeoutMinutes 30
        Should -Invoke Connect-ODataAPI -Exactly 1
    }

    It 'Send-OmadaPhaseResults posts nothing without a real job id' {
        # Guard is `JobId -le 0`. Read as `-lt 0`, a run with no job (id 0) POSTs to
        # /crawlers/jobs/0/phases -- an endpoint for a job that does not exist.
        Mock Invoke-RestMethod -MockWith { @{} }
        Send-OmadaPhaseResults -Phases @(@{ name = 'Resources'; status = 'ok'; durationMs = 5 }) -JobId 0 -ApiKey 'k' -ApiBaseUrl 'http://x/api'
        Should -Invoke Invoke-RestMethod -Exactly 0
    }

    It 'Send-OmadaPhaseResults posts the phases for a real job id' {
        Mock Invoke-RestMethod -MockWith { @{} }
        Send-OmadaPhaseResults -Phases @(@{ name = 'Resources'; status = 'ok'; durationMs = 5 }) -JobId 7 -ApiKey 'k' -ApiBaseUrl 'http://x/api'
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -match '/jobs/7/phases' }
    }

    It 'Send-OmadaPhaseResults soft-fails when the post throws' {
        # Phase reporting is best-effort: losing it must not fail a completed crawl.
        Mock Invoke-RestMethod -MockWith { throw 'jobs api 500' }
        { Send-OmadaPhaseResults -Phases @(@{ name = 'X'; status = 'ok'; durationMs = 1 }) -JobId 7 -ApiKey 'k' -ApiBaseUrl 'http://x/api' } |
            Should -Not -Throw
    }

    It 'Get-OmadaAvailableEntitySets returns the discovered sets' {
        Mock Get-ODataEntitySets -MockWith { @('Identity','User','Resource') }
        @(Get-OmadaAvailableEntitySets) | Should -Contain 'User'
    }

    It 'reports a single discovered entity set as discovered, not as missing metadata' {
        # The guard chooses between listing the sets and announcing that metadata
        # was unavailable. Read as "more than one", a tenant exposing exactly one
        # set gets told its metadata could not be read -- which is the message that
        # explains why every phase then runs blind.
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Get-ODataEntitySets -MockWith { @('User') }

        @(Get-OmadaAvailableEntitySets) | Should -Be @('User')

        $out = $script:said -join "`n"
        $out | Should -Match 'Entity sets: User'
        $out | Should -Not -Match 'metadata unavailable'
    }

    It 'says metadata was unavailable when nothing came back' {
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Get-ODataEntitySets -MockWith { @() }

        @(Get-OmadaAvailableEntitySets) | Should -HaveCount 0

        ($script:said -join "`n") | Should -Match 'metadata unavailable'
    }

    It 'Register-OmadaSystems resolves the main IGA system id from the atlas map' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/System' } -MockWith {
            @([pscustomobject]@{ DisplayName = 'Omada Identity'; UId = 'main-uid' })
        }
        Mock Invoke-IngestAPI -MockWith { @{ systemIds = @(1) } }
        Mock Invoke-RestMethod -MockWith { @([pscustomobject]@{ systemType = 'Omada'; tenantId = 'main-uid'; id = 7 }) }

        $reg = Register-OmadaSystems -ApiBaseUrl 'http://x/api' -ApiKey 'k' -BaseUrl 'http://omada' -MaxRetries 5
        $reg.systemId | Should -Be 7
        $reg.omadaIdentitySystemUId | Should -Be 'main-uid'
        $reg.omadaSystemMap['main-uid'] | Should -Be 7
    }

    It 'Register-OmadaSystems maps ONLY Omada systems that carry a tenant id' {
        # The existing fixture returns a single row that satisfies both halves of the
        # filter, so `systemType -eq Omada AND tenantId` reads identically to OR. These
        # three rows disagree: as OR, the SQL-Server row lands in the Omada system map and
        # its records would be attributed to an Omada system, and the tenant-less row adds
        # a null key.
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/System' } -MockWith {
            @([pscustomobject]@{ DisplayName = 'Omada Identity'; UId = 'main-uid' })
        }
        Mock Invoke-IngestAPI -MockWith { @{ systemIds = @(1) } }
        Mock Invoke-RestMethod -MockWith {
            @(
                [pscustomobject]@{ systemType = 'Omada';      tenantId = 'main-uid'; id = 7 }
                [pscustomobject]@{ systemType = 'SqlServer';  tenantId = 'other';    id = 8 }  # not Omada
                [pscustomobject]@{ systemType = 'Omada';      tenantId = $null;      id = 9 }  # no tenant id
            )
        }

        $reg = Register-OmadaSystems -ApiBaseUrl 'http://x/api' -ApiKey 'k' -BaseUrl 'http://omada' -MaxRetries 5

        $reg.omadaSystemMap.Count | Should -Be 1
        $reg.omadaSystemMap['main-uid'] | Should -Be 7
        $reg.systemId | Should -Be 7
    }

    It 'Register-OmadaSystems registers every Omada system as enabled and sync-enabled' {
        # These two flags decide whether Identity Atlas shows the system and whether it is
        # crawled again. Registered as $false, a freshly connected tenant is silently inert.
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/System' } -MockWith {
            @([pscustomobject]@{ DisplayName = 'Omada Identity'; UId = 'main-uid' })
        }
        Mock Invoke-RestMethod -MockWith { @([pscustomobject]@{ systemType = 'Omada'; tenantId = 'main-uid'; id = 7 }) }
        # Collect into a pre-existing list: assigning a new $script: variable inside a mock
        # body does not propagate back out (same reason SendMock in this file uses a List).
        # records is a List[object] from ConvertTo-JsonArray, NOT a JSON string, so the
        # records are inspected as objects.
        $script:systemsSent = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI -MockWith { foreach ($r in @($Body.records)) { $script:systemsSent.Add($r) }; @{ systemIds = @(1) } }

        Register-OmadaSystems -ApiBaseUrl 'http://x/api' -ApiKey 'k' -BaseUrl 'http://omada' -MaxRetries 5 | Out-Null

        # records is already a JSON string (ConvertTo-JsonArray), so match on it directly
        # rather than round-tripping it inside the filter.
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Endpoint -eq 'ingest/systems' }
        $script:systemsSent | Should -HaveCount 1
        $script:systemsSent[0].enabled     | Should -BeTrue
        $script:systemsSent[0].syncEnabled | Should -BeTrue
        $script:systemsSent[0].systemType  | Should -Be 'Omada'
    }

    It 'Register-OmadaSystems falls back to the first mapped system when the main one is absent' {
        # Omada Identity is not in the atlas map (renamed, or not yet registered), but other
        # Omada systems are -- the crawler still needs a system id to attribute records to.
        # Two mapped systems, so taking "the first" cannot be confused with taking them all.
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/System' } -MockWith {
            @([pscustomobject]@{ DisplayName = 'Something Else'; UId = 'other-uid' })
        }
        Mock Invoke-IngestAPI -MockWith { @{ systemIds = @(1) } }
        Mock Invoke-RestMethod -MockWith {
            @(
                [pscustomobject]@{ systemType = 'Omada'; tenantId = 'a-uid'; id = 11 }
                [pscustomobject]@{ systemType = 'Omada'; tenantId = 'b-uid'; id = 12 }
            )
        }

        $reg = Register-OmadaSystems -ApiBaseUrl 'http://x/api' -ApiKey 'k' -BaseUrl 'http://omada' -MaxRetries 5

        $reg.omadaIdentitySystemUId | Should -BeNullOrEmpty
        @($reg.systemId).Count | Should -Be 1     # one id, not the whole set
        $reg.systemId | Should -BeIn @(11, 12)
    }

    It 'Register-OmadaSystems reports system id 0 when nothing could be mapped' {
        # Neither branch fires: no main system and an empty map. 0 is the sentinel the
        # caller checks; starting it anywhere else would name a real system that was never
        # registered.
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/System' } -MockWith { @() }
        Mock Invoke-IngestAPI -MockWith { @{ systemIds = @(1) } }
        Mock Invoke-RestMethod -MockWith { @() }

        $reg = Register-OmadaSystems -ApiBaseUrl 'http://x/api' -ApiKey 'k' -BaseUrl 'http://omada' -MaxRetries 5

        $reg.systemId | Should -Be 0
    }

    It 'Register-OmadaSystems falls back to single-system registration on error' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/System' } -MockWith { throw 'OData down' }
        Mock Invoke-IngestAPI -MockWith { @{ systemIds = @(99) } }

        (Register-OmadaSystems -ApiBaseUrl 'http://x/api' -ApiKey 'k' -BaseUrl 'http://omada' -MaxRetries 5).systemId | Should -Be 99
    }

    It 'Register-OmadaSystems falls back to the first mapped system when no "Omada Identity" system exists' {
        Mock Invoke-ODataPagedRequest -ParameterFilter { $Path -eq '/System' } -MockWith {
            @([pscustomobject]@{ DisplayName = 'Some Connected System'; UId = 'sys-a' })
        }
        Mock Invoke-IngestAPI -MockWith { @{ systemIds = @(1) } }
        Mock Invoke-RestMethod -MockWith { @([pscustomobject]@{ systemType = 'Omada'; tenantId = 'sys-a'; id = 5 }) }
        $reg = Register-OmadaSystems -ApiBaseUrl 'http://x/api' -ApiKey 'k' -BaseUrl 'http://omada' -MaxRetries 5
        $reg.systemId | Should -Be 5
        $reg.omadaIdentitySystemUId | Should -BeNullOrEmpty
    }
}

# ─── Write-OmadaSummary ─────────────────────────────────────────────────────────
Describe 'Write-OmadaSummary' {
    BeforeEach { Reset-PhaseTestState }

    It 'throws when there were phase errors' {
        $script:phaseErrors.Add('Contexts: boom')
        { Write-OmadaSummary -StartTime ([datetime]::UtcNow) -JobId 0 -ApiKey 'k' -ApiBaseUrl 'http://x/api' } |
            Should -Throw -ExpectedMessage '*1 phase error*'
    }

    It 'does not throw on a clean run and posts phases when a job id is present' {
        Mock Invoke-RestMethod -MockWith { @{} }
        $script:phases.Add(@{ name = 'Contexts'; status = 'ok'; durationMs = 5 })
        { Write-OmadaSummary -StartTime ([datetime]::UtcNow) -JobId 7 -ApiKey 'k' -ApiBaseUrl 'http://x/api' } | Should -Not -Throw
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -match '/jobs/7/phases' }
    }

    It 'renders a FAILED row (with error + records in the payload) and swallows a POST failure' {
        Mock Invoke-RestMethod -MockWith { throw 'jobs api 500' }
        $script:phases.Add(@{ name = 'Accounts'; status = 'error'; durationMs = 3; error = 'boom'; records = @{ accounts = 0 } })
        { Write-OmadaSummary -StartTime ([datetime]::UtcNow) -JobId 7 -ApiKey 'k' -ApiBaseUrl 'http://x/api' } | Should -Not -Throw
        Should -Invoke Invoke-RestMethod -Exactly 1
    }
}

Describe 'Resolve-OmadaSysKey' {
    It 'returns the system UId when it maps to a known connected system' {
        Resolve-OmadaSysKey -SysUId 'sys1' -OmadaSystemMap @{ sys1 = 5 } | Should -Be 'sys1'
    }
    It 'falls back to __main__ for an unknown system UId' {
        Resolve-OmadaSysKey -SysUId 'nope' -OmadaSystemMap @{ sys1 = 5 } | Should -Be '__main__'
    }
    It 'falls back to __main__ when the UId is null/empty' {
        Resolve-OmadaSysKey -SysUId $null -OmadaSystemMap @{ sys1 = 5 } | Should -Be '__main__'
    }
}
