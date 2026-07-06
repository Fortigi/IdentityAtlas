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

# Resolve the display/classification fields for one appRoleAssignment (pure). Split
# out of ConvertTo-EntraAppPermissionGraph so the graph builder's per-assignment loop
# stays under the cognitive-complexity ratchet — the value-coalescing (which is what
# drives the count up) lives here at nesting 0 instead of inside the foreach.
#   $AppRoleNameById maps "targetApiSpId|appRoleId" -> the permission name (e.g. "Mail.Read").
#   $SpInfo maps an SP id -> @{ displayName; principalType } (the crawler's classified type).
function Resolve-EntraAppPermissionFields {
    [CmdletBinding()]
    param(
        $Assignment,
        [hashtable]$AppRoleNameById = @{},
        [hashtable]$SpInfo = @{}
    )
    $clientId = $Assignment.principalId
    $targetId = $Assignment.resourceId
    $permName = $AppRoleNameById["$targetId|$($Assignment.appRoleId)"]
    if (-not $permName) { $permName = $Assignment.appRoleId }
    $clientInfo = $SpInfo[$clientId]
    $clientName = if ($clientInfo) { $clientInfo.displayName } else { $clientId }
    $clientType = if ($clientInfo -and $clientInfo.principalType) { $clientInfo.principalType } else { 'ServicePrincipal' }
    $targetName = if ($Assignment.resourceDisplayName) { $Assignment.resourceDisplayName }
                  elseif ($SpInfo[$targetId]) { $SpInfo[$targetId].displayName }
                  else { $targetId }
    return @{ permName = $permName; clientName = $clientName; clientType = $clientType; targetName = $targetName }
}

# Builds the application-permission graph from a service principal's appRoleAssignments
# (the app-only permissions it holds on other APIs). One ApplicationPermission resource
# per (clientSP, targetApiSP, appRole), a HasApplicationPermission relationship from the
# client Application, and a Direct assignment whose principal is the client SP itself
# (it holds the permission app-only). Mirrors ConvertTo-EntraOAuth2ScopeGraph.
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

        $f = Resolve-EntraAppPermissionFields -Assignment $a -AppRoleNameById $AppRoleNameById -SpInfo $SpInfo
        $permResId = New-AppPermissionResourceId -ClientSpId $clientId -TargetApiSpId $targetId -AppRoleId $appRoleId
        if (-not $resMap.ContainsKey($permResId)) {
            $resMap[$permResId] = @{
                id           = $permResId
                displayName  = (Format-FGApplicationPermissionName -Permission $f.permName -TargetName $f.targetName -ClientName $f.clientName)
                resourceType = 'ApplicationPermission'
                enabled      = $true
                extendedAttributes = @{ clientSpId = $clientId; clientDisplayName = $f.clientName; targetApiSpId = $targetId; targetApiDisplayName = $f.targetName; appRoleId = $appRoleId; permission = $f.permName }
            }
        }
        $relKey = "$clientId|$permResId"
        if (-not $relMap.ContainsKey($relKey)) {
            $relMap[$relKey] = @{ parentResourceId = $clientId; childResourceId = $permResId; relationshipType = 'HasApplicationPermission'; roleName = $f.permName; roleOriginSystem = 'AppRole' }
        }
        $assns.Add(@{
            resourceId     = $permResId
            principalId    = $clientId
            principalType  = $f.clientType
            assignmentType = 'Direct'
            resourceType   = 'ApplicationPermission'
            extendedAttributes = @{ assignmentId = $a.id; targetApiSpId = $targetId; targetApiDisplayName = $f.targetName; appRoleId = $appRoleId; permission = $f.permName }
        })
    }
    return @{
        resources     = @($resMap.Values)
        relationships = @($relMap.Values)
        assignments   = @($assns)
    }
}

# The human name of an appRole: its OAuth scope value (e.g. "Mail.Read"), else its
# display name, else the raw guid. Split out to keep Get-EntraAppPermissionIndex under
# the cognitive-complexity ratchet.
function Get-EntraAppRoleName {
    [CmdletBinding()]
    param($AppRole)
    if ($AppRole.value)       { return $AppRole.value }
    if ($AppRole.displayName) { return $AppRole.displayName }
    return $AppRole.id
}

# Build the lookup index from the service-principal list: spInfo (id -> @{ displayName;
# principalType }) via the classifier, appRoleNameById ("targetApiSpId|appRoleId" ->
# permission name, from every SP's own appRoles catalog — target APIs like Microsoft
# Graph are just SPs), and spById (id -> SP object, for ensure-exists). Pure.
function Get-EntraAppPermissionIndex {
    [CmdletBinding()]
    param([array]$Sps = @(), [string[]]$AINamePatterns = @())
    $spInfo = @{}; $appRoleNameById = @{}; $spById = @{}
    foreach ($sp in $Sps) {
        $pt = if (Get-Command Get-FGServicePrincipalType -ErrorAction SilentlyContinue) {
            Get-FGServicePrincipalType -ServicePrincipal $sp -AINamePatterns $AINamePatterns
        } else { 'ServicePrincipal' }
        $spInfo[$sp.id] = @{ displayName = $sp.displayName; principalType = $pt }
        $spById[$sp.id] = $sp
        foreach ($ar in @($sp.appRoles)) {
            if ($ar.id) {
                $appRoleNameById["$($sp.id)|$($ar.id)"] = Get-EntraAppRoleName -AppRole $ar
            }
        }
    }
    return @{ spInfo = $spInfo; appRoleNameById = $appRoleNameById; spById = $spById }
}

