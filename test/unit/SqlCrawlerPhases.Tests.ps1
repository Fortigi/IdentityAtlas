#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/sql/SqlCrawler.Phases.ps1.

.DESCRIPTION
    The two boundaries are mocked — Invoke-SqlQueryStream (replays canned rows
    through the phase's own -OnRow callback) and Invoke-IngestAPI (captures every
    body). Everything between them is the real code, so the assertions are about
    what the phase DECIDED: which streams it opened and with which scope, which
    rows it skipped or held back as dangling, which scopes it registered for the
    reconcile, and that a delta run reconciles nothing.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerPhases.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $sqlDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'sql'
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngestStream.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Get-CrawlerSystemName.ps1')
    . (Join-Path $sqlDir 'SqlCrawler.Functions.ps1')
    . (Join-Path $sqlDir 'SqlCrawler.Transform.ps1')
    . (Join-Path $sqlDir 'SqlCrawler.Phases.ps1')

    function Reset-SqlTestState {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        $script:rowsToReplay = @()
    }
    # Captures every ingest call. Answers with a count so the stream totals add up.
    $script:IngestMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body })
        @{ inserted = @($Body.records).Count; updated = 0; deleted = 2; systemIds = @(7) }
    }
    # Replays $script:rowsToReplay through the phase's own callback.
    $script:StreamMock = {
        foreach ($r in $script:rowsToReplay) { & $OnRow $r }
        [long]@($script:rowsToReplay).Count
    }
    function New-TestRow { param([hashtable]$Cells) $o = [ordered]@{}; foreach ($k in $Cells.Keys) { $o[$k] = $Cells[$k] }; return $o }
    function Get-Sent { param([string]$Endpoint) @($script:sent | Where-Object { $_.Endpoint -eq $Endpoint }) }
    function Get-SentRecords {
        param([string]$Endpoint)
        $out = [System.Collections.Generic.List[object]]::new()
        foreach ($c in (Get-Sent $Endpoint)) { foreach ($r in @($c.Body.records)) { $out.Add($r) } }
        # Leading comma: a single record must stay INSIDE an array, or `$recs[0]`
        # indexes the record (an ordered dictionary) by the key 0 and yields $null.
        return , @($out)
    }
    function New-Slot {
        param([string]$Name, [string]$Target, [hashtable]$Extra = @{})
        $s = @{ name = $Name; target = $Target; sql = 'SELECT 1'; enabled = $true; resourceType = 'Entitlement'
                assignmentType = 'Direct'; governed = $false; relationshipType = 'Contains'; principalType = 'User'; paged = $false }
        foreach ($k in $Extra.Keys) { $s[$k] = $Extra[$k] }
        return $s
    }
    function New-TestState {
        param([hashtable[]]$Slots, [string]$SyncMode = 'full')
        New-SqlRunState -SystemId 7 -ServerTime '2026-09-25T09:00:00.000Z' -Slots $Slots -BatchSize 1000 -SyncMode $SyncMode
    }
}

Describe 'Get-SqlSlotsInOrder' {
    It 'sorts to the dependency order regardless of configured order, and drops disabled slots' {
        $slots = @(
            (New-Slot 'rel'  'relationships')
            (New-Slot 'asg'  'assignments')
            (New-Slot 'res'  'resources')
            (New-Slot 'off'  'identities' @{ enabled = $false })
            (New-Slot 'ids'  'identities')
            (New-Slot 'mem'  'identity-members')
            (New-Slot 'prin' 'principals')
        )
        @((Get-SqlSlotsInOrder -Slots $slots).target) | Should -Be @('identities', 'principals', 'resources', 'identity-members', 'assignments', 'relationships')
        (Get-SqlSlotsInOrder -Slots $slots).name | Should -Not -Contain 'off'
    }

    It 'keeps two slots of the same target in configured order' {
        $slots = @((New-Slot 'ent' 'resources'), (New-Slot 'roles' 'resources' @{ resourceType = 'BusinessRole' }))
        @((Get-SqlSlotsInOrder -Slots $slots).name) | Should -Be @('ent', 'roles')
    }

    It 'returns nothing when every slot is disabled' {
        @(Get-SqlSlotsInOrder -Slots @((New-Slot 'a' 'resources' @{ enabled = $false }))).Count | Should -Be 0
    }
}

