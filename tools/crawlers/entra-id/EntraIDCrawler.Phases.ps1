<#
.SYNOPSIS
    Entra ID crawler sync-phase orchestrators, extracted from Start-EntraIDCrawler.ps1.

.DESCRIPTION
    Each Sync-Entra* function owns one top-level sync phase: it runs the phase's
    Graph reads (via the mockable Invoke-FG* SDK), shapes records through the pure
    ConvertTo-*/New-* functions in EntraIDCrawler.Transform.ps1, POSTs them through
    Send-IngestBatch, and records timing/outcome via the shared Write-Phase helper.

    These are dot-sourced into Start-EntraIDCrawler.ps1's own scope, so they read
    and write the same script-scope state ($script:phaseErrors, $script:phases) the
    inline blocks used to — exactly as Write-Phase in EntraIDCrawler.Functions.ps1
    already does. The phase bodies are unchanged from their original inline form;
    only the surrounding `if ($SyncX) { ... }` toggle stays in the entry point.

    Extracted into a standalone file so the phases can be unit-tested with Pester
    by mocking their command boundary (Invoke-FGGetRequest, Send-IngestBatch,
    Get-FGGroupChildrenParallel, Update-CrawlerProgress) — see
    test/unit/EntraIDCrawlerPhases.Tests.ps1. This also pulls a large amount of
    cyclomatic complexity out of the entry point's top-level script body (the
    untestable I/O-on-load shell).

    Most phases are self-contained "leaf" phases: they take only -SystemId (+ the
    shared -Timings accumulator) and emit ingest calls. The exception is the
    group pipeline — Sync-EntraResources fetches the groups once and RETURNS them
    so Sync-EntraAssignments (and the PIM phase) can reuse them without a second
    Graph pass, matching the original inline order where $groups was set in the
    Resources block and read by the later blocks.
#>

# ─── Sync OAuth2 Delegated Grants ────────────────────────────────
# Per-user consent grants: user authorized client-app X to call target-API Y on
# their behalf with scope Z. Modelled as a child-resource tree:
#
#     Resources(Application)           <-- client SP (the app that got delegated-to)
#       └─ ResourceRelationships(DelegatesScope)
#            └─ Resources(DelegatedPermission)   <-- synthetic per (client, api, scope)
#                 └─ ResourceAssignments(OAuth2Grant)  <-- one row per consenting user
#
# The scope resource ID is deterministic over (clientSpId, targetApiSpId, scope)
# so re-runs idempotently overwrite the same rows. Tenant-wide consents
# (consentType='AllPrincipals', principalId=null) are skipped — they don't
# represent a user-specific decision. A distinct relationshipType (
# 'DelegatesScope' not 'Contains') keeps the scoped full-sync delete from
# wiping out the Access Package 'Contains' relationships produced by the
# governance sync above.
function Sync-EntraOAuth2Grants {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing OAuth2 delegated grants..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing OAuth2 grants' -Pct 72 -Detail 'Fetching from Microsoft Graph...'

    # Deterministic UUID v3-style over MD5 — mirrors normalizeRecords in
    # app/api/src/ingest/normalization.js so the same input always yields the
    # same ID whether generated here or server-side.
    try {
        $grants = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/oauth2PermissionGrants?`$top=999"
        $total = @($grants).Count
        Write-Host "  Fetched $total OAuth2 permission grants" -ForegroundColor Gray

        # Keep only per-user consents — AllPrincipals are tenant-wide admin
        # consents that we explicitly skip (they don't reflect an individual
        # user's authorization decision).
        $userGrants = @($grants | Where-Object { $_.consentType -eq 'Principal' -and $_.principalId })
        Write-Host "  $($userGrants.Count) per-user consents (skipping $($total - $userGrants.Count) tenant-wide)" -ForegroundColor Gray

        if ($userGrants.Count -eq 0) {
            Write-Host "  Nothing to ingest" -ForegroundColor Yellow
        }
        else {
            $spInfo = Get-EntraOAuth2SpInfo -UserGrants $userGrants
            Send-EntraOAuth2GrantRecords -UserGrants $userGrants -SpInfo $spInfo -SystemId $SystemId
        }
    }
    catch {
        Write-Host "  OAuth2 grant sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("OAuth2Grants: $($_.Exception.Message)")
        Write-Host "  (Requires DelegatedPermissionGrant.Read.All on the app registration.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['OAuth2Grants'] = $__phaseSW.Elapsed }
    $__oauthErr = $script:phaseErrors | Where-Object { $_.StartsWith('OAuth2Grants:') } | Select-Object -Last 1
    $__oauthErrMsg = if ($__oauthErr) { $__oauthErr.Substring('OAuth2Grants:'.Length).Trim() } else { $null }
    Write-Phase -Name 'OAuth2Grants' -Duration $__phaseSW.Elapsed -ErrorMsg $__oauthErrMsg
}

# Resolve every client/target SP referenced by the user grants to its displayName /
# appId / publisherName. Fetched one at a time (Graph's `$filter id in (...)` on
# servicePrincipals caps at 15 + a tight URL limit); a deleted/inaccessible SP falls
# back to its raw id so the grant stays ingestible. Returns spId -> info hashtable.
function Get-EntraOAuth2SpInfo {
    [CmdletBinding()]
    param($UserGrants)
    $spIds = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($g in $UserGrants) {
        if ($g.clientId)   { [void]$spIds.Add($g.clientId) }
        if ($g.resourceId) { [void]$spIds.Add($g.resourceId) }
    }
    Update-CrawlerProgress -Detail "Resolving $($spIds.Count) service principals..."
    $spInfo = @{}
    foreach ($id in $spIds) {
        try {
            $sp = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals/$id`?`$select=id,displayName,appId,publisherName"
            if ($sp) { $spInfo[$id] = @{ displayName = $sp.displayName; appId = $sp.appId; publisherName = $sp.publisherName } }
        } catch {
            $spInfo[$id] = @{ displayName = $id; appId = $null; publisherName = $null }
        }
    }
    return $spInfo
}

# Emit the OAuth2 grant graph: client-app Resources, per-(client,api,scope)
# DelegatedPermission Resources + DelegatesScope relationships, and the deduped
# grant assignments. Shaping lives in ConvertTo-EntraOAuth2ClientResource /
# ConvertTo-EntraOAuth2ScopeGraph.
function Send-EntraOAuth2GrantRecords {
    [CmdletBinding()]
    param($UserGrants, [hashtable]$SpInfo, [int]$SystemId)
    $clientIds = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($g in $UserGrants) { [void]$clientIds.Add($g.clientId) }
    $clientRecords = @($clientIds | ForEach-Object { ConvertTo-EntraOAuth2ClientResource -ClientId $_ -SpInfo $SpInfo[$_] })
    Update-CrawlerProgress -Detail "Uploading $($clientRecords.Count) client apps..."
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' -Scope @{ resourceType = 'Application' } -Records $clientRecords

    $scopeGraph = ConvertTo-EntraOAuth2ScopeGraph -UserGrants $UserGrants -SpInfo $SpInfo
    $scopeRecords = @($scopeGraph.resources)
    Update-CrawlerProgress -Detail "Uploading $($scopeRecords.Count) scope resources..."
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' -Scope @{ resourceType = 'DelegatedPermission' } -Records $scopeRecords

    $relRecords = @($scopeGraph.relationships)
    Update-CrawlerProgress -Detail "Uploading $($relRecords.Count) scope relationships..."
    Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' -Scope @{ relationshipType = 'DelegatesScope' } -Records $relRecords

    # Dedupe assignments on PK (resourceId, principalId) — one multi-scope grant is
    # split into N rows, so different (client, api) combos could collide.
    $seen = @{}
    $assignRecords = @($scopeGraph.assignments | Where-Object {
        $k = "$($_.resourceId)|$($_.principalId)"
        if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true }
    })
    Update-CrawlerProgress -Detail "Uploading $($assignRecords.Count) OAuth2 grant assignments..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' -Scope @{ assignmentType = 'Direct'; resourceType = 'DelegatedPermission' } -Records $assignRecords
}

# ─── Sync App Role Assignments ───────────────────────────────────
# For each enterprise application (servicePrincipal), pull the appRoles[]
# catalog and the assignments to users/groups. Modelled as:
#
#     Resources(Application)          <-- the enterprise app (SP)
#       └─ ResourceRelationships(HasAppRole)
#            └─ Resources(AppRole)    <-- synthetic per (SP, appRoleId)
#                 └─ ResourceAssignments(AppRole | AppRoleViaGroup)
#
# Group-typed assignments are expanded server-side from /transitiveMembers,
# emitted as `AppRoleViaGroup` rows per member so the matrix can show
# indirect access without a recursive matview. ServicePrincipal-typed
# assignments are skipped — the data model doesn't support SP-as-principal
# yet, and they're rare.
#
# Resource IDs are deterministic over (spId, appRoleId) so re-runs
# idempotently overwrite the same rows. A distinct relationshipType
# ('HasAppRole' not 'Contains') prevents the scoped full-sync delete
# from wiping out Access Package 'Contains' relationships.
# Fold one /appRoleAssignedTo row into the cross-SP accumulator maps/lists.
# Mutates the passed collections in place (hashtables/lists are reference
# types) so the caller's per-SP loop stays flat. Split out of the loop so the
# roleId-resolution + placeholder-synth + User/Group switch is unit-testable
# on its own and doesn't inflate Get-EntraAppRoleAssignmentData's complexity.
function Add-EntraAppRoleAssignment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Assignment,
        [Parameter(Mandatory)] $ServicePrincipal,
        [Parameter(Mandatory)] [hashtable]$RolesByGuid,
        [Parameter(Mandatory)] [string]$DefaultRoleId,
        [Parameter(Mandatory)] [hashtable]$AppRoleMap,
        [Parameter(Mandatory)] [hashtable]$RelMap,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [System.Collections.Generic.List[object]]$DirectAssns,
        [Parameter(Mandatory)] [hashtable]$GroupAssns
    )
    $a = $Assignment
    $sp = $ServicePrincipal
    $roleId = $a.appRoleId
    if (-not $roleId) { $roleId = $DefaultRoleId }
    if (-not $RolesByGuid.ContainsKey($roleId)) {
        # Role not in the SP's catalog (rare — usually means a custom role was
        # added/removed between calls). Synth a placeholder so the assignment
        # still has a target.
        $RolesByGuid[$roleId] = [PSCustomObject]@{
            id          = $roleId
            displayName = "Role $roleId"
            value       = $null
        }
    }
    $role = $RolesByGuid[$roleId]
    $roleResId = New-AppRoleResourceId -SpId $sp.id -AppRoleId $roleId

    if (-not $AppRoleMap.ContainsKey($roleResId)) {
        $roleName = if ($role.displayName) { $role.displayName } else { 'Default Access' }
        $AppRoleMap[$roleResId] = New-EntraAppRoleResourceRecord -ServicePrincipal $sp -Role $role -RoleResourceId $roleResId
        $relKey = "$($sp.id)|$roleResId"
        if (-not $RelMap.ContainsKey($relKey)) {
            $RelMap[$relKey] = New-EntraAppRoleRelationshipRecord -ServicePrincipal $sp -RoleResourceId $roleResId -RoleName $roleName
        }
    }

    switch ($a.principalType) {
        'User' {
            $DirectAssns.Add((New-EntraAppRoleAssignmentRecord -RoleResourceId $roleResId -Assignment $a -RoleId $roleId -PrincipalType 'User' -AppDisplayName $sp.displayName))
        }
        'Group' {
            if (-not $GroupAssns.ContainsKey($a.principalId)) {
                $GroupAssns[$a.principalId] = [System.Collections.Generic.List[object]]::new()
            }
            $GroupAssns[$a.principalId].Add(@{
                roleResId          = $roleResId
                roleId             = $roleId
                sourceAssignmentId = $a.id
                appName            = $sp.displayName
            })
            # Also store the group→AppRole edge itself (principal=group) so the
            # matrix's "expand group" feature can fan out the app roles a group
            # grants to its members. The matrix grid itself filters out
            # group-typed principals via its INNER JOIN to Principals, so this
            # row only surfaces in the nested-groups expand — not a stray column.
            $DirectAssns.Add((New-EntraAppRoleAssignmentRecord -RoleResourceId $roleResId -Assignment $a -RoleId $roleId -PrincipalType 'Group' -AppDisplayName $sp.displayName))
        }
        default {
            # ServicePrincipal or other — skip for v1.
        }
    }
}

# Expand every group-typed AppRole assignment to per-user AppRoleViaGroup rows.
# One /transitiveMembers call per unique group resolves nested groups for free
# (Graph expands member groups server-side). Returns the flat list of indirect
# assignment records.
function Expand-EntraAppRoleGroupAssignments {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$GroupAssns)

    $indirectAssns = [System.Collections.Generic.List[object]]::new()
    $groupCount = $GroupAssns.Keys.Count
    if ($groupCount -gt 0) {
        Update-CrawlerProgress -Detail "Expanding $groupCount group(s) to per-user rows..."
        Write-Host "  Expanding $groupCount group-typed assignment(s) via /transitiveMembers" -ForegroundColor Gray
    }
    foreach ($groupId in $GroupAssns.Keys) {
        try {
            $members = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/groups/$groupId/transitiveMembers?`$select=id&`$top=999")
        } catch {
            Write-Host "    /transitiveMembers failed for group $groupId : $($_.Exception.Message)" -ForegroundColor DarkYellow
            continue
        }
        $userIds = @($members |
            Where-Object { $_.'@odata.type' -eq '#microsoft.graph.user' } |
            ForEach-Object { $_.id })
        foreach ($r in (ConvertTo-EntraAppRoleIndirectAssignments -RoleAssignments $GroupAssns[$groupId] -UserIds $userIds -GroupId $groupId)) {
            $indirectAssns.Add($r)
        }
    }
    return $indirectAssns
}

# Enumerate enterprise apps, fetch each one's appRoleAssignedTo rows, and build
# the full set of ingest records: Application resources, AppRole resources,
# HasAppRole relationships, and the direct + via-group assignments (deduped on
# the (resourceId, principalId) PK). All Graph I/O for the phase lives here.
# Returns a hashtable of the five record arrays.
function Get-EntraAppRoleAssignmentData {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$DefaultRoleId)

    # Enumerate all SPs and keep the ones that look like enterprise apps: they
    # either define appRoles[] or require role assignment to use. Graph's
    # /servicePrincipals can return tens of thousands of rows on a large
    # tenant; the $select keeps payload size small.
    $sps = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,appRoles,appRoleAssignmentRequired,servicePrincipalType,tags&`$top=999"
    $allSps = @($sps)
    Write-Host "  Fetched $($allSps.Count) service principals" -ForegroundColor Gray

    $candidateSps = @($allSps | Where-Object {
        ($_.appRoles -and @($_.appRoles).Count -gt 0) -or $_.appRoleAssignmentRequired
    })
    Write-Host "  $($candidateSps.Count) enterprise apps with role catalogs / required assignment" -ForegroundColor Gray

    # Buckets accumulated across all SPs, then uploaded in one batch each.
    $appResourceMap   = @{}   # spId        -> Application Resource record
    $appRoleMap       = @{}   # roleResId   -> AppRole Resource record
    $relMap           = @{}   # "spId|roleResId" -> relationship record
    $directAssns      = [System.Collections.Generic.List[object]]::new()
    $groupAssns       = @{}   # groupId -> list of { roleResId, roleId, sourceAssignmentId }

    $spProcessed = 0
    foreach ($sp in $candidateSps) {
        $spProcessed++
        if (($spProcessed % 25) -eq 0) {
            Update-CrawlerProgress -Detail "Inspecting app $spProcessed of $($candidateSps.Count)..."
        }
        Add-EntraSpAppRoleData -Sp $sp -DefaultRoleId $DefaultRoleId `
            -AppResourceMap $appResourceMap -AppRoleMap $appRoleMap -RelMap $relMap `
            -DirectAssns $directAssns -GroupAssns $groupAssns
    }

    $indirectAssns = Expand-EntraAppRoleGroupAssignments -GroupAssns $groupAssns

    # Dedupe on PK (resourceId, principalId, assignmentType). Within one sync the same
    # (user, role) arrives twice if the user is in two groups assigned the same role.
    $directRecords   = Select-FGDistinct -Items $directAssns   -Key { "$($_.resourceId)|$($_.principalId)" }
    $indirectRecords = Select-FGDistinct -Items $indirectAssns -Key { "$($_.resourceId)|$($_.principalId)" }

    return @{
        appRecords      = @($appResourceMap.Values)
        roleRecords     = @($appRoleMap.Values)
        relRecords      = @($relMap.Values)
        directRecords   = $directRecords
        indirectRecords = $indirectRecords
    }
}

# Fold one enterprise app's role catalog + assignments into the cross-SP accumulators
# (all mutated in place). SPs with no assignments are skipped entirely (no empty
# Application/AppRole rows); a failed /appRoleAssignedTo fetch is logged and skipped.
function Add-EntraSpAppRoleData {
    [CmdletBinding()]
    param($Sp, [string]$DefaultRoleId, [hashtable]$AppResourceMap, [hashtable]$AppRoleMap, [hashtable]$RelMap, $DirectAssns, [hashtable]$GroupAssns)
    # Always include the "default access" role — SPs with appRoleAssignmentRequired=true
    # but no custom roles fall back to the zero-GUID role id.
    $rolesByGuid = Get-EntraAppRoleCatalog -ServicePrincipal $Sp -DefaultRoleId $DefaultRoleId
    $assignments = @()
    try {
        $assignments = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals/$($Sp.id)/appRoleAssignedTo?`$top=999")
    } catch {
        Write-Host "    /appRoleAssignedTo failed for $($Sp.displayName): $($_.Exception.Message)" -ForegroundColor DarkYellow
        return
    }
    if ($assignments.Count -eq 0) { return }
    # Emit the Application Resource (idempotent — the OAuth2 phase may have written it; the endpoint upserts).
    if (-not $AppResourceMap.ContainsKey($Sp.id)) {
        $AppResourceMap[$Sp.id] = ConvertTo-EntraAppRoleApplicationResource -ServicePrincipal $Sp
    }
    foreach ($a in $assignments) {
        Add-EntraAppRoleAssignment -Assignment $a -ServicePrincipal $Sp -RolesByGuid $rolesByGuid -DefaultRoleId $DefaultRoleId `
            -AppRoleMap $AppRoleMap -RelMap $RelMap -DirectAssns $DirectAssns -GroupAssns $GroupAssns
    }
}

# Upload the five AppRole record sets, each to its scoped full-sync endpoint.
# Empty sets are skipped so an empty bucket can't trigger a delete-everything
# reconcile of that scope.
function Send-EntraAppRoleBatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [array]$AppRecords,
        [array]$RoleRecords,
        [array]$RelRecords,
        [array]$DirectRecords,
        [array]$IndirectRecords
    )
    if ($AppRecords.Count -gt 0) {
        Update-CrawlerProgress -Detail "Uploading $($AppRecords.Count) enterprise apps..."
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'Application' } -Records $AppRecords
    }
    if ($RoleRecords.Count -gt 0) {
        Update-CrawlerProgress -Detail "Uploading $($RoleRecords.Count) app roles..."
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'AppRole' } -Records $RoleRecords
    }
    if ($RelRecords.Count -gt 0) {
        Update-CrawlerProgress -Detail "Uploading $($RelRecords.Count) app→role relationships..."
        Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ relationshipType = 'HasAppRole' } -Records $RelRecords
    }
    if ($DirectRecords.Count -gt 0) {
        Update-CrawlerProgress -Detail "Uploading $($DirectRecords.Count) direct app-role assignments..."
        Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ assignmentType = 'Direct'; resourceType = 'AppRole' } -Records $DirectRecords
    }
    if ($IndirectRecords.Count -gt 0) {
        Update-CrawlerProgress -Detail "Uploading $($IndirectRecords.Count) indirect (via-group) app-role assignments..."
        Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ assignmentType = 'Indirect'; resourceType = 'AppRole' } -Records $IndirectRecords
    }
}

