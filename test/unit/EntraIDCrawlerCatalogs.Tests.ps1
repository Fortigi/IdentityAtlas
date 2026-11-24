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
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Send-IngestBatch -MockWith $script:SendMock
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

    It 'returns only the raw access packages, not the ingest results' {
        $aps = @(Sync-EntraGovernanceCatalogs -SystemId 3)
        $aps.Count | Should -Be 2
        $aps[0].id | Should -Be 'ap1'
    }
}