Describe 'New-SqlRunState' {
    It 'derives the id prefix from the system and notes which entity kinds this run produces' {
        $s = New-TestState -Slots @((New-Slot 'r' 'resources'), (New-Slot 'a' 'assignments'))
        $s.IdPrefix | Should -Be 'sql-7'
        $s.HasResources | Should -BeTrue
        $s.HasPrincipals | Should -BeFalse
    }
    It 'counts an identities OR a principals slot as producing principals, and ignores disabled slots' {
        (New-TestState -Slots @((New-Slot 'i' 'identities'))).HasPrincipals | Should -BeTrue
        (New-TestState -Slots @((New-Slot 'p' 'principals'))).HasPrincipals | Should -BeTrue
        (New-TestState -Slots @((New-Slot 'r' 'resources' @{ enabled = $false }))).HasResources | Should -BeFalse
    }
}

Describe 'Add-SqlReconcileScope' {
    It 'records one entry per distinct endpoint+scope, however often it is offered' {
        $s = New-TestState -Slots @()
        Add-SqlReconcileScope -State $s -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        Add-SqlReconcileScope -State $s -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        Add-SqlReconcileScope -State $s -Endpoint 'ingest/resources' -Scope @{ resourceType = 'BusinessRole' }
        Add-SqlReconcileScope -State $s -Endpoint 'ingest/resource-assignments' -Scope @{ resourceType = 'Entitlement' }
        $s.Scopes.Count | Should -Be 3
    }
    It 'treats the same keys in a different order as one scope' {
        $s = New-TestState -Slots @()
        Add-SqlReconcileScope -State $s -Endpoint 'ingest/resource-assignments' -Scope ([ordered]@{ a = 1; b = 2 })
        Add-SqlReconcileScope -State $s -Endpoint 'ingest/resource-assignments' -Scope ([ordered]@{ b = 2; a = 1 })
        $s.Scopes.Count | Should -Be 1
    }
}

Describe 'New-SqlSlotStreams' {
    BeforeEach { Reset-SqlTestState }

    It 'an identities slot opens identity, principal and member streams, and registers ONLY principals for reconcile' {
        $state = New-TestState -Slots @()
        $streams = New-SqlSlotStreams -Slot (New-Slot 'i' 'identities') -State $state
        @($streams.Keys | Sort-Object) | Should -Be @('identity', 'member', 'principal')
        $streams.principal.Scope.principalType | Should -Be 'User'
        # Identities / IdentityMembers are cross-system tables: never reconciled.
        @($state.Scopes.Endpoint) | Should -Be @('ingest/principals')
    }

    It 'an assignments slot scopes its stream by every reconcile axis and keys dedup on both ends' {
        $state = New-TestState -Slots @()
        $slot = New-Slot 'a' 'assignments' @{ assignmentType = 'Eligible'; resourceType = 'BusinessRole'; governed = $true }
        $streams = New-SqlSlotStreams -Slot $slot -State $state
        $sc = $streams.assignment.Scope
        $sc.assignmentType | Should -Be 'Eligible'
        $sc.resourceType | Should -Be 'BusinessRole'
        $sc.governed | Should -BeTrue
        $streams.assignment.KeyFields | Should -Be @('resourceExternalId', 'principalExternalId')
        @($state.Scopes.Endpoint) | Should -Be @('ingest/resource-assignments')
    }

    It 'a resources slot scopes on its resourceType, and a relationships slot on its relationshipType' {
        $state = New-TestState -Slots @()
        (New-SqlSlotStreams -Slot (New-Slot 'r' 'resources' @{ resourceType = 'BusinessRole' }) -State $state).resource.Scope.resourceType | Should -Be 'BusinessRole'
        (New-SqlSlotStreams -Slot (New-Slot 'x' 'relationships' @{ relationshipType = 'GrantsAccessTo' }) -State $state).relationship.Scope.relationshipType | Should -Be 'GrantsAccessTo'
    }

    It 'an identity-members slot opens only the member stream and registers no reconcile scope' {
        $state = New-TestState -Slots @()
        @((New-SqlSlotStreams -Slot (New-Slot 'm' 'identity-members') -State $state).Keys) | Should -Be @('member')
        $state.Scopes.Count | Should -Be 0
    }
}

