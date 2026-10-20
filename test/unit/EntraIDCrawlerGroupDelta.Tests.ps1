#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for EntraIDCrawler.GroupDelta.ps1 — groups, memberships
    and owners read through Graph /groups/delta.

.DESCRIPTION
    The Graph boundary (Invoke-FGGetDeltaRequest / Invoke-FGGetRequest), the
    delta-token store and the ingest boundary (Send-IngestBatch /
    Send-CrawlerIngestDeletedKeys) are mocked. The record shapers
    (ConvertTo-EntraGroupResourceRecord, ConvertTo-EntraGroupOwnership,
    New-OwnershipResourceId) run for real.

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerGroupDelta.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerDeltaToken.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.Transform.ps1')
    # Sync-EntraResources / Sync-EntraAssignments — mocked in the dispatcher tests.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Phases.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.GroupDelta.ps1')

    # Graph SDK helpers with their own tests — stubbed (and mocked per test).
    function Add-FGEntraCalculatedAttributes { param($Object, $Ext, $Type) }
    function Invoke-FGGetRequest { param($URI) }

    function Reset-GroupDeltaTestState {
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:phases      = [System.Collections.Generic.List[object]]::new()
        $script:sent        = [System.Collections.Generic.List[object]]::new()
        $script:keyDeletes  = [System.Collections.Generic.List[object]]::new()
    }

    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; SyncMode = $SyncMode; Records = @($Records); DeletedIds = @($DeletedIds) })
    }
    $script:KeyDeleteMock = {
        $script:keyDeletes.Add([pscustomobject]@{ Endpoint = $Endpoint; SystemId = $SystemId; Keys = @($Keys) })
        return @($Keys).Count
    }

    $script:G1 = 'aaaaaaaa-0000-0000-0000-000000000001'
    $script:G2 = 'aaaaaaaa-0000-0000-0000-000000000002'
    $script:U1 = 'bbbbbbbb-0000-0000-0000-000000000001'
    $script:U2 = 'bbbbbbbb-0000-0000-0000-000000000002'
}

Describe 'Group delta configuration' {
    It 'keys the token on the query shape' {
        Get-EntraGroupDeltaEndpoint -IncludeMembers $true | Should -Be 'groups/delta/members-owners'
        Get-EntraGroupDeltaEndpoint -IncludeMembers $false | Should -Be 'groups/delta'
    }

    It 'primes with $deltatoken=latest, selecting members and owners only when memberships are read' {
        $withMembers = Get-EntraGroupDeltaPrimeUri -IncludeMembers $true
        $withMembers | Should -BeLike 'https://graph.microsoft.com/beta/groups/delta?$select=id,displayName,*,members,owners&$deltatoken=latest'
        Get-EntraGroupDeltaPrimeUri -IncludeMembers $false | Should -Not -Match ',(members|owners)(,|&)'
    }

    It 'builds the full-fetch select from the core attributes plus custom ones, without duplicates' {
        $select = Get-EntraGroupSelect -CustomGroupAttributes @('extensionAttribute1', 'mail')
        $select | Should -BeLike 'id,displayName,*,resourceProvisioningOptions,extensionAttribute1'
        @($select -split ',' | Where-Object { $_ -eq 'mail' }).Count | Should -Be 1
    }
}

