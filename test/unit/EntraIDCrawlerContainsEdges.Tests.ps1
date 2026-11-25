#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for EntraIDCrawler.ContainsEdges.ps1 (#1335): the group-nesting
    transform and the one merged 'Contains' batch per run.

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerContainsEdges.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id' 'EntraIDCrawler.ContainsEdges.ps1')

    # Boundaries the sender calls; stubbed here, mocked per test.
    function Send-IngestBatch { param($Endpoint, $SystemId, $SyncMode, $Scope, $Records) }
    function Update-CrawlerProgress { param($Step, $Pct, $Detail) }

    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; SystemId = $SystemId; SyncMode = $SyncMode; Scope = $Scope; Records = @($Records) })
    }
    function Edge([string]$Parent, [string]$Child) {
        @{ parentResourceId = $Parent; childResourceId = $Child; relationshipType = 'Contains' }
    }
}

Describe 'ConvertTo-EntraGroupNestingRelationships' {
    It 'maps only group-typed members to parent Contains child, dropping self-links and duplicates' {
        $members = @(
            @{ resourceId = 'g1'; principalId = 'u1'; principalType = 'User' }
            @{ resourceId = 'g1'; principalId = 'g2'; principalType = 'Group' }
            @{ resourceId = 'g1'; principalId = 'g2'; principalType = 'Group' }   # duplicate
            @{ resourceId = 'g3'; principalId = 'g3'; principalType = 'Group' }   # self-link
            @{ resourceId = 'g3'; principalId = 'g1'; principalType = 'Group' }
        )
        $out = @(ConvertTo-EntraGroupNestingRelationships -DirectMembers $members)

        $out.Count | Should -Be 2
        $out[0].parentResourceId | Should -Be 'g1'
        $out[0].childResourceId | Should -Be 'g2'
        $out[0].relationshipType | Should -Be 'Contains'
        $out[1].parentResourceId | Should -Be 'g3'
        $out[1].childResourceId | Should -Be 'g1'
    }

    It 'returns an empty set for a tenant without nesting' {
        @(ConvertTo-EntraGroupNestingRelationships -DirectMembers @()).Count | Should -Be 0
        @(ConvertTo-EntraGroupNestingRelationships -DirectMembers @(@{ resourceId = 'g1'; principalId = 'u1'; principalType = 'User' })).Count | Should -Be 0
    }
}

Describe 'Get-EntraContainsSyncMode' {
    It 'is <expected> when nesting=<nest> (enabled <nestOn>) and access packages=<ap> (enabled <apOn>)' -ForEach @(
        # Both enabled and both collected: the union is the whole truth.
        @{ nest = 'collected'; nestOn = $true;  ap = 'collected'; apOn = $true;  expected = 'full' }
        # An enabled source missing (delta run / failed fetch): keep its rows.
        @{ nest = 'missing';   nestOn = $true;  ap = 'collected'; apOn = $true;  expected = 'delta' }
        @{ nest = 'collected'; nestOn = $true;  ap = 'missing';   apOn = $true;  expected = 'delta' }
        # A disabled source has nothing to keep.
        @{ nest = 'collected'; nestOn = $true;  ap = 'missing';   apOn = $false; expected = 'full' }
        @{ nest = 'missing';   nestOn = $false; ap = 'collected'; apOn = $true;  expected = 'full' }
        # Nothing collected: send nothing at all.
        @{ nest = 'missing';   nestOn = $true;  ap = 'missing';   apOn = $true;  expected = 'none' }
        @{ nest = 'missing';   nestOn = $false; ap = 'missing';   apOn = $false; expected = 'none' }
        # An EMPTY collected set still counts as collected.
        @{ nest = 'empty';     nestOn = $true;  ap = 'missing';   apOn = $false; expected = 'full' }
    ) {
        $value = @{ collected = @(Edge 'a' 'b'); empty = @(); missing = $null }
        $collected = @{ nesting = $value[$nest]; accessPackages = $value[$ap] }
        Get-EntraContainsSyncMode -Collected $collected -NestingEnabled $nestOn -GovernanceEnabled $apOn | Should -Be $expected
    }
}

