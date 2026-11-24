#Requires -Modules Pester

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'
    # ConvertTo-EntraAccessPackageRecord, which the sync phase calls.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Transform.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Catalogs.ps1')

    # Stubs so Pester can Mock them; no Graph or ingest call ever leaves the test.
    function Invoke-FGGetRequest { param([string]$URI) }
    function Send-IngestBatch { param([string]$Endpoint, [int]$SystemId, [string]$SyncMode, [hashtable]$Scope, [array]$Records) }
    function Invoke-IngestAPI { param([string]$Endpoint, [hashtable]$Body) }
    # The real phase recorder, so a test can read what the sub-phase reported.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    function Reset-CatalogTestState {
        $script:sent        = [System.Collections.Generic.List[object]]::new()
        $script:posted      = [System.Collections.Generic.List[object]]::new()
        $script:phases      = [System.Collections.Generic.List[object]]::new()
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
    }
    $script:PostMock = {
        $script:posted.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body })
        return @{ inserted = @($Body.records).Count; skipped = 0; removed = 1 }
    }

    $script:OwnerRole   = 'ae79f266-94d4-4dab-b730-feca7e132178'
    $script:ManagerRole = '7f480852-ebdc-47d4-87de-0d8498384a83'
    $script:ReaderRole  = '44272f93-9762-48e8-af59-1b5351b1d6b3'
    $script:C1 = '11111111-1111-1111-1111-111111111111'
    $script:C2 = '2222abcd-2222-2222-2222-22222222beef'
    $script:C3 = '33333333-3333-3333-3333-333333333333'
    function New-RoleAssignment { param($Role, $Catalog, $Principal)
        [pscustomobject]@{ roleDefinitionId = $Role; appScopeId = "/AccessPackageCatalog/$Catalog"; principalId = $Principal }
    }

    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{
            Endpoint = $Endpoint; SystemId = $SystemId; SyncMode = $SyncMode; Scope = $Scope; Records = @($Records)
        })
        return @{ inserted = @($Records).Count; updated = 0; deleted = 0 }
    }
    function Get-Sent { param([string]$Endpoint) @($script:sent | Where-Object { $_.Endpoint -eq $Endpoint }) }
}

Describe 'ConvertTo-EntraCatalogContextRecord' {

    It 'maps a beta catalog to a synced Catalog context owned by the system' {
        $cat = [pscustomobject]@{
            id = 'c1'; displayName = 'Finance'; description = 'Finance roles'; catalogType = 'UserManaged'
            catalogStatus = 'Published'; isExternallyVisible = $true
            createdDateTime = '2025-01-01T00:00:00Z'; modifiedDateTime = '2025-02-01T00:00:00Z'
        }
        $rec = ConvertTo-EntraCatalogContextRecord -Catalog $cat -SystemId 7

        $rec['id']              | Should -Be 'c1'
        $rec['externalId']      | Should -Be 'c1'
        $rec['variant']         | Should -Be 'synced'
        $rec['targetType']      | Should -Be 'Resource'
        $rec['contextType']     | Should -Be 'AccessPackageCatalog'
        $rec['contextCategory'] | Should -Be 'Catalog'
        $rec['displayName']     | Should -Be 'Finance'
        $rec['description']     | Should -Be 'Finance roles'
        $rec['scopeSystemId']   | Should -Be 7
        $attrs = $rec['extendedAttributes']
        $attrs['catalogType']         | Should -Be 'UserManaged'
        $attrs['state']               | Should -Be 'Published'
        $attrs['isExternallyVisible'] | Should -BeTrue
        $attrs['createdDateTime']     | Should -Be '2025-01-01T00:00:00Z'
        $attrs['modifiedDateTime']    | Should -Be '2025-02-01T00:00:00Z'
    }

    It 'prefers the v1.0 state over the beta catalogStatus' {
        $cat = [pscustomobject]@{ id = 'c1'; displayName = 'X'; state = 'unpublished'; catalogStatus = 'Published' }
        (ConvertTo-EntraCatalogContextRecord -Catalog $cat -SystemId 1)['extendedAttributes']['state'] | Should -Be 'unpublished'
    }

    It 'keeps isExternallyVisible = false, and leaves out what the source does not say' {
        $cat = [pscustomobject]@{ id = 'c2'; displayName = 'Internal'; isExternallyVisible = $false }
        $attrs = (ConvertTo-EntraCatalogContextRecord -Catalog $cat -SystemId 1)['extendedAttributes']
        $attrs.Contains('isExternallyVisible') | Should -BeTrue
        $attrs['isExternallyVisible']          | Should -BeFalse
        @($attrs.Keys) | Should -Be @('isExternallyVisible')
    }
}

