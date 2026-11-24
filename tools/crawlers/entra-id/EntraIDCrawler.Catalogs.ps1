<#
.SYNOPSIS
    Entra ID access package catalogs, as Catalog contexts.

.DESCRIPTION
    A catalog groups access packages (business roles). It is written as a synced
    context of the Catalog template (contextType AccessPackageCatalog, targetType
    Resource) whose members are its access packages, and whose id is the
    catalog's own id. The catalog's own properties go into extendedAttributes.

    Sync-EntraGovernanceCatalogs is the first governance sub-phase: it uploads
    the catalogs, the access packages as BusinessRole resources and the
    catalog -> access package memberships, and returns the raw access packages
    for the resource-scopes sub-phase.
#>

$script:EntraCatalogContextType = 'AccessPackageCatalog'

# One entitlement-management catalog -> an ingest/contexts record.
# The beta API reports the published state as catalogStatus ("Published"),
# v1.0 as state ("published"); either is kept as state.
function ConvertTo-EntraCatalogContextRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Catalog,
        [Parameter(Mandatory)] [int]$SystemId
    )
    $state = if ($Catalog.state) { $Catalog.state } else { $Catalog.catalogStatus }
    $attrs = [ordered]@{}
    if ($Catalog.catalogType)                     { $attrs['catalogType']         = $Catalog.catalogType }
    if ($state)                                   { $attrs['state']               = $state }
    if ($null -ne $Catalog.isExternallyVisible)   { $attrs['isExternallyVisible'] = [bool]$Catalog.isExternallyVisible }
    if ($Catalog.createdDateTime)                 { $attrs['createdDateTime']     = $Catalog.createdDateTime }
    if ($Catalog.modifiedDateTime)                { $attrs['modifiedDateTime']    = $Catalog.modifiedDateTime }
    return @{
        id                 = $Catalog.id
        externalId         = $Catalog.id
        variant            = 'synced'
        targetType         = 'Resource'
        contextType        = $script:EntraCatalogContextType
        contextCategory    = 'Catalog'
        displayName        = $Catalog.displayName
        description        = $Catalog.description
        scopeSystemId      = $SystemId
        extendedAttributes = $attrs
    }
}

# The catalog -> access package memberships, one per access package whose
# catalog was synced in this run (an access package pointing at a catalog the
# list did not return would name a context that does not exist).
function Get-EntraCatalogMemberRecords {
    [CmdletBinding()]
    param(
        $AccessPackages,
        [string[]]$CatalogIds = @()
    )
    $known = [System.Collections.Generic.HashSet[string]]::new([string[]]@($CatalogIds), [StringComparer]::OrdinalIgnoreCase)
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($ap in @($AccessPackages)) {
        if (-not $ap.id -or -not $ap.catalogId -or -not $known.Contains([string]$ap.catalogId)) { continue }
        $out.Add(@{ contextId = $ap.catalogId; memberType = 'Resource'; memberId = $ap.id; addedBy = 'sync' })
    }
    return @($out)
}

# ─── Governance: catalogs + access packages ──────────────────────
# Out-Nulls its ingest calls so it returns only the access packages.
function Sync-EntraGovernanceCatalogs {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId)

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (catalogs)..." -ForegroundColor Cyan
    $catalogs = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs?`$top=999")

    $catRecords = @($catalogs | ForEach-Object { ConvertTo-EntraCatalogContextRecord -Catalog $_ -SystemId $SystemId })
    Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ variant = 'synced'; contextType = $script:EntraCatalogContextType } -Records $catRecords | Out-Null

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access packages -> business roles)..." -ForegroundColor Cyan
    $accessPackages = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages?`$top=999"

    $apRecords = @($accessPackages | ForEach-Object { ConvertTo-EntraAccessPackageRecord -AccessPackage $_ })
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ resourceType = 'BusinessRole' } -Records $apRecords | Out-Null

    # After the resources, so every member names a business role that exists.
    $memberRecords = @(Get-EntraCatalogMemberRecords -AccessPackages $accessPackages -CatalogIds @($catRecords | ForEach-Object { $_.id }))
    Send-IngestBatch -Endpoint 'ingest/context-members' -SystemId $SystemId -SyncMode 'full' -Records $memberRecords | Out-Null
    Write-Host "  $($catRecords.Count) catalogs, $($apRecords.Count) access packages, $($memberRecords.Count) catalog memberships" -ForegroundColor Gray

    Sync-EntraCatalogRoles -SystemId $SystemId -CatalogIds @($catRecords | ForEach-Object { $_.id }) | Out-Null

    return $accessPackages
}

# ─── Catalog roles → Accountable / Responsible ───────────────────
# The built-in entitlement-management role definitions read here; their ids are
# the same in every tenant. A catalog reader answers for nothing and is left out,
# as are the access package assignment manager and the tenant-wide catalog creator.
$script:EntraCatalogRoleDefinitions = [ordered]@{
    'ae79f266-94d4-4dab-b730-feca7e132178' = 'CatalogOwner'
    '7f480852-ebdc-47d4-87de-0d8498384a83' = 'AccessPackageManager'
}

# The catalog id a role assignment is scoped to ('/AccessPackageCatalog/<id>'),
# or $null for a tenant-wide or other scope.
function Get-EntraCatalogIdFromScope {
    [CmdletBinding()]
    param([string]$AppScopeId)
    if ($AppScopeId -match '^/AccessPackageCatalog/([0-9a-fA-F-]{36})$') { return $Matches[1] }
    return $null
}

