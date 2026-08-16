<#
.SYNOPSIS
    Entra ID crawler — app-role record shapers (its own file so
    EntraIDCrawler.Transform.ps1 stays under the file-length ratchet).

.DESCRIPTION
    Pure functions that shape enterprise-application app-role data into ingest
    records: the parent Application resource, the per-role AppRole resources and
    their HasAppRole relationships, and the Direct/Indirect app-role assignments.
    Extracted verbatim from EntraIDCrawler.Transform.ps1; unit-tested by
    test/unit/EntraIDCrawlerTransform.Tests.ps1.
#>

# Maps one enterprise-app service principal → an Application resource record (the
# app-role catalog parent). Verbatim from the inline `if (-not $appResourceMap...)`.
function ConvertTo-EntraAppRoleApplicationResource {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $ServicePrincipal)
    $rec = @{
        id           = $ServicePrincipal.id
        displayName  = $ServicePrincipal.displayName
        resourceType = 'Application'
        enabled      = $true
    }
    $ext = @{}
    if ($ServicePrincipal.appId)                     { $ext['appId']                     = $ServicePrincipal.appId }
    if ($ServicePrincipal.appRoleAssignmentRequired) { $ext['appRoleAssignmentRequired'] = $true }
    if ($ServicePrincipal.servicePrincipalType)      { $ext['servicePrincipalType']      = $ServicePrincipal.servicePrincipalType }
    if ($ext.Count -gt 0)                            { $rec['extendedAttributes']        = $ext }
    return $rec
}

# Builds the role catalog (appRoleId -> role object) for an SP, always including
# the synthetic "Default Access" role. Returns a mutable hashtable (the caller
# adds placeholder roles for unknown ids). Verbatim from the inline build.
function Get-EntraAppRoleCatalog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        [string]$DefaultRoleId = '00000000-0000-0000-0000-000000000000'
    )
    $rolesByGuid = @{}
    foreach ($role in @($ServicePrincipal.appRoles)) {
        if ($role -and $role.id) { $rolesByGuid[$role.id] = $role }
    }
    if (-not $rolesByGuid.ContainsKey($DefaultRoleId)) {
        $rolesByGuid[$DefaultRoleId] = [PSCustomObject]@{
            id          = $DefaultRoleId
            displayName = 'Default Access'
            value       = $null
            description = 'No specific role defined; basic access to the application.'
        }
    }
    return $rolesByGuid
}

# Builds the synthetic AppRole resource record for an (SP, role) pair.
# Verbatim from the inline `$appRoleMap[$roleResId] = @{ ... }` block.
function New-EntraAppRoleResourceRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        [Parameter(Mandatory)] $Role,
        [Parameter(Mandatory)] [string]$RoleResourceId
    )
    $roleName = if ($Role.displayName) { $Role.displayName } else { 'Default Access' }
    return @{
        id           = $RoleResourceId
        displayName  = "$roleName on $($ServicePrincipal.displayName)"
        resourceType = 'AppRole'
        enabled      = $true
        extendedAttributes = @{
            applicationSpId        = $ServicePrincipal.id
            applicationDisplayName = $ServicePrincipal.displayName
            appRoleId              = $Role.id
            appRoleDisplayName     = $roleName
            appRoleValue           = $Role.value
        }
    }
}

# Builds the HasAppRole relationship (application -> app role).
# Verbatim from the inline `$relMap[$relKey] = @{ ... }` block.
function New-EntraAppRoleRelationshipRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        [Parameter(Mandatory)] [string]$RoleResourceId,
        [Parameter(Mandatory)] [string]$RoleName
    )
    return @{
        parentResourceId = $ServicePrincipal.id
        childResourceId  = $RoleResourceId
        relationshipType = 'HasAppRole'
        roleName         = $RoleName
        roleOriginSystem = 'EntraID'
    }
}

# Builds a Direct app-role assignment record for a User- or Group-typed principal
# (the two inline blocks were identical apart from principalType).
function New-EntraAppRoleAssignmentRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$RoleResourceId,
        [Parameter(Mandatory)] $Assignment,
        [Parameter(Mandatory)] [string]$RoleId,
        [Parameter(Mandatory)] [string]$PrincipalType,
        [string]$AppDisplayName
    )
    return @{
        resourceId     = $RoleResourceId
        principalId    = $Assignment.principalId
        principalType  = $PrincipalType
        assignmentType = 'Direct'
        resourceType   = 'AppRole'
        extendedAttributes = @{
            appRoleAssignmentId = $Assignment.id
            appRoleId           = $RoleId
            createdDateTime     = $Assignment.createdDateTime
            resourceDisplayName = $AppDisplayName
        }
    }
}

# Expands one group's app-role assignments to per-user Indirect AppRole rows — the
# cartesian product of the group's role assignments and its transitive user
# members. Verbatim from the inline nested `foreach ($roleAssn) { foreach ($uid) }`.
function ConvertTo-EntraAppRoleIndirectAssignments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $RoleAssignments,
        $UserIds,
        [Parameter(Mandatory)] [string]$GroupId
    )
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($roleAssn in $RoleAssignments) {
        foreach ($uid in $UserIds) {
            $out.Add(@{
                resourceId     = $roleAssn.roleResId
                principalId    = $uid
                principalType  = 'User'
                assignmentType = 'Indirect'
                resourceType   = 'AppRole'
                extendedAttributes = @{
                    viaGroupId          = $GroupId
                    appRoleId           = $roleAssn.roleId
                    sourceAssignmentId  = $roleAssn.sourceAssignmentId
                    resourceDisplayName = $roleAssn.appName
                }
            })
        }
    }
    return @($out)
}
