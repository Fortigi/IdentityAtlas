#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the Entra ID users fetch and upload
    (tools/crawlers/entra-id/EntraIDCrawler.UserDelta.ps1).

.DESCRIPTION
    #1627: a delta run never picked up a manager change. The fix primes the
    users delta token with `manager` in its select, stores it under a new key so
    a token primed before the fix is never reused, and sends a delta run's
    manager changes in their own batch. These tests pin each of those at the
    function boundary; the Graph and ingest calls are mocked.

    The records are chosen so the cases discriminate: a set manager, a cleared
    one (explicit null) and an unchanged one (no key) sit in the same batch, so
    a split that keyed on the VALUE instead of the key's presence, or that
    leaked managerId into the user batch, fails here.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerDeltaToken.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.DeltaSelect.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.DeltaScope.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.UserDelta.ps1')

    # The Graph GET lives in the PowerShell SDK; a stub is enough to mock it.
    function Invoke-FGGetRequest { param($URI) }

    function New-TestRecords {
        @(
            @{ id = 'u-set';  displayName = 'Set';  managerId = 'mgr-new' }
            @{ id = 'u-clr';  displayName = 'Clr';  managerId = $null }
            @{ id = 'u-same'; displayName = 'Same' }
        )
    }
}

Describe 'users delta-token keys' {

    It 'stores the users token under a new, manager-tracking key' {
        $script:EntraUsersDeltaEndpoint | Should -Be 'users/delta/manager'
        $script:EntraLegacyUsersDeltaEndpoint | Should -Be 'users/delta'
    }

    It 'the new key passes the API''s endpoint validation' {
        Test-CrawlerDeltaTokenEndpoint -Endpoint $script:EntraUsersDeltaEndpoint | Should -BeTrue
    }

    It 'the delta-baseline check looks for the same key the users fetch stores' {
        # Get-EntraDeltaEndpoints lists it as a literal; if the two drifted, a
        # crawler with a valid users token would be promoted to a full run forever.
        Get-EntraDeltaEndpoints -Cfg @{ SyncPrincipals = $true } | Should -Be @($script:EntraUsersDeltaEndpoint)
    }
}

Describe 'Get-EntraUserData — token key and manager tracking (#1627)' {
    BeforeEach {
        Mock Get-FGDeltaToken -MockWith { $null }
        Mock Remove-FGDeltaToken -MockWith { }
        Mock Invoke-FGGetRequest -MockWith { @([pscustomobject]@{ id = 'u1'; displayName = 'Alice' }) }
    }

    It 'reads the token from the new key only, so a pre-fix token is never reused' {
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = 'primed' } }
        Get-EntraUserData -SystemId 3 -SyncMode 'delta' -UserSelect 'id' | Out-Null
        Should -Invoke Get-FGDeltaToken -Exactly 1
        Should -Invoke Get-FGDeltaToken -Exactly 1 -ParameterFilter { $SystemId -eq 3 -and $Endpoint -eq 'users/delta/manager' }
    }

    It 'primes the token with manager in the select' {
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = 'primed' } }
        Get-EntraUserData -SystemId 3 -SyncMode 'full' -UserSelect 'id,displayName' | Out-Null
        Should -Invoke Invoke-FGGetDeltaRequest -Exactly 1 -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users/delta?$select=id,displayName,manager'
        }
    }

    It 'retires the legacy token row once a new token is primed' {
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = 'primed' } }
        Get-EntraUserData -SystemId 3 -SyncMode 'delta' -UserSelect 'id' | Out-Null
        Should -Invoke Remove-FGDeltaToken -Exactly 1
        Should -Invoke Remove-FGDeltaToken -Exactly 1 -ParameterFilter { $SystemId -eq 3 -and $Endpoint -eq 'users/delta' }
    }

    It 'keeps the legacy row when priming returned no token' {
        # Without a new token the next run has nothing to build on, so deleting
        # the old row then would gain nothing.
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = $null } }
        Get-EntraUserData -SystemId 3 -SyncMode 'delta' -UserSelect 'id' | Out-Null
        Should -Invoke Remove-FGDeltaToken -Exactly 0
    }

    It 'a full run clears the new key, then retires the legacy one' {
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = 'primed' } }
        Get-EntraUserData -SystemId 3 -SyncMode 'full' -UserSelect 'id' | Out-Null
        Should -Invoke Remove-FGDeltaToken -Exactly 2
        Should -Invoke Remove-FGDeltaToken -Exactly 1 -ParameterFilter { $Endpoint -eq 'users/delta/manager' }
        Should -Invoke Remove-FGDeltaToken -Exactly 1 -ParameterFilter { $Endpoint -eq 'users/delta' }
    }

    It 'a delta hit leaves both rows alone' {
        Mock Get-FGDeltaToken -MockWith { 'stored' }
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @([pscustomobject]@{ id = 'u1' }); deltaToken = 'next' } }
        $data = Get-EntraUserData -SystemId 3 -SyncMode 'delta' -UserSelect 'id'
        $data.deltaHit | Should -BeTrue
        $data.newUsersToken | Should -Be 'next'
        Should -Invoke Remove-FGDeltaToken -Exactly 0
        Should -Invoke Invoke-FGGetRequest -Exactly 0
    }

    It 'a failed delta fetch falls back to a full fetch without clearing the token' {
        Mock Get-FGDeltaToken -MockWith { 'stored' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'deltatoken=' } -MockWith { throw 'network down' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'select=' } -MockWith { @{ value = @(); deltaToken = 'primed' } }
        $data = Get-EntraUserData -SystemId 3 -SyncMode 'delta' -UserSelect 'id'
        $data.deltaHit | Should -BeFalse
        @($data.users).Count | Should -Be 1
        Should -Invoke Remove-FGDeltaToken -Exactly 0 -ParameterFilter { $Endpoint -eq 'users/delta/manager' }
    }

    It 'a failed priming call still returns the fetched users, with no token' {
        Mock Invoke-FGGetDeltaRequest -MockWith { throw 'prime failed' }
        $data = Get-EntraUserData -SystemId 3 -SyncMode 'full' -UserSelect 'id'
        @($data.users).id | Should -Be @('u1')
        $data.newUsersToken | Should -BeNullOrEmpty
        Should -Invoke Remove-FGDeltaToken -Exactly 0 -ParameterFilter { $Endpoint -eq 'users/delta' }
    }
}

