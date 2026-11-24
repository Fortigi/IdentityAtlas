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

    return $accessPackages
}