Describe 'ConvertFrom-EntraGroupDeltaItems' {
    It 'records a removed group and ignores the rest of its entry' {
        $items = @([pscustomobject]@{ id = $G1; '@removed' = @{ reason = 'deleted' }; 'members@delta' = @(@{ id = $U1 }) })
        $c = ConvertFrom-EntraGroupDeltaItems -Items $items

        $c.removedGroupIds | Should -Be @($G1)
        $c.refetchIds.Count | Should -Be 0
        $c.memberChanges.Count | Should -Be 0
    }

    It 'does not re-fetch a group whose only change is its membership' {
        $items = @([pscustomobject]@{
            id = $G1; '@odata.type' = '#microsoft.graph.group'
            'members@delta' = @(
                @{ id = $U1; '@odata.type' = '#microsoft.graph.user' }
                @{ id = $U2; '@odata.type' = '#microsoft.graph.user'; '@removed' = @{ reason = 'deleted' } }
            )
        })
        $c = ConvertFrom-EntraGroupDeltaItems -Items $items

        $c.refetchIds.Count | Should -Be 0
        $c.memberChanges.Count | Should -Be 2
        ($c.memberChanges | Where-Object { $_.principalId -eq $U1 }).removed | Should -BeFalse
        ($c.memberChanges | Where-Object { $_.principalId -eq $U2 }).removed | Should -BeTrue
    }

    It 're-fetches a group with a property change once, even when it spans two pages' {
        $items = @(
            [pscustomobject]@{ id = $G1; displayName = 'Renamed'; 'members@delta' = @(@{ id = $U1 }) }
            [pscustomobject]@{ id = $G1; 'members@delta' = @(@{ id = $U2 }) }
        )
        $c = ConvertFrom-EntraGroupDeltaItems -Items $items

        $c.refetchIds | Should -Be @($G1)
        @($c.memberChanges.principalId) | Should -Be @($U1, $U2)
    }

    It 'keeps the last word for a member that was added and then removed' {
        $items = @(
            [pscustomobject]@{ id = $G1; 'members@delta' = @(@{ id = $U1 }) }
            [pscustomobject]@{ id = $G1; 'members@delta' = @(@{ id = $U1; '@removed' = @{ reason = 'deleted' } }) }
        )
        $c = ConvertFrom-EntraGroupDeltaItems -Items $items

        $c.memberChanges.Count | Should -Be 1
        $c.memberChanges[0].removed | Should -BeTrue
    }

    It 're-fetches a group whose owners changed, so its ownership resource gets the real name' {
        $items = @([pscustomobject]@{ id = $G2; 'owners@delta' = @(@{ id = $U1 }) })
        $c = ConvertFrom-EntraGroupDeltaItems -Items $items

        $c.refetchIds | Should -Be @($G2)
        $c.ownerChanges[0].groupId | Should -Be $G2
        $c.ownerChanges[0].principalId | Should -Be $U1
    }

    It 'ignores membership and owner entries when memberships are not read' {
        $items = @([pscustomobject]@{ id = $G1; 'owners@delta' = @(@{ id = $U1 }); 'members@delta' = @(@{ id = $U2 }) })
        $c = ConvertFrom-EntraGroupDeltaItems -Items $items -IncludeMembers $false

        $c.refetchIds.Count | Should -Be 0
        $c.memberChanges.Count | Should -Be 0
        $c.ownerChanges.Count | Should -Be 0
    }

    It 'skips empty items and entries without an id' {
        $items = @($null, [pscustomobject]@{ displayName = 'no id' }, [pscustomobject]@{ id = $G1; 'members@delta' = @($null, @{ '@odata.type' = 'x' }) })
        $c = ConvertFrom-EntraGroupDeltaItems -Items $items

        $c.refetchIds.Count | Should -Be 0
        $c.memberChanges.Count | Should -Be 0
    }
}

Describe 'ConvertTo-EntraGroupDeltaIngest' {
    BeforeAll {
        $script:changes = @{
            removedGroupIds = @($G2)
            refetchIds      = @($G1)
            memberChanges   = @(
                @{ groupId = $G1; principalId = $U1; childType = '#microsoft.graph.user'; removed = $false }
                @{ groupId = $G1; principalId = $G2; childType = '#microsoft.graph.group'; removed = $false }
                @{ groupId = $G1; principalId = $U2; childType = '#microsoft.graph.user'; removed = $true }
            )
            ownerChanges    = @(
                @{ groupId = $G1; principalId = $U1; removed = $false }
                @{ groupId = 'unknown-group'; principalId = $U1; removed = $false }
                @{ groupId = $G1; principalId = $U2; removed = $true }
            )
        }
        $script:groupsById = @{
            $G1 = [pscustomobject]@{ id = $G1; displayName = 'Finance'; groupTypes = @('Unified'); securityEnabled = $false; mailEnabled = $true }
        }
        $script:payload = ConvertTo-EntraGroupDeltaIngest -Changes $script:changes -GroupsById $script:groupsById
    }

    It 'builds group records from the re-fetched whole group, derived attributes included' {
        $payload.groupRecords.Count | Should -Be 1
        $payload.groupRecords[0].displayName | Should -Be 'Finance'
        $payload.groupRecords[0].extendedAttributes.groupCategory | Should -Be 'Microsoft365'
        $payload.removedGroupIds | Should -Be @($G2)
    }

    It 'upserts added members as Direct Group assignments, typed by member kind' {
        $members = @($payload.assignmentAdds | Where-Object { $_.resourceType -eq 'Group' })
        $members.Count | Should -Be 2
        ($members | Where-Object { $_.principalId -eq $U1 }).principalType | Should -Be 'User'
        ($members | Where-Object { $_.principalId -eq $G2 }).principalType | Should -Be 'Group'
        @($members.assignmentType | Select-Object -Unique) | Should -Be @('Direct')
    }

    It 'turns an added owner into an ownership resource named after the group, skipping unknown groups' {
        $ownId = New-OwnershipResourceId -GroupId $G1
        $payload.ownershipResources.Count | Should -Be 1
        $payload.ownershipResources[0].id | Should -Be $ownId
        $payload.ownershipResources[0].displayName | Should -Be 'Finance'
        $payload.ownershipRels[0].parentResourceId | Should -Be $G1
        $owner = @($payload.assignmentAdds | Where-Object { $_.resourceType -eq 'GroupOwnership' })
        $owner.Count | Should -Be 1
        $owner[0].resourceId | Should -Be $ownId
        $owner[0].principalId | Should -Be $U1
    }

    It 'names each removed member and owner by its full assignment key' {
        $payload.assignmentRemoves.Count | Should -Be 2
        $payload.assignmentRemoves[0].resourceId | Should -Be $G1
        $payload.assignmentRemoves[0].principalId | Should -Be $U2
        $payload.assignmentRemoves[0].assignmentType | Should -Be 'Direct'
        $payload.assignmentRemoves[1].resourceId | Should -Be (New-OwnershipResourceId -GroupId $G1)
        $payload.assignmentRemoves[1].principalId | Should -Be $U2
    }
}

