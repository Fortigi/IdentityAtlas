<#
.SYNOPSIS
    Entra ID crawler — application-ownership feature (its own file so
    EntraIDCrawler.Transform.ps1 / .Phases.ps1 stay under the file-length ratchet).

.DESCRIPTION
    Owners of Entra applications, modelled as ownership resources hanging off the
    app's Application resource:

        Resources(Application)   <-- the enterprise app (SP), ensured to exist
          |- ResourceRelationships(HasAppOwnership)
               |- Resources(ServicePrincipalOwnership | ApplicationOwnership)
                    |- ResourceAssignments(Direct)   <-- one per owner

    Two ownership kinds, genuinely different:
      * ServicePrincipalOwnership — owners of the enterprise-app SP
        (/servicePrincipals/{id}/owners); manage the tenant instance.
      * ApplicationOwnership — owners of the app registration
        (/applications/{id}/owners), matched to the SP by appId; they can add a
        credential and authenticate AS the app (the classic priv-esc), so this is
        the security-relevant one.

    The Application resource is keyed by SP id. For an owned app that isn't already
    an Application resource (no app-roles / OAuth2 grants), a minimal Application
    record is upserted with SyncMode 'delta' — the app-roles + OAuth2 phases own the
    resourceType='Application' full-sync, so a reconcile here would clobber theirs.
    Sync-EntraAppOwners runs after those so its upsert is the final word. A distinct
    'HasAppOwnership' relationshipType keeps the group-owners full-sync (HasOwnership)
    from wiping these links — same reason AppRole uses 'HasAppRole' not 'Contains'.

    Dot-sourced by Start-EntraIDCrawler.ps1 (and auto-loaded by the dispatcher's
    *.ps1 glob). ConvertTo-EntraAppOwnershipGraph + the index/resolve helpers are
    pure/mockable; Sync-EntraAppOwners is thin phase orchestration.
#>

# Builds an app-ownership graph from raw (appResourceId, principalId) owner pairs:
# one ownership resource per owned app, a HasAppOwnership relationship to the app's
# Application resource, and a Direct owner assignment per pair. Returns a hashtable
# with .resources / .relationships / .assignments. Generic over the two app-ownership
# kinds — the caller passes the resourceType and the id/externalId seed prefix.
# Mirrors ConvertTo-EntraGroupOwnership. $ow.appResourceId is the SP-keyed Application
# resource id the ownership hangs off, resolved by the caller (the SP id for SP owners,
# the appId-matched SP id for app-registration owners).
function ConvertTo-EntraAppOwnershipGraph {
    [CmdletBinding()]
    param(
        $RawOwners,
        [hashtable]$AppNameById = @{},
        [Parameter(Mandatory)] [string]$ResourceType,   # 'ApplicationOwnership' | 'ServicePrincipalOwnership'
        [Parameter(Mandatory)] [string]$SeedPrefix       # 'entraid-app-ownership' | 'entraid-sp-ownership'
    )
    $resMap = @{}   # ownershipId -> resource record
    $relMap = @{}   # "appResourceId|ownershipId" -> relationship record
    $assns  = [System.Collections.Generic.List[object]]::new()
    foreach ($ow in $RawOwners) {
        if (-not $ow.appResourceId -or -not $ow.principalId) { continue }
        $ownId = ConvertTo-FGDeterministicUuid -Seed "${SeedPrefix}:$($ow.appResourceId)"
        if (-not $resMap.ContainsKey($ownId)) {
            $name = $AppNameById[$ow.appResourceId]
            if (-not $name) { $name = '(app)' }
            $resMap[$ownId] = @{
                id                 = $ownId
                displayName        = $name
                resourceType       = $ResourceType
                externalId         = "${SeedPrefix}:$($ow.appResourceId)"
                extendedAttributes = @{ ownedResourceId = $ow.appResourceId }
            }
            $relMap["$($ow.appResourceId)|$ownId"] = @{
                parentResourceId = $ow.appResourceId
                childResourceId  = $ownId
                relationshipType = 'HasAppOwnership'
            }
        }
        $assns.Add(@{
            resourceId     = $ownId
            principalId    = $ow.principalId
            assignmentType = 'Direct'
            resourceType   = $ResourceType
        })
    }
    return @{
        resources     = @($resMap.Values)
        relationships = @($relMap.Values)
        assignments   = @($assns)
    }
}

