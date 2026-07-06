<#
.SYNOPSIS
    Entra ID crawler — application-permission feature (its own file so
    EntraIDCrawler.Transform.ps1 / .Phases.ps1 stay under the file-length ratchet).

.DESCRIPTION
    The *app-only* (admin-consented) permissions a service principal holds on other
    APIs — the sibling of DelegatedPermission (which is delegated, on-behalf-of-a-user).
    e.g. an SP that holds `Mail.Read` on Microsoft Graph can read every mailbox
    tenant-wide, no user involved — the security-critical kind.

        Resources(Application)   <-- the client enterprise app (SP)
          |- ResourceRelationships(HasApplicationPermission)
               |- Resources(ApplicationPermission)   <-- one per (clientSP, targetAPI, appRole)
                    |- ResourceAssignments(Direct, principalType=ServicePrincipal)
                         <-- the client SP itself is the holder (app-only, no user)

    Sourced from /servicePrincipals/{id}/appRoleAssignments (what app roles THIS SP
    has been granted on other APIs). The appRoleId is resolved to its permission name
    (e.g. "Mail.Read") from the target API SP's appRoles catalog by the phase.

    Dot-sourced by Start-EntraIDCrawler.ps1 (and auto-loaded by the dispatcher's
    *.ps1 glob). ConvertTo-EntraAppPermissionGraph is pure — unit-tests with no mocks.
#>

# Deterministic UUID for a (clientSP, targetApiSP, appRole) ApplicationPermission
# resource — same md5->uuid scheme as New-OAuth2ScopeResourceId.
function New-AppPermissionResourceId {
    [CmdletBinding()]
    param([string]$ClientSpId, [string]$TargetApiSpId, [string]$AppRoleId)
    return ConvertTo-FGDeterministicUuid -Seed "entraid-app-permission:${ClientSpId}:${TargetApiSpId}:${AppRoleId}"
}

# Build the display name for an ApplicationPermission. One resource per (clientSP,
# targetApiSP, appRole), so the same permission held by many SPs is many distinct
# resources; including the holding SP keeps them apart in the resources grid.
function Format-FGApplicationPermissionName {
    [CmdletBinding()]
    param([string]$Permission, [string]$TargetName, [string]$ClientName)
    if ($ClientName) { "$Permission on $TargetName (via $ClientName)" }
    else { "$Permission on $TargetName" }
}

# Builds the application-permission graph from a service principal's appRoleAssignments
# (the app-only permissions it holds on other APIs). One ApplicationPermission resource
# per (clientSP, targetApiSP, appRole), a HasApplicationPermission relationship from the
# client Application, and a Direct assignment whose principal is the client SP itself
# (it holds the permission app-only). Mirrors ConvertTo-EntraOAuth2ScopeGraph.
#   $AppRoleNameById maps "targetApiSpId|appRoleId" -> the permission name (e.g. "Mail.Read"),
#     resolved by the caller from the target API SP's appRoles catalog.
#   $SpInfo maps an SP id -> @{ displayName; principalType } (the crawler's classified
#     principalType — ServicePrincipal / ManagedIdentity / AIAgent — so an AI agent's or
#     managed identity's permission is held by that principal type, not a flat SP).
function ConvertTo-EntraAppPermissionGraph {
    [CmdletBinding()]
    param(
        $Assignments,
        [hashtable]$AppRoleNameById = @{},
        [hashtable]$SpInfo = @{}
    )
    $resMap = @{}   # permResId -> resource record
    $relMap = @{}   # "clientId|permResId" -> relationship record
    $assns  = [System.Collections.Generic.List[object]]::new()
    foreach ($a in $Assignments) {
        $clientId  = $a.principalId    # the SP that HOLDS the permission
        $targetId  = $a.resourceId     # the target API SP (e.g. Microsoft Graph)
        $appRoleId = $a.appRoleId
        if (-not $clientId -or -not $targetId -or -not $appRoleId) { continue }

        $permName = $AppRoleNameById["$targetId|$appRoleId"]
        if (-not $permName) { $permName = $appRoleId }
        $clientInfo = $SpInfo[$clientId]
        $clientName = if ($clientInfo) { $clientInfo.displayName } else { $clientId }
        $clientType = if ($clientInfo -and $clientInfo.principalType) { $clientInfo.principalType } else { 'ServicePrincipal' }
        $targetName = if ($a.resourceDisplayName) { $a.resourceDisplayName }
                      elseif ($SpInfo[$targetId]) { $SpInfo[$targetId].displayName }
                      else { $targetId }

        $permResId = New-AppPermissionResourceId -ClientSpId $clientId -TargetApiSpId $targetId -AppRoleId $appRoleId
        if (-not $resMap.ContainsKey($permResId)) {
            $resMap[$permResId] = @{
                id           = $permResId
                displayName  = (Format-FGApplicationPermissionName -Permission $permName -TargetName $targetName -ClientName $clientName)
                resourceType = 'ApplicationPermission'
                enabled      = $true
                extendedAttributes = @{ clientSpId = $clientId; clientDisplayName = $clientName; targetApiSpId = $targetId; targetApiDisplayName = $targetName; appRoleId = $appRoleId; permission = $permName }
            }
        }
        $relKey = "$clientId|$permResId"
        if (-not $relMap.ContainsKey($relKey)) {
            $relMap[$relKey] = @{ parentResourceId = $clientId; childResourceId = $permResId; relationshipType = 'HasApplicationPermission'; roleName = $permName; roleOriginSystem = 'AppRole' }
        }
        $assns.Add(@{
            resourceId     = $permResId
            principalId    = $clientId
            principalType  = $clientType
            assignmentType = 'Direct'
            resourceType   = 'ApplicationPermission'
            extendedAttributes = @{ assignmentId = $a.id; targetApiSpId = $targetId; targetApiDisplayName = $targetName; appRoleId = $appRoleId; permission = $permName }
        })
    }
    return @{
        resources     = @($resMap.Values)
        relationships = @($relMap.Values)
        assignments   = @($assns)
    }
}