Describe 'Get-EntraGroupsById' {
    It 'fetches 15 ids per call with an id-in filter and returns them by id' {
        $ids = 1..16 | ForEach-Object { 'cccccccc-0000-0000-0000-{0:d12}' -f $_ }
        $script:uris = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-FGGetRequest {
            $script:uris.Add($URI)
            $decoded = [uri]::UnescapeDataString($URI)
            [regex]::Matches($decoded, "'([^']+)'") | ForEach-Object { [pscustomobject]@{ id = $_.Groups[1].Value } }
        }
        $byId = Get-EntraGroupsById -Ids $ids -Select 'id,displayName'

        $script:uris.Count | Should -Be 2
        [regex]::Matches([uri]::UnescapeDataString($script:uris[0]), "'").Count | Should -Be 30
        $script:uris[1] | Should -BeLike "*`$select=id,displayName"
        $byId.Count | Should -Be 16
    }

    It 'makes no call for no ids' {
        Mock Invoke-FGGetRequest { throw 'should not be called' }
        (Get-EntraGroupsById -Ids @() -Select 'id').Count | Should -Be 0
    }
}

Describe 'Sync-EntraGroupDelta' {
    BeforeEach {
        Reset-GroupDeltaTestState
        Mock Send-IngestBatch -MockWith $script:SendMock
        Mock Send-CrawlerIngestDeletedKeys -MockWith $script:KeyDeleteMock
        Mock Set-FGDeltaToken {}
        Mock Remove-FGDeltaToken {}
    }

    It 'applies the changes since the stored token and stores the new one' {
        Mock Get-FGDeltaToken { 'tok-1' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -like '*$deltatoken=tok-1' } -MockWith {
            @{ deltaToken = 'tok-2'; value = @(
                [pscustomobject]@{ id = $G1; displayName = 'Finance'; 'members@delta' = @(@{ id = $U1 }, @{ id = $U2; '@removed' = @{ reason = 'deleted' } }) }
                [pscustomobject]@{ id = $G2; '@removed' = @{ reason = 'deleted' } }
            ) }
        }
        Mock Invoke-FGGetRequest { [pscustomobject]@{ id = $G1; displayName = 'Finance'; securityEnabled = $true } }

        Sync-EntraGroupDelta -SystemId 3 -Timings ([ordered]@{})

        $groups = @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/resources' })[0]
        $groups.SyncMode | Should -Be 'delta'
        $groups.Records[0].id | Should -Be $G1
        $groups.DeletedIds | Should -Be @($G2)
        $assign = @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/resource-assignments' })[0]
        $assign.SyncMode | Should -Be 'delta'
        $assign.Records[0].principalId | Should -Be $U1
        $script:keyDeletes[0].SystemId | Should -Be 3
        $script:keyDeletes[0].Keys[0].principalId | Should -Be $U2
        Should -Invoke Set-FGDeltaToken -Exactly -Times 1 -ParameterFilter { $Token -eq 'tok-2' -and $Endpoint -eq 'groups/delta/members-owners' -and $SystemId -eq 3 }
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'starts a baseline and applies nothing when there is no token yet' {
        Mock Get-FGDeltaToken { $null }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -like '*$deltatoken=latest' } -MockWith { @{ deltaToken = 'tok-new'; value = @() } }

        Sync-EntraGroupDelta -SystemId 3 -IncludeMembers $false

        $script:sent.Count | Should -Be 0
        Should -Invoke Set-FGDeltaToken -Exactly -Times 1 -ParameterFilter { $Token -eq 'tok-new' -and $Endpoint -eq 'groups/delta' }
    }

    It 'clears a token Graph rejects and starts a new baseline' {
        Mock Get-FGDeltaToken { 'tok-old' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -like '*$deltatoken=tok-old' } -MockWith { throw [System.InvalidOperationException]::new('410 Gone') }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -like '*$deltatoken=latest' } -MockWith { @{ deltaToken = 'tok-new'; value = @() } }

        Sync-EntraGroupDelta -SystemId 3

        Should -Invoke Remove-FGDeltaToken -Exactly -Times 1 -ParameterFilter { $Endpoint -eq 'groups/delta/members-owners' }
        Should -Invoke Set-FGDeltaToken -Exactly -Times 1 -ParameterFilter { $Token -eq 'tok-new' }
        $script:sent.Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure and keeps the old token when applying fails' {
        Mock Get-FGDeltaToken { 'tok-1' }
        Mock Invoke-FGGetDeltaRequest { @{ deltaToken = 'tok-2'; value = @([pscustomobject]@{ id = $G1; 'members@delta' = @(@{ id = $U1 }) }) } }
        Mock Send-IngestBatch { throw 'ingest 500' }

        Sync-EntraGroupDelta -SystemId 3

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'GroupDelta:*ingest 500*'
        Should -Invoke Set-FGDeltaToken -Exactly -Times 0
    }
}