Describe 'Send-EntraContainsRelationships' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Reset-EntraContainsEdges
        Mock Send-IngestBatch -MockWith $script:SendMock
    }

    It 'full-syncs the union of both sources in one Contains-scoped batch' {
        Add-EntraContainsEdges -Source 'nesting' -Records @(Edge 'g1' 'g2')
        Add-EntraContainsEdges -Source 'accessPackages' -Records @(Edge 'ap1' 'g1')

        Send-EntraContainsRelationships -SystemId 7 -NestingEnabled $true -GovernanceEnabled $true

        $script:sent.Count | Should -Be 1
        $script:sent[0].Endpoint | Should -Be 'ingest/resource-relationships'
        $script:sent[0].SystemId | Should -Be 7
        $script:sent[0].SyncMode | Should -Be 'full'
        $script:sent[0].Scope.relationshipType | Should -Be 'Contains'
        @($script:sent[0].Records | ForEach-Object { "$($_.parentResourceId)>$($_.childResourceId)" }) | Sort-Object |
            Should -Be @('ap1>g1', 'g1>g2')
    }

    It 'upserts as a delta, without a reconcile scope, when an enabled source was not collected' {
        Add-EntraContainsEdges -Source 'accessPackages' -Records @(Edge 'ap1' 'g1')

        Send-EntraContainsRelationships -SystemId 7 -NestingEnabled $true -GovernanceEnabled $true

        $script:sent.Count | Should -Be 1
        $script:sent[0].SyncMode | Should -Be 'delta'
        $script:sent[0].Scope | Should -BeNullOrEmpty
        $script:sent[0].Records.Count | Should -Be 1
    }

    It 'full-syncs an empty batch when the collected sources hold no edges (reconcile clears stale rows)' {
        Add-EntraContainsEdges -Source 'nesting' -Records @()

        Send-EntraContainsRelationships -SystemId 7 -NestingEnabled $true -GovernanceEnabled $false

        $script:sent.Count | Should -Be 1
        $script:sent[0].SyncMode | Should -Be 'full'
        $script:sent[0].Records.Count | Should -Be 0
    }

    It 'sends nothing when nothing was collected' {
        Send-EntraContainsRelationships -SystemId 7 -NestingEnabled $true -GovernanceEnabled $true
        $script:sent.Count | Should -Be 0
    }

    It 'clears the collected edges, so a second send in the same session sends nothing' {
        Add-EntraContainsEdges -Source 'nesting' -Records @(Edge 'g1' 'g2')
        Send-EntraContainsRelationships -SystemId 7 -NestingEnabled $true
        Send-EntraContainsRelationships -SystemId 7 -NestingEnabled $true

        $script:sent.Count | Should -Be 1
        $null -eq $script:entraContainsEdges.nesting | Should -BeTrue
    }

    It 'records a null result as an empty, collected set (no null rows reach ingest)' {
        Add-EntraContainsEdges -Source 'accessPackages' -Records $null
        Add-EntraContainsEdges -Source 'nesting' -Records @($null, (Edge 'g1' 'g2'))

        $null -eq $script:entraContainsEdges.accessPackages | Should -BeFalse
        @($script:entraContainsEdges.accessPackages).Count | Should -Be 0
        $script:entraContainsEdges.nesting.Count | Should -Be 1
    }

    It 'works before any reset (state initialised on demand)' {
        $script:entraContainsEdges = $null
        Add-EntraContainsEdges -Source 'nesting' -Records @(Edge 'g1' 'g2')
        $script:entraContainsEdges.nesting.Count | Should -Be 1

        $script:entraContainsEdges = $null
        Send-EntraContainsRelationships -SystemId 7 -NestingEnabled $true
        $script:sent.Count | Should -Be 0
    }
}
