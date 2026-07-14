#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the ApplicationPermission shaper
    (tools/crawlers/entra-id/EntraIDCrawler.AppPermissions.ps1).

.DESCRIPTION
    ConvertTo-EntraAppPermissionGraph is pure (no HTTP, no script-scope writes), so
    it runs against in-memory fixtures with no mocks. Models the app-only permissions
    an SP holds on other APIs — the sibling of DelegatedPermission.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'
    # ConvertTo-FGDeterministicUuid lives in Functions.ps1.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.AppPermissions.ps1')
}

Describe 'ConvertTo-EntraAppPermissionGraph' {

    It 'maps an appRoleAssignment to an ApplicationPermission resource, HasApplicationPermission rel, and a ServicePrincipal-principal Direct assignment' {
        $assignments = @(
            [pscustomobject]@{ id = 'ara1'; principalId = 'sp1'; resourceId = 'graphSp'; resourceDisplayName = 'Microsoft Graph'; appRoleId = 'role-mailread' }
        )
        $out = ConvertTo-EntraAppPermissionGraph -Assignments $assignments `
            -AppRoleNameById @{ 'graphSp|role-mailread' = 'Mail.Read' } `
            -SpInfo @{ sp1 = @{ displayName = 'Payroll App' } }

        $out.resources.Count     | Should -Be 1
        $out.relationships.Count | Should -Be 1
        $out.assignments.Count   | Should -Be 1

        $res = $out.resources[0]
        $res.resourceType | Should -Be 'ApplicationPermission'
        $res.enabled      | Should -BeTrue   # line 98 $true->$false — the resource must be enabled
        $res.displayName  | Should -Be 'Mail.Read on Microsoft Graph (via Payroll App)'
        $res.extendedAttributes.permission    | Should -Be 'Mail.Read'
        $res.extendedAttributes.targetApiSpId | Should -Be 'graphSp'
        $res.extendedAttributes.clientSpId    | Should -Be 'sp1'

        $rel = $out.relationships[0]
        $rel.relationshipType | Should -Be 'HasApplicationPermission'
        $rel.parentResourceId | Should -Be 'sp1'
        $rel.childResourceId  | Should -Be $res.id

        $assn = $out.assignments[0]
        $assn.assignmentType | Should -Be 'Direct'
        $assn.principalType  | Should -Be 'ServicePrincipal'
        $assn.principalId    | Should -Be 'sp1'
        $assn.resourceId     | Should -Be $res.id
        $assn.resourceType   | Should -Be 'ApplicationPermission'
    }

    It 'carries the holder principalType from SpInfo (managed identity / AI agent), not a flat ServicePrincipal' {
        $out = ConvertTo-EntraAppPermissionGraph -Assignments @([pscustomobject]@{ id = '1'; principalId = 'agent1'; resourceId = 'graphSp'; appRoleId = 'role-mailread' }) `
            -AppRoleNameById @{ 'graphSp|role-mailread' = 'Mail.Read' } `
            -SpInfo @{ agent1 = @{ displayName = 'Sales Copilot Agent'; principalType = 'AIAgent' } }
        $out.assignments[0].principalType | Should -Be 'AIAgent'
        $out.assignments[0].principalId   | Should -Be 'agent1'

        $mi = ConvertTo-EntraAppPermissionGraph -Assignments @([pscustomobject]@{ id = '2'; principalId = 'mi1'; resourceId = 'graphSp'; appRoleId = 'role-mailread' }) `
            -SpInfo @{ mi1 = @{ displayName = 'kv-reader-mi'; principalType = 'ManagedIdentity' } }
        $mi.assignments[0].principalType | Should -Be 'ManagedIdentity'
    }

    It 'falls back to the appRole guid + SP ids when names are unknown' {
        $out = ConvertTo-EntraAppPermissionGraph -Assignments @([pscustomobject]@{ id = 'x'; principalId = 'spX'; resourceId = 'apiX'; appRoleId = 'guid-9' })
        $out.resources[0].extendedAttributes.permission | Should -Be 'guid-9'
        $out.resources[0].displayName | Should -Be 'guid-9 on apiX (via spX)'
    }

    It 'prefers resourceDisplayName from the assignment for the target API name' {
        $out = ConvertTo-EntraAppPermissionGraph -Assignments @([pscustomobject]@{ id = '1'; principalId = 'sp1'; resourceId = 'g'; resourceDisplayName = 'Office 365 Exchange Online'; appRoleId = 'r1' })
        $out.resources[0].displayName | Should -Match 'on Office 365 Exchange Online'
    }

    It 'is deterministic over (clientSP, targetAPI, appRole)' {
        $a = ConvertTo-EntraAppPermissionGraph -Assignments @([pscustomobject]@{ id = '1'; principalId = 'sp9'; resourceId = 'api9'; appRoleId = 'r9' })
        $b = ConvertTo-EntraAppPermissionGraph -Assignments @([pscustomobject]@{ id = '2'; principalId = 'sp9'; resourceId = 'api9'; appRoleId = 'r9' })
        $a.resources[0].id | Should -Be $b.resources[0].id
    }

    It 'creates one resource + relationship + assignment per distinct permission' {
        $assignments = @(
            [pscustomobject]@{ id = '1'; principalId = 'sp1'; resourceId = 'g'; appRoleId = 'mail' },
            [pscustomobject]@{ id = '3'; principalId = 'sp1'; resourceId = 'g'; appRoleId = 'dir'  }
        )
        $out = ConvertTo-EntraAppPermissionGraph -Assignments $assignments
        $out.resources.Count     | Should -Be 2
        $out.relationships.Count | Should -Be 2
        $out.assignments.Count   | Should -Be 2
    }

    It 'skips rows missing principalId, resourceId, or appRoleId' {
        $assignments = @(
            [pscustomobject]@{ id = '1'; principalId = 'sp1'; resourceId = 'g'; appRoleId = 'r1' },
            [pscustomobject]@{ id = '2'; principalId = '';    resourceId = 'g'; appRoleId = 'r2' },
            [pscustomobject]@{ id = '3'; principalId = 'sp1'; resourceId = '';  appRoleId = 'r3' },
            [pscustomobject]@{ id = '4'; principalId = 'sp1'; resourceId = 'g'; appRoleId = '' }
        )
        $out = ConvertTo-EntraAppPermissionGraph -Assignments $assignments
        $out.assignments.Count | Should -Be 1
        $out.resources.Count   | Should -Be 1
    }

    It 'returns empty collections for no assignments' {
        $out = ConvertTo-EntraAppPermissionGraph -Assignments @()
        $out.resources.Count     | Should -Be 0
        $out.relationships.Count | Should -Be 0
        $out.assignments.Count   | Should -Be 0
    }

    It 'dedupes to one resource + one relationship when the same (clientSP, targetAPI, appRole) appears twice' {
        $assignments = @(
            [pscustomobject]@{ id = '1'; principalId = 'sp1'; resourceId = 'g'; appRoleId = 'r1' },
            [pscustomobject]@{ id = '2'; principalId = 'sp1'; resourceId = 'g'; appRoleId = 'r1' }
        )
        $out = ConvertTo-EntraAppPermissionGraph -Assignments $assignments
        $out.resources.Count     | Should -Be 1   # collapsed
        $out.relationships.Count | Should -Be 1   # collapsed
        $out.assignments.Count   | Should -Be 2   # both grant rows kept (distinct assignmentId)
    }

    It 'falls back to the target SP''s SpInfo displayName when the assignment carries no resourceDisplayName' {
        $out = ConvertTo-EntraAppPermissionGraph `
            -Assignments @([pscustomobject]@{ id = '1'; principalId = 'sp1'; resourceId = 'graphSp'; appRoleId = 'r1' }) `
            -SpInfo @{ graphSp = @{ displayName = 'Microsoft Graph' } }
        $out.resources[0].displayName | Should -Match 'on Microsoft Graph'
    }
}

Describe 'Get-EntraAppRoleName' {
    It 'prefers the scope value, then displayName, then the raw guid' {
        Get-EntraAppRoleName -AppRole ([pscustomobject]@{ value = 'Mail.Read'; displayName = 'Read mail'; id = 'guid-1' }) | Should -Be 'Mail.Read'
        Get-EntraAppRoleName -AppRole ([pscustomobject]@{ displayName = 'Read mail'; id = 'guid-1' })                     | Should -Be 'Read mail'
        Get-EntraAppRoleName -AppRole ([pscustomobject]@{ id = 'guid-1' })                                               | Should -Be 'guid-1'
    }
}

Describe 'Get-EntraAppPermissionIndex' {

    It 'builds spInfo, spById, and appRoleNameById (target APIs are just SPs with an appRoles catalog)' {
        $sps = @(
            [pscustomobject]@{ id = 'sp1'; displayName = 'Payroll App' },
            [pscustomobject]@{ id = 'graphSp'; displayName = 'Microsoft Graph';
                appRoles = @(
                    [pscustomobject]@{ id = 'role-mailread'; value = 'Mail.Read' },
                    [pscustomobject]@{ id = 'role-dirread';  displayName = 'Read directory data' }  # no value -> displayName
                ) }
        )
        $idx = Get-EntraAppPermissionIndex -Sps $sps

        $idx.spInfo['sp1'].displayName                | Should -Be 'Payroll App'
        $idx.spInfo['sp1'].principalType              | Should -Not -BeNullOrEmpty  # classifier or fallback
        $idx.spById['graphSp'].displayName            | Should -Be 'Microsoft Graph'
        $idx.appRoleNameById['graphSp|role-mailread'] | Should -Be 'Mail.Read'
        $idx.appRoleNameById['graphSp|role-dirread']  | Should -Be 'Read directory data'
    }

    It 'skips appRoles that have no id' {
        $sps = @(
            [pscustomobject]@{ id = 'api1'; displayName = 'API';
                appRoles = @([pscustomobject]@{ value = 'NoId.Scope' }) }   # missing id
        )
        $idx = Get-EntraAppPermissionIndex -Sps $sps
        $idx.appRoleNameById.Count | Should -Be 0
    }

    It 'returns empty maps for no service principals' {
        $idx = Get-EntraAppPermissionIndex -Sps @()
        $idx.spInfo.Count          | Should -Be 0
        $idx.appRoleNameById.Count | Should -Be 0
        $idx.spById.Count          | Should -Be 0
    }
}

Describe 'Resolve-EntraAppPermissionFields' {

    It 'resolves the permission name, client name/type, and target name from the maps' {
        $a = [pscustomobject]@{ principalId = 'sp1'; resourceId = 'graphSp'; appRoleId = 'role-x'; resourceDisplayName = 'Microsoft Graph' }
        $f = Resolve-EntraAppPermissionFields -Assignment $a `
            -AppRoleNameById @{ 'graphSp|role-x' = 'Mail.Read' } `
            -SpInfo @{ sp1 = @{ displayName = 'Payroll App'; principalType = 'AIAgent' } }

        $f.permName   | Should -Be 'Mail.Read'
        $f.clientName | Should -Be 'Payroll App'
        $f.clientType | Should -Be 'AIAgent'      # carried from SpInfo, not flattened
        $f.targetName | Should -Be 'Microsoft Graph'
    }

    It 'falls back to the appRole guid, the client SP id, ServicePrincipal, and the target id when the maps are empty' {
        $a = [pscustomobject]@{ principalId = 'spX'; resourceId = 'apiX'; appRoleId = 'guid-9' }
        $f = Resolve-EntraAppPermissionFields -Assignment $a

        $f.permName   | Should -Be 'guid-9'
        $f.clientName | Should -Be 'spX'
        $f.clientType | Should -Be 'ServicePrincipal'
        $f.targetName | Should -Be 'apiX'
    }

    It 'falls back to the target SP''s SpInfo displayName when the assignment has no resourceDisplayName' {
        $a = [pscustomobject]@{ principalId = 'sp1'; resourceId = 'graphSp'; appRoleId = 'r1' }
        $f = Resolve-EntraAppPermissionFields -Assignment $a `
            -SpInfo @{ graphSp = @{ displayName = 'Microsoft Graph' } }
        $f.targetName | Should -Be 'Microsoft Graph'
    }
}

Describe 'Format-FGApplicationPermissionName' {

    It 'includes the holder SP when a client name is supplied' {
        Format-FGApplicationPermissionName -Permission 'Mail.Read' -TargetName 'Microsoft Graph' -ClientName 'Payroll App' |
            Should -Be 'Mail.Read on Microsoft Graph (via Payroll App)'
    }

    It 'omits the "(via ...)" suffix when there is no client name' {
        Format-FGApplicationPermissionName -Permission 'Mail.Read' -TargetName 'Microsoft Graph' |
            Should -Be 'Mail.Read on Microsoft Graph'
    }
}