function Sync-EntraAppRoles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing app role assignments..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing app role assignments' -Pct 74 -Detail 'Fetching enterprise apps from Microsoft Graph...'

    # Deterministic UUID v3-style over MD5 — same approach as the OAuth2
    # scope IDs. Mirrors normalizeRecords in app/api/src/ingest/normalization.js.
    $DEFAULT_ROLE_ID = '00000000-0000-0000-0000-000000000000'

    try {
        $data = Get-EntraAppRoleAssignmentData -DefaultRoleId $DEFAULT_ROLE_ID

        Write-Host "  Apps: $($data.appRecords.Count) · App roles: $($data.roleRecords.Count) · Direct: $($data.directRecords.Count) · ViaGroup: $($data.indirectRecords.Count)" -ForegroundColor Gray

        Send-EntraAppRoleBatches -SystemId $SystemId `
            -AppRecords $data.appRecords -RoleRecords $data.roleRecords -RelRecords $data.relRecords `
            -DirectRecords $data.directRecords -IndirectRecords $data.indirectRecords
    }
    catch {
        Write-Host "  App role sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("AppRoles: $($_.Exception.Message)")
        Write-Host "  (Requires Application.Read.All on the app registration.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['AppRoles'] = $__phaseSW.Elapsed }
    $__appRoleErr = $script:phaseErrors | Where-Object { $_.StartsWith('AppRoles:') } | Select-Object -Last 1
    $__appRoleErrMsg = if ($__appRoleErr) { $__appRoleErr.Substring('AppRoles:'.Length).Trim() } else { $null }
    Write-Phase -Name 'AppRoles' -Duration $__phaseSW.Elapsed -ErrorMsg $__appRoleErrMsg
}