# Build the lookup maps from the service-principal list: appId -> SP id (the SP id is
# the Application resource id), SP id -> SP object (for ensure-exists), and SP id ->
# app displayName (for the ownership resource name). Pure — unit-testable directly.
function Get-EntraAppOwnerIndex {
    [CmdletBinding()]
    param([array]$Sps = @())
    $appIdToSpId = @{}
    $spById      = @{}
    $appNameById = @{}
    foreach ($sp in $Sps) {
        $spById[$sp.id]      = $sp
        $appNameById[$sp.id] = $sp.displayName
        if ($sp.appId) { $appIdToSpId[$sp.appId] = $sp.id }
    }
    return @{ appIdToSpId = $appIdToSpId; spById = $spById; appNameById = $appNameById }
}

# Fetch each service principal's owners in parallel and return the
# (appResourceId = spId, principalId) owner pairs. Empty when there are no SPs.
function Get-EntraSpOwnerPairs {
    [CmdletBinding()]
    param([array]$Sps = @())
    if ($Sps.Count -eq 0) { return @() }
    $result = Get-FGGroupChildrenParallel -Groups $Sps -EntityType 'servicePrincipals' -ChildPath 'owners' -ThrottleLimit 16 `
        -ProgressStep 'Syncing app owners' -ProgressStartPct 75 -ProgressEndPct 79 `
        -RecordBuilder { param($o) @{ appResourceId = $o.resourceId; principalId = $o.principalId } }
    if ($result.errorCount -gt 0) {
        Write-Host "  WARNING: $($result.errorCount) service principals failed during owner fetch (skipped)" -ForegroundColor Yellow
    }
    return @($result.records)
}

# Fetch each app registration's owners in parallel and resolve them to the SP-keyed
# Application resource via appId. Returns @{ pairs = @(...); unmatched = <int> } —
# app-reg owners whose appId has no service principal are counted and skipped.
function Resolve-EntraAppRegOwnerPairs {
    [CmdletBinding()]
    param([array]$Apps = @(), [hashtable]$AppIdToSpId = @{})
    $pairs = [System.Collections.Generic.List[object]]::new()
    $unmatched = 0
    if ($Apps.Count -eq 0) { return @{ pairs = @($pairs); unmatched = 0 } }

    $appIdByObjectId = @{}
    foreach ($a in $Apps) { $appIdByObjectId[$a.id] = $a.appId }

    $result = Get-FGGroupChildrenParallel -Groups $Apps -EntityType 'applications' -ChildPath 'owners' -ThrottleLimit 16 `
        -ProgressStep 'Syncing app owners' -ProgressStartPct 79 -ProgressEndPct 83 `
        -RecordBuilder { param($o) @{ appObjectId = $o.resourceId; principalId = $o.principalId } }
    if ($result.errorCount -gt 0) {
        Write-Host "  WARNING: $($result.errorCount) app registrations failed during owner fetch (skipped)" -ForegroundColor Yellow
    }
    foreach ($r in @($result.records)) {
        $appId = $appIdByObjectId[$r.appObjectId]
        $spId  = if ($appId) { $AppIdToSpId[$appId] } else { $null }
        if ($spId) { $pairs.Add(@{ appResourceId = $spId; principalId = $r.principalId }) }
        else { $unmatched++ }
    }
    return @{ pairs = @($pairs); unmatched = $unmatched }
}

