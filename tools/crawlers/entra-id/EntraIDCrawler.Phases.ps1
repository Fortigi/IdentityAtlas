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
            # Collect unique SP IDs referenced as either client or target API so
            # we can attach human-readable displayNames to the Resource rows.
            # We fetch each SP individually — Graph's `$filter id in (...)` on
            # servicePrincipals has a 15-item cap and a tight total URL length
            # limit; one-at-a-time is slower but robust across all tenant sizes.
            $spIds = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($g in $userGrants) {
                if ($g.clientId)   { [void]$spIds.Add($g.clientId) }
                if ($g.resourceId) { [void]$spIds.Add($g.resourceId) }
            }
            Update-CrawlerProgress -Detail "Resolving $($spIds.Count) service principals..."

            $spInfo = @{}
            foreach ($id in $spIds) {
                try {
                    $sp = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals/$id`?`$select=id,displayName,appId,publisherName"
                    if ($sp) {
                        $spInfo[$id] = @{
                            displayName    = $sp.displayName
                            appId          = $sp.appId
                            publisherName  = $sp.publisherName
                        }
                    }
                } catch {
                    # SP deleted / inaccessible — fall back to the raw id so
                    # the grant is still ingestible.
                    $spInfo[$id] = @{ displayName = $id; appId = $null; publisherName = $null }
                }
            }

            # ── Emit client-app Resources (one per distinct client SP) ────
            $clientIds = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($g in $userGrants) { [void]$clientIds.Add($g.clientId) }
            $clientRecords = @($clientIds | ForEach-Object {
                ConvertTo-EntraOAuth2ClientResource -ClientId $_ -SpInfo $spInfo[$_]
            })
            Update-CrawlerProgress -Detail "Uploading $($clientRecords.Count) client apps..."
            Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ resourceType = 'Application' } -Records $clientRecords

            # ── Build unique scope resources and relationships ────────────
            # One Resource per (clientSpId, targetApiSpId, scope). The scope
            # string is space-separated — split it so analysts can filter on
            # individual scopes like "Mail.Read".
            $scopeGraph = ConvertTo-EntraOAuth2ScopeGraph -UserGrants $userGrants -SpInfo $spInfo

            $scopeRecords = @($scopeGraph.resources)
            Update-CrawlerProgress -Detail "Uploading $($scopeRecords.Count) scope resources..."
            Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ resourceType = 'DelegatedPermission' } -Records $scopeRecords

            $relRecords = @($scopeGraph.relationships)
            Update-CrawlerProgress -Detail "Uploading $($relRecords.Count) scope relationships..."
            Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ relationshipType = 'DelegatesScope' } -Records $relRecords

            # Dedupe assignments on PK (resourceId, principalId, assignmentType).
            # Graph never returns duplicate per-user grants for the same (client,
            # api) pair, but we split one multi-scope grant into N rows so two
            # different grants referencing the same user/scope via different
            # (client, api) combos could collide at the PK. Unlikely in practice
            # — but a HashSet is cheap insurance.
            $seen = @{}
            $assignRecords = @($scopeGraph.assignments | Where-Object {
                $k = "$($_.resourceId)|$($_.principalId)"
                if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true }
            })
            Update-CrawlerProgress -Detail "Uploading $($assignRecords.Count) OAuth2 grant assignments..."
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'Direct'; resourceType = 'DelegatedPermission' } -Records $assignRecords
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

        # Build a role catalog. Always include the "default access" role — for
        # SPs configured with appRoleAssignmentRequired=true but no custom
        # roles, assignments fall back to the zero-GUID role id.
        $rolesByGuid = Get-EntraAppRoleCatalog -ServicePrincipal $sp -DefaultRoleId $DefaultRoleId

        # Fetch assignments. SPs without any assignments still emit Application
        # + AppRole Resources so the catalog is browseable.
        $assignments = @()
        try {
            $assignments = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals/$($sp.id)/appRoleAssignedTo?`$top=999")
        } catch {
            Write-Host "    /appRoleAssignedTo failed for $($sp.displayName): $($_.Exception.Message)" -ForegroundColor DarkYellow
            continue
        }

        if ($assignments.Count -eq 0) { continue }

        # Emit Application Resource (idempotent — OAuth2 phase may already have
        # written this same record, but the ingest endpoint upserts).
        if (-not $appResourceMap.ContainsKey($sp.id)) {
            $appResourceMap[$sp.id] = ConvertTo-EntraAppRoleApplicationResource -ServicePrincipal $sp
        }

        foreach ($a in $assignments) {
            Add-EntraAppRoleAssignment -Assignment $a -ServicePrincipal $sp `
                -RolesByGuid $rolesByGuid -DefaultRoleId $DefaultRoleId `
                -AppRoleMap $appRoleMap -RelMap $relMap `
                -DirectAssns $directAssns -GroupAssns $groupAssns
        }
    }

    $indirectAssns = Expand-EntraAppRoleGroupAssignments -GroupAssns $groupAssns

    # Dedupe on PK (resourceId, principalId, assignmentType). Within a single
    # sync the same (user, role) can arrive twice if the user belongs to two
    # groups both assigned the same role.
    $seenDirect = @{}
    $directRecords = @($directAssns | Where-Object {
        $k = "$($_.resourceId)|$($_.principalId)"
        if ($seenDirect.ContainsKey($k)) { $false } else { $seenDirect[$k] = $true; $true }
    })
    $seenIndirect = @{}
    $indirectRecords = @($indirectAssns | Where-Object {
        $k = "$($_.resourceId)|$($_.principalId)"
        if ($seenIndirect.ContainsKey($k)) { $false } else { $seenIndirect[$k] = $true; $true }
    })

    return @{
        appRecords      = @($appResourceMap.Values)
        roleRecords     = @($appRoleMap.Values)
        relRecords      = @($relMap.Values)
        directRecords   = $directRecords
        indirectRecords = $indirectRecords
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
#     Resources(EntraRole)            <-- one per roleDefinition (id = roleDefinitionId)
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

    # Map a Graph directory-object @odata.type to our principalType vocabulary.
    try {
        # 1. Role catalog. /roleDefinitions returns the full set of built-in
        #    roles plus any custom roles. id == templateId for built-ins.
        $roleDefs = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/roleManagement/directory/roleDefinitions")
        Write-Host "  Fetched $($roleDefs.Count) role definitions" -ForegroundColor Gray

        $roleRecords = @($roleDefs | ForEach-Object { ConvertTo-EntraRoleResourceRecord -RoleDefinition $_ })

        # 2. Active assignments (permanent + currently-activated PIM). $expand=principal
        #    gives us the principal's @odata.type so we can set principalType
        #    without a second lookup per assignment.
        $activeList = [System.Collections.Generic.List[object]]::new()
        try {
            $roleAssignments = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/roleManagement/directory/roleAssignments?`$expand=principal")
            foreach ($ra in $roleAssignments) {
                $activeRec = ConvertTo-EntraDirectoryRoleAssignment -RoleAssignment $ra
                if ($activeRec) { $activeList.Add($activeRec) }
            }
        } catch {
            Write-Host "    /roleAssignments failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }

        # 3. PIM-eligible assignments (eligible but not active). Tenants without
        #    PIM (no Entra ID P2) return 400/403 here — non-fatal.
        $eligibleList = [System.Collections.Generic.List[object]]::new()
        try {
            $eligibility = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/roleManagement/directory/roleEligibilityScheduleInstances?`$expand=principal")
            foreach ($e in $eligibility) {
                $eligibleRec = ConvertTo-EntraDirectoryRoleEligibility -Eligibility $e
                if ($eligibleRec) { $eligibleList.Add($eligibleRec) }
            }
        } catch {
            Write-Host "    /roleEligibilityScheduleInstances failed (PIM may be unavailable): $($_.Exception.Message)" -ForegroundColor DarkYellow
        }

        # Dedupe on the assignment PK (resourceId, principalId, assignmentType).
        # The same principal can hold one role at multiple directory scopes; the
        # PK has no scope component, so collapse to the first (tenant-wide is the
        # dominant case — per-scope modelling is a follow-up).
        $seenActive = @{}
        $activeRecords = @($activeList | Where-Object {
            $k = "$($_.resourceId)|$($_.principalId)"
            if ($seenActive.ContainsKey($k)) { $false } else { $seenActive[$k] = $true; $true }
        })
        $seenEligible = @{}
        $eligibleRecords = @($eligibleList | Where-Object {
            $k = "$($_.resourceId)|$($_.principalId)"
            if ($seenEligible.ContainsKey($k)) { $false } else { $seenEligible[$k] = $true; $true }
        })

        Write-Host "  Roles: $($roleRecords.Count) · Active: $($activeRecords.Count) · Eligible: $($eligibleRecords.Count)" -ForegroundColor Gray

        if ($roleRecords.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($roleRecords.Count) directory roles..."
            Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ resourceType = 'EntraRole' } -Records $roleRecords
        }
        if ($activeRecords.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($activeRecords.Count) active role assignments..."
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'Direct'; resourceType = 'EntraRole' } -Records $activeRecords
        }
        if ($eligibleRecords.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($eligibleRecords.Count) eligible role assignments..."
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'Eligible'; resourceType = 'EntraRole' } -Records $eligibleRecords
        }
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