Describe 'Invoke-EntraGroupPhases' {
    BeforeEach {
        Reset-GroupDeltaTestState
        $script:order = [System.Collections.Generic.List[string]]::new()
        Mock Set-FGDeltaToken { $script:order.Add("store:$Token") }
        Mock New-EntraGroupDeltaToken { $script:order.Add('prime'); 'tok-full' }
        Mock Sync-EntraResources { $script:order.Add('resources'); [pscustomobject]@{ id = 'g1' }; [pscustomobject]@{ id = 'g2' } }
        Mock Sync-EntraAssignments { $script:order.Add("assignments:$(@($Groups).Count)") }
        Mock Sync-EntraGroupDelta { $script:order.Add("delta:$IncludeMembers") }
    }

    It 'reads /groups/delta on a delta run and returns no groups' {
        $groups = @(Invoke-EntraGroupPhases -SystemId 1 -SyncMode 'delta' -SyncResources $true -SyncAssignments $true)

        $groups.Count | Should -Be 0
        $script:order | Should -Be @('delta:True')
    }

    It 'does nothing on a delta run with groups switched off' {
        Invoke-EntraGroupPhases -SystemId 1 -SyncMode 'delta' -SyncResources '' -SyncAssignments $true | Out-Null
        $script:order.Count | Should -Be 0
    }

    It 'starts the token before reading on a full run and stores it after both phases succeed' {
        $groups = @(Invoke-EntraGroupPhases -SystemId 1 -SyncMode 'full' -SyncResources $true -SyncAssignments $true)

        $groups.Count | Should -Be 2
        $script:order | Should -Be @('prime', 'resources', 'assignments:2', 'store:tok-full')
    }

    It 'does not store the token when a phase failed' {
        Mock Sync-EntraAssignments { $script:phaseErrors.Add('Assignments: boom') }
        Invoke-EntraGroupPhases -SystemId 1 -SyncMode 'full' -SyncResources $true -SyncAssignments $true | Out-Null

        Should -Invoke Set-FGDeltaToken -Exactly -Times 0
    }

    It 'neither primes nor reads groups on a full run with groups switched off' {
        Invoke-EntraGroupPhases -SystemId 1 -SyncMode 'full' -SyncResources $false -SyncAssignments $true | Out-Null
        $script:order | Should -Be @('assignments:0')
    }
}

Describe 'New-EntraGroupDeltaToken' {
    It 'returns the token Graph hands out' {
        Mock Invoke-FGGetDeltaRequest { @{ deltaToken = 'abc'; value = @() } }
        New-EntraGroupDeltaToken | Should -Be 'abc'
    }

    It 'returns $null when Graph fails or returns no deltaLink' {
        Mock Invoke-FGGetDeltaRequest { throw 'Graph 400' }
        New-EntraGroupDeltaToken | Should -BeNullOrEmpty
        Mock Invoke-FGGetDeltaRequest { @{ deltaToken = $null; value = @() } }
        New-EntraGroupDeltaToken | Should -BeNullOrEmpty
    }
}
