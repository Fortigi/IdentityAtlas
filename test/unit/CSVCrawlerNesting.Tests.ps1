#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the CSV crawler's nested-access expansion
    (CSVCrawler.Nesting.ps1).

.DESCRIPTION
    The graph build, the holder collection and the expansion are pure functions
    over in-memory records, so they are tested directly; the phase is tested
    with only the HTTP boundary (Invoke-IngestAPI / Get-CrawlerServerTime /
    Invoke-CrawlerReconcile) mocked, so the real streams and the real reconcile
    scope are exercised.

    Inputs are chosen to DISCRIMINATE, per
    docs/contributing/writing-tests-that-assert.md — each case below fails for a
    different defect rather than re-proving the same happy path:

      * the depth-3 chain fails an expansion that walks the edges the WRONG WAY
        (Parents[parent] += child), which a single hop cannot tell apart, and
        one that stops after the first hop;
      * the diamond fails an expansion that emits a row per path instead of per
        user;
      * the cycle fails one without the walk's visited set (it hangs) AND one
        that lets an inherited row shadow a direct one;
      * Contains + Eligible fixtures fail an expansion that treats every stored
        relationship, or every stored assignment, as nesting;
      * the two-system fixture fails one that stamps the fallback system on
        every computed row.

.USAGE
    Invoke-Pester -Path test/unit/CSVCrawlerNesting.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:csvDir   = Join-Path $script:repoRoot 'tools/crawlers/csv'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngestStream.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Functions.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Transform.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Phases.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Nesting.ps1')

    # Scope state the nesting phase resolves at call time.
    $script:SystemType       = 'CSV'
    $script:fallbackSystemId = 2
    $script:JobId            = 0

    # One shaped ResourceRelationships.csv record, as ConvertTo-CsvRelationshipRecord emits it.
    function New-Rel {
        param([string]$Parent, [string]$Child, [string]$Type = 'GrantsAccessTo', [int]$SystemId = 2)
        @{ _systemId = $SystemId; parentExternalId = $Parent; childExternalId = $Child; relationshipType = $Type }
    }
    # One shaped Assignments.csv record, as ConvertTo-CsvAssignmentRecordSet emits it (no _systemId).
    function New-Assign {
        param([string]$Resource, [string]$User, [string]$Type = 'Direct')
        @{ resourceExternalId = $Resource; principalExternalId = $User; assignmentType = $Type }
    }
    # A graph loaded with edges and Direct holders in one call, as a run builds it.
    function New-Fixture {
        param($Edges, $Assignments, [int]$SystemId = 2)
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records $Edges
        Add-CsvNestingHolders -Graph $g -SystemId $SystemId -Records $Assignments
        return $g
    }
    # The computed rows as "<resource>/<principal>" strings, sorted — so an
    # assertion names the pairs it expects rather than counting them. Unrolled
    # deliberately: the caller compares it with Should -Be.
    function Get-Pairs {
        param($Records)
        @($Records) | ForEach-Object { "$($_.resourceExternalId)/$($_.principalExternalId)" } | Sort-Object
    }
}

Describe 'Add-CsvNestingEdges' {

    It 'records a GrantsAccessTo edge reversed, as "the resources that grant this one"' {
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records @((New-Rel 'A' 'B'))
        @($g.Parents.Keys) | Should -Be @('B')
        @($g.Parents['B']) | Should -Be @('A')
        @($g.Nodes | Sort-Object) | Should -Be @('A', 'B')
    }

    It 'ignores Contains — a business role''s resource grants are not nesting' {
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records @((New-Rel 'BR1' 'G1' 'Contains'))
        $g.Parents.Count | Should -Be 0
        $g.Nodes.Count   | Should -Be 0
    }

    It 'keeps every parent of a resource granted by two different ones' {
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records @((New-Rel 'A' 'C'), (New-Rel 'B' 'C'))
        @($g.Parents['C'] | Sort-Object) | Should -Be @('A', 'B')
    }

    It 'drops a self-loop and a row missing either end' {
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records @((New-Rel 'A' 'A'), (New-Rel 'A' ''), (New-Rel '' 'B'))
        $g.Parents.Count | Should -Be 0
    }

    It 'stamps the granting edge''s system on the resource it grants (D7)' {
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records @((New-Rel 'A' 'B' 'GrantsAccessTo' 7))
        $g.Granted['B'] | Should -Be 7
    }

    It 'treats two externalIds differing only in case as two resources' {
        # PowerShell's own hashtables would merge these; the ingest does not.
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records @((New-Rel 'a' 'B'), (New-Rel 'A' 'b'))
        $g.Parents.Count | Should -Be 2
        @($g.Nodes | Sort-Object) | Should -Be @('a', 'A', 'b', 'B')
    }

    It 'does nothing at all without a graph (no run in progress)' {
        { Add-CsvNestingEdges -Graph $null -Records @((New-Rel 'A' 'B')) } | Should -Not -Throw
    }
}