# ─── Sync Application Permissions phase ──────────────────────────
# The app-only permissions each service principal holds on other APIs (the sibling
# of DelegatedPermission). One servicePrincipals fetch yields every SP's display name,
# classification inputs, AND every API's appRoles catalog (Graph etc. are SPs too), so
# appRoleId -> permission-name resolution needs no extra calls. Each SP's
# /appRoleAssignments (what it HOLDS) is then fetched in parallel. Opt-in via
# SyncAppPermissions; runs after app-roles/OAuth2 so its ensure-exists Application
# upsert (delta) is the final word rather than clobbering their full-sync.
function Sync-EntraAppPermissions {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string[]]$AINamePatterns = @(),
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing application permissions..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing application permissions' -Pct 84 -Detail 'Fetching service principals from Microsoft Graph...'
    try {
        $sps = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,appRoles,appRoleAssignmentRequired,servicePrincipalType,accountEnabled,tags&`$top=999")
        Write-Host "  Service principals: $($sps.Count)" -ForegroundColor Gray
        $index = Get-EntraAppPermissionIndex -Sps $sps -AINamePatterns $AINamePatterns

        $records = @()
        if ($sps.Count -gt 0) {
            $result = Get-FGGroupChildrenParallel -Groups $sps -EntityType 'servicePrincipals' -ChildPath 'appRoleAssignments' `
                -Select 'id,principalId,resourceId,resourceDisplayName,appRoleId' -ThrottleLimit 16 `
                -ProgressStep 'Syncing application permissions' -ProgressStartPct 84 -ProgressEndPct 90 `
                -RecordBuilder { param($o) $o.raw }
            $records = @($result.records)
            if ($result.errorCount -gt 0) {
                Write-Host "  WARNING: $($result.errorCount) service principals failed during appRoleAssignments fetch (skipped)" -ForegroundColor Yellow
            }
        }

        $graph = ConvertTo-EntraAppPermissionGraph -Assignments $records -AppRoleNameById $index.appRoleNameById -SpInfo $index.spInfo

        # Ensure the parent Application resource exists for every SP that holds a
        # permission (delta upsert — the app-roles/OAuth2 phases own the Application
        # full-sync). Reuse the app-roles shaper so the record matches theirs.
        $holderSpIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($a in $graph.assignments) { [void]$holderSpIds.Add($a.principalId) }
        $appResources = @($holderSpIds | Where-Object { $index.spById.ContainsKey($_) } | ForEach-Object { ConvertTo-EntraAppRoleApplicationResource -ServicePrincipal $index.spById[$_] })

        Write-Host "  Application permissions: $($graph.assignments.Count) grants across $($graph.resources.Count) (SP, API, role) resources; $($appResources.Count) holder apps" -ForegroundColor Gray
        Send-EntraAppPermissionBatches -SystemId $SystemId -AppResources $appResources -Graph $graph
    }
    catch {
        Write-Host "  Application permission sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("AppPermissions: $($_.Exception.Message)")
        Write-Host "  (Requires Application.Read.All to read servicePrincipal appRoleAssignments.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['AppPermissions'] = $__phaseSW.Elapsed }
    $__err = $script:phaseErrors | Where-Object { $_.StartsWith('AppPermissions:') } | Select-Object -Last 1
    $__errMsg = if ($__err) { $__err.Substring('AppPermissions:'.Length).Trim() } else { $null }
    Write-Phase -Name 'AppPermissions' -Duration $__phaseSW.Elapsed -ErrorMsg $__errMsg
}

# Upload the application-permission graph. Parent Application resources are upserted
# with SyncMode 'delta' (non-reconciling). The ApplicationPermission resources, the
# HasApplicationPermission relationships, and the Direct assignments are each
# full-synced on their own phase-exclusive scope so a reconcile clears revoked grants.
function Send-EntraAppPermissionBatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [array]$AppResources = @(),
        [Parameter(Mandatory)] [hashtable]$Graph
    )
    if ($AppResources.Count -gt 0) {
        Update-CrawlerProgress -Detail "Ensuring $($AppResources.Count) holder-app resources exist..."
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'delta' `
            -Scope @{ resourceType = 'Application' } -Records $AppResources
    }
    Update-CrawlerProgress -Detail "Uploading application-permission resources..."
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ resourceType = 'ApplicationPermission' } -Records @($Graph.resources)
    Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ relationshipType = 'HasApplicationPermission' } -Records @($Graph.relationships)
    Update-CrawlerProgress -Detail "Uploading application-permission assignments..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Direct'; resourceType = 'ApplicationPermission' } -Records @($Graph.assignments)
}