Describe 'Split-EntraDeltaManagerRecords' {

    It 'moves every record that carries managerId — a null included — into the manager batch' {
        $split = Split-EntraDeltaManagerRecords -Records (New-TestRecords)
        @($split.managerRecords).Count | Should -Be 2
        $split.managerRecords[0]['id'] | Should -Be 'u-set'
        $split.managerRecords[0]['managerId'] | Should -Be 'mgr-new'
        $split.managerRecords[1]['id'] | Should -Be 'u-clr'
        $split.managerRecords[1].ContainsKey('managerId') | Should -BeTrue
        $split.managerRecords[1]['managerId'] | Should -Be $null
    }

    It 'the manager batch carries only id and managerId' {
        # Anything more would be written twice, and a displayName sent here
        # would land in a session with full-sync semantics.
        $split = Split-EntraDeltaManagerRecords -Records (New-TestRecords)
        @($split.managerRecords[0].Keys | Sort-Object) | Should -Be @('id', 'managerId')
    }

    It 'keeps every user in the user batch, in order, with managerId removed' {
        $split = Split-EntraDeltaManagerRecords -Records (New-TestRecords)
        @($split.records).id | Should -Be @('u-set', 'u-clr', 'u-same')
        @($split.records | Where-Object { $_.ContainsKey('managerId') }).Count | Should -Be 0
        $split.records[0]['displayName'] | Should -Be 'Set'
    }

    It 'does not modify the records it was given' {
        $records = New-TestRecords
        Split-EntraDeltaManagerRecords -Records $records | Out-Null
        $records[0]['managerId'] | Should -Be 'mgr-new'
        $records[1].ContainsKey('managerId') | Should -BeTrue
    }

    It 'returns two empty batches for no records' {
        $split = Split-EntraDeltaManagerRecords -Records @()
        @($split.records).Count | Should -Be 0
        @($split.managerRecords).Count | Should -Be 0
    }
}

Describe 'Send-EntraUserRecords' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Send-IngestBatch -MockWith {
            $script:sent.Add([pscustomobject]@{
                Endpoint = $Endpoint; SystemId = $SystemId; SyncMode = $SyncMode
                Scope = $Scope; Records = @($Records); DeletedIds = @($DeletedIds | Where-Object { $_ })
            })
        }
    }

    It 'a full run sends one authoritative batch, managerId and tombstones included' {
        Send-EntraUserRecords -SystemId 7 -Records (New-TestRecords) -DeltaHit $false -DeletedIds @('gone')
        $script:sent.Count | Should -Be 1
        $script:sent[0].SyncMode | Should -Be 'full'
        $script:sent[0].SystemId | Should -Be 7
        $script:sent[0].Scope.principalType | Should -Be 'User'
        @($script:sent[0].Records).Count | Should -Be 3
        $script:sent[0].Records[0]['managerId'] | Should -Be 'mgr-new'
        $script:sent[0].DeletedIds | Should -Be @('gone')
    }

    It 'a delta run sends the users with the tombstones, then the manager changes' {
        Send-EntraUserRecords -SystemId 7 -Records (New-TestRecords) -DeltaHit $true -DeletedIds @('gone')
        $script:sent.Count | Should -Be 2
        $script:sent[0].SyncMode | Should -Be 'delta'
        $script:sent[0].Endpoint | Should -Be 'ingest/principals'
        @($script:sent[0].Records).id | Should -Be @('u-set', 'u-clr', 'u-same')
        $script:sent[0].DeletedIds | Should -Be @('gone')
        $script:sent[1].SyncMode | Should -Be 'delta'
        $script:sent[1].Endpoint | Should -Be 'ingest/principals'
        $script:sent[1].SystemId | Should -Be 7
        @($script:sent[1].Records).id | Should -Be @('u-set', 'u-clr')
        # Tombstones go once, with the users, never again with the managers.
        @($script:sent[1].DeletedIds).Count | Should -Be 0
    }

    It 'a delta run with no manager change sends no manager batch' {
        Send-EntraUserRecords -SystemId 7 -Records @(@{ id = 'u-same'; displayName = 'Same' }) -DeltaHit $true
        $script:sent.Count | Should -Be 1
    }
}