Describe 'Add-CsvNestingHolders' {

    It 'collects the Direct holders of a node and nothing else' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @(
            (New-Assign 'A' 'u1'),
            (New-Assign 'A' 'u2'),
            (New-Assign 'unrelated' 'u3')
        )
        @($g.Holders.Keys) | Should -Be @('A')
        @($g.Holders['A'] | Sort-Object) | Should -Be @('u1', 'u2')
    }

    It 'ignores an Eligible holder — eligibility is not active access' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @((New-Assign 'A' 'u2' 'Eligible'))
        $g.Holders.Count | Should -Be 0
    }

    It 'ignores a supplied Indirect holder, so one does not seed another hop' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @((New-Assign 'A' 'u3' 'Indirect'))
        $g.Holders.Count | Should -Be 0
    }

    It 'records the system a batch fed even when the file has no nesting at all' {
        # The Indirect reconcile needs this: it is what clears rows inherited
        # through nesting that has since been removed from the file.
        $g = New-Fixture -Edges @() -Assignments @((New-Assign 'X' 'u1')) -SystemId 5
        $g.Holders.Count | Should -Be 0
        @($g.Systems) | Should -Be @(5)
    }

    It 'collects across batches and systems without duplicating a holder' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @((New-Assign 'A' 'u1'))
        Add-CsvNestingHolders -Graph $g -SystemId 9 -Records @((New-Assign 'A' 'u1'), (New-Assign 'A' 'u4'))
        @($g.Holders['A'] | Sort-Object) | Should -Be @('u1', 'u4')
        @($g.Systems | Sort-Object)      | Should -Be @(2, 9)
    }
}

Describe 'Get-CsvNestingAssignments' {

    It 'gives a resource the holders of the resource that grants it (AC 1)' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @((New-Assign 'A' 'u1'))
        $rows = Get-CsvNestingAssignments -Graph $g
        Get-Pairs $rows | Should -Be @('B/u1')
        $rows[0].assignmentType | Should -Be 'Indirect'
    }

    It 'reaches the far end of a three-deep chain, not just the first hop (AC 2)' {
        # A→B→C: u1 is Direct on A only. An expansion that walked the edges the
        # other way round would return nothing here; one that stopped after a
        # single hop would return B and miss C.
        $g = New-Fixture -Edges @((New-Rel 'A' 'B'), (New-Rel 'B' 'C')) -Assignments @((New-Assign 'A' 'u1'))
        Get-Pairs (Get-CsvNestingAssignments -Graph $g) | Should -Be @('B/u1', 'C/u1')
    }

    It 'terminates on a cycle and leaves the direct row the stronger one (AC 3)' {
        # A ∈ B ∈ A. Without the walk's visited set this hangs rather than fails.
        $g = New-Fixture -Edges @((New-Rel 'A' 'B'), (New-Rel 'B' 'A')) -Assignments @((New-Assign 'A' 'u1'))
        Get-Pairs (Get-CsvNestingAssignments -Graph $g) | Should -Be @('B/u1')
    }

    It 'emits one row per gained resource across a diamond, not one per path (AC 4)' {
        # A→B, A→C, B→D, C→D: u1 reaches D by two paths.
        $g = New-Fixture -Edges @(
            (New-Rel 'A' 'B'), (New-Rel 'A' 'C'), (New-Rel 'B' 'D'), (New-Rel 'C' 'D')
        ) -Assignments @((New-Assign 'A' 'u1'))
        Get-Pairs (Get-CsvNestingAssignments -Graph $g) | Should -Be @('B/u1', 'C/u1', 'D/u1')
    }

    It 'says nothing about a user who already holds the resource directly (AC 5)' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @(
            (New-Assign 'A' 'u1'), (New-Assign 'B' 'u1'), (New-Assign 'A' 'u2')
        )
        Get-Pairs (Get-CsvNestingAssignments -Graph $g) | Should -Be @('B/u2')
    }

    It 'expands nothing from a Contains relationship (AC 6)' {
        $g = New-Fixture -Edges @((New-Rel 'BR1' 'G1' 'Contains')) -Assignments @((New-Assign 'BR1' 'u1'))
        $rows = Get-CsvNestingAssignments -Graph $g
        $rows.Count | Should -Be 0
    }

    It 'does not propagate an Eligible holder (AC 9)' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @(
            (New-Assign 'A' 'u2' 'Eligible'), (New-Assign 'A' 'u1')
        )
        Get-Pairs (Get-CsvNestingAssignments -Graph $g) | Should -Be @('B/u1')
    }

    It 'expands nothing when the nesting involves no holders at all' {
        $g = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @((New-Assign 'other' 'u1'))
        $rows = Get-CsvNestingAssignments -Graph $g
        $rows.Count | Should -Be 0
    }

    It 'expands any resource type, not only groups' {
        $g = New-Fixture -Edges @((New-Rel 'SAP-SINGLE' 'SAP-COMPOSITE')) -Assignments @((New-Assign 'SAP-SINGLE' 'u1'))
        Get-Pairs (Get-CsvNestingAssignments -Graph $g) | Should -Be @('SAP-COMPOSITE/u1')
    }

    It 'stamps each row with the system of the edge that granted its resource (D7)' {
        $g = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $g -Records @((New-Rel 'A' 'B' 'GrantsAccessTo' 7), (New-Rel 'A' 'C' 'GrantsAccessTo' 8))
        Add-CsvNestingHolders -Graph $g -SystemId 7 -Records @((New-Assign 'A' 'u1'))
        $rows = Get-CsvNestingAssignments -Graph $g
        $rows.Count | Should -Be 2
        @($rows | Where-Object { $_.resourceExternalId -eq 'B' })[0]._systemId | Should -Be 7
        @($rows | Where-Object { $_.resourceExternalId -eq 'C' })[0]._systemId | Should -Be 8
    }

    It 'returns an empty, enumerable result for an empty graph (AC 10)' {
        $rows = Get-CsvNestingAssignments -Graph (New-CsvNestingGraph)
        @($rows).Count | Should -Be 0
    }
}

