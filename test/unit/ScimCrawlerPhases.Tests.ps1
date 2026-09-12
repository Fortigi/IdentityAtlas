#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the SCIM crawler sync phases
    (tools/crawlers/scim/ScimCrawler.Phases.ps1).

.DESCRIPTION
    Each phase is exercised by mocking its command boundary — Invoke-ScimSearchStream
    for the SCIM read, Invoke-IngestAPI / Invoke-CrawlerIngestBatch for the write —
    and then asserting on the RECORDS that were built, not just that a call happened:
    which principalType a bucket carried, which membership rows a nested group
    produced, which scope an empty reconcile batch used.

.USAGE
    Invoke-Pester -Path test/unit/ScimCrawlerPhases.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:scimDir  = Join-Path $script:repoRoot 'tools' 'crawlers' 'scim'
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:scimDir 'ScimCrawler.Transform.ps1')
    . (Join-Path $script:scimDir 'ScimCrawler.Functions.ps1')
    . (Join-Path $script:scimDir 'ScimCrawler.Phases.ps1')

    # Progress reporting needs $JobId from the crawler scope; 0 = standalone (no-op).
    $JobId = 0

    function New-IdSet {
        param([string[]]$Ids)
        $set = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($i in $Ids) { [void]$set.Add($i) }
        return $set
    }

    # Pester does not allow a BeforeEach directly in the file root, so the shared
    # per-test setup lives here and each Describe calls it. Both ingest boundaries
    # are captured into $script:batches so a test can assert on the RECORDS that
    # were built, not merely that a call happened.
    function Initialize-ScimPhaseTest {
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:batches     = [System.Collections.Generic.List[object]]::new()
        Mock -CommandName Invoke-CrawlerIngestBatch -MockWith {
            $script:batches.Add([pscustomobject]@{ endpoint = $Endpoint; systemId = $SystemId; scope = $Scope; records = @($Records); idPrefix = $IdPrefix; idGeneration = $IdGeneration })
            @{ inserted = 0; updated = 0; deleted = 0 }
        }
        Mock -CommandName Invoke-IngestAPI -MockWith {
            $script:batches.Add([pscustomobject]@{ endpoint = $Endpoint; body = $Body })
            [pscustomobject]@{ systemIds = @(7); syncId = 'sync-1'; inserted = 0; updated = 0; deleted = 0 }
        }
    }
}

Describe 'Register-ScimSystem' {
    BeforeEach { Initialize-ScimPhaseTest }

    It 'registers the endpoint as one SCIM system keyed on its base URL and returns the id' {
        $id = Register-ScimSystem -BaseUrl 'https://h/scim/v2' -SystemName 'SAP CIS'
        $id | Should -Be 7
        $call = $script:batches[0]
        $call.endpoint            | Should -Be 'ingest/systems'
        $call.body.syncMode       | Should -Be 'delta'   # cross-system table: never reconcile-delete
        $call.body.records[0].systemType  | Should -Be 'SCIM'
        $call.body.records[0].displayName | Should -Be 'SAP CIS'
        $call.body.records[0].tenantId    | Should -Be 'https://h/scim/v2'
    }

    It 'throws when the API returns no system id — nothing downstream can be scoped' {
        Mock -CommandName Invoke-IngestAPI -MockWith { [pscustomobject]@{} }
        { Register-ScimSystem -BaseUrl 'https://h/scim/v2' -SystemName 'X' } | Should -Throw '*Could not resolve the SCIM system id*'
    }
}