# ─── Sync Directory Roles ────────────────────────────────────────
# Entra ID directory roles (Global Administrator, Privileged Role
# Administrator, etc.). Three Graph reads, modelled as:
#
#     Resources(EntraDirectoryRole)   <-- one per roleDefinition (id = roleDefinitionId)
#       └─ ResourceAssignments(DirectoryRole)          <-- active (permanent or PIM-activated)
#       └─ ResourceAssignments(DirectoryRoleEligible)  <-- PIM eligible (not yet active)
#
# Each role Resource stores its granular permission actions
# (rolePermissions[].allowedResourceActions, flattened + de-duped) in
# extendedAttributes so a later risk-scoring pass can tier a role by what
# it can actually do (EAM Control/Management plane), not just its name.
#
# Distinct assignment types ('DirectoryRole' / 'DirectoryRoleEligible')
# rather than reusing 'Direct' / 'Eligible' so the scoped full-sync delete
# keys on them without wiping group memberships or PIM-group eligibilities —
# the same reason AppRole uses a distinct type. The matrix view collapses
# them to Direct/Eligible badges (migration 043).
#
# Group-typed assignments (a role-assignable group granted a role) are
# recorded against the group principal but NOT yet expanded to per-member
# rows — that's a follow-up, mirroring how the matrix shows group-typed
# AppRole rows only in the nested-group expand.
function Sync-EntraDirectoryRoles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing directory roles..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing directory roles' -Pct 75 -Detail 'Fetching role definitions from Microsoft Graph...'

    try {
        # 1. Role catalog. /roleDefinitions returns built-in roles + any custom roles.
        $roleDefs = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/roleManagement/directory/roleDefinitions")
        Write-Host "  Fetched $($roleDefs.Count) role definitions" -ForegroundColor Gray
        $roleRecords = @($roleDefs | ForEach-Object { ConvertTo-EntraRoleResourceRecord -RoleDefinition $_ })

        # 2. Active assignments (permanent + currently-activated PIM). $expand=principal
        #    carries the principal @odata.type so we set principalType without a lookup.
        $activeList = Get-EntraShapedGraphRecords -URI "https://graph.microsoft.com/beta/roleManagement/directory/roleAssignments?`$expand=principal" `
            -Shaper { param($x) ConvertTo-EntraDirectoryRoleAssignment -RoleAssignment $x } -FailMessage "    /roleAssignments failed:"
        # 3. PIM-eligible assignments. Tenants without PIM (no Entra ID P2) 400/403 here — non-fatal.
        $eligibleList = Get-EntraShapedGraphRecords -URI "https://graph.microsoft.com/beta/roleManagement/directory/roleEligibilityScheduleInstances?`$expand=principal" `
            -Shaper { param($x) ConvertTo-EntraDirectoryRoleEligibility -Eligibility $x } -FailMessage "    /roleEligibilityScheduleInstances failed (PIM may be unavailable):"

        # Dedupe on the assignment PK (resourceId, principalId, assignmentType). The
        # same principal can hold one role at multiple scopes; the PK has no scope
        # component, so collapse to the first (tenant-wide is the dominant case).
        $activeRecords   = Select-FGDistinct -Items $activeList   -Key { "$($_.resourceId)|$($_.principalId)" }
        $eligibleRecords = Select-FGDistinct -Items $eligibleList -Key { "$($_.resourceId)|$($_.principalId)" }

        Write-Host "  Roles: $($roleRecords.Count) · Active: $($activeRecords.Count) · Eligible: $($eligibleRecords.Count)" -ForegroundColor Gray

        Send-EntraRecordsIfAny -Records $roleRecords -Endpoint 'ingest/resources' -SystemId $SystemId `
            -Scope @{ resourceType = 'EntraDirectoryRole' } -Detail "Uploading $($roleRecords.Count) directory roles..."
        Send-EntraRecordsIfAny -Records $activeRecords -Endpoint 'ingest/resource-assignments' -SystemId $SystemId `
            -Scope @{ assignmentType = 'Direct'; resourceType = 'EntraDirectoryRole' } -Detail "Uploading $($activeRecords.Count) active role assignments..."
        Send-EntraRecordsIfAny -Records $eligibleRecords -Endpoint 'ingest/resource-assignments' -SystemId $SystemId `
            -Scope @{ assignmentType = 'Eligible'; resourceType = 'EntraDirectoryRole' } -Detail "Uploading $($eligibleRecords.Count) eligible role assignments..."
    }
    catch {
        Write-Host "  Directory role sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("DirectoryRoles: $($_.Exception.Message)")
        Write-Host "  (Requires RoleManagement.Read.Directory or Directory.Read.All; eligible assignments also need RoleEligibilitySchedule.Read.Directory.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['DirectoryRoles'] = $__phaseSW.Elapsed }
    $__dirRoleErr = $script:phaseErrors | Where-Object { $_.StartsWith('DirectoryRoles:') } | Select-Object -Last 1
    $__dirRoleErrMsg = if ($__dirRoleErr) { $__dirRoleErr.Substring('DirectoryRoles:'.Length).Trim() } else { $null }
    Write-Phase -Name 'DirectoryRoles' -Duration $__phaseSW.Elapsed -ErrorMsg $__dirRoleErrMsg
}

# Fetch a Graph collection and shape each item via $Shaper (returns $null to skip);
# a failed fetch is logged with $FailMessage and yields an empty list (non-fatal).
function Get-EntraShapedGraphRecords {
    [CmdletBinding()]
    param([string]$URI, [scriptblock]$Shaper, [string]$FailMessage)
    $list = [System.Collections.Generic.List[object]]::new()
    try {
        $items = @(Invoke-FGGetRequest -URI $URI)
        foreach ($it in $items) {
            $rec = $Shaper.Invoke($it)[0]
            if ($rec) { $list.Add($rec) }
        }
    } catch {
        Write-Host "$FailMessage $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
    return $list
}

# Send a scoped full-sync batch only when there are records — an empty batch would
# trigger a delete-everything reconcile of that scope. Emits the progress detail first.
function Send-EntraRecordsIfAny {
    [CmdletBinding()]
    param([array]$Records, [string]$Endpoint, [int]$SystemId, [hashtable]$Scope, [string]$Detail)
    if (-not $Records -or $Records.Count -eq 0) { return }
    Update-CrawlerProgress -Detail $Detail
    Send-IngestBatch -Endpoint $Endpoint -SystemId $SystemId -SyncMode 'full' -Scope $Scope -Records $Records
}

# ─── Sync Resources (Groups) ─────────────────────────────────────
# Fetches all groups, uploads them as Group resources, and RETURNS the raw
# group objects so the Assignments and PIM phases can reuse them without a second
# Graph pass (preserving the original inline order where $groups was set here and
# read by the later blocks). Returns whatever Graph returned (or nothing on a
# failed fetch — the phase is recorded failed and the caller sees empty groups).
function Sync-EntraResources {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string[]]$CustomGroupAttributes = @(),
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing resources (groups)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing groups' -Pct 20 -Detail 'Fetching groups from Microsoft Graph...'
    $groups = @()
    try {
        $coreGroupAttrs = @('id','displayName','description','mail','visibility','createdDateTime','groupTypes','securityEnabled','mailEnabled','membershipRule','membershipRuleProcessingState','onPremisesSyncEnabled','resourceProvisioningOptions')
        $allGroupAttrs = $coreGroupAttrs + $CustomGroupAttributes | Select-Object -Unique
        $groupSelect = $allGroupAttrs -join ','
        $groups = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/groups?`$select=$groupSelect&`$top=999"

        $records = @($groups | ForEach-Object {
            ConvertTo-EntraGroupResourceRecord -Group $_ -CustomGroupAttributes $CustomGroupAttributes
        })

        # Out-Null so the phase function returns ONLY $groups, not the ingest result.
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'Group' } -Records $records | Out-Null
    } catch {
        $script:phaseErrors.Add("Resources: $($_.Exception.Message)")
        Write-Host "  Resources phase failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    $__resourcesErrMsg = $script:phaseErrors | Where-Object { $_.StartsWith('Resources: ') } | Select-Object -Last 1
    $__phaseSW.Stop(); if ($Timings) { $Timings['Resources'] = $__phaseSW.Elapsed }
    Write-Phase -Name 'Resources' -Duration $__phaseSW.Elapsed -ErrorMsg $__resourcesErrMsg
    return $groups
}

# ─── Sync Assignments (Group Members + Owners) ───────────────────
# Parallel-fetches each group's members and owners, uploads the direct group
# memberships, and models group ownership as Direct assignments to synthetic
# GroupOwnership resources (+ HasOwnership relationships). Consumes the $Groups
# produced by Sync-EntraResources.
function Sync-EntraAssignments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [AllowEmptyCollection()] [array]$Groups = @(),
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing assignments (group memberships)..." -ForegroundColor Cyan
    $totalGroups = $Groups.Count
    Update-CrawlerProgress -Step 'Syncing group memberships' -Pct 25 -Detail "0 of $totalGroups groups"
    try {

    # Parallel fetch — see Get-FGGroupChildrenParallel for design notes.
    $memberResult = Get-FGGroupChildrenParallel `
        -Groups $Groups -ChildPath 'members' -ThrottleLimit 16 `
        -ProgressStep 'Syncing group memberships' -ProgressStartPct 25 -ProgressEndPct 50 `
        -RecordBuilder {
            param($o)
            @{
                resourceId     = $o.resourceId
                principalId    = $o.principalId
                assignmentType = 'Direct'
                resourceType   = 'Group'
                principalType  = if ($o.childType -eq '#microsoft.graph.group') { 'Group' } else { 'User' }
            }
        }
    $allMembers = $memberResult.records
    if ($memberResult.errorCount -gt 0) {
        Write-Host "  WARNING: $($memberResult.errorCount) groups failed after retries (skipped)" -ForegroundColor Yellow
    }

    Update-CrawlerProgress -Detail "Uploading $($allMembers.Count) memberships to ingest API..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Direct'; resourceType = 'Group' } -Records $allMembers

    # Nested-group indirect memberships — expand group-in-group nesting into
    # per-user Indirect rows so the matrix shows inherited members. Derived from
    # the direct-membership edges we just fetched (no extra Graph calls); the
    # matrix reads a declared-only matview, so these must be materialized the same
    # way AppRole-via-group Indirect rows are. Sent as its own scoped full-sync
    # batch so its reconcile-delete partition is separate from Direct memberships.
    # Sent unconditionally (like the Direct batch above); Send-IngestBatch no-ops
    # on an empty set, so a tenant with no nesting simply sends nothing.
    $indirectMembers = @(ConvertTo-EntraNestedGroupIndirectAssignments -DirectMembers $allMembers)
    Update-CrawlerProgress -Detail "Uploading $($indirectMembers.Count) indirect (nested-group) memberships..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Indirect'; resourceType = 'Group' } -Records $indirectMembers

    # Group Owners — modelled as a Direct assignment to a synthetic
    # GroupOwnership resource (named after the group), linked to the
    # group by a HasOwnership relationship — mirroring how an AppRole hangs off
    # its Application. The ownership resource id is deterministic over the group
    # id (same scheme as New-AppRoleResourceId and migration 046), so re-syncs
    # upsert the same rows.
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing assignments (group owners)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing group owners' -Pct 51 -Detail "0 of $totalGroups groups"

    $ownerResult = Get-FGGroupChildrenParallel `
        -Groups $Groups -ChildPath 'owners' -ThrottleLimit 16 `
        -ProgressStep 'Syncing group owners' -ProgressStartPct 51 -ProgressEndPct 60 `
        -RecordBuilder {
            param($o)
            @{
                groupId     = $o.resourceId
                principalId = $o.principalId
            }
        }
    $rawOwners = $ownerResult.records
    if ($ownerResult.errorCount -gt 0) {
        Write-Host "  WARNING: $($ownerResult.errorCount) groups failed during owner fetch (skipped)" -ForegroundColor Yellow
    }

    # Build ownership resources (one per owned group), HasOwnership relationships,
    # and the owner assignments (Direct to the ownership resource). Shaping lives
    # in ConvertTo-EntraGroupOwnership (EntraIDCrawler.Transform.ps1).
    $groupNameById = @{}
    foreach ($g in $Groups) { $groupNameById[$g.id] = $g.displayName }

    $ownership = ConvertTo-EntraGroupOwnership -RawOwners $rawOwners -GroupNameById $groupNameById
    $ownershipResources = $ownership.resources
    $ownershipRels      = $ownership.relationships
    $ownerRecords       = $ownership.assignments

    # Send unconditionally (even when empty) so a full-sync reconcile clears
    # ownership resources/relationships/assignments for groups that lost owners.
    Update-CrawlerProgress -Detail "Uploading $($ownershipResources.Count) ownership resources..."
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ resourceType = 'GroupOwnership' } -Records $ownershipResources
    Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ relationshipType = 'HasOwnership' } -Records $ownershipRels
    Update-CrawlerProgress -Detail "Uploading $($ownerRecords.Count) owner assignments..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Direct'; resourceType = 'GroupOwnership' } -Records $ownerRecords
    } catch {
        $script:phaseErrors.Add("Assignments: $($_.Exception.Message)")
        Write-Host "  Assignments phase failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    $__assignErrMsg = $script:phaseErrors | Where-Object { $_.StartsWith('Assignments: ') } | Select-Object -Last 1
    $__phaseSW.Stop(); if ($Timings) { $Timings['Assignments'] = $__phaseSW.Elapsed }
    Write-Phase -Name 'Assignments' -Duration $__phaseSW.Elapsed -ErrorMsg $__assignErrMsg
}

# ─── Sync PIM (Eligible group memberships) ───────────────────────
# Privileged Identity Management gives users "Eligible" (not active) membership
# in groups. The Graph endpoint requires a `$filter=groupId eq '<id>'` — there
# is no supported "list all" variant (an earlier attempt to drop the filter
# returned 400). On a 9k-group tenant this phase is ~25 min; optimisation is
# a separate problem (Graph $batch or a different endpoint). For now we
# accept the duration in exchange for correctness. Consumes the $Groups produced
# by Sync-EntraResources. The per-batch parallel Graph fetch lives in
# Invoke-FGGroupPimBatchParallel (EntraIDCrawler.Functions.ps1).
function Sync-EntraPim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [AllowEmptyCollection()] [array]$Groups = @(),
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing PIM eligible memberships..." -ForegroundColor Cyan
    try {
        # Filter out dynamic groups (cannot be PIM-enabled). Wrap in @() so a
        # single surviving group stays an array — a bare scalar makes the
        # $candidateGroups[$i..$end] batch slice below yield an empty range,
        # which previously skipped PIM entirely on single-candidate-group tenants.
        $candidateGroups = @($Groups | Where-Object { $_.groupTypes -notcontains 'DynamicMembership' })
        $pimTotal = $candidateGroups.Count
        Write-Host "  Checking $pimTotal groups for PIM eligibility..." -ForegroundColor Gray
        Update-CrawlerProgress -Step 'Syncing PIM eligibilities' -Pct 61 -Detail "0 of $pimTotal groups"

        # Per-group eligibility check. Parallel runspaces (16 in flight) keep
        # this from being trivially serial. Most groups return zero rows (Graph
        # returns 4xx for some group types) — per-group errors are normal and
        # silently dropped.
        $pimRecordsList = [System.Collections.Generic.List[object]]::new()
        $pimGroupCount  = 0
        $pimBatchSize   = 200
        $pimChecked     = 0

        for ($i = 0; $i -lt $pimTotal; $i += $pimBatchSize) {
            if (Get-Command Update-FGAccessTokenIfExpired -ErrorAction SilentlyContinue) {
                Update-FGAccessTokenIfExpired -DebugFlag 'T' | Out-Null
            }
            $token = $Global:AccessToken
            $end = [Math]::Min($i + $pimBatchSize - 1, $pimTotal - 1)
            $batch = $candidateGroups[$i..$end]

            $batchOutput = Invoke-FGGroupPimBatchParallel -Batch @($batch) -Token $token -ThrottleLimit 16

            # Fold the batch into $pimRecordsList and count the distinct groups it touched.
            $pimGroupCount += Add-EntraPimBatchRecords -BatchOutput $batchOutput -RecordsList $pimRecordsList

            $pimChecked = [Math]::Min($i + $pimBatchSize, $pimTotal)
            $subPct = 61 + [int](([double]$pimChecked / $pimTotal) * 4)
            Update-CrawlerProgress -Pct $subPct -Detail "$pimChecked of $pimTotal groups · $pimGroupCount with eligibilities"
        }

        $pimRecords = @($pimRecordsList)
        Write-Host "  Found $pimGroupCount PIM-enabled group(s) with $($pimRecords.Count) eligible memberships" -ForegroundColor Gray

        if ($pimRecords.Count -gt 0) {
            # Dedup by (resourceId, principalId) — HashSet.Add returns $false for a dup.
            $seen = [System.Collections.Generic.HashSet[string]]::new()
            $pimRecords = @($pimRecords | Where-Object { $seen.Add("$($_.resourceId)|$($_.principalId)") })
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'Eligible'; resourceType = 'Group' } -Records $pimRecords
        }
    } catch {
        Write-Host "  PIM sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("PIM: $($_.Exception.Message)")
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['PIM'] = $__phaseSW.Elapsed }
    $__pimErr = $script:phaseErrors | Where-Object { $_.StartsWith('PIM:') } | Select-Object -Last 1
    $__pimErrMsg = if ($__pimErr) { $__pimErr.Substring('PIM:'.Length).Trim() } else { $null }
    Write-Phase -Name 'PIM' -Duration $__phaseSW.Elapsed -ErrorMsg $__pimErrMsg
}

# ─── Service Principals: fetch (delta vs full) ───────────────────
# Delta/full fetch of service principals — same delta-token pattern as Users.
# Returns @{ sps; removedSpIds; newSpsToken; spDeltaHit }. Verbatim from the
# inline fetch block; all Graph I/O for the discovery half of the phase.
function Get-EntraServicePrincipalData {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'delta'
    )
    # `tags` and `servicePrincipalType` drive classification; `appId`,
    # `appOwnerOrganizationId`, and `notes` go into extendedAttributes for
    # downstream visibility. `accountEnabled` lives in its dedicated column.
    $spSelectAttrs = @(
        'id','appId','displayName','servicePrincipalType','accountEnabled',
        'tags','appOwnerOrganizationId','createdDateTime','notes',
        'servicePrincipalNames','homepage','publisherName'
    )
    $spSelect = $spSelectAttrs -join ','

    $spsEndpoint   = 'servicePrincipals/delta'
    $spsToken      = $null
    $newSpsToken   = $null
    $spDeltaHit    = $false
    $removedSpIds  = @()
    $sps           = $null

    if ($SyncMode -eq 'full') {
        Remove-FGDeltaToken -SystemId $SystemId -Endpoint $spsEndpoint
    } elseif ($SyncMode -eq 'delta') {
        $spsToken = Get-FGDeltaToken -SystemId $SystemId -Endpoint $spsEndpoint
    }

    if ($spsToken) {
        Write-Host "  Delta mode: fetching only changed SPs..." -ForegroundColor Gray
        try {
            $deltaUri = "https://graph.microsoft.com/beta/servicePrincipals/delta?`$deltatoken=$([uri]::EscapeDataString($spsToken))"
            $resp = Invoke-FGGetDeltaRequest -URI $deltaUri
            $split = Split-FGDeltaResponse -Response $resp
            $sps = $split.items
            $removedSpIds = $split.removedIds
            $newSpsToken = $resp.deltaToken
            $spDeltaHit = $true
            Write-Host "  Delta: $($sps.Count) changed + $($removedSpIds.Count) removed" -ForegroundColor Gray
        } catch [System.InvalidOperationException] {
            Write-Host "  SP delta token rejected — falling back to full" -ForegroundColor Yellow
            Remove-FGDeltaToken -SystemId $SystemId -Endpoint $spsEndpoint
            $spsToken = $null
            $sps = $null
        } catch {
            Write-Host "  SP delta fetch failed: $($_.Exception.Message) — falling back to full" -ForegroundColor Yellow
            $spsToken = $null
            $sps = $null
        }
    }

    if (-not $spDeltaHit) {
        $sps = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals?`$select=$spSelect&`$top=999"
        try {
            Write-Host "  Priming SP delta token (walks full /servicePrincipals/delta once)..." -ForegroundColor DarkGray
            $primeResp = Invoke-FGGetDeltaRequest -URI "https://graph.microsoft.com/beta/servicePrincipals/delta?`$select=id"
            $newSpsToken = $primeResp.deltaToken
            if ($newSpsToken) { Write-Host "  Primed SP delta token for next run" -ForegroundColor DarkGray }
        } catch {
            Write-Host "  (SP delta token priming skipped: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }

    return @{
        sps          = $sps
        removedSpIds = $removedSpIds
        newSpsToken  = $newSpsToken
        spDeltaHit   = $spDeltaHit
    }
}

# ─── Service Principals: classify + upload ───────────────────────
# Bucket the fetched SPs by principalType (via ConvertTo-EntraServicePrincipalRecord)
# and submit one scoped full-sync per type. In delta mode the @removed tombstones
# ride on the first bucket's call (the id-scoped delete is principalType-agnostic).
# Verbatim from the inline bucket/upload block.
function Send-EntraServicePrincipalBatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Sps,
        [array]$RemovedSpIds = @(),
        [bool]$SpDeltaHit = $false,
        [string[]]$AINamePatterns = @()
    )
    # Bucket records by principalType so we can submit one scoped full-sync
    # per type. An empty bucket is skipped entirely to avoid an unintended
    # delete-everything-of-that-type against the DB.
    $buckets = @{
        ServicePrincipal = New-Object System.Collections.ArrayList
        ManagedIdentity  = New-Object System.Collections.ArrayList
        AIAgent          = New-Object System.Collections.ArrayList
    }

    foreach ($sp in $Sps) {
        $rec = ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp -AINamePatterns $AINamePatterns
        [void]$buckets[$rec.principalType].Add($rec)
    }

    Write-Host ("  Classified: {0} ServicePrincipal / {1} ManagedIdentity / {2} AIAgent" -f `
        $buckets.ServicePrincipal.Count, $buckets.ManagedIdentity.Count, $buckets.AIAgent.Count) -ForegroundColor Gray

    # In delta mode, use syncMode='delta' (no scoped delete of unchanged
    # records) and attach the @removed tombstones to the FIRST bucket's
    # call — the /ingest/principals delete is id-scoped and doesn't care
    # which principalType bucket the record originally lived in, so it
    # only needs to run once per phase.
    $spIngestMode = if ($SpDeltaHit) { 'delta' } else { 'full' }
    $firstBucket = $true
    foreach ($pt in @('ServicePrincipal','ManagedIdentity','AIAgent')) {
        $bucket = $buckets[$pt]
        if ($bucket.Count -eq 0 -and (-not $firstBucket -or $RemovedSpIds.Count -eq 0)) { continue }
        Update-CrawlerProgress -Detail "Uploading $($bucket.Count) $pt records..."
        $deletes = @()
        if ($firstBucket -and $SpDeltaHit -and $RemovedSpIds.Count -gt 0) {
            $deletes = $RemovedSpIds
            $firstBucket = $false
        } elseif ($firstBucket) {
            $firstBucket = $false
        }
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode $spIngestMode `
            -Scope @{ principalType = $pt } -Records @($bucket) -DeletedIds $deletes
    }
}