Describe 'Sync-CsvNestedAccess' {
    BeforeEach {
        $script:posted = [System.Collections.Generic.List[object]]::new()
        $script:reconciled = [System.Collections.Generic.List[object]]::new()
        Mock Update-CrawlerProgress { }
        Mock Get-CrawlerServerTime { '2026-11-24T10:00:00.0000000Z' }
        Mock Invoke-IngestAPI {
            $script:posted.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body })
            @{ inserted = @($Body.records).Count; updated = 0 }
        }
        Mock Invoke-CrawlerReconcile {
            $script:reconciled.Add([pscustomobject]@{ Endpoint = $Endpoint; SystemId = $SystemId; Scope = $Scope; Before = $Before })
            0
        }
    }

    It 'streams the inherited rows as Indirect and reconciles that scope afterwards' {
        $script:CsvNesting = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @((New-Assign 'A' 'u1'))
        Sync-CsvNestedAccess

        $script:posted.Count | Should -Be 1
        $script:posted[0].Endpoint          | Should -Be 'ingest/resource-assignments'
        $script:posted[0].Body.systemId     | Should -Be 2
        $script:posted[0].Body.syncMode     | Should -Be 'delta'
        $script:posted[0].Body.scope.assignmentType | Should -Be 'Indirect'
        $script:posted[0].Body.idPrefix     | Should -Be 'CSV-resource-assignments'
        @($script:posted[0].Body.records).Count | Should -Be 1
        $rec = @($script:posted[0].Body.records)[0]
        $rec.resourceExternalId  | Should -Be 'B'
        $rec.principalExternalId | Should -Be 'u1'
        $rec.assignmentType      | Should -Be 'Indirect'
        # _systemId is the envelope's job — sent on the record it would be stored
        # as an extended attribute.
        $rec.ContainsKey('_systemId') | Should -BeFalse

        $script:reconciled.Count | Should -Be 1
        $script:reconciled[0].Endpoint | Should -Be 'ingest/resource-assignments'
        $script:reconciled[0].SystemId | Should -Be 2
        $script:reconciled[0].Scope.assignmentType | Should -Be 'Indirect'
        # Read AFTER step 6, so a user-supplied Indirect row written there is
        # newer than the bound and survives (AC 8).
        $script:reconciled[0].Before | Should -Be '2026-11-24T10:00:00.0000000Z'
    }

    It 'still reconciles when the nesting is gone, so inherited rows do not linger (AC 7)' {
        $script:CsvNesting = New-Fixture -Edges @() -Assignments @((New-Assign 'A' 'u1'))
        Sync-CsvNestedAccess
        $script:posted.Count | Should -Be 0
        $script:reconciled.Count | Should -Be 1
        $script:reconciled[0].SystemId | Should -Be 2
        $script:reconciled[0].Scope.assignmentType | Should -Be 'Indirect'
    }

    It 'reconciles a system named only by an edge as well as the ones assignments fed' {
        $script:CsvNesting = New-CsvNestingGraph
        Add-CsvNestingEdges -Graph $script:CsvNesting -Records @((New-Rel 'A' 'B' 'GrantsAccessTo' 7))
        Add-CsvNestingHolders -Graph $script:CsvNesting -SystemId 2 -Records @((New-Assign 'A' 'u1'))
        Sync-CsvNestedAccess
        @($script:posted).Count | Should -Be 1
        $script:posted[0].Body.systemId | Should -Be 7
        @($script:reconciled.SystemId | Sort-Object) | Should -Be @(2, 7)
    }

    It 'does nothing when the assignments run fed no system — a run that read nothing never deletes' {
        $script:CsvNesting = New-Fixture -Edges @((New-Rel 'A' 'B')) -Assignments @()
        $script:CsvNesting.Systems.Clear()
        Sync-CsvNestedAccess
        $script:posted.Count     | Should -Be 0
        $script:reconciled.Count | Should -Be 0
        Should -Invoke Get-CrawlerServerTime -Exactly 0
    }

    It 'does nothing when no run is in progress' {
        $script:CsvNesting = $null
        { Sync-CsvNestedAccess } | Should -Not -Throw
        $script:reconciled.Count | Should -Be 0
    }
}