Describe 'Get-SqlRowHandler' {
    It 'maps every target to its handler and rejects an unknown one' {
        Get-SqlRowHandler -Target 'identities' | Should -Be 'Add-SqlIdentityRow'
        Get-SqlRowHandler -Target 'assignments' | Should -Be 'Add-SqlAssignmentRow'
        Get-SqlRowHandler -Target 'relationships' | Should -Be 'Add-SqlRelationshipRow'
        { Get-SqlRowHandler -Target 'nope' } | Should -Throw '*No row handler*'
    }
}

Describe 'Invoke-SqlSlot — identities' {
    BeforeEach {
        Reset-SqlTestState
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Invoke-SqlQueryStream $script:StreamMock
        Mock Update-CrawlerProgress { }
    }

    It 'emits an identity, its account principal and the link for each row, and remembers the principal' {
        $script:rowsToReplay = @(
            (New-TestRow @{ id = 'i1'; display_name = 'Ann'; inactive = 0 })
            (New-TestRow @{ id = 'i2'; display_name = 'Bob'; inactive = 1 })
        )
        $state = New-TestState -Slots @()
        $r = Invoke-SqlSlot -Slot (New-Slot 'Identities' 'identities') -Connection 'conn' -State $state
        $r.rows | Should -Be 2
        $r.skipped | Should -Be 0
        @(Get-SentRecords 'ingest/identities').externalId | Should -Be @('i1', 'i2')
        $principals = Get-SentRecords 'ingest/principals'
        @($principals.externalId) | Should -Be @('i1', 'i2')
        @($principals.accountEnabled) | Should -Be @($true, $false)
        $members = Get-SentRecords 'ingest/identity-members'
        @($members.identityExternalId) | Should -Be @('i1', 'i2')
        @($members.principalExternalId) | Should -Be @('i1', 'i2')
        @($state.KnownPrincipals) | Should -Be @('i1', 'i2')
    }

    It 'counts a row with no id as skipped and sends nothing for it' {
        $script:rowsToReplay = @((New-TestRow @{ id = ''; display_name = 'ghost' }), (New-TestRow @{ id = 'i1'; display_name = 'Ann' }))
        $r = Invoke-SqlSlot -Slot (New-Slot 'Identities' 'identities') -Connection 'conn' -State (New-TestState -Slots @())
        $r.rows | Should -Be 2
        $r.skipped | Should -Be 1
        @(Get-SentRecords 'ingest/identities').Count | Should -Be 1
    }

    It 'sends the batch as a deterministic-id delta in the system-scoped namespace' {
        $script:rowsToReplay = @((New-TestRow @{ id = 'i1'; displayName = 'Ann' }))
        Invoke-SqlSlot -Slot (New-Slot 'Identities' 'identities') -Connection 'conn' -State (New-TestState -Slots @()) | Out-Null
        $body = (Get-Sent 'ingest/identities')[0].Body
        $body.syncMode | Should -Be 'delta'
        $body.idGeneration | Should -Be 'deterministic'
        $body.idPrefix | Should -Be 'sql-7-identities'
        $body.systemId | Should -Be 7
    }

    It 'passes the slot SQL, the command timeout, the paging flag and the page size to the reader' {
        $script:rowsToReplay = @()
        $state = New-SqlRunState -SystemId 7 -ServerTime 'T' -Slots @() -PageSize 250 -CommandTimeout 45
        Invoke-SqlSlot -Slot (New-Slot 'Paged' 'identities' @{ sql = 'SELECT 1 OFFSET @Offset ROWS'; paged = $true }) -Connection 'conn' -State $state | Out-Null
        Should -Invoke Invoke-SqlQueryStream -Exactly 1 -ParameterFilter {
            $Sql -eq 'SELECT 1 OFFSET @Offset ROWS' -and $Paged -eq $true -and $PageSize -eq 250 -and $CommandTimeout -eq 45
        }
    }
}