Describe 'Sync-ScimUsers' {
    BeforeEach { Initialize-ScimPhaseTest }

    It 'shapes each page into principal records, bucketed by mapped principalType' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith {
            & $OnPage @(
                [pscustomobject]@{ id = 'u-1'; userName = 'alice'; displayName = 'Alice'; userType = 'employee'; active = $true }
                [pscustomobject]@{ id = 'sp-1'; userName = 'svc';  userType = 'service';  active = $true }
            )
            return 2
        }
        $mapping = @( @{ userType = 'service'; principalType = 'ServicePrincipal' }, @{ userType = ''; principalType = 'User' } )
        $res = Sync-ScimUsers -SystemId 7 -PageSize 100 -Mapping $mapping -SelectedAttributes @() -Buckets @('User', 'ServicePrincipal')

        $res.userIds.Count | Should -Be 2
        $res.principalTypeById['u-1']  | Should -Be 'User'
        $res.principalTypeById['sp-1'] | Should -Be 'ServicePrincipal'

        $userBatch = @($script:batches | Where-Object { $_.scope.principalType -eq 'User' })
        $spBatch   = @($script:batches | Where-Object { $_.scope.principalType -eq 'ServicePrincipal' })
        $userBatch[0].records[0].externalId  | Should -Be 'u-1'
        $userBatch[0].records[0].displayName | Should -Be 'Alice'
        $spBatch[0].records[0].externalId    | Should -Be 'sp-1'
        # A ServicePrincipal batch must never carry the User rows, or its reconcile
        # would delete them.
        @($spBatch[0].records).Count | Should -Be 1
    }

    It 'sends the deterministic-id envelope scoped to this system' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith { & $OnPage @([pscustomobject]@{ id = 'u-1'; userName = 'a' }); return 1 }
        Sync-ScimUsers -SystemId 7 -PageSize 100 -Mapping @() -SelectedAttributes @() -Buckets @('User') | Out-Null
        $script:batches[0].idGeneration | Should -Be 'deterministic'
        $script:batches[0].idPrefix     | Should -Be 'scim-sys7'
        $script:batches[0].systemId     | Should -Be 7
    }

    It 'flushes an empty full-sync batch per declared bucket when the endpoint has no users' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith { return 0 }
        $res = Sync-ScimUsers -SystemId 7 -PageSize 100 -Mapping @() -SelectedAttributes @() -Buckets @('User', 'ExternalUser')
        $res.userIds.Count | Should -Be 0
        @($script:batches).Count | Should -Be 2
        foreach ($b in $script:batches) { @($b.records).Count | Should -Be 0 }
        @($script:batches | ForEach-Object { $_.scope.principalType }) | Should -Be @('User', 'ExternalUser')
    }

    It 'carries only the opt-in attributes onto the record' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith {
            & $OnPage @([pscustomobject]@{ id = 'u-1'; userName = 'a'; department = 'IT'; costCenter = 'CC1' })
            return 1
        }
        Sync-ScimUsers -SystemId 7 -PageSize 100 -Mapping @() -SelectedAttributes @('department') -Buckets @('User') | Out-Null
        $rec = $script:batches[0].records[0]
        $rec.department | Should -Be 'IT'
        $rec.ContainsKey('costCenter') | Should -BeFalse
    }

    It 'records a read failure as a phase error instead of aborting the whole crawl' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith { throw 'SCIM request failed (HTTP 401)' }
        $res = Sync-ScimUsers -SystemId 7 -PageSize 100 -Mapping @() -SelectedAttributes @() -Buckets @('User')
        $res.userIds.Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 1
        $script:phaseErrors[0] | Should -Match 'Users: .*HTTP 401'
    }
}

Describe 'Sync-ScimGroups' {
    BeforeEach { Initialize-ScimPhaseTest }

    It 'shapes groups into Group resources and retains their member lists' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith {
            & $OnPage @([pscustomobject]@{ id = 'g-1'; displayName = 'Finance'; members = @([pscustomobject]@{ value = 'u-1' }) })
            return 1
        }
        $res = Sync-ScimGroups -SystemId 7 -PageSize 100 -SelectedAttributes @()
        $res.groupIds.Contains('g-1') | Should -BeTrue
        $res.membership.Count         | Should -Be 1
        $res.membership[0].id         | Should -Be 'g-1'
        @($res.membership[0].members).Count | Should -Be 1

        $script:batches[0].endpoint            | Should -Be 'ingest/resources'
        $script:batches[0].scope.resourceType  | Should -Be 'Group'
        $script:batches[0].records[0].displayName  | Should -Be 'Finance'
        $script:batches[0].records[0].resourceType | Should -Be 'Group'
    }

    It 'reconciles away stale groups with an empty scoped batch when the endpoint has none' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith { return 0 }
        $res = Sync-ScimGroups -SystemId 7 -PageSize 100 -SelectedAttributes @()
        $res.groupIds.Count | Should -Be 0
        @($script:batches).Count | Should -Be 1
        @($script:batches[0].records).Count   | Should -Be 0
        $script:batches[0].scope.resourceType | Should -Be 'Group'
    }

    It 'records a read failure as a phase error' {
        Mock -CommandName Invoke-ScimSearchStream -MockWith { throw 'boom' }
        Sync-ScimGroups -SystemId 7 -PageSize 100 -SelectedAttributes @() | Out-Null
        $script:phaseErrors[0] | Should -Match '^Groups: boom'
    }
}

