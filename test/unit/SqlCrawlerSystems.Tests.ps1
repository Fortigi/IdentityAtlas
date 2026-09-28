#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Systems.ps1 — the
    `systems` target and the per-row routing that sends each row to the system
    its source connector owns.

.DESCRIPTION
    Invoke-SqlQueryStream and Invoke-IngestAPI are the only mocks; everything
    between them is the real code, so the assertions are about what the crawler
    DECIDED: which system each row was addressed to, which namespace its ids
    were generated in, which scopes were reconciled, and what it said about a
    row naming a system no statement created.

    The first test in this file is the one the whole change exists for: a
    principal in one system, an entitlement in another, and an assignment
    joining them. Read tools/crawlers/mssql/CLAUDE.md → "One namespace per run".

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerSystems.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $sqlDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql'
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $sqlDir 'SqlCrawler.Load.ps1')

    # Ingest double. Every registration record is handed the next system id from
    # 11 up, so a routed batch's systemId is a value only registration could have
    # produced — the crawler's own system is 7 and can never be mistaken for one.
    function Reset-SqlTestState {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        $script:rowsBySlot = @{}
        $script:nextSystemId = 11
    }
    $script:IngestMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body })
        $ids = @()
        if ($Endpoint -eq 'ingest/systems') {
            foreach ($r in @($Body.records)) { $ids += $script:nextSystemId; $script:nextSystemId++ }
        }
        @{ inserted = @($Body.records).Count; updated = 0; deleted = 0; systemIds = $ids }
    }
    # Replays the rows registered for the slot currently streaming.
    $script:StreamMock = {
        $rows = @($script:rowsBySlot[$script:currentSlot])
        foreach ($r in $rows) { & $OnRow $r }
        [long]$rows.Count
    }

    function New-TestRow { param([hashtable]$Cells) $o = [ordered]@{}; foreach ($k in $Cells.Keys) { $o[$k] = $Cells[$k] }; return $o }
    function Get-Sent { param([string]$Endpoint) @($script:sent | Where-Object { $_.Endpoint -eq $Endpoint }) }
    function Get-SentRecords {
        param([string]$Endpoint)
        $out = [System.Collections.Generic.List[object]]::new()
        foreach ($c in (Get-Sent $Endpoint)) { foreach ($r in @($c.Body.records)) { $out.Add($r) } }
        return , @($out)
    }
    # What app/api/src/routes/ingest/helpers.js → recoverSystemPrefix() strips an
    # ingest body's idPrefix back to: the namespace every cross-entity reference
    # in that batch is resolved in.
    function Get-RunNamespace {
        param([string]$Endpoint)
        $body = (Get-Sent $Endpoint)[0].Body
        $suffix = '-' + ($Endpoint -replace '^ingest/', '')
        return ([string]$body.idPrefix) -replace ([regex]::Escape($suffix) + '$'), ''
    }

    function New-Slot {
        param([string]$Name, [string]$Target, [hashtable]$Extra = @{})
        $s = @{ name = $Name; target = $Target; sql = 'SELECT 1'; enabled = $true; resourceType = 'Entitlement'
                assignmentType = 'Direct'; governed = $false; relationshipType = 'Contains'; principalType = 'User'
                systemType = ''; contextType = ''; targetType = 'Resource'; memberType = 'Resource'; paged = $false }
        foreach ($k in $Extra.Keys) { $s[$k] = $Extra[$k] }
        return $s
    }
    function New-TestState {
        param([hashtable[]]$Slots, [string]$SyncMode = 'full')
        New-SqlRunState -SystemId 7 -ServerTime '2026-09-28T09:00:00.000Z' -Slots $Slots -BatchSize 1000 -SyncMode $SyncMode `
            -SystemType 'SQL' -Tenant 'sk8/identityiq'
    }
    # Run every slot in dependency order with its own canned rows.
    # $Rows: slot name -> the rows that statement returns.
    function Invoke-SqlTestRun {
        param([hashtable[]]$Slots, [hashtable]$Rows, [string]$SyncMode = 'full')
        Reset-SqlTestState
        foreach ($k in $Rows.Keys) { $script:rowsBySlot[$k] = $Rows[$k] }
        $state = New-TestState -Slots $Slots -SyncMode $SyncMode
        foreach ($slot in @(Get-SqlSlotsInOrder -Slots $Slots)) {
            $script:currentSlot = $slot.name
            Invoke-SqlSlot -Slot $slot -Connection 'conn' -State $state | Out-Null
        }
        return $state
    }
}

Describe 'Routing across systems' {
    BeforeEach {
        Mock -CommandName Invoke-IngestAPI      -MockWith $script:IngestMock
        Mock -CommandName Invoke-SqlQueryStream -MockWith $script:StreamMock
        Mock -CommandName Update-CrawlerProgress -MockWith {}
        Mock -CommandName Add-SqlReadCheck       -MockWith {}
    }

    # THE test. An IdentityIQ-shaped source keeps its people in the directory and
    # its entitlements in the connector each one came from, so every grant spans
    # two systems. With a namespace per system the two halves of this assignment
    # would hash in different namespaces, match nothing, and be lost without a
    # word — see the pair of tests in app/api/src/ingest/normalization.test.js.
    It 'joins a principal in one system to an entitlement in another' {
        $slots = @(
            (New-Slot 'apps'  'systems')
            (New-Slot 'users' 'principals')
            (New-Slot 'ents'  'resources')
            (New-Slot 'grants' 'assignments')
        )
        $state = Invoke-SqlTestRun -Slots $slots -Rows @{
            apps   = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }))
            users  = @((New-TestRow @{ id = 'alice'; displayName = 'Alice' }))
            ents   = @((New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' }))
            grants = @((New-TestRow @{ principalId = 'alice'; resourceId = 'ENT-1' }))
        }

        # Three batches, three envelopes: the person stays in the directory, the
        # entitlement and the grant on it belong to the connector's own system.
        (Get-Sent 'ingest/principals')[0].Body.systemId          | Should -Be 7
        (Get-Sent 'ingest/resources')[0].Body.systemId           | Should -Be 11
        (Get-Sent 'ingest/resource-assignments')[0].Body.systemId | Should -Be 11

        # One namespace for all three, so the assignment's principalExternalId
        # hashes to the id the principals batch gave Alice and its
        # resourceExternalId to the id the resources batch gave ENT-1.
        $ns = Get-RunNamespace 'ingest/principals'
        $ns | Should -Be 'sql-7'
        Get-RunNamespace 'ingest/resources'            | Should -Be $ns
        Get-RunNamespace 'ingest/resource-assignments' | Should -Be $ns

        # And the grant really was sent, not held back as dangling.
        $grant = (Get-SentRecords 'ingest/resource-assignments')[0]
        $grant.principalExternalId | Should -Be 'alice'
        $grant.resourceExternalId  | Should -Be 'ENT-1'
        $state.Totals['grants'].dangling | Should -Be 0
    }

    It 'sends each system its own batch, and a relationship follows its parent rather than its child' {
        $slots = @(
            (New-Slot 'apps' 'systems')
            (New-Slot 'ents' 'resources')
            (New-Slot 'roles' 'resources' @{ resourceType = 'BusinessRole' })
            (New-Slot 'comp' 'relationships')
        )
        $state = Invoke-SqlTestRun -Slots $slots -Rows @{
            apps  = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }), (New-TestRow @{ id = 'APP-2'; displayName = 'Finance' }))
            ents  = @(
                (New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' })
                (New-TestRow @{ id = 'ENT-2'; displayName = 'Ledger'; systemId = 'APP-2' })
            )
            # A business role is the crawler's own: it is not a connector's object.
            roles = @((New-TestRow @{ id = 'ROLE-1'; displayName = 'Payroll clerk' }))
            comp  = @((New-TestRow @{ parentId = 'ROLE-1'; childId = 'ENT-1' }))
        }
        # One batch per system, each holding only its own entitlement.
        $batches = @(Get-Sent 'ingest/resources' | ForEach-Object { @{ sid = $_.Body.systemId; ids = @($_.Body.records.externalId) } })
        ($batches | Where-Object { $_.sid -eq 11 }).ids | Should -Be @('ENT-1')
        ($batches | Where-Object { $_.sid -eq 12 }).ids | Should -Be @('ENT-2')
        ($batches | Where-Object { $_.sid -eq 7 }).ids  | Should -Be @('ROLE-1')
        # The edge belongs with the role that contains the entitlement, not with
        # the connector the entitlement happens to come from.
        (Get-Sent 'ingest/resource-relationships')[0].Body.systemId | Should -Be 7
        $state.Totals['comp'].dangling | Should -Be 0
    }

    It 'routes by system NAME, folding case and surrounding spaces the one way names are folded' {
        Invoke-SqlTestRun -Slots @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources')) -Rows @{
            apps = @((New-TestRow @{ displayName = 'HR Portal' }))
            ents = @((New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemName = '  hr PORTAL ' }))
        } | Out-Null
        (Get-Sent 'ingest/resources')[0].Body.systemId | Should -Be 11
    }

    It 'keeps the routing columns as attributes instead of consuming them out of sight' {
        Invoke-SqlTestRun -Slots @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources')) -Rows @{
            apps = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }))
            ents = @((New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' }))
        } | Out-Null
        (Get-SentRecords 'ingest/resources')[0].extendedAttributes.systemId | Should -Be 'APP-1'
    }

    It 'leaves a run with no systems statement on exactly the path it was on before' {
        # No catalogue, so no routing: a systemId column is an ordinary attribute
        # and every row stays in the crawler's own system. This is the existing
        # installation, and its ids must not move.
        Invoke-SqlTestRun -Slots @((New-Slot 'ents' 'resources')) -Rows @{
            ents = @((New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' }))
        } | Out-Null
        $body = (Get-Sent 'ingest/resources')[0].Body
        $body.systemId | Should -Be 7
        $body.idPrefix | Should -Be 'sql-7-resources'
        (Get-Sent 'ingest/systems').Count | Should -Be 0
    }

    It 'asks a second identical run for exactly the same things, so the same rows come back' {
        # What makes a re-run land on the same system rather than a copy of it is
        # the registration KEY: the API upserts a system on (systemType, tenantId)
        # (migration 006 / 074). A tenantId built from anything that varies per
        # run — the Atlas id, a clock — would add a second system every night and
        # re-home its whole inventory, which is exactly what migration 074 had to
        # repair for the CSV crawler. So the assertion is on the request, not on
        # the ids a double happens to hand back.
        $slots = @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources'), (New-Slot 'grants' 'assignments'))
        $rows = @{
            apps   = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }))
            ents   = @((New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' }))
            grants = @((New-TestRow @{ principalId = 'alice'; resourceId = 'ENT-1' }))
        }
        $describe = {
            @($script:sent | ForEach-Object {
                $keys = @($_.Body.records | ForEach-Object { if ($_.externalId) { $_.externalId } elseif ($_.tenantId) { "$($_.systemType):$($_.tenantId)" } else { "$($_.resourceExternalId)->$($_.principalExternalId)" } })
                "$($_.Endpoint)|$($_.Body.syncMode)|$($_.Body.idPrefix)|$($keys -join ',')"
            })
        }
        $first = Invoke-SqlTestRun -Slots $slots -Rows $rows
        $firstRequests = & $describe
        $firstScopes = @($first.Scopes | ForEach-Object { "$($_.Endpoint)|$($_.SystemId)" } | Sort-Object)

        $second = Invoke-SqlTestRun -Slots $slots -Rows $rows
        (& $describe) | Should -Be $firstRequests
        @($second.Scopes | ForEach-Object { "$($_.Endpoint)|$($_.SystemId)" } | Sort-Object) | Should -Be $firstScopes
        # And the registration is a delta: a full sync of ingest/systems would
        # treat the batch as every system there is and cascade the rest away.
        (Get-Sent 'ingest/systems')[0].Body.syncMode | Should -Be 'delta'
    }
}

Describe 'ConvertTo-SqlSystemRecord' {
    BeforeAll {
        $script:sysState = @{ SystemType = 'SQL'; Tenant = 'sk8:14330/identityiq' }
        function Convert-One {
            param([hashtable]$Cells, [hashtable]$SlotExtra = @{})
            $row = New-TestRow $Cells
            $map = Resolve-SqlColumnMap -Columns @($row.Keys) -Target 'systems'
            return ConvertTo-SqlSystemRecord -Row $row -Map $map -Slot (New-Slot 's' 'systems' $SlotExtra) -State $script:sysState
        }
    }

    It 'keys on the row id and derives a tenant that is stable across runs and unique to this crawler' {
        $r = Convert-One @{ id = 'APP-1'; displayName = 'HR Portal' }
        $r.key | Should -BeExactly 'APP-1'
        $r.record.displayName | Should -BeExactly 'HR Portal'
        $r.record.systemType | Should -BeExactly 'SQL'
        $r.record.tenantId | Should -BeExactly 'sk8:14330/identityiq/app-1'
        $r.record.enabled | Should -BeTrue
        $r.record.syncEnabled | Should -BeTrue
    }

    It 'falls back to the folded name as the key when the statement returns no id' {
        # A rename then moves the system, which is why an id column is preferred
        # and why the presets alias one wherever the source has it.
        (Convert-One @{ displayName = '  HR Portal ' }).key | Should -BeExactly 'hr portal'
        (Convert-One @{ name = 'HR Portal' }).key | Should -BeExactly 'hr portal'
    }

    It 'lets the row and then the slot name the systemType, and the crawler own type last' {
        (Convert-One @{ id = 'a'; displayName = 'A'; systemType = 'ActiveDirectory' }).record.systemType | Should -BeExactly 'ActiveDirectory'
        (Convert-One @{ id = 'a'; displayName = 'A' } @{ systemType = 'IdentityIQ' }).record.systemType | Should -BeExactly 'IdentityIQ'
        (Convert-One @{ id = 'a'; displayName = 'A' }).record.systemType | Should -BeExactly 'SQL'
    }

    It 'lets a statement supply the connector own tenant instead of the derived one' {
        (Convert-One @{ id = 'a'; displayName = 'A'; tenantId = 'contoso.onmicrosoft.com' }).record.tenantId |
            Should -BeExactly 'contoso.onmicrosoft.com'
    }

    It 'carries the description, the enabled flag and every other column as an attribute' {
        $r = Convert-One @{ id = 'a'; displayName = 'A'; description = 'The HR system'; inactive = 1; connector = 'LDAP' }
        $r.record.description | Should -BeExactly 'The HR system'
        $r.record.enabled | Should -BeFalse
        $r.record.extendedAttributes.connector | Should -BeExactly 'LDAP'
    }

    It 'skips a row with no name at all rather than registering a system called nothing' {
        Convert-One @{ id = 'a' } | Should -BeNullOrEmpty
        Convert-One @{ displayName = '   ' } | Should -BeNullOrEmpty
    }
}

Describe 'Register-SqlSystemCatalog' {
    BeforeEach {
        Reset-SqlTestState
        Mock -CommandName Invoke-IngestAPI       -MockWith $script:IngestMock
        Mock -CommandName Invoke-SqlQueryStream  -MockWith $script:StreamMock
        Mock -CommandName Update-CrawlerProgress -MockWith {}
        Mock -CommandName Add-SqlReadCheck       -MockWith {}
    }

    It 'refuses to guess when the API answers with fewer ids than it was sent systems' {
        # The ids come back one per record in order, and a record whose lookup
        # found nothing is simply left out. Mapping the remainder by position
        # would point each system at its neighbour's rows — silently.
        Mock -CommandName Invoke-IngestAPI -MockWith { @{ systemIds = @(11) } }
        $state = New-TestState -Slots @()
        $ctx = @{ Slot = (New-Slot 's' 'systems'); Map = $null; State = $state; Skipped = 0 }
        foreach ($cells in @(@{ id = 'A'; displayName = 'A' }, @{ id = 'B'; displayName = 'B' })) {
            $row = New-TestRow $cells
            $ctx.Map = Resolve-SqlColumnMap -Columns @($row.Keys) -Target 'systems'
            Add-SqlSystemRow -Row $row -Ctx $ctx
        }
        { Register-SqlSystemCatalog -State $state } | Should -Throw '*refusing to guess*'
    }

    It 'counts a repeated key, keeps the first, and registers each system once' {
        $state = Invoke-SqlTestRun -Slots @((New-Slot 'apps' 'systems')) -Rows @{
            apps = @(
                (New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' })
                (New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal (old)' })
            )
        }
        @((Get-Sent 'ingest/systems')[0].Body.records).Count | Should -Be 1
        (Get-SentRecords 'ingest/systems')[0].displayName | Should -BeExactly 'HR Portal'
        (Get-SqlSystemReport -Catalog $state.Systems).duplicateKeyCount | Should -Be 1
    }
}

Describe 'Get-SqlRouteMode' {
    It 'decides once per statement how its rows find their system' {
        $withColumn = @{ systemId = 'application' }
        $without = @{}
        # Nothing to route to: every target stays fixed, whatever it selects.
        Get-SqlRouteMode -Map $withColumn -Target 'resources' -Routing $false | Should -Be 'fixed'
        # A named column wins for every routed target.
        Get-SqlRouteMode -Map $withColumn -Target 'resources' -Routing $true | Should -Be 'column'
        Get-SqlRouteMode -Map @{ systemName = 'app' } -Target 'assignments' -Routing $true | Should -Be 'column'
        # Without one, a grant follows its resource and an edge its parent — so
        # the largest statement in the source needs no extra join.
        Get-SqlRouteMode -Map $without -Target 'assignments' -Routing $true | Should -Be 'resource'
        Get-SqlRouteMode -Map $without -Target 'relationships' -Routing $true | Should -Be 'parent'
        Get-SqlRouteMode -Map $without -Target 'resources' -Routing $true | Should -Be 'fixed'
        # Cross-system tables have no systemId column and are never routed.
        Get-SqlRouteMode -Map $withColumn -Target 'identities' -Routing $true | Should -Be 'fixed'
        Get-SqlRouteMode -Map $withColumn -Target 'identity-members' -Routing $true | Should -Be 'fixed'
        Get-SqlRouteMode -Map $withColumn -Target 'contexts' -Routing $true | Should -Be 'fixed'
    }
}

Describe 'Resolve-SqlRowSystem' {
    BeforeAll {
        function New-TestSystemCatalog {
            $c = New-SqlSystemCatalog
            $c.ByKey['APP-1'] = 11; $c.ByName['hr portal'] = 'APP-1'
            $c.ByKey['APP-2'] = 12; $c.ByName['finance'] = 'APP-2'
            $c.ByName['twins'] = 'APP-1'; [void]$c.Ambiguous.Add('twins')
            return $c
        }
        function Resolve-With {
            param([hashtable]$Cells, [hashtable]$Catalog)
            $row = New-TestRow $Cells
            $map = Resolve-SqlColumnMap -Columns @($row.Keys) -Target 'resources'
            return Resolve-SqlRowSystem -Row $row -Map $map -Catalog $Catalog -Default 7
        }
    }

    It 'resolves by key, then by folded name, and leaves a row naming neither in the default system' {
        $c = New-TestSystemCatalog
        Resolve-With @{ id = 'e'; systemId = 'APP-2' } $c | Should -Be 12
        Resolve-With @{ id = 'e'; systemName = ' FINANCE ' } $c | Should -Be 12
        Resolve-With @{ id = 'e'; systemName = '' } $c | Should -Be 7
        Resolve-With @{ id = 'e' } $c | Should -Be 7
        $c.Unknown.Count | Should -Be 0
    }

    It 'prefers the key over the name when a statement carries both' {
        # The key is the stable reference; a name drifts, and a row that carries
        # a stale name alongside a good key should still land correctly.
        Resolve-With @{ id = 'e'; systemId = 'APP-1'; systemName = 'Finance' } (New-TestSystemCatalog) | Should -Be 11
    }

    It 'answers 0 — never a guess — for an unknown key, an unknown name, or an ambiguous one, and counts each' {
        $c = New-TestSystemCatalog
        Resolve-With @{ id = 'e'; systemId = 'APP-GONE' } $c | Should -Be 0
        Resolve-With @{ id = 'e'; systemName = 'Nowhere' } $c | Should -Be 0
        Resolve-With @{ id = 'e'; systemName = 'Twins' } $c | Should -Be 0
        @($c.Unknown.Keys | Sort-Object) | Should -Be @('APP-GONE', 'Nowhere', 'Twins')
        $c.Unknown['APP-GONE'] | Should -Be 1
        Resolve-With @{ id = 'e'; systemId = 'APP-GONE' } $c | Out-Null
        $c.Unknown['APP-GONE'] | Should -Be 2
    }
}

Describe 'A row naming a system no statement created' {
    BeforeEach {
        Mock -CommandName Invoke-IngestAPI      -MockWith $script:IngestMock
        Mock -CommandName Invoke-SqlQueryStream -MockWith $script:StreamMock
        Mock -CommandName Update-CrawlerProgress -MockWith {}
        Mock -CommandName Add-SqlReadCheck       -MockWith {}
    }

    It 'keeps the row in the crawler own system, counts it, and names it in the report' {
        $state = Invoke-SqlTestRun -Slots @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources')) -Rows @{
            apps = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }))
            ents = @(
                (New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' })
                (New-TestRow @{ id = 'ENT-9'; displayName = 'Orphan'; systemId = 'APP-GONE' })
            )
        }
        # The data is kept — dropping it would lose an entitlement that exists.
        @(Get-SentRecords 'ingest/resources').externalId | Should -Contain 'ENT-9'
        ((Get-Sent 'ingest/resources') | Where-Object { $_.Body.records.externalId -contains 'ENT-9' }).Body.systemId | Should -Be 7
        # But it is counted, and the count reaches both the slot total and the report.
        $state.Totals['ents'].misrouted | Should -Be 1
        $report = Get-SqlSystemReport -Catalog $state.Systems
        $report.unknownRows | Should -Be 1
        $report.unknownSample | Should -Contain "'APP-GONE' (1)"
    }

    It 'fails the run once more than a rounding error of a statement is misrouted' {
        # Two of two rows, which is the case where the systems statement and this
        # one plainly disagree about which connectors exist.
        (Get-SqlReadVerdict -Read @{ Read = [long]100; Source = [long]100; Unplaced = [long]0; Misrouted = [long]6 }).ok | Should -BeFalse
        (Get-SqlReadVerdict -Read @{ Read = [long]100; Source = [long]100; Unplaced = [long]0; Misrouted = [long]5 }).ok | Should -BeTrue
        (Get-SqlReadVerdict -Read @{ Read = [long]100; Source = [long]100; Unplaced = [long]0; Misrouted = [long]6 }).reason |
            Should -BeLike "*name a system no 'systems' statement created*"
    }
}

Describe 'Per-system reconcile' {
    BeforeEach {
        Mock -CommandName Invoke-IngestAPI      -MockWith $script:IngestMock
        Mock -CommandName Invoke-SqlQueryStream -MockWith $script:StreamMock
        Mock -CommandName Update-CrawlerProgress -MockWith {}
        Mock -CommandName Add-SqlReadCheck       -MockWith {}
    }

    It 'reconciles each scope once per system it wrote to, and never a system it did not' {
        $state = Invoke-SqlTestRun -Slots @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources')) -Rows @{
            # APP-2 is registered but nothing lands in it this run.
            apps = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }), (New-TestRow @{ id = 'APP-2'; displayName = 'Finance' }))
            ents = @((New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' }))
        }
        Invoke-SqlReconcile -State $state | Out-Null
        $calls = @(Get-Sent 'ingest/reconcile' | ForEach-Object { "$($_.Body.entity)|$($_.Body.systemId)" })
        # Exactly one: the system that received a row. Reconciling system 12 would
        # empty a system this run never wrote to; skipping system 11 would leave
        # its stale rows behind for good.
        $calls | Should -Be @('resources|11')
    }

    It 'reconciles nothing at all on a delta run' {
        $state = Invoke-SqlTestRun -SyncMode 'delta' -Slots @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources')) -Rows @{
            apps = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }))
            ents = @((New-TestRow @{ id = 'ENT-1'; displayName = 'Payroll admin'; systemId = 'APP-1' }))
        }
        Invoke-SqlReconcile -State $state | Should -Be 0
        (Get-Sent 'ingest/reconcile').Count | Should -Be 0
    }
}

Describe 'One namespace per run means external ids must be unique across systems' {
    BeforeEach {
        Mock -CommandName Invoke-IngestAPI      -MockWith $script:IngestMock
        Mock -CommandName Invoke-SqlQueryStream -MockWith $script:StreamMock
        Mock -CommandName Update-CrawlerProgress -MockWith {}
        Mock -CommandName Add-SqlReadCheck       -MockWith {}
    }

    It 'fails the run when two systems claim the same entitlement id' {
        $state = Invoke-SqlTestRun -Slots @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources')) -Rows @{
            apps = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }), (New-TestRow @{ id = 'APP-2'; displayName = 'Finance' }))
            ents = @(
                (New-TestRow @{ id = 'SHARED'; displayName = 'In HR'; systemId = 'APP-1' })
                (New-TestRow @{ id = 'SHARED'; displayName = 'In Finance'; systemId = 'APP-2' })
            )
        }
        $v = Get-SqlIdCollisionVerdict -Catalog $state.Systems
        $v.ok | Should -BeFalse
        $v.reason | Should -BeLike "*'SHARED' in systems 11 and 12*"
        $v.atlas | Should -Be 1
    }

    It 'says nothing when one system uses an id twice — that is the existing per-scope check' {
        $state = Invoke-SqlTestRun -Slots @((New-Slot 'apps' 'systems'), (New-Slot 'ents' 'resources')) -Rows @{
            apps = @((New-TestRow @{ id = 'APP-1'; displayName = 'HR Portal' }))
            ents = @(
                (New-TestRow @{ id = 'SHARED'; displayName = 'One'; systemId = 'APP-1' })
                (New-TestRow @{ id = 'SHARED'; displayName = 'Two'; systemId = 'APP-1' })
            )
        }
        Get-SqlIdCollisionVerdict -Catalog $state.Systems | Should -BeNullOrEmpty
    }
}