Describe 'Invoke-SqlSlot — principals with an identity link' {
    BeforeEach {
        Reset-SqlTestState
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Invoke-SqlQueryStream $script:StreamMock
        Mock Update-CrawlerProgress { }
    }

    It 'links an account to its identity only when the row names one, as a non-primary account' {
        $script:rowsToReplay = @(
            (New-TestRow @{ id = 'a1'; displayName = 'Acct 1'; identityId = 'i1' })
            (New-TestRow @{ id = 'a2'; displayName = 'Acct 2' })
        )
        Invoke-SqlSlot -Slot (New-Slot 'Accounts' 'principals') -Connection 'conn' -State (New-TestState -Slots @()) | Out-Null
        @(Get-SentRecords 'ingest/principals').externalId | Should -Be @('a1', 'a2')
        $members = Get-SentRecords 'ingest/identity-members'
        @($members).Count | Should -Be 1
        $members[0].identityExternalId | Should -Be 'i1'
        $members[0].principalExternalId | Should -Be 'a1'
        $members[0].isPrimary | Should -BeFalse
        $members[0].accountType | Should -Be 'Linked'
    }
}

Describe 'Invoke-SqlSlot — dangling references' {
    BeforeEach {
        Reset-SqlTestState
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Invoke-SqlQueryStream $script:StreamMock
        Mock Update-CrawlerProgress { }
    }

    It 'holds back an assignment whose resource or principal this run never emitted, and counts it' {
        $slots = @((New-Slot 'res' 'resources'), (New-Slot 'ids' 'identities'), (New-Slot 'asg' 'assignments'))
        $state = New-TestState -Slots $slots
        $script:rowsToReplay = @((New-TestRow @{ id = 'e1'; displayName = 'Ent 1' }))
        Invoke-SqlSlot -Slot $slots[0] -Connection 'conn' -State $state | Out-Null
        $script:rowsToReplay = @((New-TestRow @{ id = 'u1'; displayName = 'Ann' }))
        Invoke-SqlSlot -Slot $slots[1] -Connection 'conn' -State $state | Out-Null
        $script:rowsToReplay = @(
            (New-TestRow @{ principalId = 'u1'; resourceId = 'e1' })   # both known — sent
            (New-TestRow @{ principalId = 'u1'; resourceId = 'e9' })   # unknown resource
            (New-TestRow @{ principalId = 'u9'; resourceId = 'e1' })   # unknown principal
            (New-TestRow @{ principalId = ''; resourceId = 'e1' })     # unusable
        )
        $r = Invoke-SqlSlot -Slot $slots[2] -Connection 'conn' -State $state
        $r.rows | Should -Be 4
        $r.dangling | Should -Be 2
        $r.skipped | Should -Be 1
        $sentAsg = Get-SentRecords 'ingest/resource-assignments'
        @($sentAsg).Count | Should -Be 1
        $sentAsg[0].resourceExternalId | Should -Be 'e1'
        $sentAsg[0].principalExternalId | Should -Be 'u1'
    }

    It 'checks only the axis this run actually produces — no resources slot means no resource check' {
        $slots = @((New-Slot 'ids' 'identities'), (New-Slot 'asg' 'assignments'))
        $state = New-TestState -Slots $slots
        $script:rowsToReplay = @((New-TestRow @{ id = 'u1'; displayName = 'Ann' }))
        Invoke-SqlSlot -Slot $slots[0] -Connection 'conn' -State $state | Out-Null
        $script:rowsToReplay = @((New-TestRow @{ principalId = 'u1'; resourceId = 'e-from-another-crawler' }))
        (Invoke-SqlSlot -Slot $slots[1] -Connection 'conn' -State $state).dangling | Should -Be 0
        @(Get-SentRecords 'ingest/resource-assignments').Count | Should -Be 1
    }

    It 'holds back a relationship edge unless BOTH ends are known resources' {
        $slots = @((New-Slot 'res' 'resources'), (New-Slot 'rel' 'relationships'))
        $state = New-TestState -Slots $slots
        $script:rowsToReplay = @((New-TestRow @{ id = 'b1'; displayName = 'Role' }), (New-TestRow @{ id = 'e1'; displayName = 'Ent' }))
        Invoke-SqlSlot -Slot $slots[0] -Connection 'conn' -State $state | Out-Null
        $script:rowsToReplay = @(
            (New-TestRow @{ parentId = 'b1'; childId = 'e1' })
            (New-TestRow @{ parentId = 'b1'; childId = 'e9' })
            (New-TestRow @{ parentId = 'b9'; childId = 'e1' })
        )
        (Invoke-SqlSlot -Slot $slots[1] -Connection 'conn' -State $state).dangling | Should -Be 2
        @(Get-SentRecords 'ingest/resource-relationships').Count | Should -Be 1
    }
}