Describe 'Sync-ScimGroupMembers' {
    BeforeEach {
        Initialize-ScimPhaseTest
        $script:users  = New-IdSet @('u-1', 'u-2')
        $script:groups = New-IdSet @('g-outer', 'g-inner')
        $script:types  = @{ 'u-1' = 'User'; 'u-2' = 'User' }
    }

    It 'emits Direct assignments, a Contains relationship, and the expanded Indirect rows' {
        $membership = @(
            [pscustomobject]@{ id = 'g-outer'; members = @([pscustomobject]@{ value = 'u-1' }, [pscustomobject]@{ value = 'g-inner' }) }
            [pscustomobject]@{ id = 'g-inner'; members = @([pscustomobject]@{ value = 'u-2' }) }
        )
        Sync-ScimGroupMembers -SystemId 7 -Membership $membership -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types

        $assign = @($script:batches | Where-Object { $_.endpoint -eq 'ingest/resource-assignments' })[0]
        $rel    = @($script:batches | Where-Object { $_.endpoint -eq 'ingest/resource-relationships' })[0]

        # u-1 Direct on g-outer, u-2 Direct on g-inner, u-2 Indirect on g-outer.
        @($assign.records).Count | Should -Be 3
        @($assign.records | Where-Object { $_.assignmentType -eq 'Direct' }).Count   | Should -Be 2
        $indirect = @($assign.records | Where-Object { $_.assignmentType -eq 'Indirect' })
        $indirect.Count | Should -Be 1
        $indirect[0].resourceExternalId  | Should -Be 'g-outer'
        $indirect[0].principalExternalId | Should -Be 'u-2'

        @($rel.records).Count | Should -Be 1
        $rel.records[0].parentExternalId | Should -Be 'g-outer'
        $rel.records[0].childExternalId  | Should -Be 'g-inner'
        $rel.records[0].relationshipType | Should -Be 'Contains'
    }

    It 'scopes each batch so a full-sync reconcile only touches what this crawler owns' {
        Sync-ScimGroupMembers -SystemId 7 -Membership @() -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $assign = @($script:batches | Where-Object { $_.endpoint -eq 'ingest/resource-assignments' })[0]
        $rel    = @($script:batches | Where-Object { $_.endpoint -eq 'ingest/resource-relationships' })[0]
        $assign.scope.resourceType     | Should -Be 'Group'
        $assign.scope.ContainsKey('assignmentType') | Should -BeFalse   # one batch must cover Direct AND Indirect
        $rel.scope.relationshipType    | Should -Be 'Contains'
        $assign.idGeneration           | Should -Be 'deterministic'
        $assign.idPrefix               | Should -Be 'scim-sys7'
    }

    It 'sends empty batches when every membership disappeared, so stale rows are removed' {
        Sync-ScimGroupMembers -SystemId 7 -Membership @() -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        foreach ($b in $script:batches) { @($b.records).Count | Should -Be 0 }
        @($script:batches).Count | Should -Be 2
    }

    It 'skips an unresolvable member but still syncs the rest of the group' {
        $membership = @([pscustomobject]@{ id = 'g-outer'; members = @(
            [pscustomobject]@{ value = 'u-1' }, [pscustomobject]@{ value = 'device-1'; type = 'Device' }) })
        Sync-ScimGroupMembers -SystemId 7 -Membership $membership -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $assign = @($script:batches | Where-Object { $_.endpoint -eq 'ingest/resource-assignments' })[0]
        @($assign.records).Count | Should -Be 1
        $assign.records[0].principalExternalId | Should -Be 'u-1'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records an ingest failure as a phase error' {
        Mock -CommandName Invoke-CrawlerIngestBatch -MockWith { throw 'ingest exploded' }
        Sync-ScimGroupMembers -SystemId 7 -Membership @() -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $script:phaseErrors[0] | Should -Match '^GroupMembers: ingest exploded'
    }
}

Describe 'Complete-ScimRun' {
    BeforeEach { Initialize-ScimPhaseTest }

    It 'refreshes the matrix views and succeeds when every phase was clean' {
        { Complete-ScimRun } | Should -Not -Throw
        @($script:batches | Where-Object { $_.endpoint -eq 'ingest/refresh-views' }).Count | Should -Be 1
    }

    It 'treats a failed view refresh as non-critical' {
        Mock -CommandName Invoke-IngestAPI -MockWith { throw 'views unavailable' }
        { Complete-ScimRun } | Should -Not -Throw
    }

    It 'fails the job when a phase recorded an error, naming every failed phase' {
        $script:phaseErrors.Add('Users: HTTP 401')
        $script:phaseErrors.Add('Groups: boom')
        { Complete-ScimRun } | Should -Throw '*Users: HTTP 401; Groups: boom*'
    }
}