# Role assignments -> ingest/context-roles records, per synced catalog:
#   exactly one owner     -> that owner is Accountable
#   more than one owner   -> every owner is Responsible
#   access package manager -> Responsible (unless already named as an owner)
# An owner that is a group, not an account, still counts as an owner (two owners
# means nobody alone answers for the catalog); the ingest skips a holder that is
# not an account.
function ConvertTo-EntraCatalogRoleRecords {
    [CmdletBinding()]
    param(
        $Assignments,
        [string[]]$CatalogIds = @()
    )
    $byKey = [ordered]@{}
    foreach ($id in @($CatalogIds | Where-Object { $_ })) {
        $byKey[([string]$id).ToLowerInvariant()] = @{
            id = $id; owners = [System.Collections.Generic.List[string]]::new(); managers = [System.Collections.Generic.List[string]]::new()
        }
    }
    foreach ($a in @($Assignments)) { Add-EntraCatalogRoleHolder -Index $byKey -Assignment $a }
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $byKey.Values) { $out.AddRange([object[]]@(Get-EntraCatalogRoleRows -Entry $entry)) }
    return @($out)
}

# Files one role assignment under its catalog's owners or managers, once per
# principal; an assignment for another scope, role or catalog is ignored.
function Add-EntraCatalogRoleHolder {
    [CmdletBinding()]
    param([System.Collections.IDictionary]$Index, $Assignment)
    $catalogId = Get-EntraCatalogIdFromScope -AppScopeId $Assignment.appScopeId
    $kind = $script:EntraCatalogRoleDefinitions[[string]$Assignment.roleDefinitionId]
    if (-not $catalogId -or -not $kind -or -not $Assignment.principalId) { return }
    $entry = $Index[$catalogId.ToLowerInvariant()]
    if (-not $entry) { return }
    # Not `$list = if (...)`: an if-expression unrolls an empty list to $null.
    $list = $entry.managers
    if ($kind -eq 'CatalogOwner') { $list = $entry.owners }
    if (-not $list.Contains([string]$Assignment.principalId)) { $list.Add([string]$Assignment.principalId) }
}

# One catalog's owners and managers -> its role rows (the rules above).
function Get-EntraCatalogRoleRows {
    [CmdletBinding()]
    param([hashtable]$Entry)
    $ownerRole = 'Responsible'
    if ($Entry.owners.Count -eq 1) { $ownerRole = 'Accountable' }
    $managers = @($Entry.managers | Where-Object { -not $Entry.owners.Contains($_) })
    @($Entry.owners | ForEach-Object { @{ contextId = $Entry.id; role = $ownerRole; principalId = $_ } })
    @($managers | ForEach-Object { @{ contextId = $Entry.id; role = 'Responsible'; principalId = $_ } })
}

# Reads the catalog role assignments and states them as the catalogs' roles —
# a full sync, so an owner removed in Entra ID loses the role here too. A Graph
# failure sends nothing (an empty full sync would remove every catalog role)
# and is recorded as this sub-phase's error; the governance sync carries on.
function Sync-EntraCatalogRoles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string[]]$CatalogIds = @()
    )
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (catalog owners and managers)..." -ForegroundColor Cyan
    try {
        # Per catalog, every role on it; the owner / manager split happens here,
        # so the log shows which roles a catalog has even when none is mapped.
        $assignments = [System.Collections.Generic.List[object]]::new()
        foreach ($catalogId in @($CatalogIds | Where-Object { $_ })) {
            $page = Invoke-FGGetRequest -URI "https://graph.microsoft.com/v1.0/roleManagement/entitlementManagement/roleAssignments?`$filter=appScopeId eq '/AccessPackageCatalog/$catalogId'"
            foreach ($a in @($page)) { if ($a) { $assignments.Add($a) } }
        }
        $byRole = @($assignments | Group-Object roleDefinitionId | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', '
        if ($byRole) { Write-Host "  Role definitions on the catalogs: $byRole" -ForegroundColor Gray }
        $records = @(ConvertTo-EntraCatalogRoleRecords -Assignments $assignments -CatalogIds $CatalogIds)
        $result = Invoke-IngestAPI -Endpoint 'ingest/context-roles' -Body @{
            systemId = $SystemId; syncMode = 'full'; scope = @{ contextType = $script:EntraCatalogContextType }
            records  = [object[]]$records
        }
        Write-Host "  $($assignments.Count) role assignments -> $($records.Count) catalog roles (+$($result.inserted) -$($result.removed))" -ForegroundColor Gray
        Write-Phase -Name 'Governance/CatalogRoles' -Duration $sw.Elapsed -Records @{ catalogRoles = $records.Count }
    }
    catch {
        $msg = $_.Exception.Message
        Write-Host "  Catalog role sync failed: $msg" -ForegroundColor Yellow
        Write-Host "  (Reading catalog roles needs EntitlementManagement.Read.All.)" -ForegroundColor Yellow
        $script:phaseErrors.Add("Governance/CatalogRoles: $msg")
        Write-Phase -Name 'Governance/CatalogRoles' -Duration $sw.Elapsed -ErrorMsg $msg
    }
}