Describe 'Get-EntraCatalogMemberRecords' {

    It 'links each access package to its synced catalog, and only to one that was synced' {
        $aps = @(
            [pscustomobject]@{ id = 'ap1'; catalogId = 'c1' }
            [pscustomobject]@{ id = 'ap2'; catalogId = 'C2' }        # case differs from the catalog id
            [pscustomobject]@{ id = 'ap3'; catalogId = 'c-gone' }    # catalog not in this run
            [pscustomobject]@{ id = 'ap4' }                          # no catalog at all
            [pscustomobject]@{ catalogId = 'c1' }                    # no id
        )
        $members = @(Get-EntraCatalogMemberRecords -AccessPackages $aps -CatalogIds @('c1', 'c2'))

        $members.Count | Should -Be 2
        @($members | ForEach-Object { "$($_.contextId)>$($_.memberId)" }) | Should -Be @('c1>ap1', 'C2>ap2')
        $members[0]['memberType'] | Should -Be 'Resource'
        $members[0]['addedBy']    | Should -Be 'sync'
    }

    It 'returns nothing when no catalog was synced' {
        @(Get-EntraCatalogMemberRecords -AccessPackages @([pscustomobject]@{ id = 'ap1'; catalogId = 'c1' })).Count | Should -Be 0
    }
}

Describe 'Sync-EntraGovernanceCatalogs' {
    BeforeEach {
        Reset-CatalogTestState
        Mock Send-IngestBatch -MockWith $script:SendMock
        Mock Invoke-IngestAPI -MockWith $script:PostMock
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleManagement' } -MockWith { @() }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessPackageCatalogs' } -MockWith {
            @([pscustomobject]@{ id = 'c1'; displayName = 'Finance' }, [pscustomobject]@{ id = 'c2'; displayName = 'HR' })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'entitlementManagement/accessPackages\?' } -MockWith {
            @([pscustomobject]@{ id = 'ap1'; displayName = 'AP1'; catalogId = 'c1' },
              [pscustomobject]@{ id = 'ap2'; displayName = 'AP2'; catalogId = 'c9' })
        }
    }

    It 'writes the catalogs as contexts, reconciled per synced AccessPackageCatalog' {
        Sync-EntraGovernanceCatalogs -SystemId 3 | Out-Null

        $ctx = Get-Sent 'ingest/contexts'
        $ctx.Count | Should -Be 1
        $ctx[0].SyncMode          | Should -Be 'full'
        $ctx[0].SystemId          | Should -Be 3
        $ctx[0].Scope.variant     | Should -Be 'synced'
        $ctx[0].Scope.contextType | Should -Be 'AccessPackageCatalog'
        @($ctx[0].Records | ForEach-Object { $_.id }) | Should -Be @('c1', 'c2')
        Get-Sent 'ingest/governance/catalogs' | Should -BeNullOrEmpty
    }

    It 'writes the roles before their catalog memberships, and only memberships of synced catalogs' {
        Sync-EntraGovernanceCatalogs -SystemId 3 | Out-Null

        @($script:sent.Endpoint) | Should -Be @('ingest/contexts', 'ingest/resources', 'ingest/context-members')
        $roles = (Get-Sent 'ingest/resources')[0]
        $roles.Scope.resourceType | Should -Be 'BusinessRole'
        $roles.Records.Count      | Should -Be 2
        $members = (Get-Sent 'ingest/context-members')[0]
        $members.SyncMode | Should -Be 'full'
        @($members.Records | ForEach-Object { "$($_.contextId)>$($_.memberId)" }) | Should -Be @('c1>ap1')
    }

    It 'returns only the raw access packages, not the ingest or role results' {
        $aps = @(Sync-EntraGovernanceCatalogs -SystemId 3)
        $aps.Count | Should -Be 2
        $aps[0].id | Should -Be 'ap1'
    }

    It 'states the roles of exactly the catalogs it synced, after their memberships' {
        Sync-EntraGovernanceCatalogs -SystemId 3 | Out-Null
        $script:posted.Count | Should -Be 1
        $script:posted[0].Endpoint | Should -Be 'ingest/context-roles'
        Should -Invoke Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleManagement' } -Times 2 -Exactly
    }
}