# ─── Sync Resources (Groups) ─────────────────────────────────────
# Fetches all groups, uploads them as EntraGroup resources, and RETURNS the raw
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
        $coreGroupAttrs = @('id','displayName','description','mail','visibility','createdDateTime','groupTypes','securityEnabled','mailEnabled')
        $allGroupAttrs = $coreGroupAttrs + $CustomGroupAttributes | Select-Object -Unique
        $groupSelect = $allGroupAttrs -join ','
        $groups = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/groups?`$select=$groupSelect&`$top=999"

        $records = @($groups | ForEach-Object {
            ConvertTo-EntraGroupResourceRecord -Group $_ -CustomGroupAttributes $CustomGroupAttributes
        })

        # Out-Null so the phase function returns ONLY $groups, not the ingest result.
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'EntraGroup' } -Records $records | Out-Null
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
                resourceType   = 'EntraGroup'
                principalType  = if ($o.childType -eq '#microsoft.graph.group') { 'Group' } else { 'User' }
            }
        }
    $allMembers = $memberResult.records
    if ($memberResult.errorCount -gt 0) {
        Write-Host "  WARNING: $($memberResult.errorCount) groups failed after retries (skipped)" -ForegroundColor Yellow
    }

    Update-CrawlerProgress -Detail "Uploading $($allMembers.Count) memberships to ingest API..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Direct'; resourceType = 'EntraGroup' } -Records $allMembers

    # Group Owners — modelled as a Direct assignment to a synthetic
    # "Owner @ <group>" resource (resourceType='GroupOwnership'), linked to the
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

            # Group output by source group to compute pimGroupCount accurately
            $groupSet = @{}
            foreach ($r in $batchOutput) {
                $pimRecordsList.Add((ConvertTo-EntraPimRecord -EligibilityRow $r))
                $groupSet[$r.resourceId] = $true
            }
            $pimGroupCount += $groupSet.Count

            $pimChecked = [Math]::Min($i + $pimBatchSize, $pimTotal)
            $subPct = 61 + [int](([double]$pimChecked / $pimTotal) * 4)
            Update-CrawlerProgress -Pct $subPct -Detail "$pimChecked of $pimTotal groups · $pimGroupCount with eligibilities"
        }

        $pimRecords = @($pimRecordsList)
        Write-Host "  Found $pimGroupCount PIM-enabled group(s) with $($pimRecords.Count) eligible memberships" -ForegroundColor Gray

        if ($pimRecords.Count -gt 0) {
            # Dedup by (resourceId, principalId)
            $seen = @{}
            $pimRecords = @($pimRecords | Where-Object {
                $k = "$($_.resourceId)|$($_.principalId)"
                if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true }
            })
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'Eligible'; resourceType = 'EntraGroup' } -Records $pimRecords
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