# ─── Sync App Owners phase ───────────────────────────────────────
# Thin orchestration: fetch the SP + app-registration lists, resolve owners into
# ownership graphs (via the helpers above), ensure the parent Application resources
# exist, and upload. Opt-in via SyncAppOwners — owners are fetched per-SP / per-app
# (no bulk Graph endpoint), so this can be slow on large tenants.
function Sync-EntraAppOwners {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing app owners..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing app owners' -Pct 75 -Detail 'Fetching service principals from Microsoft Graph...'
    try {
        $sps = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,appId,displayName,servicePrincipalType,appRoleAssignmentRequired,accountEnabled&`$top=999")
        Write-Host "  Service principals: $($sps.Count)" -ForegroundColor Gray
        $index        = Get-EntraAppOwnerIndex -Sps $sps
        $spOwnerPairs = Get-EntraSpOwnerPairs -Sps $sps

        $apps = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/applications?`$select=id,appId,displayName&`$top=999")
        Write-Host "  App registrations: $($apps.Count)" -ForegroundColor Gray
        $appReg = Resolve-EntraAppRegOwnerPairs -Apps $apps -AppIdToSpId $index.appIdToSpId
        if ($appReg.unmatched -gt 0) {
            Write-Host "  ($($appReg.unmatched) app-registration owner rows had no matching service principal — skipped)" -ForegroundColor DarkGray
        }

        $spOwnership  = ConvertTo-EntraAppOwnershipGraph -RawOwners $spOwnerPairs -AppNameById $index.appNameById `
            -ResourceType 'ServicePrincipalOwnership' -SeedPrefix 'entraid-sp-ownership'
        $appOwnership = ConvertTo-EntraAppOwnershipGraph -RawOwners $appReg.pairs -AppNameById $index.appNameById `
            -ResourceType 'ApplicationOwnership' -SeedPrefix 'entraid-app-ownership'

        # Ensure the parent Application resource exists for every owned app (delta
        # upsert — the app-roles/OAuth2 phases own the Application full-sync). Reuse
        # the app-roles shaper so the record matches what SyncAppRoles would produce.
        $ownedSpIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($p in @($spOwnerPairs) + @($appReg.pairs)) { [void]$ownedSpIds.Add($p.appResourceId) }
        $appResources = @($ownedSpIds | Where-Object { $index.spById.ContainsKey($_) } | ForEach-Object { ConvertTo-EntraAppRoleApplicationResource -ServicePrincipal $index.spById[$_] })

        Write-Host "  SP owners: $($spOwnership.assignments.Count) · App-reg owners: $($appOwnership.assignments.Count) · Owned apps: $($appResources.Count)" -ForegroundColor Gray
        Send-EntraAppOwnerBatches -SystemId $SystemId -AppResources $appResources -SpOwnership $spOwnership -AppOwnership $appOwnership
    }
    catch {
        Write-Host "  App owner sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("AppOwners: $($_.Exception.Message)")
        Write-Host "  (Requires Application.Read.All to read app + service-principal owners.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['AppOwners'] = $__phaseSW.Elapsed }
    $__appOwnerErr = $script:phaseErrors | Where-Object { $_.StartsWith('AppOwners:') } | Select-Object -Last 1
    $__appOwnerErrMsg = if ($__appOwnerErr) { $__appOwnerErr.Substring('AppOwners:'.Length).Trim() } else { $null }
    Write-Phase -Name 'AppOwners' -Duration $__phaseSW.Elapsed -ErrorMsg $__appOwnerErrMsg
}

# Upload the app-ownership graph. The parent Application resources are upserted
# with SyncMode 'delta' (non-reconciling — the app-roles/OAuth2 phases own the
# resourceType='Application' full-sync). The two ownership resource types, the
# HasAppOwnership relationships, and the Direct owner assignments are each
# full-synced on their own phase-exclusive scope, sent unconditionally so a
# reconcile clears ownership for apps that lost all owners.
function Send-EntraAppOwnerBatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [array]$AppResources = @(),
        [Parameter(Mandatory)] [hashtable]$SpOwnership,
        [Parameter(Mandatory)] [hashtable]$AppOwnership
    )
    if ($AppResources.Count -gt 0) {
        Update-CrawlerProgress -Detail "Ensuring $($AppResources.Count) owned-app resources exist..."
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'delta' `
            -Scope @{ resourceType = 'Application' } -Records $AppResources
    }

    Update-CrawlerProgress -Detail "Uploading app ownership resources..."
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ resourceType = 'ServicePrincipalOwnership' } -Records @($SpOwnership.resources)
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ resourceType = 'ApplicationOwnership' } -Records @($AppOwnership.resources)

    Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ relationshipType = 'HasAppOwnership' } -Records @($SpOwnership.relationships + $AppOwnership.relationships)

    Update-CrawlerProgress -Detail "Uploading app owner assignments..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Direct'; resourceType = 'ServicePrincipalOwnership' } -Records @($SpOwnership.assignments)
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Direct'; resourceType = 'ApplicationOwnership' } -Records @($AppOwnership.assignments)
}