Describe 'Get-EntraCatalogIdFromScope' {
    It 'reads the catalog id from a catalog scope only' {
        Get-EntraCatalogIdFromScope -AppScopeId "/AccessPackageCatalog/$($script:C1)" | Should -Be $script:C1
        Get-EntraCatalogIdFromScope -AppScopeId '/' | Should -BeNullOrEmpty
        Get-EntraCatalogIdFromScope -AppScopeId "/AccessPackage/$($script:C1)" | Should -BeNullOrEmpty
        Get-EntraCatalogIdFromScope -AppScopeId "/AccessPackageCatalog/$($script:C1)/x" | Should -BeNullOrEmpty
        Get-EntraCatalogIdFromScope -AppScopeId $null | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraCatalogRoleRecords' {
    BeforeAll {
        $assignments = @(
            # C1: one owner (u1), who is also a manager, plus manager u2.
            New-RoleAssignment $script:OwnerRole   $script:C1 'u1'
            New-RoleAssignment $script:ManagerRole $script:C1 'u1'
            New-RoleAssignment $script:ManagerRole $script:C1 'u2'
            New-RoleAssignment $script:ReaderRole  $script:C1 'u9'          # reader: answers for nothing
            # C2: two owners (u3 listed twice) -> both Responsible, nobody Accountable.
            New-RoleAssignment $script:OwnerRole   $script:C2.ToUpper() 'u3' # case differs from the synced id
            New-RoleAssignment $script:OwnerRole   $script:C2 'u3'
            New-RoleAssignment $script:OwnerRole   $script:C2 'u4'
            # C3: no owner, one manager.
            New-RoleAssignment $script:ManagerRole $script:C3 'u5'
            # Not a synced catalog, a tenant-wide scope, no principal.
            New-RoleAssignment $script:OwnerRole   '99999999-9999-9999-9999-999999999999' 'u6'
            [pscustomobject]@{ roleDefinitionId = $script:OwnerRole; appScopeId = '/'; principalId = 'u7' }
            New-RoleAssignment $script:OwnerRole   $script:C3 $null
        )
        $script:recs = @(ConvertTo-EntraCatalogRoleRecords -Assignments $assignments -CatalogIds @($script:C1, $script:C2, $script:C3))
        $script:flat = @($script:recs | ForEach-Object { "$($_.contextId)|$($_.role)|$($_.principalId)" })
    }

    It 'makes the one owner Accountable, and a manager who is not that owner Responsible' {
        $script:flat | Should -Contain "$($script:C1)|Accountable|u1"
        $script:flat | Should -Contain "$($script:C1)|Responsible|u2"
        $script:flat | Should -Not -Contain "$($script:C1)|Responsible|u1"
    }

    It 'makes every owner Responsible when there is more than one, once each' {
        @($script:flat | Where-Object { $_ -like "$($script:C2)|*" }) | Should -Be @("$($script:C2)|Responsible|u3", "$($script:C2)|Responsible|u4")
    }

    It 'gives a catalog without an owner its managers as Responsible' {
        @($script:flat | Where-Object { $_ -like "$($script:C3)|*" }) | Should -Be @("$($script:C3)|Responsible|u5")
    }

    It 'leaves out readers, other catalogs, tenant-wide scopes and assignments without a principal' {
        $script:recs.Count | Should -Be 5
        $script:flat -join ' ' | Should -Not -Match 'u6|u7|u9'
    }

    It 'names each role by principal and by the catalog id as it was synced' {
        $script:recs | ForEach-Object { $_.Keys | Sort-Object | Should -Be @('contextId', 'principalId', 'role') }
        @($script:recs | Where-Object { $_.contextId -ceq $script:C2.ToUpper() }).Count | Should -Be 0
    }

    It 'returns nothing without synced catalogs' {
        @(ConvertTo-EntraCatalogRoleRecords -Assignments @(New-RoleAssignment $script:OwnerRole $script:C1 'u1')).Count | Should -Be 0
    }
}

Describe 'Sync-EntraCatalogRoles' {
    BeforeEach {
        Reset-CatalogTestState
        Mock Invoke-IngestAPI -MockWith $script:PostMock
    }

    It 'reads both role definitions and states the roles as a full sync of the catalog contexts' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match [regex]::Escape($script:OwnerRole) } -MockWith { @(New-RoleAssignment $script:OwnerRole $script:C1 'u1') }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match [regex]::Escape($script:ManagerRole) } -MockWith { @(New-RoleAssignment $script:ManagerRole $script:C1 'u2') }

        Sync-EntraCatalogRoles -SystemId 4 -CatalogIds @($script:C1)

        $script:posted.Count | Should -Be 1
        $body = $script:posted[0].Body
        $body.systemId          | Should -Be 4
        $body.syncMode          | Should -Be 'full'
        $body.scope.contextType | Should -Be 'AccessPackageCatalog'
        @($body.records | ForEach-Object { "$($_.role)|$($_.principalId)" }) | Should -Be @('Accountable|u1', 'Responsible|u2')
        Should -Invoke Invoke-FGGetRequest -Times 1 -Exactly -ParameterFilter { $URI -like '*v1.0/roleManagement/entitlementManagement/roleAssignments?$filter=roleDefinitionId eq*' -and $URI -match [regex]::Escape($script:OwnerRole) }
        $script:phases[0].name   | Should -Be 'Governance/CatalogRoles'
        $script:phases[0].status | Should -Be 'ok'
        $script:phases[0].records.catalogRoles | Should -Be 2
    }

    It 'still sends an empty full sync when Entra ID has no catalog roles, so removed owners go' {
        Mock Invoke-FGGetRequest -MockWith { @() }
        Sync-EntraCatalogRoles -SystemId 4 -CatalogIds @($script:C1)
        $script:posted.Count | Should -Be 1
        @($script:posted[0].Body.records).Count | Should -Be 0
        $script:posted[0].Body.records -is [array] | Should -BeTrue
    }

    It 'sends nothing when Graph fails, and records the sub-phase error instead' {
        Mock Invoke-FGGetRequest -MockWith { throw 'HTTP 403 Forbidden' }
        Sync-EntraCatalogRoles -SystemId 4 -CatalogIds @($script:C1)
        $script:posted.Count | Should -Be 0
        $script:phaseErrors | Should -Be @('Governance/CatalogRoles: HTTP 403 Forbidden')
        $script:phases[0].status | Should -Be 'failed'
    }
}