Describe 'Invoke-SqlReconcile' {
    BeforeEach { Reset-SqlTestState; Mock Invoke-IngestAPI $script:IngestMock; Mock Update-CrawlerProgress { } }

    It 'reconciles each registered scope against the API clock and totals the deletions' {
        $state = New-TestState -Slots @()
        Add-SqlReconcileScope -State $state -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        Add-SqlReconcileScope -State $state -Endpoint 'ingest/resource-assignments' -Scope @{ assignmentType = 'Direct' }
        $deleted = Invoke-SqlReconcile -State $state
        $deleted | Should -Be 4                       # the mock reports 2 per call
        $calls = Get-Sent 'ingest/reconcile'
        @($calls).Count | Should -Be 2
        @($calls.Body.entity) | Should -Be @('resources', 'resource-assignments')
        foreach ($c in $calls) {
            $c.Body.before | Should -Be '2026-09-25T09:00:00.000Z'
            $c.Body.systemId | Should -Be 7
        }
    }

    It 'a DELTA run reconciles nothing at all' {
        $state = New-TestState -Slots @() -SyncMode 'delta'
        Add-SqlReconcileScope -State $state -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        Invoke-SqlReconcile -State $state | Should -Be 0
        Should -Invoke Invoke-IngestAPI -Exactly 0
    }

    It 'a full run with no registered scopes calls nothing' {
        Invoke-SqlReconcile -State (New-TestState -Slots @()) | Should -Be 0
        Should -Invoke Invoke-IngestAPI -Exactly 0
    }
}

Describe 'Register-SqlSystem' {
    BeforeEach { Reset-SqlTestState; Mock Invoke-IngestAPI $script:IngestMock; Mock Get-CrawlerServerTime { '2026-09-25T09:00:00.000Z' } }

    It 'registers one SQL system keyed on server/database and returns its id plus the API clock' {
        $reg = Register-SqlSystem -Cfg @{ server = 'DB1'; database = 'IIQ'; configName = 'IIQ prod'; systemName = '' }
        $reg.systemId | Should -Be 7
        $reg.serverTime | Should -Be '2026-09-25T09:00:00.000Z'
        $body = (Get-Sent 'ingest/systems')[0].Body
        $body.syncMode | Should -Be 'delta'
        $rec = @($body.records)[0]
        $rec.systemType | Should -Be 'SQL'
        $rec.tenantId | Should -Be 'db1/iiq'
        $rec.displayName | Should -Be 'IIQ prod'      # the crawler's own name wins
    }

    It 'an explicit system name overrides the crawler name' {
        (Register-SqlSystem -Cfg @{ server = 'db1'; database = 'iiq'; configName = 'IIQ prod'; systemName = 'Payroll DB' }).systemId | Should -Be 7
        @((Get-Sent 'ingest/systems')[0].Body.records)[0].displayName | Should -Be 'Payroll DB'
    }

    It 'falls back to the type default when the run carries no crawler name' {
        Register-SqlSystem -Cfg @{ server = 'db1'; database = 'iiq'; configName = ''; systemName = '' } | Out-Null
        @((Get-Sent 'ingest/systems')[0].Body.records)[0].displayName | Should -Be 'SQL Database (db1/iiq)'
    }

    It 'throws rather than guessing when the API returns no id — every reconcile is scoped to it' {
        Mock Invoke-IngestAPI { @{} }
        { Register-SqlSystem -Cfg @{ server = 'db1'; database = 'iiq'; configName = 'x'; systemName = '' } } | Should -Throw '*system id*'
    }
}

Describe 'Complete-SqlRun' {
    BeforeEach { Reset-SqlTestState; Mock Update-CrawlerProgress { } }

    It 'refreshes the views and writes the sync log' {
        Mock Invoke-IngestAPI $script:IngestMock
        Complete-SqlRun -State (New-TestState -Slots @()) -SyncStart (Get-Date)
        @(Get-Sent 'ingest/refresh-views').Count | Should -Be 1
        @(Get-Sent 'ingest/sync-log').Count | Should -Be 1
        (Get-Sent 'ingest/sync-log')[0].Body.systemId | Should -Be 7
    }

    It 'treats a failed view refresh and a failed sync-log write as non-fatal' {
        Mock Invoke-IngestAPI { throw 'HTTP 500' }
        { Complete-SqlRun -State (New-TestState -Slots @()) -SyncStart (Get-Date) } | Should -Not -Throw
    }
}
