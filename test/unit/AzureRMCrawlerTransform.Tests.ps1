#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure Azure RM record-shapers
    (AzureRMCrawler.Transform.ps1).

.DESCRIPTION
    The ConvertTo/New-Azure* shapers take explicit parameters, do no I/O and read no
    scope, so they are tested directly. New-Azure*ScopeRecord call the deterministic
    Get-ScopeNodeId / Get-AzureResourceType helpers, so Functions.ps1 + Get-CapabilityId
    are dot-sourced here.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Get-CapabilityId.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'azure-rm' 'AzureRMCrawler.Functions.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'azure-rm' 'AzureRMCrawler.Transform.ps1')
}

Describe 'Get-AzureRolePlane' {
    It 'classifies control-only when there are only actions' {
        $perms = @([pscustomobject]@{ actions = @('*'); dataActions = @() })
        Get-AzureRolePlane -Permissions $perms | Should -Be 'control'
    }
    It 'classifies data-only when there are only dataActions' {
        $perms = @([pscustomobject]@{ actions = @(); dataActions = @('Microsoft.Storage/.../read') })
        Get-AzureRolePlane -Permissions $perms | Should -Be 'data'
    }
    It "classifies 'both' when a role grants control and data actions" {
        $perms = @([pscustomobject]@{ actions = @('*'); dataActions = @('x/read') })
        Get-AzureRolePlane -Permissions $perms | Should -Be 'both'
    }
    It 'defaults to control for an empty permission set' {
        Get-AzureRolePlane -Permissions @() | Should -Be 'control'
    }
}

Describe 'New-AzureAboveSubScopeRecord' {
    It 'shapes the tenant root as an AzureScope with Root labels' {
        $rec = New-AzureAboveSubScopeRecord -ScopePath '/' -DisplayName 'Tenant Root'
        $rec.resourceType | Should -Be 'AzureScope'
        $rec.displayName  | Should -Be 'Tenant Root'
        $rec.extendedAttributes.scopeKind      | Should -Be 'Root'
        $rec.extendedAttributes.scopeTypeLabel | Should -Be 'Root'
    }
    It 'shapes a management group as AzureManagementGroup with MG labels' {
        $mg = '/providers/Microsoft.Management/managementGroups/mg1'
        $rec = New-AzureAboveSubScopeRecord -ScopePath $mg -DisplayName 'Platform'
        $rec.resourceType | Should -Be 'AzureManagementGroup'
        $rec.displayName  | Should -Be 'Platform'
        $rec.extendedAttributes.scopeKind      | Should -Be 'ManagementGroup'
        $rec.extendedAttributes.scopeTypeLabel | Should -Be 'MG'
        $rec.externalId   | Should -Be $mg
    }
}

Describe 'New-AzureBelowSubScopeRecord' {
    It 'shapes a resource group as AzureResourceGroup with RG labels and no azureResourceType' {
        $rg = '/subscriptions/s1/resourceGroups/rg1'
        $rec = New-AzureBelowSubScopeRecord -ScopePath $rg
        $rec.resourceType | Should -Be 'AzureResourceGroup'
        $rec.displayName  | Should -Be 'rg1'
        $rec.extendedAttributes.scopeTypeLabel | Should -Be 'RG'
        $rec.extendedAttributes.ContainsKey('azureResourceType') | Should -BeFalse
    }
    It 'shapes an individual resource as AzureResource with its azureResourceType' {
        $res = '/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/sa1'
        $rec = New-AzureBelowSubScopeRecord -ScopePath $res
        $rec.resourceType | Should -Be 'AzureResource'
        $rec.displayName  | Should -Be 'sa1'
        $rec.extendedAttributes.scopeTypeLabel   | Should -Be 'Res'
        $rec.extendedAttributes.azureResourceType | Should -Be 'Microsoft.Storage/storageAccounts'
    }
}

Describe 'New-AzureRoleAtScopeRecord' {
    It 'shapes the capability-resource with its extended attributes' {
        $rec = New-AzureRoleAtScopeRecord -CapResId 'cap1' -DisplayName 'Owner @ Sub: X' -RoleDefId 'guid1' -ScopeNodeId 'node1' -RoleName 'Owner' -IsCustom $false -Plane 'control'
        $rec.id           | Should -Be 'cap1'
        $rec.resourceType | Should -Be 'AzureRoleAssignment'
        $rec.enabled      | Should -BeTrue
        $rec.extendedAttributes.capabilityId | Should -Be 'guid1'
        $rec.extendedAttributes.targetNodeId | Should -Be 'node1'
        $rec.extendedAttributes.roleName     | Should -Be 'Owner'
        $rec.extendedAttributes.plane        | Should -Be 'control'
    }
}

Describe 'New-AzureGrantRecord' {
    It 'shapes a Direct allow grant with the roleAssignmentId' {
        $a = [pscustomobject]@{ name = 'ra1'; properties = [pscustomobject]@{ principalId = 'p1' } }
        $rec = New-AzureGrantRecord -CapResId 'cap1' -Assignment $a -PrincipalType 'User'
        $rec.resourceId       | Should -Be 'cap1'
        $rec.principalId      | Should -Be 'p1'
        $rec.assignmentType   | Should -Be 'Direct'
        $rec.effect           | Should -Be 'allow'
        $rec.propagationScope | Should -Be 'selfAndDescendants'
        $rec.principalType    | Should -Be 'User'
        $rec.extendedAttributes.roleAssignmentId | Should -Be 'ra1'
    }
    It 'carries the ABAC condition (+version) and provenance when present' {
        $a = [pscustomobject]@{ name = 'ra2'; properties = [pscustomobject]@{
            principalId = 'p1'; condition = "x eq 'y'"; conditionVersion = '2.0'; createdOn = '2026-01-01'; createdBy = 'admin' } }
        $rec = New-AzureGrantRecord -CapResId 'cap1' -Assignment $a -PrincipalType 'ServicePrincipal'
        $rec.extendedAttributes.condition        | Should -Be "x eq 'y'"
        $rec.extendedAttributes.conditionVersion | Should -Be '2.0'
        $rec.extendedAttributes.createdOn        | Should -Be '2026-01-01'
        $rec.extendedAttributes.createdBy        | Should -Be 'admin'
    }
    It 'omits conditionVersion when there is no condition' {
        $a = [pscustomobject]@{ name = 'ra3'; properties = [pscustomobject]@{ principalId = 'p1' } }
        $rec = New-AzureGrantRecord -CapResId 'cap1' -Assignment $a -PrincipalType 'User'
        $rec.extendedAttributes.ContainsKey('condition') | Should -BeFalse
    }
}

Describe 'New-AzurePrincipalStub' {
    It 'asserts principalType only for Users' {
        $u = New-AzurePrincipalStub -PrincipalId 'u1' -PrincipalType 'User'
        $u.id | Should -Be 'u1'
        $u.accountEnabled | Should -BeTrue
        $u.principalType | Should -Be 'User'
    }
    It 'leaves principalType unset for ServicePrincipals (Entra crawler owns the typing)' {
        $sp = New-AzurePrincipalStub -PrincipalId 'sp1' -PrincipalType 'ServicePrincipal'
        $sp.ContainsKey('principalType') | Should -BeFalse
    }
}
