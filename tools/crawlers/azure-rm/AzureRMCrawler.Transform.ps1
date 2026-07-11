<#
.SYNOPSIS
    Pure record-shapers for the Azure RM crawler.

.DESCRIPTION
    Deterministic mappers from Azure objects to Identity Atlas ingest records.
    They take everything as explicit parameters, do no network I/O and read no
    script scope, and `return` the record hashtable — so they unit-test directly
    with zero mocks. (Get-ScopeNodeId / Get-AzureResourceType from
    AzureRMCrawler.Functions.ps1 are pure too, so calling them keeps these pure.)

    Orchestration and the mutable cross-phase accumulators live in
    CSVCrawler-style phase functions in AzureRMCrawler.Phases.ps1.
#>

# Control-plane vs data-plane classification of a role definition's permissions.
# `actions` manage the resource (Owner/Contributor); `dataActions` read/write the
# data inside it (Storage Blob Data Reader, Key Vault Secrets User). A role can grant
# both. Lets the matrix answer "who has any data-plane access?".
function Get-AzureRolePlane {
    [CmdletBinding()]
    param($Permissions)
    $ctl  = @($Permissions | ForEach-Object { $_.actions }     | Where-Object { $_ })
    $data = @($Permissions | ForEach-Object { $_.dataActions } | Where-Object { $_ })
    if ($data.Count -gt 0 -and $ctl.Count -gt 0) { return 'both' }
    if ($data.Count -gt 0) { return 'data' }
    return 'control'
}

# Scope node for a scope at/above the subscription (management group or the tenant
# root '/'). $DisplayName is resolved by the caller (root → "Tenant Root", MG → its
# friendly name). Get-ScopeNodeId is deterministic, so this stays pure.
function New-AzureAboveSubScopeRecord {
    [CmdletBinding()]
    param([string]$ScopePath, [string]$DisplayName)
    $isRoot = ($ScopePath -eq '/')
    return @{
        id           = (Get-ScopeNodeId -ArmScopePath $ScopePath)
        displayName  = $DisplayName
        resourceType = if ($isRoot) { 'AzureScope' } else { 'AzureManagementGroup' }
        externalId   = $ScopePath
        extendedAttributes = @{
            armPath        = $ScopePath
            scopeKind      = if ($isRoot) { 'Root' } else { 'ManagementGroup' }
            scopeTypeLabel = if ($isRoot) { 'Root' } else { 'MG' }
        }
    }
}

# Scope node for a scope below the subscription (a resource group or an individual
# resource) discovered on demand from an assignment's declared scope.
function New-AzureBelowSubScopeRecord {
    [CmdletBinding()]
    param([string]$ScopePath)
    $isRg = ($ScopePath -match '^/subscriptions/[^/]+/resourceGroups/[^/]+$')
    $ext = @{
        armPath        = $ScopePath
        scopeKind      = if ($isRg) { 'ResourceGroup' } else { 'Resource' }
        scopeTypeLabel = if ($isRg) { 'RG' } else { 'Res' }
    }
    if (-not $isRg) { $ext['azureResourceType'] = (Get-AzureResourceType -ArmPath $ScopePath) }
    return @{
        id           = (Get-ScopeNodeId -ArmScopePath $ScopePath)
        displayName  = ($ScopePath -split '/')[-1]
        resourceType = if ($isRg) { 'AzureResourceGroup' } else { 'AzureResource' }
        externalId   = $ScopePath
        extendedAttributes = $ext
    }
}

# One synthetic "<role> @ <scope>" capability-resource per (scope, roleDefinition).
function New-AzureRoleAtScopeRecord {
    [CmdletBinding()]
    param([string]$CapResId, [string]$DisplayName, [string]$RoleDefId, [string]$ScopeNodeId, [string]$RoleName, [bool]$IsCustom, [string]$Plane)
    return @{
        id           = $CapResId
        displayName  = $DisplayName
        resourceType = 'AzureRoleAssignment'
        enabled      = $true
        extendedAttributes = @{ capabilityId = $RoleDefId; targetNodeId = $ScopeNodeId; roleName = $RoleName; isCustom = $IsCustom; plane = $Plane }
    }
}

# The grant (ResourceAssignment) for one Azure role assignment. Carries the ABAC
# condition (so a conditional grant reads as conditional) and provenance.
function New-AzureGrantRecord {
    [CmdletBinding()]
    param([string]$CapResId, $Assignment, [string]$PrincipalType)
    $aExt = @{ roleAssignmentId = $Assignment.name }
    if ($Assignment.properties.condition) {
        $aExt['condition'] = [string]$Assignment.properties.condition
        if ($Assignment.properties.conditionVersion) { $aExt['conditionVersion'] = [string]$Assignment.properties.conditionVersion }
    }
    if ($Assignment.properties.createdOn) { $aExt['createdOn'] = [string]$Assignment.properties.createdOn }
    if ($Assignment.properties.createdBy) { $aExt['createdBy'] = [string]$Assignment.properties.createdBy }
    return @{
        resourceId       = $CapResId
        principalId      = [string]$Assignment.properties.principalId
        assignmentType   = 'Direct'
        effect           = 'allow'
        propagationScope = 'selfAndDescendants'
        principalType    = $PrincipalType
        extendedAttributes = $aExt
    }
}

# Thin principal stub for a User / ServicePrincipal referenced by an assignment.
# Only Users assert principalType — Azure labels every workload identity
# 'ServicePrincipal', and asserting it would overwrite the Entra crawler's finer
# ManagedIdentity / AIAgent classification on a delta upsert.
function New-AzurePrincipalStub {
    [CmdletBinding()]
    param([string]$PrincipalId, [string]$PrincipalType)
    $stub = @{ id = $PrincipalId; accountEnabled = $true }
    if ($PrincipalType -eq 'User') { $stub['principalType'] = 'User' }
    return $stub
}