# ─── Service Principals: sign-in activity (aggregate per SP) ──────
# Graph's per-appId last-activity report joined by appId to the SPs we synced,
# so each PrincipalActivity row is keyed on the SP object id. Soft-fails (WARN)
# if the report endpoint 403s. Verbatim from the inline activity sub-block.
function Sync-EntraSpActivity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Sps,
        [string]$AggregateResourceId
    )
    try {
        Update-CrawlerProgress -Step 'Fetching SP sign-in activity report' -Pct 20 -Detail '/reports/servicePrincipalSignInActivities'
        $spActivityRows = Invoke-FGGetRequest -URI 'https://graph.microsoft.com/beta/reports/servicePrincipalSignInActivities?$top=999'

        # Build appId → activity map. Graph returns one row per appId with
        # four timestamp "flavours"; we promote the primary last/nonInteractive
        # to first-class columns and stash the two client-variant timestamps
        # in extendedAttributes so downstream queries can still reach them.
        $activityByAppId = @{}
        foreach ($a in $spActivityRows) {
            if (-not $a.appId) { continue }
            $activityByAppId[$a.appId] = $a
        }

        $spActivityRecords = @($Sps | ForEach-Object {
            ConvertTo-EntraSpActivityRecord -ServicePrincipal $_ -Activity $activityByAppId[$_.appId] -AggregateResourceId $AggregateResourceId
        } | Where-Object { $_ })

        if ($spActivityRecords.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($spActivityRecords.Count) SP sign-in activity records..."
            Send-IngestBatch -Endpoint 'ingest/principal-activity' -SystemId $SystemId -SyncMode 'delta' `
                -Records $spActivityRecords
        } else {
            Write-Host '  No SP sign-in activity to upload (report empty or no matches)' -ForegroundColor Gray
        }
    } catch {
        # The report endpoint needs AuditLog.Read.All, which should already
        # be granted, but tenants that haven't consented yet will 403 here.
        # Fail soft — SP data itself still lands, activity just stays stale.
        Write-Host "  WARN: SP sign-in activity sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── Sync Service Principals ─────────────────────────────────────
# Service principals are Entra ID's non-human identities — enterprise-app SPs,
# managed identities, AI agents (Copilot Studio / Azure OpenAI), etc. They own
# a large fraction of role assignments in Azure and M365, so we want them in the
# `Principals` table alongside human users. RETURNS the fetched SPs so the
# SignInLogs phase can reuse them without a second Graph pass.
function Sync-EntraServicePrincipals {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'delta',
        [string[]]$AINamePatterns = @(),
        [string]$AggregateResourceId,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing service principals..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing service principals' -Pct 18 -Detail 'Fetching from Microsoft Graph...'
    $sps = @()
    try {
        $data = Get-EntraServicePrincipalData -SystemId $SystemId -SyncMode $SyncMode
        $sps = $data.sps

        Update-CrawlerProgress -Detail "Classifying $(@($sps).Count) service principals..."
        # Out-Null so this phase function returns ONLY $sps, not ingest results.
        Send-EntraServicePrincipalBatches -SystemId $SystemId -Sps $sps `
            -RemovedSpIds $data.removedSpIds -SpDeltaHit $data.spDeltaHit -AINamePatterns $AINamePatterns | Out-Null

        if ($data.newSpsToken) {
            Set-FGDeltaToken -SystemId $SystemId -Endpoint 'servicePrincipals/delta' -Token $data.newSpsToken -RecordsLastSeen @($sps).Count
        }

        Sync-EntraSpActivity -SystemId $SystemId -Sps $sps -AggregateResourceId $AggregateResourceId | Out-Null
    } catch {
        $script:phaseErrors.Add("ServicePrincipals: $($_.Exception.Message)")
        Write-Host "  ServicePrincipals phase failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    $__spErrMsg = $script:phaseErrors | Where-Object { $_.StartsWith('ServicePrincipals: ') } | Select-Object -Last 1
    $__phaseSW.Stop(); if ($Timings) { $Timings['ServicePrincipals'] = $__phaseSW.Elapsed }
    Write-Phase -Name 'ServicePrincipals' -Duration $__phaseSW.Elapsed -ErrorMsg $__spErrMsg
    return $sps
}

# ─── Sign-in Logs: appId -> SP id index ──────────────────────────
# Reuses the $Sps from the ServicePrincipals phase when present; otherwise
# fetches a stripped id/appId list on demand so the SignInLogs phase works
# whether or not the SP sync ran this run. Verbatim from the inline index build.
function Get-EntraSpAppIdIndex {
    [CmdletBinding()]
    param($Sps)
    $appIdToSpId = @{}
    if ($Sps -and $Sps.Count -gt 0) {
        foreach ($sp in $Sps) { if ($sp.appId) { $appIdToSpId[$sp.appId] = $sp.id } }
    } else {
        $spIndex = Invoke-FGGetRequest -URI 'https://graph.microsoft.com/beta/servicePrincipals?$select=id,appId&$top=999'
        foreach ($sp in $spIndex) { if ($sp.appId) { $appIdToSpId[$sp.appId] = $sp.id } }
    }
    return $appIdToSpId
}

# ─── Sync Sign-in Logs (per-(user, app) activity) ────────────────
# Aggregates /auditLogs/signIns events from the last $SignInLogsDays days into
# per-(user, app) last-activity rows (granularity B). Each event is O(1) work;
# the sum is kept in a hashtable keyed by "$userId|$appSpId" so peak memory is
# bounded by the number of DISTINCT pairs, not event count. Consumes the $Sps
# from the ServicePrincipals phase (via Get-EntraSpAppIdIndex).
function Sync-EntraSignInLogs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Sps,
        [int]$SignInLogsDays = 7,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing sign-in logs (last $SignInLogsDays days)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing sign-in logs' -Pct 22 -Detail 'Building appId index...'

    try {
        $appIdToSpId = Get-EntraSpAppIdIndex -Sps $Sps
        Write-Host "  Indexed $($appIdToSpId.Count) app ids" -ForegroundColor Gray

        # Day-sliced fetch. Fetching the full window as a single request has
        # repeatedly failed mid-pagination with a 400 once Graph's skiptoken
        # expires on a slow client. Slicing into 1-day windows means a single
        # bad slice costs one day, not the whole phase.
        #
        # Memory: feed events into the aggregate AS THEY ARRIVE via
        # Invoke-FGGetRequestStream's pipeline output — peak memory is bounded by
        # one Graph page (~1k events) + the aggregate hashtable, not the full
        # multi-hundred-thousand-event slice that used to OOM-kill the worker.
        $agg = @{}
        $skipped = 0
        $totalEvents = 0
        $sliceFailures = @()

        # Per-slice streaming lives in Invoke-EntraSignInSlice
        # (EntraIDCrawler.Functions.ps1): it folds each event into $agg (by
        # reference) via Add-EntraSignInEventToAggregate and returns the event and
        # skip counts for the slice, which we accumulate here.
        $script:_signin_skipped = 0

        $nowUtc = (Get-Date).ToUniversalTime()
        for ($d = 0; $d -lt $SignInLogsDays; $d++) {
            $sliceEnd   = $nowUtc.AddDays(-$d).ToString('yyyy-MM-ddTHH:mm:ssZ')
            $sliceStart = $nowUtc.AddDays(-($d + 1)).ToString('yyyy-MM-ddTHH:mm:ssZ')
            $sliceFilter = [uri]::EscapeDataString("createdDateTime ge $sliceStart and createdDateTime lt $sliceEnd")
            $sliceUri = "https://graph.microsoft.com/beta/auditLogs/signIns?`$filter=$sliceFilter&`$top=999"
            Update-CrawlerProgress -Detail "Fetching day slice $($d + 1)/${SignInLogsDays}: $sliceStart..$sliceEnd"
            try {
                $sliceResult = Invoke-EntraSignInSlice -SliceUri $sliceUri -Aggregate $agg -AppIdToSpId $appIdToSpId
                $script:_signin_skipped += $sliceResult.skipped
                $totalEvents += $sliceResult.count
                Write-Host "  Slice $($d + 1)/$SignInLogsDays ($sliceStart..$sliceEnd): $($sliceResult.count) events" -ForegroundColor Gray
            } catch {
                # One bad slice (typically an expired skiptoken 400 deep in
                # pagination) doesn't abort the whole phase — we record it
                # and keep going. If *every* slice fails, the outer handler
                # still flags the phase as failed.
                $msg = $_.Exception.Message
                Write-Host "  Slice $($d + 1)/$SignInLogsDays failed: $msg" -ForegroundColor Yellow
                $sliceFailures += "day $($d + 1): $msg"
            }
        }
        Write-Host "  Pulled $totalEvents events across $SignInLogsDays slices ($(@($sliceFailures).Count) slice failure(s))" -ForegroundColor Gray
        if ($sliceFailures.Count -gt 0 -and $sliceFailures.Count -eq $SignInLogsDays) {
            throw "All $SignInLogsDays sign-in log slices failed: $($sliceFailures -join '; ')"
        }
        if ($sliceFailures.Count -gt 0) {
            $script:phaseErrors.Add("SignInLogs: $($sliceFailures.Count) of $SignInLogsDays day slice(s) failed: $($sliceFailures -join '; ')")
        }

        $skipped = $script:_signin_skipped
        if ($skipped -gt 0) {
            Write-Host "  Skipped $skipped events (missing userId/appId, or app not synced yet)" -ForegroundColor Gray
        }

        $records = @($agg.Values)
        Write-Host "  Aggregated to $($records.Count) (user, app) pairs" -ForegroundColor Cyan
        if ($records.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($records.Count) per-app activity rows..."
            Send-IngestBatch -Endpoint 'ingest/principal-activity' -SystemId $SystemId -SyncMode 'delta' `
                -Records $records
        }
    } catch {
        # 403 if the tenant hasn't consented AuditLog.Read.All, 429 if the
        # report is rate-limited. Fail soft — user/SP aggregate activity
        # from the cheaper endpoints still landed.
        Write-Host "  ERROR: Sign-in log sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("SignInLogs: $($_.Exception.Message)")
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['SignInLogs'] = $__phaseSW.Elapsed }
    $__signInErr = $script:phaseErrors | Where-Object { $_.StartsWith('SignInLogs:') } | Select-Object -Last 1
    $__signInErrMsg = if ($__signInErr) { $__signInErr.Substring('SignInLogs:'.Length).Trim() } else { $null }
    Write-Phase -Name 'SignInLogs' -Duration $__phaseSW.Elapsed -ErrorMsg $__signInErrMsg
}

# ─── Governance: catalogs + access packages ──────────────────────
# Fetch entitlement-management catalogs and access packages, upload catalogs and
# the access-package-as-BusinessRole resources, and RETURN the raw access
# packages so the resource-scopes sub-phase can expand each one. Out-Nulls its
# ingest calls so it returns only the access packages.
function Sync-EntraGovernanceCatalogs {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId)

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (catalogs)..." -ForegroundColor Cyan
    $catalogs = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs?`$top=999"

    $catRecords = @($catalogs | ForEach-Object { ConvertTo-EntraGovernanceCatalogRecord -Catalog $_ })
    Send-IngestBatch -Endpoint 'ingest/governance/catalogs' -SystemId $SystemId -SyncMode 'full' -Records $catRecords | Out-Null

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access packages -> business roles)..." -ForegroundColor Cyan
    $accessPackages = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages?`$top=999"

    $apRecords = @($accessPackages | ForEach-Object { ConvertTo-EntraAccessPackageRecord -AccessPackage $_ })
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ resourceType = 'BusinessRole' } -Records $apRecords | Out-Null

    return $accessPackages
}

# ─── Governance sub-phase: access-package resource role scopes ────
# Each access package's resourceRoleScopes describe the groups it Contains — the
# matrix's user->group AP coloring joins through these. One detail call per AP
# (tight retry budget), deduped by (parent, child). Own timing/error wrapper.
function Sync-EntraGovernanceResourceScopes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $AccessPackages
    )
    $__scopeSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access package resource scopes)..." -ForegroundColor Cyan
    try {
        $relRecords = [System.Collections.Generic.List[object]]::new()
        foreach ($ap in $AccessPackages) {
            $relRecords.AddRange([object[]]@(Get-EntraApScopeRelationships -Ap $ap))
        }
        # Dedupe (parent + child) — Graph can return duplicates if an AP has multiple roles on the same group.
        $relRecords = Select-FGDistinct -Items $relRecords -Key { "$($_.parentResourceId)|$($_.childResourceId)" }

        if ($relRecords.Count -gt 0) {
            Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ relationshipType = 'Contains' } -Records $relRecords
        } else {
            Write-Host "  No access package resource scopes found" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  Resource scope sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("Governance/ResourceScopes: $($_.Exception.Message)")
    }
    $__scopeSW.Stop()
    $__scopeErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/ResourceScopes:') } | Select-Object -Last 1
    $__scopeErrMsg = if ($__scopeErr) { $__scopeErr.Substring('Governance/ResourceScopes:'.Length).Trim() } else { $null }
    Write-Phase -Name 'Governance/ResourceScopes' -Duration $__scopeSW.Elapsed -ErrorMsg $__scopeErrMsg
}

# One access package's Contains relationships (AP → resource-role scope). Tight
# retry/timeout budget (fires once per ~500 APs); a slow/wedged AP is skipped, not
# allowed to stall the loop. Returns a list of relationship records.
function Get-EntraApScopeRelationships {
    [CmdletBinding()]
    param($Ap)
    $rels = [System.Collections.Generic.List[object]]::new()
    try {
        $apDetail = Invoke-FGGetRequest -MaxRetries 1 -TimeoutSec 30 -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages/$($Ap.id)?`$expand=accessPackageResourceRoleScopes(`$expand=accessPackageResourceRole,accessPackageResourceScope)"
        foreach ($rrs in @($apDetail.accessPackageResourceRoleScopes)) {
            $rel = ConvertTo-EntraAccessPackageScopeRelationship -RoleScope $rrs -AccessPackageId $Ap.id
            if ($rel) { $rels.Add($rel) }
        }
    } catch {
        Write-Host "  Skipping AP $($Ap.displayName): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    return $rels
}

# ─── Governance sub-phase: access-package assignments ─────────────
# Each assignment is a Direct membership on the access-package resource
# (governed=true). Streamed + deduped on (apId, principalId) to bound memory.
function Sync-EntraGovernanceAssignments {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId)

    $__apaSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access package assignments)..." -ForegroundColor Cyan
    try {
        # $top=500 survives where 999 produced 504s; stream pages and dedup on
        # the fly so we hold one (apId, principalId) entry per pair, not the full
        # expanded assignment list (which OOM-killed the worker).
        $assignRecords = [System.Collections.Generic.List[hashtable]]::new()
        $seenKeys = @{}
        Invoke-FGGetRequestStream -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignments?`$expand=target,accessPackage&`$top=500" | ForEach-Object {
            $apaRec = ConvertTo-EntraAccessPackageAssignmentRecord -Assignment $_
            if (-not $apaRec) { return }
            $key = "$($apaRec.resourceId)|$($apaRec.principalId)"
            if ($seenKeys.ContainsKey($key)) { return }
            $seenKeys[$key] = $true
            $assignRecords.Add($apaRec)
        }
        $assignRecords = @($assignRecords)

        if ($assignRecords.Count -gt 0) {
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'Direct'; resourceType = 'BusinessRole' } -Records $assignRecords
        } else {
            Write-Host "  No active access package assignments found" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  Access Package assignments sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("Governance/APAssignments: $($_.Exception.Message)")
    }
    $__apaSW.Stop()
    $__apaErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/APAssignments:') } | Select-Object -Last 1
    $__apaErrMsg = if ($__apaErr) { $__apaErr.Substring('Governance/APAssignments:'.Length).Trim() } else { $null }
    Write-Phase -Name 'Governance/APAssignments' -Duration $__apaSW.Elapsed -ErrorMsg $__apaErrMsg
}

# ─── Governance sub-phase: assignment policies ────────────────────
# Drives the Business Roles page "Type"/review badges. The ONE governance
# endpoint called via /v1.0 (the /beta segment was removed); accessPackage is
# expanded to recover accessPackageId.
function Sync-EntraGovernancePolicies {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId)

    $__polSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (assignment policies)..." -ForegroundColor Cyan
    try {
        $policies = Invoke-FGGetRequest -URI "https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentPolicies?`$expand=accessPackage"
        $polRecords = @()
        foreach ($pol in $policies) {
            $polRec = ConvertTo-EntraAssignmentPolicyRecord -Policy $pol
            if ($polRec) { $polRecords += $polRec }
        }
        if ($polRecords.Count -gt 0) {
            Send-IngestBatch -Endpoint 'ingest/governance/policies' -SystemId $SystemId -SyncMode 'full' -Records $polRecords
        } else {
            Write-Host "  No assignment policies found" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  Assignment policy sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("Governance/AssignmentPolicies: $($_.Exception.Message)")
    }
    $__polSW.Stop()
    $__polErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/AssignmentPolicies:') } | Select-Object -Last 1
    $__polErrMsg = if ($__polErr) { $__polErr.Substring('Governance/AssignmentPolicies:'.Length).Trim() } else { $null }
    Write-Phase -Name 'Governance/AssignmentPolicies' -Duration $__polSW.Elapsed -ErrorMsg $__polErrMsg
}

# Fetch every decision under an access-review definition's instances and shape
# them into CertificationDecisions records. All Graph I/O for one definition;
# per-instance failures are logged and skipped. Pulled out of the review loop so
# Sync-EntraGovernanceReviews stays under the complexity threshold.
function Get-EntraAccessReviewCertRecords {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Definition,
        [string]$ApId
    )
    $out = [System.Collections.Generic.List[object]]::new()
    try {
        $instances = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions/$($Definition.id)/instances?`$top=100")
        foreach ($inst in $instances) {
            $out.AddRange([object[]]@(Get-EntraReviewInstanceDecisions -Definition $Definition -Instance $inst -ApId $ApId))
        }
    } catch {
        Write-Host "  Skipping review definition $($Definition.id): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    return $out
}

# All CertificationDecisions records for one access-review instance. Graph caps the
# decisions collection at 100/page (larger $top 400s — rely on @odata.nextLink). A
# per-instance failure is logged (with the real Graph error body) and skipped.
function Get-EntraReviewInstanceDecisions {
    [CmdletBinding()]
    param($Definition, $Instance, [string]$ApId)
    $out = [System.Collections.Generic.List[object]]::new()
    try {
        $decisions = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions/$($Definition.id)/instances/$($Instance.id)/decisions")
        foreach ($d in $decisions) {
            $out.Add((ConvertTo-EntraCertificationDecisionRecord -Decision $d -Definition $Definition -Instance $Instance -ApId $ApId))
        }
    } catch {
        Write-Host "    Skipping instance $($Instance.id): $(Get-FGGraphErrorDetail $_)" -ForegroundColor Yellow
    }
    return $out
}

# ─── Governance sub-phase: access reviews -> certifications ───────
# Walk access-review definitions scoped to an access package, pull their
# instance decisions, and upload CertificationDecisions. Best-effort: a tenant
# may not use access reviews at all. apId resolution + record shaping are pure
# (Resolve-EntraAccessReviewApId / ConvertTo-EntraCertificationDecisionRecord);
# per-definition decision fetching lives in Get-EntraAccessReviewCertRecords.
function Sync-EntraGovernanceReviews {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId)

    $__arvSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access review decisions)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing access review decisions' -Pct 74 -Detail 'Fetching review definitions from Graph...'
    try {
        $reviewDefs = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions?`$top=100"
        Write-Host "  Found $($reviewDefs.Count) review definitions; filtering to access-package scoped..." -ForegroundColor Gray
        $certRecords = @()
        $st = @{ noScope = 0; noApMatch = 0; sampleLogged = 0 }
        $defIndex = 0
        $defTotal = $reviewDefs.Count
        foreach ($def in $reviewDefs) {
            $defIndex++
            # Keep the UI's step/detail line fresh — this phase can walk hundreds of
            # definitions x many instances and previously looked frozen.
            if (($defIndex % 25) -eq 1) {
                Update-CrawlerProgress -Detail "Access reviews: $defIndex of $defTotal definitions..."
            }
            $apId = Get-EntraReviewDefApId -Def $def -State $st
            if ($apId) { $certRecords += Get-EntraAccessReviewCertRecords -Definition $def -ApId $apId }
        }
        Write-Host "  Review definitions: $($reviewDefs.Count) total; skipped $($st.noScope) (no scope) + $($st.noApMatch) (no access-package id) = $($st.noScope + $st.noApMatch) skipped; kept $($reviewDefs.Count - $st.noScope - $st.noApMatch)" -ForegroundColor Gray
        if ($certRecords.Count -gt 0) {
            Send-IngestBatch -Endpoint 'ingest/governance/certifications' -SystemId $SystemId -SyncMode 'full' -Records $certRecords
        } else {
            Write-Host "  No access review decisions found" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  Access review sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("Governance/AccessReviews: $($_.Exception.Message)")
        Write-Host "  This tenant may not use access reviews on access packages." -ForegroundColor Yellow
    }
    $__arvSW.Stop()
    $__arvErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/AccessReviews:') } | Select-Object -Last 1
    $__arvErrMsg = if ($__arvErr) { $__arvErr.Substring('Governance/AccessReviews:'.Length).Trim() } else { $null }
    Write-Phase -Name 'Governance/AccessReviews' -Duration $__arvSW.Elapsed -ErrorMsg $__arvErrMsg
}

# Resolve one review definition's access-package id, or $null if it isn't AP-scoped.
# Bumps the skip counters in $State (@{ noScope; noApMatch; sampleLogged }) and logs
# up to 2 sample skips so a tenant that keeps skipping everything is diagnosable.
function Get-EntraReviewDefApId {
    [CmdletBinding()]
    param($Def, [hashtable]$State)
    $resolved = Resolve-EntraAccessReviewApId -Definition $Def
    if ($resolved.apId) { return $resolved.apId }
    if ($resolved.reason -eq 'noscope') {
        $State.noScope++
        if ($State.sampleLogged -lt 2) {
            Write-Host "    (sample skip, no scope/resourceScope.query on def $($Def.id): $($Def | ConvertTo-Json -Depth 3 -Compress))" -ForegroundColor DarkGray
            $State.sampleLogged++
        }
    } else {
        $State.noApMatch++
        if ($State.sampleLogged -lt 2) {
            Write-Host "    (sample skip, no AP id in queries: $($resolved.queryStrings -join ' | '))" -ForegroundColor DarkGray
            $State.sampleLogged++
        }
    }
    return $null
}

# ─── Sync Governance ─────────────────────────────────────────────
# Orchestrates the five governance sub-phases (each of which owns its own
# timing/error/Write-Phase wrapper). The outer catch covers the common
# "tenant has no Entitlement Management" case where the very first catalog/AP
# fetch 400s. No top-level 'Governance' Write-Phase — the sub-phases report
# individually so the UI breakdown shows them directly.
function Sync-EntraGovernance {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Update-CrawlerProgress -Step 'Syncing governance' -Pct 66 -Detail 'Catalogs, access packages, policies, reviews...'
    try {
        $accessPackages = Sync-EntraGovernanceCatalogs -SystemId $SystemId
        Sync-EntraGovernanceResourceScopes -SystemId $SystemId -AccessPackages $accessPackages
        Sync-EntraGovernanceAssignments -SystemId $SystemId
        Sync-EntraGovernancePolicies -SystemId $SystemId
        Sync-EntraGovernanceReviews -SystemId $SystemId
    }
    catch {
        Write-Host "  Governance sync skipped: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  This tenant may not have Entitlement Management (Access Packages) enabled." -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['Governance'] = $__phaseSW.Elapsed }
}

# ─── Principals: build the $select ───────────────────────────────
# Core user attributes + custom, adding onPremisesExtensionAttributes when any
# custom attribute or the identity filter references an extensionAttributeN.
# Verbatim from the inline $select build; no I/O.
function Get-EntraUserSelect {
    [CmdletBinding()]
    param(
        [string[]]$CustomUserAttributes = @(),
        [hashtable]$IdentityFilter = @{}
    )
    # signInActivity and userType feed the risk engine's stale/guest signals;
    # manager is expanded inline elsewhere; onPremisesDistinguishedName lets
    # Add-FGEntraCalculatedAttributes derive _OuPath for on-prem-synced users.
    $coreUserAttrs = @(
        'id','displayName','mail','userPrincipalName','accountEnabled',
        'givenName','surname','department','jobTitle','companyName','employeeId',
        'createdDateTime','userType','signInActivity','externalUserState',
        'onPremisesDistinguishedName'
    )

    $extraSelectAttrs = @()
    $hasExtensionAttrs = $false
    foreach ($attr in $CustomUserAttributes) {
        if ($attr -match '^extensionAttribute\d+$') {
            $hasExtensionAttrs = $true
        } else {
            $extraSelectAttrs += $attr
        }
    }
    if ($IdentityFilter['attribute'] -match '^extensionAttribute\d+$') {
        $hasExtensionAttrs = $true
    }
    if ($hasExtensionAttrs) {
        $extraSelectAttrs += 'onPremisesExtensionAttributes'
    }
    $allUserAttrs = $coreUserAttrs + $extraSelectAttrs | Select-Object -Unique
    return ($allUserAttrs -join ',')
}

# ─── Principals: fetch (delta vs full) ───────────────────────────
# Delta/full fetch of users. `/users/delta` can't $expand=manager, so full runs
# fetch with manager expand AND prime a delta token for the next run; delta runs
# use the stored token and fall back to full on 400/410. Returns
# @{ users; removedUserIds; newUsersToken; deltaHit }. Verbatim from the inline
# fetch block.
function Get-EntraUserData {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'delta',
        [string]$UserSelect
    )
    $usersEndpoint  = 'users/delta'
    $usersToken     = $null
    $newUsersToken  = $null
    $deltaHit       = $false
    $removedUserIds = @()
    $users          = $null

    if ($SyncMode -eq 'full') {
        # Explicit full: wipe any stored token so stale context can't survive.
        Remove-FGDeltaToken -SystemId $SystemId -Endpoint $usersEndpoint
    } elseif ($SyncMode -eq 'delta') {
        $usersToken = Get-FGDeltaToken -SystemId $SystemId -Endpoint $usersEndpoint
    }

    if ($usersToken) {
        Write-Host "  Delta mode: fetching only changes since last run..." -ForegroundColor Gray
        try {
            $deltaUri = "https://graph.microsoft.com/beta/users/delta?`$deltatoken=$([uri]::EscapeDataString($usersToken))"
            $resp = Invoke-FGGetDeltaRequest -URI $deltaUri
            $split = Split-FGDeltaResponse -Response $resp
            $users = $split.items
            $removedUserIds = $split.removedIds
            $newUsersToken = $resp.deltaToken
            $deltaHit = $true
            Write-Host "  Delta: $($users.Count) changed + $($removedUserIds.Count) removed" -ForegroundColor Gray
        } catch [System.InvalidOperationException] {
            Write-Host "  Delta token rejected by Graph — clearing and falling back to full fetch" -ForegroundColor Yellow
            Remove-FGDeltaToken -SystemId $SystemId -Endpoint $usersEndpoint
            $usersToken = $null
            $users = $null
        } catch {
            Write-Host "  Delta fetch failed: $($_.Exception.Message) — falling back to full" -ForegroundColor Yellow
            $usersToken = $null
            $users = $null
        }
    }

    if (-not $deltaHit) {
        # Full path: authoritative fetch with manager expand, then prime a delta
        # token (Graph only hands it out after walking the whole collection).
        $users = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/users?`$select=$UserSelect&`$expand=manager(`$select=id)&`$top=999"
        try {
            Write-Host "  Priming delta token (walks full /users/delta once)..." -ForegroundColor DarkGray
            $primeResp = Invoke-FGGetDeltaRequest -URI "https://graph.microsoft.com/beta/users/delta?`$select=id"
            $newUsersToken = $primeResp.deltaToken
            if ($newUsersToken) {
                Write-Host "  Primed delta token for next run" -ForegroundColor DarkGray
            } else {
                Write-Host "  (priming call succeeded but no deltaLink returned — Graph may have paginated further)" -ForegroundColor DarkGray
            }
        } catch {
            Write-Host "  (delta token priming skipped: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }

    return @{
        users          = $users
        removedUserIds = $removedUserIds
        newUsersToken  = $newUsersToken
        deltaHit       = $deltaHit
    }
}

# Filter the fetched users down to the identity subset per the configured
# IdentityFilter (attribute/condition/value(s)), coercing the configured value to
# the attribute's runtime type. Verbatim from the inline Where-Object predicate.
# Get-UserAttrValue / ConvertTo-FilterValue live in EntraIDCrawler.Functions.ps1.
function Select-EntraIdentityUsers {
    [CmdletBinding()]
    param(
        $Users,
        [Parameter(Mandatory)] [hashtable]$IdentityFilter
    )
    $attr        = $IdentityFilter['attribute']
    $condition   = $IdentityFilter['condition']
    $filterValue = $IdentityFilter['value']
    $filterValues = $IdentityFilter['values']

    return @($Users | Where-Object {
        $val = Get-UserAttrValue -User $_ -AttrName $attr
        $coercedValue = ConvertTo-FilterValue -Value $filterValue -Sample $val
        $coercedValues = if ($filterValues) { $filterValues | ForEach-Object { ConvertTo-FilterValue -Value $_ -Sample $val } } else { @() }
        switch ($condition) {
            'isNotNull'  { $null -ne $val -and $val -ne '' }
            'equals'     { $val -eq $coercedValue }
            'notEquals'  { $val -ne $coercedValue }
            'inValues'   { $coercedValues -contains $val }
            default      { $false }
        }
    })
}

# ─── Principals sub-phase: identity sync (filtered users) ────────
# Upload the filtered users as Identities plus the identity<->principal links.
# Uses the same ingest mode as Principals so delta runs upsert only.
function Sync-EntraIdentities {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Users,
        [Parameter(Mandatory)] [hashtable]$IdentityFilter,
        [string[]]$CustomUserAttributes = @(),
        [string]$IngestMode = 'full'
    )
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing identities (filtered from users)..." -ForegroundColor Cyan
    $identityUsers = Select-EntraIdentityUsers -Users $Users -IdentityFilter $IdentityFilter

    $attr = $IdentityFilter['attribute']
    $condition = $IdentityFilter['condition']
    $filterValue = $IdentityFilter['value']
    $filterValues = $IdentityFilter['values']
    Write-Host "  Matched $($identityUsers.Count) of $(@($Users).Count) users as identities (filter: $attr $condition $filterValue$($filterValues -join ','))" -ForegroundColor Cyan

    if ($identityUsers.Count -gt 0) {
        $idRecords = @($identityUsers | ForEach-Object { ConvertTo-EntraIdentityRecord -User $_ -CustomUserAttributes $CustomUserAttributes })
        # In delta mode we only have changed users, so full-mode scoped-delete
        # would wipe unchanged identities — use the caller's ingest mode.
        Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $SystemId -SyncMode $IngestMode -Records $idRecords

        $idMembers = @($identityUsers | ForEach-Object { @{ identityId = $_.id; principalId = $_.id } })
        Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $SystemId -SyncMode $IngestMode -Records $idMembers
    }
}

# ─── Sync Principals (users) ─────────────────────────────────────
# Fetch users (delta/full), upload them as User principals with @removed
# tombstones, upload per-user aggregate sign-in activity, prime the delta token,
# and run the optional filtered identity sub-sync.
function Sync-EntraPrincipals {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'delta',
        [string[]]$CustomUserAttributes = @(),
        [hashtable]$IdentityFilter = @{},
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing principals (users)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing users' -Pct 12 -Detail 'Fetching from Microsoft Graph...'
    try {
        $userSelect = Get-EntraUserSelect -CustomUserAttributes $CustomUserAttributes -IdentityFilter $IdentityFilter
        $data = Get-EntraUserData -SystemId $SystemId -SyncMode $SyncMode -UserSelect $userSelect
        $users = $data.users

        Update-CrawlerProgress -Detail "Building $(@($users).Count) user records..."
        $records = @($users | ForEach-Object {
            ConvertTo-EntraPrincipalRecord -User $_ -CustomUserAttributes $CustomUserAttributes
        })

        Update-CrawlerProgress -Detail "Uploading $($records.Count) users to ingest API..."
        # Delta-hit runs forward @removed tombstones and use syncMode='delta' so
        # the ingest engine doesn't scoped-delete users we didn't see this run.
        $ingestMode = if ($data.deltaHit) { 'delta' } else { 'full' }
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode $ingestMode `
            -Scope @{ principalType = 'User' } -Records $records -DeletedIds $data.removedUserIds

        if ($data.newUsersToken) {
            Set-FGDeltaToken -SystemId $SystemId -Endpoint 'users/delta' -Token $data.newUsersToken -RecordsLastSeen $records.Count
        }

        # Per-user aggregate sign-in activity (the four signInActivity timestamps
        # from the same /users call), keyed on the AGG_RESOURCE_ID sentinel.
        $activityRecords = @($users | ForEach-Object { ConvertTo-EntraSignInActivityRecord -User $_ } | Where-Object { $_ })
        if ($activityRecords.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($activityRecords.Count) user sign-in activity records..."
            Send-IngestBatch -Endpoint 'ingest/principal-activity' -SystemId $SystemId -SyncMode 'delta' -Records $activityRecords
        }

        if ($IdentityFilter.Count -gt 0 -and $IdentityFilter['attribute']) {
            Sync-EntraIdentities -SystemId $SystemId -Users $users -IdentityFilter $IdentityFilter `
                -CustomUserAttributes $CustomUserAttributes -IngestMode $ingestMode
        }
    } catch {
        $script:phaseErrors.Add("Principals: $($_.Exception.Message)")
        Write-Host "  Principals phase failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    $__principalsErrMsg = $script:phaseErrors | Where-Object { $_.StartsWith('Principals: ') } | Select-Object -Last 1
    $__phaseSW.Stop(); if ($Timings) { $Timings['Principals'] = $__phaseSW.Elapsed }
    Write-Phase -Name 'Principals' -Duration $__phaseSW.Elapsed -ErrorMsg $__principalsErrMsg
}

# ─── Config resolution ───────────────────────────────────────────
# Resolve the job config into the crawler's sync toggles + attribute lists.
# Defaults, then selectedObjects overrides, then direct-toggle overrides (older
# job configs). Data-driven over the original long if-ContainsKey chains — the
# per-key overrides are independent (each key maps to a distinct toggle), except
# usersGroupsMembers which intentionally overrides the three user/group toggles
# after `identity`, matching the original ordering. Returns a hashtable of
# settings. Pure — no I/O.
function Resolve-EntraSyncConfig {
    [CmdletBinding()]
    param([hashtable]$RawConfig = @{})

    $cfg = @{
        SyncMode              = if ($RawConfig['_syncMode'] -in @('full','delta')) { $RawConfig['_syncMode'] } else { 'delta' }
        SyncPrincipals        = $true
        SyncServicePrincipals = $false
        SyncResources         = $true
        SyncAssignments       = $true
        SyncGovernance        = $true
        SyncPim               = $false
        SyncSignInLogs        = $false
        SyncOAuth2Grants      = $false
        SyncAppRoles          = $false
        SyncPrincipalRelationships = $false; SyncDirectoryRoles = $false
        RefreshViews          = $true
        SignInLogsDays        = 7
        CustomUserAttributes  = @()
        CustomGroupAttributes = @()
        AINamePatterns        = @()
        IdentityFilter        = @{}
    }

    # selectedObjects.<key> -> toggle
    $objects = $RawConfig['selectedObjects']
    if ($objects) {
        Set-EntraTogglesFrom -Cfg $cfg -Source $objects -Map ([ordered]@{
            identity = 'SyncPrincipals'; servicePrincipals = 'SyncServicePrincipals'
            identityGovernance = 'SyncGovernance'; pim = 'SyncPim'; signInLogs = 'SyncSignInLogs'
            oauth2Grants = 'SyncOAuth2Grants'; appsAppRoles = 'SyncAppRoles'; appOwners = 'SyncAppOwners'; appPermissions = 'SyncAppPermissions'; principalRelationships = 'SyncPrincipalRelationships'; directoryRoles = 'SyncDirectoryRoles'
        })
        # usersGroupsMembers drives three toggles at once (applied after `identity` so it wins on SyncPrincipals).
        if ($objects.ContainsKey('usersGroupsMembers')) {
            $v = [bool]$objects['usersGroupsMembers']
            $cfg.SyncPrincipals = $v; $cfg.SyncResources = $v; $cfg.SyncAssignments = $v
        }
    }

    # Direct config toggles (backward compat with older job configs).
    Set-EntraTogglesFrom -Cfg $cfg -Source $RawConfig -Map ([ordered]@{
        syncPrincipals = 'SyncPrincipals'; syncServicePrincipals = 'SyncServicePrincipals'
        syncResources = 'SyncResources'; syncAssignments = 'SyncAssignments'; syncGovernance = 'SyncGovernance'
        syncSignInLogs = 'SyncSignInLogs'; syncOAuth2Grants = 'SyncOAuth2Grants'
        syncAppRoles = 'SyncAppRoles'; syncAppOwners = 'SyncAppOwners'; syncAppPermissions = 'SyncAppPermissions'; syncPrincipalRelationships = 'SyncPrincipalRelationships'; syncDirectoryRoles = 'SyncDirectoryRoles'
    })
    Set-EntraConfigExtras -Cfg $cfg -RawConfig $RawConfig
    return $cfg
}

# Apply a { sourceKey -> Cfg key } boolean toggle map from $Source (selectedObjects or
# the raw config) onto $Cfg. Only keys actually present in $Source override the default.
function Set-EntraTogglesFrom {
    [CmdletBinding()]
    param([hashtable]$Cfg, $Source, $Map)
    foreach ($k in $Map.Keys) {
        if ($Source.ContainsKey($k)) { $Cfg[$Map[$k]] = [bool]$Source[$k] }
    }
}

# Apply the non-boolean config extras (day windows, attribute lists, identity filter)
# onto $Cfg. identityAttributes are merged into CustomUserAttributes (deduped).
function Set-EntraConfigExtras {
    [CmdletBinding()]
    param([hashtable]$Cfg, [hashtable]$RawConfig)
    if ($RawConfig.ContainsKey('signInLogsDays')) { $Cfg.SignInLogsDays = [int]$RawConfig['signInLogsDays'] }
    if ($RawConfig['customUserAttributes'])  { $Cfg.CustomUserAttributes  = @($RawConfig['customUserAttributes']) }
    if ($RawConfig['identityAttributes'])    { $Cfg.CustomUserAttributes += @($RawConfig['identityAttributes']); $Cfg.CustomUserAttributes = $Cfg.CustomUserAttributes | Select-Object -Unique }
    if ($RawConfig['customGroupAttributes']) { $Cfg.CustomGroupAttributes = @($RawConfig['customGroupAttributes']) }
    if ($RawConfig['aiNamePatterns'])        { $Cfg.AINamePatterns        = @($RawConfig['aiNamePatterns']) }
    if ($RawConfig['identityFilter'] -and $RawConfig['identityFilter']['attribute']) {
        $Cfg.IdentityFilter = $RawConfig['identityFilter']
    }
}

# ─── Run initialization ──────────────────────────────────────────
# Verify Ingest API connectivity, authenticate to Graph, and register/get the
# EntraID system. Returns the resolved systemId (falls back to 1). Calls exit 1
# if the API is unreachable — same as the original inline setup.
function Initialize-EntraCrawlerRun {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$ApiBaseUrl,
        [Parameter(Mandatory)] [string]$ApiKey,
        [Parameter(Mandatory)] [string]$ConfigFile
    )
    Write-Host "`n=== FortigiGraph EntraID Crawler ===" -ForegroundColor Cyan
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting EntraID sync via Ingest API" -ForegroundColor Cyan

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Verifying API connectivity..." -ForegroundColor Cyan
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey" }
        $whoami = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers $headers
        Write-Host "  Connected as: $($whoami.displayName)" -ForegroundColor Green
    }
    catch {
        Write-Host "  FAILED to connect to API: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Authenticating to Microsoft Graph..." -ForegroundColor Cyan
    Get-FGAccessToken -ConfigFile $ConfigFile | Out-Null

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Registering system..." -ForegroundColor Cyan
    $systemResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'delta'
        records  = @(@{
            systemType   = 'EntraID'
            displayName  = "Entra ID ($Global:TenantId)"
            tenantId     = $Global:TenantId
            enabled      = $true
            syncEnabled  = $true
        })
    }

    # ingest/systems returns systemIds[] after merging the record(s).
    $systemId = $null
    if ($systemResult.systemIds -and $systemResult.systemIds.Count -gt 0) {
        $systemId = [int]$systemResult.systemIds[0]
    }
    if (-not $systemId) {
        Write-Host "  WARNING: ingest/systems did not return a systemId — falling back to 1" -ForegroundColor Yellow
        $systemId = 1
    }
    Write-Host "  System ID: $systemId" -ForegroundColor Green
    return $systemId
}

# ─── Refresh Views ───────────────────────────────────────────────
function Sync-EntraRefreshViews {
    [CmdletBinding()]
    param($Timings)
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Update-CrawlerProgress -Step 'Refreshing materialized views' -Pct 76 -Detail 'Rebuilding SQL views...'
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Refreshing materialized views..." -ForegroundColor Cyan
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{}
        Write-Host "  Views refreshed" -ForegroundColor Green
    }
    catch {
        Write-Host "  View refresh failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['RefreshViews'] = $__phaseSW.Elapsed }
    Write-Phase -Name 'RefreshViews' -Duration $__phaseSW.Elapsed
}

# ─── Summary: per-phase timing table ─────────────────────────────
# Prints where the crawl spent its time so a "too slow" complaint is
# investigable without re-running with profiling. Unaccounted time shows as
# "Other (setup/etc)".
function Write-EntraPhaseSummary {
    [CmdletBinding()]
    param($PhaseTimings, [datetime]$SyncStart)
    $elapsed = (Get-Date) - $SyncStart
    Write-Host "`n=== Sync Complete ===" -ForegroundColor Green
    Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds)) seconds" -ForegroundColor Gray

    if ($PhaseTimings.Count -gt 0) {
        Write-Host "`nPer-phase breakdown:" -ForegroundColor Cyan
        $phaseTotal = [TimeSpan]::Zero
        foreach ($kv in $PhaseTimings.GetEnumerator()) {
            $secs = [Math]::Round($kv.Value.TotalSeconds, 1)
            $pct  = if ($elapsed.TotalSeconds -gt 0) { [Math]::Round(100 * $kv.Value.TotalSeconds / $elapsed.TotalSeconds, 1) } else { 0 }
            Write-Host ("  {0,-22} {1,8}s  ({2,5}%)" -f $kv.Key, $secs, $pct) -ForegroundColor Gray
            $phaseTotal += $kv.Value
        }
        $other = $elapsed - $phaseTotal
        if ($other.TotalSeconds -gt 1) {
            $otherSecs = [Math]::Round($other.TotalSeconds, 1)
            $otherPct  = [Math]::Round(100 * $other.TotalSeconds / $elapsed.TotalSeconds, 1)
            Write-Host ("  {0,-22} {1,8}s  ({2,5}%)" -f 'Other (setup/etc)', $otherSecs, $otherPct) -ForegroundColor DarkGray
        }
    }
}

