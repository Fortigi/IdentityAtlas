<#
.SYNOPSIS
    Orchestrates a full Entra ID sync via the FortigiGraph Ingest API.

.DESCRIPTION
    Standalone crawler that fetches data from Microsoft Graph and POSTs it to the Ingest API.
    Replaces the old Start-FGSync direct-SQL approach with an API-driven architecture.

    Requires:
    - FortigiGraph module (for Graph API functions: Get-FGAccessToken, Invoke-FGGetRequest)
    - Ingest API running and accessible
    - Crawler API key (fgc_...)

.PARAMETER ApiBaseUrl
    Base URL of the Ingest API (e.g., https://myapp.azurewebsites.net/api)

.PARAMETER ApiKey
    Crawler API key (fgc_...)

.PARAMETER ConfigFile
    Path to FortigiGraph config file (for Graph API credentials)

.PARAMETER SyncPrincipals
    Sync user principals (default: true)

.PARAMETER SyncServicePrincipals
    Sync service principals (default: false)

.PARAMETER SyncResources
    Sync groups, directory roles, app roles (default: true)

.PARAMETER SyncAssignments
    Sync group memberships, owners, eligible members (default: true)

.PARAMETER SyncGovernance
    Sync catalogs, access packages, policies, reviews (default: true)

.PARAMETER SyncOAuth2Grants
    Sync OAuth2 delegated permission grants — per-user consents (a user
    authorized app X to call API Y with scope Z on their behalf). Tenant-wide
    (AllPrincipals) grants are skipped because they don't represent a
    user-specific authorization decision. Default: false.

.PARAMETER SyncAppRoles
    Sync application role assignments — for each enterprise application,
    fetch the catalog of appRoles[] and the assignments to users/groups.
    Group-typed assignments are expanded to per-user 'AppRoleViaGroup'
    rows so the matrix surfaces indirect access. ServicePrincipal-typed
    assignments are skipped (those would need SP-as-principal which the
    data model doesn't yet support). Default: false.

.PARAMETER SyncDirectoryRoles
    Sync Entra ID directory roles — the role catalog (roleDefinitions,
    including each role's granular allowedResourceActions), active role
    assignments, and PIM-eligible role assignments. Roles are stored as
    Resources(resourceType='EntraRole'); assignments use 'DirectoryRole'
    (active) and 'DirectoryRoleEligible' (eligible). Group-typed assignments
    are recorded against the group principal but not yet expanded to members.
    Default: false.

.PARAMETER RefreshViews
    Refresh materialized SQL views after sync (default: true)

.EXAMPLE
    .\Start-EntraIDCrawler.ps1 -ApiBaseUrl "https://myapp.azurewebsites.net/api" -ApiKey "fgc_abc123..." -ConfigFile ".\Config\mycompany.json"
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

# Read full job config and derive all crawler variables from it.
# This replaces the many named parameters previously splatted by the dispatcher.
$RawConfig = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable

# Build a synthetic ConfigFile so Get-FGAccessToken can be called with -ConfigFile.
# The Graph SDK expects { Graph: { TenantId, ClientId, ClientSecret } }.
$_graphConfigFile = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
try {
    @{ Graph = @{
        TenantId     = $RawConfig['tenantId']
        ClientId     = $RawConfig['clientId']
        ClientSecret = $RawConfig['clientSecret']
    }} | ConvertTo-Json -Depth 5 | Set-Content $_graphConfigFile -Encoding UTF8
} catch {
    Remove-Item $_graphConfigFile -Force -ErrorAction SilentlyContinue
    throw
}
$ConfigFile = $_graphConfigFile  # used by Get-FGAccessToken and Graph SDK helpers

# Sync toggles — defaults, then apply selectedObjects overrides from config
$SyncPrincipals        = $true
$SyncServicePrincipals = $false
$SyncResources         = $true
$SyncAssignments       = $true
$SyncGovernance        = $true
$SyncPim               = $false
$SyncSignInLogs        = $false
$SyncOAuth2Grants      = $false
$SyncAppRoles          = $false
$SyncDirectoryRoles    = $false
$RefreshViews          = $true
$SignInLogsDays        = 7
$CustomUserAttributes  = @()
$CustomGroupAttributes = @()
$AINamePatterns        = @()
$IdentityFilter        = @{}

$SyncMode = if ($RawConfig['_syncMode'] -in @('full','delta')) { $RawConfig['_syncMode'] } else { 'delta' }

$objects = $RawConfig['selectedObjects']
if ($objects) {
    if ($objects.ContainsKey('identity'))           { $SyncPrincipals        = [bool]$objects['identity'] }
    if ($objects.ContainsKey('usersGroupsMembers')) {
        $SyncPrincipals  = [bool]$objects['usersGroupsMembers']
        $SyncResources   = [bool]$objects['usersGroupsMembers']
        $SyncAssignments = [bool]$objects['usersGroupsMembers']
    }
    if ($objects.ContainsKey('servicePrincipals'))  { $SyncServicePrincipals = [bool]$objects['servicePrincipals'] }
    if ($objects.ContainsKey('identityGovernance')) { $SyncGovernance        = [bool]$objects['identityGovernance'] }
    if ($objects.ContainsKey('pim'))                { $SyncPim               = [bool]$objects['pim'] }
    if ($objects.ContainsKey('signInLogs'))         { $SyncSignInLogs        = [bool]$objects['signInLogs'] }
    if ($objects.ContainsKey('oauth2Grants'))       { $SyncOAuth2Grants      = [bool]$objects['oauth2Grants'] }
    if ($objects.ContainsKey('appsAppRoles'))       { $SyncAppRoles          = [bool]$objects['appsAppRoles'] }
    if ($objects.ContainsKey('directoryRoles'))     { $SyncDirectoryRoles    = [bool]$objects['directoryRoles'] }
}
# Direct config toggles (backward compat with older job configs)
if ($RawConfig.ContainsKey('syncPrincipals'))        { $SyncPrincipals        = [bool]$RawConfig['syncPrincipals'] }
if ($RawConfig.ContainsKey('syncServicePrincipals'))  { $SyncServicePrincipals = [bool]$RawConfig['syncServicePrincipals'] }
if ($RawConfig.ContainsKey('syncResources'))          { $SyncResources         = [bool]$RawConfig['syncResources'] }
if ($RawConfig.ContainsKey('syncAssignments'))        { $SyncAssignments       = [bool]$RawConfig['syncAssignments'] }
if ($RawConfig.ContainsKey('syncGovernance'))         { $SyncGovernance        = [bool]$RawConfig['syncGovernance'] }
if ($RawConfig.ContainsKey('syncSignInLogs'))         { $SyncSignInLogs        = [bool]$RawConfig['syncSignInLogs'] }
if ($RawConfig.ContainsKey('signInLogsDays'))         { $SignInLogsDays        = [int]$RawConfig['signInLogsDays'] }
if ($RawConfig.ContainsKey('syncOAuth2Grants'))       { $SyncOAuth2Grants      = [bool]$RawConfig['syncOAuth2Grants'] }
if ($RawConfig.ContainsKey('syncAppRoles'))           { $SyncAppRoles          = [bool]$RawConfig['syncAppRoles'] }
if ($RawConfig.ContainsKey('syncDirectoryRoles'))     { $SyncDirectoryRoles    = [bool]$RawConfig['syncDirectoryRoles'] }
if ($RawConfig['customUserAttributes'])  { $CustomUserAttributes  = @($RawConfig['customUserAttributes']) }
if ($RawConfig['identityAttributes'])    { $CustomUserAttributes  += @($RawConfig['identityAttributes']); $CustomUserAttributes = $CustomUserAttributes | Select-Object -Unique }
if ($RawConfig['customGroupAttributes']) { $CustomGroupAttributes = @($RawConfig['customGroupAttributes']) }
if ($RawConfig['aiNamePatterns'])        { $AINamePatterns        = @($RawConfig['aiNamePatterns']) }
if ($RawConfig['identityFilter'] -and $RawConfig['identityFilter']['attribute']) {
    $IdentityFilter = $RawConfig['identityFilter']
}

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.Phases.ps1')

# ─── Main ─────────────────────────────────────────────────────────

# Collected phase failures. Each main sync phase catches its own exceptions and
# appends a short summary here so the crawl can continue. At end-of-run, if the
# list is non-empty, we throw — the worker scheduler then marks the job
# `failed` with a message listing all phase failures. This prevents the
# April 2026 class of bug where silent phase 400s left the job marked
# "completed successfully" even though users/reviews/policies were missing.
$script:phaseErrors = [System.Collections.Generic.List[string]]::new()

# Structured per-phase outcomes: one entry per phase (and per sub-phase in
# governance). Posted as `phases` on the final sync-log write so the UI can
# render a proper per-phase breakdown instead of parsing the single-line
# errorMessage text. Shape is one hashtable per phase with:
#   name, status ('ok' | 'failed'), durationMs, error?, records?
$script:phases = [System.Collections.Generic.List[object]]::new()

Write-Host "`n=== FortigiGraph EntraID Crawler ===" -ForegroundColor Cyan
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting EntraID sync via Ingest API" -ForegroundColor Cyan

# Verify API connectivity
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

# Get Graph access token
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Authenticating to Microsoft Graph..." -ForegroundColor Cyan
Get-FGAccessToken -ConfigFile $ConfigFile

# Register/get system
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

# Read the actual system ID from the API response. The ingest/systems endpoint
# returns systemIds[] in the response after looking up the merged record(s).
$systemId = $null
if ($systemResult.systemIds -and $systemResult.systemIds.Count -gt 0) {
    $systemId = [int]$systemResult.systemIds[0]
}
if (-not $systemId) {
    Write-Host "  WARNING: ingest/systems did not return a systemId — falling back to 1" -ForegroundColor Yellow
    $systemId = 1
}

Write-Host "  System ID: $systemId" -ForegroundColor Green

$syncStart = Get-Date

# Sentinel resourceId for aggregate per-principal activity rows (the DEFAULT on
# the PrincipalActivity.resourceId column). Shared by the Principals and Service
# Principals phases — defined here, not inside a phase, so neither phase depends
# on the other having run first.
$aggResourceId = '00000000-0000-0000-0000-000000000000'

# Per-phase timings. Each major `if ($Sync...)` block stops a Stopwatch at
# its end and records the elapsed time here. Printed as a table at the end
# so operators can see where the crawl actually spent its time without
# needing to instrument downstream logs. Ordered so the Summary prints in
# execution order.
$phaseTimings = [ordered]@{}

# ─── Sync Principals ─────────────────────────────────────────────
if ($SyncPrincipals) {
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing principals (users)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing users' -Pct 12 -Detail 'Fetching from Microsoft Graph...'
    try {

    # Build $select dynamically — core attributes + custom.
    # signInActivity and userType are included so the risk scoring engine can
    # compute "stale account" and "guest user" signals. signInActivity requires
    # AuditLog.Read.All (already in the base permission set). `manager` is
    # expanded inline so we get managerId in one round trip — the alternative
    # (/users/{id}/manager per user) is ~4,500 requests for a mid-size tenant.
    $coreUserAttrs = @(
        'id','displayName','mail','userPrincipalName','accountEnabled',
        'givenName','surname','department','jobTitle','companyName','employeeId',
        'createdDateTime','userType','signInActivity','externalUserState',
        # Needed so Add-FGEntraCalculatedAttributes can derive the _OuPath
        # calculated field for on-prem-synced users. Cheap to fetch (single
        # string), high value for reporting. Cloud-native users just leave
        # it null and no _OuPath is emitted.
        'onPremisesDistinguishedName'
    )

    # If any custom attribute is extensionAttributeN, add onPremisesExtensionAttributes to the select
    $extraSelectAttrs = @()
    $hasExtensionAttrs = $false
    foreach ($attr in $CustomUserAttributes) {
        if ($attr -match '^extensionAttribute\d+$') {
            $hasExtensionAttrs = $true
        } else {
            $extraSelectAttrs += $attr
        }
    }
    # Also check identity filter — if it filters on extensionAttributeN we need the parent
    if ($IdentityFilter['attribute'] -match '^extensionAttribute\d+$') {
        $hasExtensionAttrs = $true
    }
    if ($hasExtensionAttrs) {
        $extraSelectAttrs += 'onPremisesExtensionAttributes'
    }
    $allUserAttrs = $coreUserAttrs + $extraSelectAttrs | Select-Object -Unique
    $userSelect = $allUserAttrs -join ','

    # ── Delta vs full fetch decision ─────────────────────────────
    # `/users/delta` doesn't support $expand=manager (Graph limitation), so
    # delta runs lose manager refresh. The recommended pattern is: full-mode
    # runs still use /users?$expand=manager (authoritative managerId), AND
    # prime a delta token by making a second "skipToken=latest" call at the
    # end so the next delta run starts from the current state. Delta-mode
    # runs use /users/delta?$deltatoken=<token> for changes only. If the
    # token is rejected (400/410), we clear it and fall back to a full pass
    # — the operator sees the slower run in the Details drawer.
    $usersEndpoint  = 'users/delta'
    $usersToken     = $null
    $newUsersToken  = $null
    $deltaHit       = $false
    $removedUserIds = @()

    if ($SyncMode -eq 'full') {
        # Explicit full: wipe any stored token so stale context can't survive.
        Remove-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint
    } elseif ($SyncMode -eq 'delta') {
        $usersToken = Get-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint
    }

    if ($usersToken) {
        Write-Host "  Delta mode: fetching only changes since last run..." -ForegroundColor Gray
        try {
            $deltaUri = "https://graph.microsoft.com/beta/users/delta?`$deltatoken=$([uri]::EscapeDataString($usersToken))"
            $resp = Invoke-FGGetDeltaRequest -URI $deltaUri
            $users = @($resp.value | Where-Object { -not $_.'@removed' })
            $removedUserIds = @($resp.value | Where-Object { $_.'@removed' } | ForEach-Object { $_.id })
            $newUsersToken = $resp.deltaToken
            $deltaHit = $true
            Write-Host "  Delta: $($users.Count) changed + $($removedUserIds.Count) removed" -ForegroundColor Gray
        } catch [System.InvalidOperationException] {
            Write-Host "  Delta token rejected by Graph — clearing and falling back to full fetch" -ForegroundColor Yellow
            Remove-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint
            $usersToken = $null
            $users = $null
        } catch {
            Write-Host "  Delta fetch failed: $($_.Exception.Message) — falling back to full" -ForegroundColor Yellow
            $usersToken = $null
            $users = $null
        }
    }

    if (-not $deltaHit) {
        # Full path: authoritative fetch with manager expand. Then prime a
        # delta token with a real /users/delta call — Graph only hands the
        # token out after you've walked the entire collection, so we pay
        # the full pagination cost here (~500KB × N pages). $select=id keeps
        # the payload minimal. This is a one-time cost on forced-full runs
        # (hourly runs after that use delta).
        $users = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/users?`$select=$userSelect&`$expand=manager(`$select=id)&`$top=999"
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

    Update-CrawlerProgress -Detail "Building $($users.Count) user records..."

    # Per-user record shaping lives in ConvertTo-EntraPrincipalRecord
    # (EntraIDCrawler.Transform.ps1) so it can be unit-tested without a tenant.
    $records = @($users | ForEach-Object {
        ConvertTo-EntraPrincipalRecord -User $_ -CustomUserAttributes $CustomUserAttributes
    })

    Update-CrawlerProgress -Detail "Uploading $($records.Count) users to ingest API..."
    # In a delta-hit run we also forward @removed tombstone ids, and we use
    # syncMode='delta' so the ingest engine DOESN'T scoped-delete any user
    # we didn't touch (we only saw the changed subset).
    $ingestMode = if ($deltaHit) { 'delta' } else { 'full' }
    Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode $ingestMode `
        -Scope @{ principalType = 'User' } -Records $records -DeletedIds $removedUserIds

    # Save the fresh delta token (if we got one). Next run will pick it up.
    if ($newUsersToken) {
        Set-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint -Token $newUsersToken -RecordsLastSeen $records.Count
    }

    # ─── Upload user sign-in activity (aggregate per-principal) ──
    # The four signInActivity timestamps come back on the same /users call,
    # but they live in the dedicated PrincipalActivity table now — sending
    # them to /ingest/principal-activity with resourceId set to the
    # AGG_RESOURCE_ID sentinel (the DEFAULT on the column) produces one
    # aggregate row per user.
    $activityRecords = @($users | ForEach-Object {
        ConvertTo-EntraSignInActivityRecord -User $_
    } | Where-Object { $_ })
    if ($activityRecords.Count -gt 0) {
        Update-CrawlerProgress -Detail "Uploading $($activityRecords.Count) user sign-in activity records..."
        Send-IngestBatch -Endpoint 'ingest/principal-activity' -SystemId $systemId -SyncMode 'delta' `
            -Records $activityRecords
    }

    # ─── Identity sync (filtered subset of users) ────────────────
    if ($IdentityFilter.Count -gt 0 -and $IdentityFilter['attribute']) {
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing identities (filtered from users)..." -ForegroundColor Cyan
        $attr = $IdentityFilter['attribute']
        $condition = $IdentityFilter['condition']
        $filterValue = $IdentityFilter['value']
        $filterValues = $IdentityFilter['values']

        # Coerce filter value to match the attribute's runtime type — booleans
        # need a real $true/$false (PowerShell -eq is type-strict for booleans)
        $identityUsers = $users | Where-Object {
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
        }

        Write-Host "  Matched $($identityUsers.Count) of $($users.Count) users as identities (filter: $attr $condition $filterValue$($filterValues -join ','))" -ForegroundColor Cyan

        if ($identityUsers.Count -gt 0) {
            $idRecords = @($identityUsers | ForEach-Object {
                $idRec = @{
                    id            = $_.id
                    displayName   = $_.displayName
                    email         = $_.mail ?? $_.userPrincipalName
                    department    = $_.department
                    jobTitle      = $_.jobTitle
                    companyName   = $_.companyName
                    employeeId    = $_.employeeId
                }
                # Identities also get custom attributes in extendedAttributes
                if ($CustomUserAttributes.Count -gt 0) {
                    $ext = @{}
                    foreach ($a in $CustomUserAttributes) {
                        $v = Get-UserAttrValue -User $_ -AttrName $a
                        if ($null -ne $v -and $v -ne '') { $ext[$a] = $v }
                    }
                    if ($ext.Count -gt 0) { $idRec['extendedAttributes'] = $ext }
                }
                $idRec
            })

            # In delta mode we only have changed users, so full-mode
            # scoped-delete would wipe unchanged identities. Use the same
            # $ingestMode as Principals — delta runs upsert only, full runs
            # reconcile deletes. Weekly full run cleans up filter drop-offs.
            Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $systemId -SyncMode $ingestMode -Records $idRecords

            # Link identities to principals
            $idMembers = @($identityUsers | ForEach-Object {
                @{
                    identityId  = $_.id
                    principalId = $_.id
                }
            })
            Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $systemId -SyncMode $ingestMode -Records $idMembers
        }
    }
    } catch {
        $script:phaseErrors.Add("Principals: $($_.Exception.Message)")
        Write-Host "  Principals phase failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    $__principalsErrMsg = $script:phaseErrors | Where-Object { $_.StartsWith('Principals: ') } | Select-Object -Last 1
    $__phaseSW.Stop(); $phaseTimings['Principals'] = $__phaseSW.Elapsed
    Write-Phase -Name 'Principals' -Duration $__phaseSW.Elapsed -ErrorMsg $__principalsErrMsg
}

# ─── Sync Service Principals ─────────────────────────────────────
# $sps is fetched here and reused by the Sign-in Logs phase below, so it's
# initialized up front and only (re)assigned when this phase runs.
$sps = @()
if ($SyncServicePrincipals) {
    $sps = Sync-EntraServicePrincipals -SystemId $systemId -SyncMode $SyncMode `
        -AINamePatterns $AINamePatterns -AggregateResourceId $aggResourceId -Timings $phaseTimings
}

# ─── Sync Sign-in Logs (per-(user, app) activity) ────────────────
# Aggregates /auditLogs/signIns events from the last $SignInLogsDays days
# into per-(user, app) last-activity rows (granularity B). Each event is
# O(1) work; the sum is kept in a hashtable keyed by "$userId|$appSpId"
# so the peak memory is bounded by the number of DISTINCT pairs, not
# event count. Tenants with millions of events/week still aggregate to
# ~O(users × apps) entries — well within PowerShell's reach.
#
# Requires AuditLog.Read.All (already in the base permission set). The
# block also resolves app appId → SP principalId on the fly via
# /servicePrincipals so it works whether or not the SP sync ran this run.
if ($SyncSignInLogs) {
    Sync-EntraSignInLogs -SystemId $systemId -Sps $sps -SignInLogsDays $SignInLogsDays -Timings $phaseTimings
}

# ─── Sync Resources (Groups) ─────────────────────────────────────
# $groups is fetched here and reused by the Assignments and PIM phases below, so
# it's initialized up front and only (re)assigned when the Resources phase runs.
$groups = @()
if ($SyncResources) {
    $groups = Sync-EntraResources -SystemId $systemId -CustomGroupAttributes $CustomGroupAttributes -Timings $phaseTimings
}

# ─── Sync Assignments (Group Members + Owners) ───────────────────
if ($SyncAssignments) {
    Sync-EntraAssignments -SystemId $systemId -Groups $groups -Timings $phaseTimings
}

# ─── Sync PIM (Eligible group memberships) ───────────────────────
# Privileged Identity Management gives users "Eligible" (not active) membership
# in groups. The Graph endpoint requires a `$filter=groupId eq '<id>'` — there
# is no supported "list all" variant (an earlier attempt to drop the filter
# returned 400). On a 9k-group tenant this phase is ~25 min; optimisation is
# a separate problem (Graph $batch or a different endpoint). For now we
# accept the duration in exchange for correctness.
if ($SyncPim) {
    Sync-EntraPim -SystemId $systemId -Groups $groups -Timings $phaseTimings
}

# ─── Sync Governance ─────────────────────────────────────────────
if ($SyncGovernance) {
    Sync-EntraGovernance -SystemId $systemId -Timings $phaseTimings
}

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
if ($SyncOAuth2Grants) {
    Sync-EntraOAuth2Grants -SystemId $systemId -Timings $phaseTimings
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
if ($SyncAppRoles) {
    Sync-EntraAppRoles -SystemId $systemId -Timings $phaseTimings
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
if ($SyncDirectoryRoles) {
    Sync-EntraDirectoryRoles -SystemId $systemId -Timings $phaseTimings
}

# ─── Refresh Views ───────────────────────────────────────────────
if ($RefreshViews) {
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
    $__phaseSW.Stop(); $phaseTimings['RefreshViews'] = $__phaseSW.Elapsed
    Write-Phase -Name 'RefreshViews' -Duration $__phaseSW.Elapsed
}

# ─── Summary ─────────────────────────────────────────────────────
$elapsed = (Get-Date) - $syncStart
Write-Host "`n=== Sync Complete ===" -ForegroundColor Green
Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds)) seconds" -ForegroundColor Gray

# Per-phase breakdown. The point of the table is to tell an operator
# WHERE the time went so a "this sync takes too long" complaint can be
# investigated without re-running with profiling hacks. Unaccounted time
# (setup, context build invoked by the dispatcher, etc.) is the line
# at the bottom.
if ($phaseTimings.Count -gt 0) {
    Write-Host "`nPer-phase breakdown:" -ForegroundColor Cyan
    $phaseTotal = [TimeSpan]::Zero
    foreach ($kv in $phaseTimings.GetEnumerator()) {
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

# Write a single sync log entry covering the full crawler runtime so the
# Sync Log page reflects the actual end-to-end duration (not just the per-batch
# bulk insert timings written by individual ingest endpoints).
$finalStatus = if ($script:phaseErrors.Count -gt 0) { 'Warning' } else { 'Success' }
$finalError  = if ($script:phaseErrors.Count -gt 0) { ($script:phaseErrors -join ' | ') } else { $null }

# Post the structured per-phase array so the Jobs UI can render a Details
# drawer instead of parsing the single-line errorMessage. Best-effort — if
# this fails we still fall through to the legacy sync-log write.
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
        startTime    = $syncStart.ToString('o')
        endTime      = (Get-Date).ToString('o')
        recordCount  = 0
        status       = $finalStatus
        errorMessage = $finalError
    } | Out-Null
} catch {
    Write-Host "  (sync log write failed: $($_.Exception.Message))" -ForegroundColor DarkGray
}

# If any main-phase failures occurred, throw so the worker scheduler marks
# the job `failed` with a summary message. All successful phases have
# already been ingested and are visible in the UI — this is strictly
# about making the silent-failure case loud. See the $script:phaseErrors
# comment at the top of the script for the motivation.
if ($script:phaseErrors.Count -gt 0) {
    $summary = "Crawl completed with $($script:phaseErrors.Count) phase failure(s):`n  - " + ($script:phaseErrors -join "`n  - ")
    Write-Host "`n$summary" -ForegroundColor Red
    throw $summary
}

# After a successful full sync, flip the config back to delta so the next
# scheduled run uses the fast path. Non-fatal — worst case the next run
# is also full, which is slow but correct.
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

# Clean up the temporary Graph credentials file (contains client secret)
Remove-Item $_graphConfigFile -Force -ErrorAction SilentlyContinue