# ─── Summary: sync-log + structured phases write ─────────────────
# Posts the structured per-phase array (for the Jobs UI Details drawer) and a
# single end-to-end sync-log entry. Both best-effort. Reads $script:phaseErrors
# / $script:phases from the caller's scope.
function Write-EntraSyncLog {
    [CmdletBinding()]
    param(
        [datetime]$SyncStart,
        [int]$JobId,
        [string]$ApiKey,
        [string]$ApiBaseUrl
    )
    $finalStatus = if ($script:phaseErrors.Count -gt 0) { 'Warning' } else { 'Success' }
    $finalError  = if ($script:phaseErrors.Count -gt 0) { ($script:phaseErrors -join ' | ') } else { $null }

    if ($JobId -and $JobId -gt 0 -and $script:phases.Count -gt 0) {
        try {
            $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
            $payload = @{ phases = $script:phases } | ConvertTo-Json -Depth 10 -Compress
            Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/jobs/$JobId/phases" -Method Post `
                -Headers $headers -Body $payload -TimeoutSec 10 | Out-Null
            Write-Host "  Posted $($script:phases.Count) phase record(s) to job API" -ForegroundColor DarkGray
        } catch {
            Write-Host "  (phases write failed: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }
    try {
        Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{
            syncType     = 'EntraID-FullCrawl'
            tableName    = $null
            startTime    = $SyncStart.ToString('o')
            endTime      = (Get-Date).ToString('o')
            recordCount  = 0
            status       = $finalStatus
            errorMessage = $finalError
        } | Out-Null
    } catch {
        Write-Host "  (sync log write failed: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}

# ─── Finalization: flip nextRunMode back to delta ────────────────
# After a successful full sync, flip the config back to delta so the next
# scheduled run uses the fast path. Non-fatal.
function Complete-EntraDeltaModeFlip {
    [CmdletBinding()]
    param(
        [string]$SyncMode,
        [hashtable]$RawConfig = @{},
        [string]$ApiBaseUrl,
        [string]$ApiKey
    )
    if ($SyncMode -eq 'full' -and $RawConfig['_scheduledByConfigId']) {
        try {
            $cid = [int]$RawConfig['_scheduledByConfigId']
            $headers = @{ 'Authorization' = "Bearer $ApiKey" }
            Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/configs/$cid/mark-delta-mode" `
                -Method Post -Headers $headers -TimeoutSec 10 | Out-Null
            Write-Host "  Reset nextRunMode to 'delta' on config $cid" -ForegroundColor Gray
        } catch {
            Write-Host "  (mark-delta-mode failed: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }
}
