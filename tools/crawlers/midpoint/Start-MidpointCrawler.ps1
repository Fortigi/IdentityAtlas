<#
.SYNOPSIS
    Synchronise midPoint (Evolveum) IGA data to Identity Atlas via the Ingest API.

.DESCRIPTION
    Reads midPoint's focus/projection model over the REST API and maps it onto the
    Identity Atlas universal data model:

      ResourceType (connected systems) → Systems
      OrgType                          → Contexts (OrgUnit) + ContextMembers
      RoleType                         → Resources (BusinessRole)   + ResourceRelationships (Contains, via inducement)
      ServiceType                      → Resources (Service)
      UserType (focus / person)        → Identities + a Principal (the midPoint account) + IdentityMembers
      ShadowType (accounts on systems) → Principals (per resource system) + IdentityMembers (via user.linkRef)
      user.assignment[] → Role/Service → ResourceAssignments (Governed)
      user.parentOrgRef[]              → ContextMembers (org membership)

    midPoint object OIDs are UUIDs, so they are reused directly as Identity Atlas
    id / externalId, which makes every record traceable back to its source object.

    SAFE SYNC SCOPING — this instance may hold data from other sources (Entra, Omada,
    CSV). The Identity Atlas ingest engine reconciles (deletes stale rows) on a full
    sync. To never delete another source's data, full-sync reconcile is used ONLY for
    entities that carry a per-system scope column (Principals, Resources,
    ResourceAssignments, ResourceRelationships — scoped by systemId; Contexts — scoped
    by scopeSystemId). Cross-system tables without a system scope (Systems, Identities,
    IdentityMembers, ContextMembers) are always written in delta (upsert-only) mode.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL (e.g. http://web:3001/api).
.PARAMETER ApiKey
    Identity Atlas crawler API key (fgc_...).
.PARAMETER JobId
    Job ID for live progress reporting. 0 = standalone.
.PARAMETER ConfigPath
    Path to the JSON config file written by the dispatcher.
#>

#region Parameters
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)
#endregion Parameters

#region Configuration
$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

if (-not (Test-Path $ConfigPath)) { throw "Config file not found: $ConfigPath" }
$Cfg       = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$RawConfig = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable

$SyncMode = if ($RawConfig['_syncMode'] -in @('full', 'delta')) { $RawConfig['_syncMode'] } else { 'full' }
$PageSize = if ($Cfg.pageSize) { [int]$Cfg.pageSize } else { 100 }

# Phase toggles — default on, overridden by selectedObjects
$Sync = @{ systems = $true; orgs = $true; roles = $true; services = $true
           users = $true; shadows = $true; orgMembership = $true
           assignments = $true; roleNesting = $true; reviews = $true }
if ($null -ne $Cfg.syncShadows) { $Sync.shadows = [bool]$Cfg.syncShadows }
$objects = $RawConfig['selectedObjects']
if ($objects) {
    foreach ($k in @($Sync.Keys)) {
        if ($objects.ContainsKey($k)) { $Sync[$k] = [bool]$objects[$k] }
    }
}

# Dot-source shared ingest helpers (Invoke-IngestAPI, Update-CrawlerProgress, ConvertTo-JsonArray)
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')

# The dispatcher dot-sources Invoke-MidpointApi.ps1 (sibling library) before this
# entry point runs. For standalone invocation, load it here if absent.
if (-not (Get-Command Connect-MidpointAPI -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Invoke-MidpointApi.ps1')
}
#endregion Configuration

#region Helpers
# Cross-system tables have no per-system delete scope → never reconcile-delete them
# (would remove other sources' data). Always upsert-only (delta) for these.
$CrossSystemEntities = @('systems', 'identities', 'identity-members', 'context-members', 'governance/certifications')
function Get-EntitySyncMode {
    param([string]$Entity)
    if ($CrossSystemEntities -contains $Entity) { return 'delta' }
    return $SyncMode
}

function Send-IngestBatch {
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [int]$SystemId      = 0,
        [string]$SyncModeOverride = $null,
        [hashtable]$Scope   = @{},
        [array]$Records     = @(),
        [int]$BatchSize     = 5000
    )
    $entity = ($Endpoint -replace '^ingest/', '')
    $mode   = if ($SyncModeOverride) { $SyncModeOverride } else { Get-EntitySyncMode -Entity $entity }

    if (-not $Records -or $Records.Count -eq 0) {
        # The ingest API rejects an empty records array (no scoped-delete-only mode),
        # so skip the call entirely when a phase produced no records.
        Write-Host "  (no records for $Endpoint — skipping)" -ForegroundColor DarkGray
        return @{ inserted = 0; updated = 0; deleted = 0 }
    }
    $swIngest = [System.Diagnostics.Stopwatch]::StartNew()
    if ($Records.Count -le $BatchSize) {
        $Body   = @{ systemId = $SystemId; syncMode = $mode; scope = $Scope; records = ConvertTo-JsonArray $Records }
        $Result = Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
    }
    else {
        # Chunked session for large batches
        $SyncId = $null; $TotIns = 0; $TotUpd = 0; $TotDel = 0
        for ($i = 0; $i -lt $Records.Count; $i += $BatchSize) {
            $Chunk   = $Records[$i..([Math]::Min($i + $BatchSize - 1, $Records.Count - 1))]
            $IsFirst = ($i -eq 0)
            $IsLast  = ($i + $BatchSize -ge $Records.Count)
            $Body    = @{ systemId = $SystemId; syncMode = $mode; scope = $Scope; records = ConvertTo-JsonArray $Chunk
                          syncSession = if ($IsFirst) { 'start' } elseif ($IsLast) { 'end' } else { 'continue' } }
            if ($SyncId) { $Body.syncId = $SyncId }
            $R = Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
            if ($IsFirst -and $R.syncId) { $SyncId = $R.syncId }
            $TotIns += ($R.inserted ?? 0); $TotUpd += ($R.updated ?? 0); $TotDel += ($R.deleted ?? 0)
        }
        $Result = @{ inserted = $TotIns; updated = $TotUpd; deleted = $TotDel }
    }
    $swIngest.Stop()
    Add-IngestStat -Endpoint $entity -Seconds $swIngest.Elapsed.TotalSeconds -Records $Records.Count
    return $Result
}

# ── Streaming ingest ──────────────────────────────────────────────────────────
# Flush records in BatchSize chunks within ONE sync session so a full-sync's scoped
# delete still sees the complete set — without ever holding all records in memory.
# Mirrors Send-IngestBatch's chunked-session protocol (start → continue → end), or a
# single full-sync call when everything fits in one batch.
function New-IngestStream {
    param([Parameter(Mandatory)][string]$Endpoint, [int]$SystemId = 0, [hashtable]$Scope = @{}, [int]$BatchSize = 5000)
    [pscustomobject]@{
        Endpoint = $Endpoint; SystemId = $SystemId; Scope = $Scope; BatchSize = $BatchSize
        Buffer = [System.Collections.Generic.List[object]]::new(); SyncId = $null; Started = $false
        Records = 0; Inserted = 0; Updated = 0; Deleted = 0
    }
}
function Send-IngestStreamChunk {
    param($Stream, [string]$Session)   # 'start' | 'continue' | 'end' | 'single'
    $entity = ($Stream.Endpoint -replace '^ingest/', '')
    $mode   = Get-EntitySyncMode -Entity $entity
    $count  = $Stream.Buffer.Count
    $body   = @{ systemId = $Stream.SystemId; syncMode = $mode; scope = $Stream.Scope; records = ConvertTo-JsonArray @($Stream.Buffer) }
    if ($Session -ne 'single') {
        $body['syncSession'] = $Session
        if ($Stream.SyncId) { $body['syncId'] = $Stream.SyncId }
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $R  = Invoke-IngestAPI -Endpoint $Stream.Endpoint -Body $body
    $sw.Stop()
    if ($Session -in @('start', 'single') -and $R.syncId) { $Stream.SyncId = $R.syncId }
    $Stream.Inserted += ($R.inserted ?? 0); $Stream.Updated += ($R.updated ?? 0); $Stream.Deleted += ($R.deleted ?? 0)
    Add-IngestStat -Endpoint $entity -Seconds $sw.Elapsed.TotalSeconds -Records $count
    $Stream.Buffer.Clear()
}
function Add-IngestStreamRecord {
    param($Stream, $Record)
    $Stream.Buffer.Add($Record); $Stream.Records++
    # Flush only once we hold MORE than a full batch, so a non-empty remainder is always
    # left for the closing 'end' (the ingest API rejects an empty records array, and the
    # scoped delete fires on 'end').
    if ($Stream.Buffer.Count -gt $Stream.BatchSize) {
        $remainder = [System.Collections.Generic.List[object]]::new()
        for ($i = $Stream.BatchSize; $i -lt $Stream.Buffer.Count; $i++) { $remainder.Add($Stream.Buffer[$i]) }
        while ($Stream.Buffer.Count -gt $Stream.BatchSize) { $Stream.Buffer.RemoveAt($Stream.Buffer.Count - 1) }
        Send-IngestStreamChunk -Stream $Stream -Session ($(if ($Stream.Started) { 'continue' } else { 'start' }))
        $Stream.Started = $true
        $Stream.Buffer = $remainder
    }
}
function Complete-IngestStream {
    param($Stream)
    if ($Stream.Records -eq 0) { return }   # nothing → no scoped delete (matches Send-IngestBatch empty-skip)
    Send-IngestStreamChunk -Stream $Stream -Session ($(if ($Stream.Started) { 'end' } else { 'single' }))
}

function Write-Step { param([string]$Msg) Write-Host "  → $Msg" -ForegroundColor DarkGray }

$Script:phaseErrors = [System.Collections.Generic.List[string]]::new()
function Add-PhaseError { param([string]$Phase, [string]$Msg)
    Write-Host "  $Phase failed: $Msg" -ForegroundColor Red
    $Script:phaseErrors.Add("${Phase}: $Msg")
}

# ── Lightweight performance instrumentation (behaviour-neutral) ──────────────
# Master wall-clock, per-ingest-endpoint latency, and midPoint read timings, so a
# load test can attribute time to source reads vs ingest writes. Printed in the summary.
$Script:swMaster    = [System.Diagnostics.Stopwatch]::StartNew()
$Script:ingestStats = [ordered]@{}   # endpoint → @{ seconds; calls; records }
$Script:fetchStats  = [ordered]@{}   # read label → @{ seconds; count }
function Add-IngestStat { param([string]$Endpoint, [double]$Seconds, [int]$Records)
    if (-not $Script:ingestStats.Contains($Endpoint)) { $Script:ingestStats[$Endpoint] = @{ seconds = 0.0; calls = 0; records = 0 } }
    $Script:ingestStats[$Endpoint].seconds += $Seconds
    $Script:ingestStats[$Endpoint].calls++
    $Script:ingestStats[$Endpoint].records += $Records
}
function Measure-MidpointFetch { param([string]$Label, [scriptblock]$Script)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $result = & $Script
    $sw.Stop()
    $n = @($result).Count
    $Script:fetchStats[$Label] = @{ seconds = $sw.Elapsed.TotalSeconds; count = $n }
    return $result
}

# Build a human-readable label for a shadow account. Some connectors (e.g. DatabaseTable)
# name shadows by a numeric key; prefer a readable attribute, then the owner's name +
# resource, and only fall back to the raw (possibly numeric) shadow name as a last resort.
function Get-MidpointShadowLabel {
    param($Shadow, [string]$ShadowOid, [string]$ResourceOid)
    $readable = Get-MidpointAttrValue -Shadow $Shadow -Keys @('fullName', 'cn', 'displayName', 'sAMAccountName', 'login', 'name')
    if (-not $readable) { $readable = Format-AccountLabel (Get-MidpointString $Shadow.name '') }
    else { $readable = Format-AccountLabel $readable }
    if ($readable -and $readable -match '[A-Za-z]') { return $readable }
    if ($ShadowOidToUserOid.ContainsKey($ShadowOid)) {
        $ownerOid = $ShadowOidToUserOid[$ShadowOid]
        if ($UserOidToName.ContainsKey($ownerOid)) {
            $rn = if ($ResourceOidToName.ContainsKey($ResourceOid)) { $ResourceOidToName[$ResourceOid] } else { 'account' }
            return ($UserOidToName[$ownerOid] + ' (' + $rn + ')')
        }
    }
    return (Get-MidpointString $Shadow.name $ShadowOid)
}
#endregion Helpers

#region Main
Write-Host "`n=== midPoint Crawler ===" -ForegroundColor Cyan
Write-Host "Base URL:    $($Cfg.baseUrl)" -ForegroundColor Gray
Write-Host "Auth method: $($Cfg.authMethod)" -ForegroundColor Gray
Write-Host "Sync mode:   $SyncMode (cross-system tables forced to delta for safety)" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Authenticating to midPoint' -Pct 2
$AuthParams = @{ BaseUrl = $Cfg.baseUrl; AuthMethod = $Cfg.authMethod }
if ($Cfg.username)      { $AuthParams['Username']      = $Cfg.username }
if ($Cfg.password)      { $AuthParams['Password']      = $Cfg.password }
if ($Cfg.apiToken)      { $AuthParams['ApiToken']      = $Cfg.apiToken }
if ($Cfg.clientId)      { $AuthParams['ClientId']      = $Cfg.clientId }
if ($Cfg.clientSecret)  { $AuthParams['ClientSecret']  = $Cfg.clientSecret }
if ($Cfg.tokenEndpoint) { $AuthParams['TokenEndpoint'] = $Cfg.tokenEndpoint }
Connect-MidpointAPI @AuthParams

# Shared cross-phase state
$RestRoot                = (Get-MidpointRestRoot -BaseUrl $Cfg.baseUrl)
$MidpointSystemId        = 0
$ResourceSystemId        = @{}                                                   # resource OID → Identity Atlas system.id
$ResourceOidToName       = @{}                                                   # resource OID → display name (for readable shadow labels)
$UserOidToName           = @{}                                                   # user OID → display name (for readable shadow labels)
$SyncedOrgIds            = [System.Collections.Generic.HashSet[string]]::new()  # OrgType OIDs synced as Contexts
$OrgOidToName            = @{}                                                   # OrgType OID → display name (for the user's department)
$SyncedResourceIds       = [System.Collections.Generic.HashSet[string]]::new()  # Role/Service OIDs synced as Resources
$AllUsers                = $null
$ShadowOidToUserOid      = @{}                                                   # shadow OID → owning user OID (from user.linkRef)

# ─── Phase: Systems ──────────────────────────────────────────────────────────
# midPoint itself + each ResourceType become Identity Atlas Systems.
if ($Sync.systems) {
    Write-Host "`nSystems:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Registering systems' -Pct 5
    try {
        $hostLabel = ([System.Uri]$RestRoot).Authority
        $sysRecords = [System.Collections.Generic.List[object]]::new()
        $sysRecords.Add([PSCustomObject]@{ systemType = 'Midpoint'; displayName = "midPoint ($hostLabel)"; tenantId = $RestRoot; enabled = $true; syncEnabled = $true })

        $resources = @(Invoke-MidpointSearch -Type 'resources' -PageSize $PageSize)
        Write-Host "  $($resources.Count) connected resources in midPoint" -ForegroundColor Gray

        # STREAM shadows (do NOT retain — memory stays bounded regardless of volume) to learn
        # which resources actually hold account/entitlement shadows. Resources whose shadows are
        # all generic (e.g. context/data-only connectors) are NOT registered as systems — that
        # avoids empty, confusing systems in the UI. The Shadows phase re-streams independently.
        $resWithData = [System.Collections.Generic.HashSet[string]]::new()
        $swShRead = [System.Diagnostics.Stopwatch]::StartNew()
        $nShadowsScan = Invoke-MidpointSearchStream -Type 'shadows' -PageSize $PageSize -Options 'raw' -Include 'association' -OnPage {
            param($page)
            foreach ($s in $page) {
                if (($s.kind -eq 'account') -or ($s.kind -eq 'entitlement')) {
                    $ro = Get-MidpointRefOid $s.resourceRef $null
                    if ($ro) { [void]$resWithData.Add($ro) }
                }
            }
        }
        $swShRead.Stop()
        $Script:fetchStats['shadows (system scan)'] = @{ seconds = $swShRead.Elapsed.TotalSeconds; count = $nShadowsScan }
        Write-Host "  scanned $nShadowsScan shadows ($($resWithData.Count) resources hold accounts/entitlements)" -ForegroundColor Gray

        foreach ($r in $resources) {
            $roid  = [string]$r.oid
            $rName = (Get-MidpointString $r.name "Resource $roid")
            $ResourceOidToName[$roid] = $rName
            if (-not $resWithData.Contains($roid)) {
                Write-Host "  Skipping system registration for '$rName' (no account/entitlement shadows)" -ForegroundColor DarkGray
                continue
            }
            $sysRecords.Add([PSCustomObject]@{
                systemType = 'Midpoint'
                displayName = $rName
                tenantId   = $roid
                enabled    = $true; syncEnabled = $false
            })
        }

        Write-Step "Registering $($sysRecords.Count) systems..."
        # Systems is cross-system (no per-system scope) → delta, never deletes other sources.
        Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{ syncMode = 'delta'; records = ConvertTo-JsonArray $sysRecords } | Out-Null

        # Build tenantId(OID) → system.id map
        $atlasSystems = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
        foreach ($s in $atlasSystems) {
            if ($s.systemType -ne 'Midpoint' -or -not $s.tenantId) { continue }
            if ($s.tenantId -eq $RestRoot) { $MidpointSystemId = [int]$s.id }
            else { $ResourceSystemId[[string]$s.tenantId] = [int]$s.id }
        }
        if ($MidpointSystemId -eq 0) { throw "Could not resolve midPoint system id after registration" }
        Write-Host "  midPoint system id: $MidpointSystemId; resource systems: $($ResourceSystemId.Count)" -ForegroundColor Green
    } catch { Add-PhaseError 'Systems' $_.Exception.Message; throw }
}

# ─── Phase: Orgs → Contexts ──────────────────────────────────────────────────
if ($Sync.orgs) {
    Write-Host "`nOrgs (Contexts):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing orgs' -Pct 15
    try {
        $orgs = @(Invoke-MidpointSearch -Type 'orgs' -PageSize $PageSize)
        Write-Host "  $($orgs.Count) orgs from midPoint" -ForegroundColor Gray
        $raw = @($orgs | ForEach-Object {
            [PSCustomObject]@{
                id              = [string]$_.oid
                externalId      = [string]$_.oid
                displayName     = (Get-MidpointString $_.displayName (Get-MidpointString $_.name $_.oid))
                contextType     = 'OrgUnit'
                variant         = 'synced'
                targetType      = 'Identity'
                scopeSystemId   = $MidpointSystemId
                parentContextId = (Get-MidpointRefOid $_.parentOrgRef $null)
            }
        } | Where-Object { $_.id -and $_.displayName })

        # Topological sort — parents before children (FK on parentContextId)
        $records   = [System.Collections.Generic.List[object]]::new()
        $remaining = [System.Collections.Generic.List[object]]::new($raw)
        $present   = [System.Collections.Generic.HashSet[string]]::new(); $raw | ForEach-Object { [void]$present.Add($_.id) }
        $inserted  = [System.Collections.Generic.HashSet[string]]::new()
        $pass = 0; $maxPass = $raw.Count + 1
        while ($remaining.Count -gt 0 -and $pass -lt $maxPass) {
            $pass++; $next = [System.Collections.Generic.List[object]]::new()
            foreach ($rec in $remaining) {
                $p = $rec.parentContextId
                # A parent outside the synced set is treated as a root (null it out)
                if (-not $p -or -not $present.Contains($p) -or $inserted.Contains($p)) {
                    if ($p -and -not $present.Contains($p)) { $rec.parentContextId = $null }
                    $records.Add($rec); [void]$inserted.Add($rec.id)
                } else { $next.Add($rec) }
            }
            $remaining = $next
        }
        foreach ($rec in $remaining) { $records.Add($rec) }

        $R = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $MidpointSystemId `
            -Scope @{ variant = 'synced'; contextType = 'OrgUnit'; scopeSystemId = $MidpointSystemId } -Records @($records)
        $records | ForEach-Object { [void]$SyncedOrgIds.Add($_.id); $OrgOidToName[$_.id] = $_.displayName }
        Write-Host "  Contexts: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
    } catch { Add-PhaseError 'Orgs' $_.Exception.Message }
}

# ─── Phase: Roles + Services → Resources ─────────────────────────────────────
$AllRoles = $null
if ($Sync.roles -or $Sync.services) {
    Write-Host "`nResources (Roles + Services):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing roles and services' -Pct 30
    if ($Sync.roles) {
        try {
            $AllRoles = @(Invoke-MidpointSearch -Type 'roles' -PageSize $PageSize)
            Write-Host "  $($AllRoles.Count) roles from midPoint" -ForegroundColor Gray
            $recs = @($AllRoles | ForEach-Object {
                [PSCustomObject]@{
                    id           = [string]$_.oid
                    externalId   = [string]$_.oid
                    displayName  = (Get-MidpointString $_.displayName (Get-MidpointString $_.name $_.oid))
                    resourceType = 'BusinessRole'
                    description  = (Get-MidpointString $_.description '')
                    enabled      = (Test-MidpointEnabled $_)
                    extendedAttributes = @{
                        name       = (Get-MidpointString $_.name '')
                        identifier = (Get-MidpointString $_.identifier '')
                        roleType   = (Get-MidpointString $_.subtype (Get-MidpointString $_.roleType ''))
                    }
                }
            } | Where-Object { $_.id -and $_.displayName })
            $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $MidpointSystemId `
                -Scope @{ resourceType = 'BusinessRole' } -Records @($recs)
            $recs | ForEach-Object { [void]$SyncedResourceIds.Add($_.id) }
            Write-Host "  Roles → Resources(BusinessRole): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        } catch { Add-PhaseError 'Roles' $_.Exception.Message }
    }
    if ($Sync.services) {
        try {
            $services = @(Invoke-MidpointSearch -Type 'services' -PageSize $PageSize)
            Write-Host "  $($services.Count) services from midPoint" -ForegroundColor Gray
            $recs = @($services | ForEach-Object {
                [PSCustomObject]@{
                    id           = [string]$_.oid
                    externalId   = [string]$_.oid
                    displayName  = (Get-MidpointString $_.displayName (Get-MidpointString $_.name $_.oid))
                    resourceType = 'Service'
                    description  = (Get-MidpointString $_.description '')
                    enabled      = (Test-MidpointEnabled $_)
                    extendedAttributes = @{ name = (Get-MidpointString $_.name ''); identifier = (Get-MidpointString $_.identifier '') }
                }
            } | Where-Object { $_.id -and $_.displayName })
            $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $MidpointSystemId `
                -Scope @{ resourceType = 'Service' } -Records @($recs)
            $recs | ForEach-Object { [void]$SyncedResourceIds.Add($_.id) }
            Write-Host "  Services → Resources(Service): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        } catch { Add-PhaseError 'Services' $_.Exception.Message }
    }
}

# ─── Phase: Users → Identities + Principals + IdentityMembers ────────────────
if ($Sync.users) {
    Write-Host "`nUsers (Identities + Principals):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing users' -Pct 45
    try {
        $AllUsers = @(Measure-MidpointFetch 'users (read)' { Invoke-MidpointSearch -Type 'users' -PageSize $PageSize })
        Write-Host "  $($AllUsers.Count) users from midPoint" -ForegroundColor Gray

        $identRecs  = [System.Collections.Generic.List[object]]::new()
        $princRecs  = [System.Collections.Generic.List[object]]::new()
        $memberRecs = [System.Collections.Generic.List[object]]::new()

        foreach ($u in $AllUsers) {
            $oid  = [string]$u.oid
            $name = (Get-MidpointString $u.fullName (Get-MidpointString $u.name $oid))
            $UserOidToName[$oid] = $name
            # Department = the user's primary org-unit (parentOrgRef, default relation).
            $department = (Resolve-MidpointDepartment -User $u -OrgMap $OrgOidToName)
            $identRecs.Add([PSCustomObject]@{
                id          = $oid
                externalId  = $oid
                displayName = $name
                givenName   = (Get-MidpointString $u.givenName '')
                surname     = (Get-MidpointString $u.familyName '')
                email       = (Get-MidpointString $u.emailAddress '')
                employeeId  = (Get-MidpointString $u.employeeNumber '')
                jobTitle    = (Get-MidpointString $u.title '')
                department  = $department
                extendedAttributes = @{
                    name           = (Get-MidpointString $u.name '')
                    lifecycleState = (Get-MidpointString $u.lifecycleState '')
                    emailAddress   = (Get-MidpointString $u.emailAddress '')
                }
            })
            $princRecs.Add([PSCustomObject]@{
                id             = $oid
                externalId     = $oid
                displayName    = $name
                email          = (Get-MidpointString $u.emailAddress '')
                principalType  = 'User'
                accountEnabled = (Test-MidpointEnabled $u)
                jobTitle       = (Get-MidpointString $u.title '')
                department     = $department
                extendedAttributes = @{ name = (Get-MidpointString $u.name ''); source = 'midpoint-focus' }
            })
            $memberRecs.Add([PSCustomObject]@{ identityId = $oid; principalId = $oid; accountType = 'Primary'; isPrimary = $true })

            # Capture linkRef (shadow OIDs) for the Shadows phase
            $links = $u.linkRef
            if ($links) {
                foreach ($lr in @($links)) {
                    $shadowOid = Get-MidpointRefOid $lr $null
                    if ($shadowOid) { $ShadowOidToUserOid[$shadowOid] = $oid }
                }
            }
        }

        $R1 = Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $MidpointSystemId -Records @($identRecs)
        Write-Host "  Identities: +$($R1.inserted) ~$($R1.updated) -$($R1.deleted)" -ForegroundColor Green
        $R2 = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $MidpointSystemId -Scope @{ principalType = 'User' } -Records @($princRecs)
        Write-Host "  Principals (midPoint accounts): +$($R2.inserted) ~$($R2.updated) -$($R2.deleted)" -ForegroundColor Green
        $R3 = Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $MidpointSystemId -Records @($memberRecs)
        Write-Host "  IdentityMembers: +$($R3.inserted) ~$($R3.updated) -$($R3.deleted)" -ForegroundColor Green
    } catch { Add-PhaseError 'Users' $_.Exception.Message }
}

# ─── Phase: Shadows → Accounts / Entitlements ────────────────────────────────
# A midPoint shadow is NOT always a user account. Map by `kind`:
#   account     → Principal (account) on its resource system, linked to the identity
#   entitlement → Resource (resourceType='Entitlement', e.g. an AD group); account→
#                 entitlement associations become ResourceAssignments (matrix membership)
#   generic / other → skipped (these are non-account objects such as OU/container/DB rows,
#                 and must NOT pollute the Users list)
if ($Sync.shadows -and $Sync.users) {
    Write-Host "`nShadows (accounts + entitlements):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing shadows' -Pct 60
    try {
        # STREAMING design (memory stays bounded regardless of volume):
        #   Pass A — stream shadows; accumulate the comparatively small entitlement/account/
        #            member records and ingest them. Entitlements MUST land before assignments
        #            (resource FK), so assignments are emitted in a second pass.
        #   Pass B — stream account-shadows again; emit person→entitlement assignments straight
        #            into a per-system streaming ingest (flushed in batches, never all held).
        $acctBySystem  = @{}   # systemId → List[account principal record]
        $entBySystem   = @{}   # systemId → List[entitlement resource record]
        $shadowMembers = [System.Collections.Generic.List[object]]::new()   # account → identity links
        $skipped = @{ generic = 0; other = 0 }

        $swPassA = [System.Diagnostics.Stopwatch]::StartNew()
        $nPassA = Invoke-MidpointSearchStream -Type 'shadows' -PageSize $PageSize -Options 'raw' -Include 'association' -OnPage {
            param($page)
            foreach ($s in $page) {
                $resOid = Get-MidpointRefOid $s.resourceRef $null
                if (-not $resOid -or -not $ResourceSystemId.ContainsKey($resOid)) { continue }   # skip shadows on un-synced resources
                $sysId     = $ResourceSystemId[$resOid]
                $shadowOid = [string]$s.oid
                $kind      = if ($s.kind) { [string]$s.kind } else { '' }

                if ($kind -eq 'account') {
                    if (-not $acctBySystem.ContainsKey($sysId)) { $acctBySystem[$sysId] = [System.Collections.Generic.List[object]]::new() }
                    $acctBySystem[$sysId].Add([PSCustomObject]@{
                        id             = $shadowOid
                        externalId     = $shadowOid
                        displayName    = (Get-MidpointShadowLabel -Shadow $s -ShadowOid $shadowOid -ResourceOid $resOid)
                        principalType  = 'User'
                        accountEnabled = (Test-MidpointEnabled $s)
                        extendedAttributes = @{
                            accountName = (Get-MidpointString $s.name '')
                            resourceOid = $resOid
                            objectClass = (Get-MidpointString $s.objectClass '')
                            kind        = $kind
                            intent      = (Get-MidpointString $s.intent '')
                            source      = 'midpoint-shadow'
                        }
                    })
                    if ($ShadowOidToUserOid.ContainsKey($shadowOid)) {
                        $shadowMembers.Add([PSCustomObject]@{ identityId = $ShadowOidToUserOid[$shadowOid]; principalId = $shadowOid; accountType = 'Account'; isPrimary = $false })
                    }
                }
                elseif ($kind -eq 'entitlement') {
                    if (-not $entBySystem.ContainsKey($sysId)) { $entBySystem[$sysId] = [System.Collections.Generic.List[object]]::new() }
                    $entBySystem[$sysId].Add([PSCustomObject]@{
                        id           = $shadowOid
                        externalId   = $shadowOid
                        displayName  = (Format-AccountLabel (Get-MidpointString $s.name $shadowOid))
                        resourceType = 'Entitlement'
                        extendedAttributes = @{
                            accountName = (Get-MidpointString $s.name '')
                            resourceOid = $resOid
                            objectClass = (Get-MidpointString $s.objectClass '')
                            intent      = (Get-MidpointString $s.intent '')
                            source      = 'midpoint-entitlement'
                        }
                    })
                    [void]$SyncedResourceIds.Add($shadowOid)
                }
                else { if ($kind -eq 'generic') { $skipped.generic++ } else { $skipped.other++ } }
            }
        }
        $swPassA.Stop(); $Script:fetchStats['shadows (pass A)'] = @{ seconds = $swPassA.Elapsed.TotalSeconds; count = $nPassA }

        # Entitlements first (so the assignments in pass B satisfy the resource FK), then accounts, then members.
        $totalEnt = 0
        foreach ($sysId in $entBySystem.Keys) {
            $recs = @($entBySystem[$sysId]); $totalEnt += $recs.Count
            $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $sysId -Scope @{ resourceType = 'Entitlement' } -Records $recs
            Write-Host "  Entitlements (resources, system $sysId): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        }
        $totalAcct = 0
        foreach ($sysId in $acctBySystem.Keys) {
            $recs = @($acctBySystem[$sysId]); $totalAcct += $recs.Count
            $R = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $sysId -Scope @{ principalType = 'User' } -Records $recs
            Write-Host "  Accounts (principals, system $sysId): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        }
        if ($shadowMembers.Count -gt 0) {
            $R = Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $MidpointSystemId -Records @($shadowMembers)
            Write-Host "  IdentityMembers (account links): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        }

        # PASS B — person → entitlement assignments (the resource's "ist" state). An account
        # shadow points at the entitlement shadows it belongs to (e.g. AD group membership),
        # stored either as legacy association[] or 4.9 referenceAttributes.<name>[]. Each ref
        # becomes a Direct ResourceAssignment consolidated on the owner (focus) principal, with
        # the source account recorded in extendedAttributes.viaAccount. Streamed in batches so
        # the (potentially millions of) assignments are never all held in memory at once.
        $entAssignStreams = @{}   # systemId → IngestStream
        $entAssignSeen    = [System.Collections.Generic.HashSet[string]]::new()   # dedup (resourceId|ownerOid)
        $swPassB = [System.Diagnostics.Stopwatch]::StartNew()
        $nPassB = Invoke-MidpointSearchStream -Type 'shadows' -PageSize $PageSize -Options 'raw' -Include 'association' -OnPage {
            param($page)
            foreach ($s in $page) {
                if ($s.kind -ne 'account') { continue }
                $resOid = Get-MidpointRefOid $s.resourceRef $null
                if (-not $resOid -or -not $ResourceSystemId.ContainsKey($resOid)) { continue }
                $sysId     = $ResourceSystemId[$resOid]
                $shadowOid = [string]$s.oid
                $ownerOid  = if ($ShadowOidToUserOid.ContainsKey($shadowOid)) { $ShadowOidToUserOid[$shadowOid] } else { $shadowOid }
                $emit = {
                    param($entOid)
                    if (-not $entOid) { return }
                    if (-not $entAssignSeen.Add("$entOid|$ownerOid")) { return }
                    if (-not $entAssignStreams.ContainsKey($sysId)) {
                        $entAssignStreams[$sysId] = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId $sysId -Scope @{ assignmentType = 'Direct' }
                    }
                    Add-IngestStreamRecord -Stream $entAssignStreams[$sysId] -Record ([PSCustomObject]@{ resourceId = $entOid; principalId = $ownerOid; assignmentType = 'Direct'; extendedAttributes = @{ viaAccount = $shadowOid } })
                }
                if ($s.association) {
                    foreach ($assoc in @($s.association)) {
                        $entOid = Get-MidpointRefOid $assoc.shadowRef $null
                        if (-not $entOid) { $entOid = Get-MidpointRefOid $assoc.identifier $null }
                        & $emit $entOid
                    }
                }
                if ($s.referenceAttributes) {
                    foreach ($refProp in $s.referenceAttributes.PSObject.Properties) {
                        if ($refProp.Name -eq '@ns' -or $null -eq $refProp.Value) { continue }
                        foreach ($ref in @($refProp.Value)) { & $emit (Get-MidpointRefOid $ref $null) }
                    }
                }
            }
        }
        $swPassB.Stop(); $Script:fetchStats['shadows (pass B)'] = @{ seconds = $swPassB.Elapsed.TotalSeconds; count = $nPassB }

        $totalEntAssign = 0
        foreach ($sysId in $entAssignStreams.Keys) {
            $st = $entAssignStreams[$sysId]
            Complete-IngestStream -Stream $st
            $totalEntAssign += $st.Records
            Write-Host "  Entitlement assignments (system $sysId): +$($st.Inserted) ~$($st.Updated) -$($st.Deleted) (streamed $($st.Records))" -ForegroundColor Green
        }
        Write-Host "  Accounts: $totalAcct | Entitlements: $totalEnt | Entitlement-memberships: $totalEntAssign | skipped generic/other: $($skipped.generic)/$($skipped.other)" -ForegroundColor Gray
    } catch { Add-PhaseError 'Shadows' $_.Exception.Message }
}

# ─── Phase: Org membership → ContextMembers ──────────────────────────────────
if ($Sync.orgMembership -and $Sync.users -and $AllUsers) {
    Write-Host "`nContext Members (org membership):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing org membership' -Pct 72
    try {
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        $cm   = [System.Collections.Generic.List[object]]::new()
        foreach ($u in $AllUsers) {
            $uoid = [string]$u.oid
            $refs = $u.parentOrgRef
            if (-not $refs) { continue }
            foreach ($ref in @($refs)) {
                $orgOid = Get-MidpointRefOid $ref $null
                if (-not $orgOid -or -not $SyncedOrgIds.Contains($orgOid)) { continue }
                if (-not $seen.Add("$orgOid|$uoid")) { continue }
                $cm.Add([PSCustomObject]@{ contextId = $orgOid; memberId = $uoid; memberType = 'Identity'; addedBy = 'sync' })
            }
        }
        $R = Send-IngestBatch -Endpoint 'ingest/context-members' -SystemId $MidpointSystemId -Records @($cm)
        Write-Host "  ContextMembers: +$($R.inserted) ~$($R.updated) -$($R.deleted) (from $($cm.Count) links)" -ForegroundColor Green
    } catch { Add-PhaseError 'ContextMembers' $_.Exception.Message }
}

# ─── Phase: Assignments → ResourceAssignments (Governed) ─────────────────────
if ($Sync.assignments -and $Sync.users -and $AllUsers) {
    Write-Host "`nAssignments (Governed):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 82
    try {
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        $ra   = [System.Collections.Generic.List[object]]::new()
        foreach ($u in $AllUsers) {
            $uoid = [string]$u.oid
            $assignments = $u.assignment
            if (-not $assignments) { continue }
            foreach ($a in @($assignments)) {
                $tr = $a.targetRef
                if (-not $tr) { continue }
                $targetType = Get-MidpointRefType $tr ''
                $targetOid  = Get-MidpointRefOid $tr $null
                if (-not $targetOid) { continue }
                # Only Role/Service assignments are resource assignments; Org → context membership; Archetype → skip.
                if ($targetType -notin @('RoleType', 'ServiceType')) { continue }
                if (-not $SyncedResourceIds.Contains($targetOid)) { continue }
                if (-not $seen.Add("$targetOid|$uoid")) { continue }
                # Resources.id = role/service oid and Principals.id = user oid (native-id
                # ingest), so reference them directly by id — no externalId resolution needed.
                $ra.Add([PSCustomObject]@{
                    resourceId     = $targetOid
                    principalId    = $uoid
                    assignmentType = 'Governed'
                })
            }
        }
        $R = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $MidpointSystemId -Scope @{ assignmentType = 'Governed' } -Records @($ra)
        Write-Host "  ResourceAssignments (Governed): +$($R.inserted) ~$($R.updated) -$($R.deleted) (from $($ra.Count) links)" -ForegroundColor Green
    } catch { Add-PhaseError 'Assignments' $_.Exception.Message }
}

# ─── Phase: Role nesting → ResourceRelationships (Contains) ───────────────────
if ($Sync.roleNesting -and $AllRoles) {
    Write-Host "`nRole nesting (Contains):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing role nesting' -Pct 90
    try {
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        $rr   = [System.Collections.Generic.List[object]]::new()
        foreach ($r in $AllRoles) {
            $parentOid = [string]$r.oid
            $inducements = $r.inducement
            if (-not $inducements) { continue }
            foreach ($ind in @($inducements)) {
                $tr = $ind.targetRef
                if (-not $tr) { continue }
                $tt = Get-MidpointRefType $tr ''
                $childOid = Get-MidpointRefOid $tr $null
                if (-not $childOid -or $tt -notin @('RoleType', 'ServiceType')) { continue }
                if (-not $SyncedResourceIds.Contains($childOid)) { continue }
                if (-not $seen.Add("$parentOid|$childOid")) { continue }
                $rr.Add([PSCustomObject]@{
                    parentResourceId = $parentOid
                    childResourceId  = $childOid
                    relationshipType = 'Contains'
                })
            }
        }
        $R = Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $MidpointSystemId -Scope @{ relationshipType = 'Contains' } -Records @($rr)
        Write-Host "  ResourceRelationships (Contains): +$($R.inserted) ~$($R.updated) -$($R.deleted) (from $($rr.Count) links)" -ForegroundColor Green
    } catch { Add-PhaseError 'RoleNesting' $_.Exception.Message }
}

# ─── Phase: Reviews → CertificationDecisions ─────────────────────────────────
# midPoint access certification campaigns → review decisions. Each campaign case
# (objectRef=user, targetRef=role/service, outcome=accept/revoke) maps to one
# CertificationDecisions row. The case container is only returned with ?include=case.
if ($Sync.reviews) {
    Write-Host "`nReviews (certification decisions):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing reviews' -Pct 92
    try {
        $campaigns = @(Invoke-MidpointSearch -Type 'accessCertificationCampaigns' -PageSize $PageSize -Include 'case')
        Write-Host "  $($campaigns.Count) certification campaigns from midPoint" -ForegroundColor Gray
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        $cd   = [System.Collections.Generic.List[object]]::new()
        foreach ($camp in $campaigns) {
            $campOid   = [string]$camp.oid
            $campName  = (Get-MidpointString $camp.name $campOid)
            $campState = (Get-MidpointString $camp.state '')
            $cases = $camp.case; $cases = if ($cases -is [System.Array]) { $cases } elseif ($cases) { @($cases) } else { @() }
            foreach ($case in $cases) {
                $principalOid = Get-MidpointRefOid $case.objectRef $null   # the user under review
                $targetOid    = Get-MidpointRefOid $case.targetRef $null   # role/service under review
                $targetType   = Get-MidpointRefType $case.targetRef ''
                if (-not $principalOid -or -not $targetOid) { continue }
                if ($targetType -notin @('RoleType', 'ServiceType')) { continue }   # org reviews aren't resource reviews
                if (-not $SyncedResourceIds.Contains($targetOid)) { continue }
                $caseId = [string]$case.'@id'
                $key = "$campOid|$caseId"
                if (-not $seen.Add($key)) { continue }
                $wi = $case.workItem; $wi = if ($wi -is [System.Array]) { $wi | Select-Object -First 1 } else { $wi }
                $comment = if ($wi -and $wi.output) { (Get-MidpointString $wi.output.comment '') } else { '' }
                $reviewerOid = if ($wi) { Get-MidpointRefOid $wi.assigneeRef $null } else { $null }
                $rec = [ordered]@{
                    id                   = (New-StableGuid $key)
                    resourceId           = $targetOid
                    principalId          = $principalOid
                    decision             = (Convert-MidpointOutcome (Get-MidpointString $case.outcome ''))
                    justification        = $comment
                    reviewInstanceStatus = $campState
                    extendedAttributes   = @{ campaign = $campName; campaignOid = $campOid; caseId = $caseId; outcome = (Get-MidpointString $case.outcome '') }
                }
                if ($UserOidToName.ContainsKey($principalOid)) { $rec['principalDisplayName'] = $UserOidToName[$principalOid] }
                # Only set reviewedBy when the reviewer is a synced principal (FK safety).
                if ($reviewerOid -and $UserOidToName.ContainsKey($reviewerOid)) {
                    $rec['reviewedBy'] = $reviewerOid
                    $rec['reviewedByDisplayName'] = $UserOidToName[$reviewerOid]
                }
                $cd.Add([PSCustomObject]$rec)
            }
        }
        $R = Send-IngestBatch -Endpoint 'ingest/governance/certifications' -SystemId $MidpointSystemId -Records @($cd)
        Write-Host "  CertificationDecisions: +$($R.inserted) ~$($R.updated) -$($R.deleted) (from $($cd.Count) decisions)" -ForegroundColor Green
    } catch { Add-PhaseError 'Reviews' $_.Exception.Message }
}

# ─── Refresh matrix views ────────────────────────────────────────────────────
# The matrix and several derived UI pages read from materialized views that are
# stale until refreshed; do it here so the new data is visible immediately.
Write-Host "`nRefreshing matrix views:" -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
try {
    Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post `
        -Headers @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } -TimeoutSec 180 | Out-Null
    Write-Host "  Views refreshed." -ForegroundColor Green
} catch {
    Write-Host "  Warning: refresh-views failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ─── Performance summary (load-test instrumentation) ─────────────────────────
$Script:swMaster.Stop()
Write-Host "`n── Performance ──" -ForegroundColor Cyan
Write-Host ("  Total wall-clock: {0:N1}s" -f $Script:swMaster.Elapsed.TotalSeconds) -ForegroundColor Gray
if ($Script:fetchStats.Count -gt 0) {
    Write-Host "  midPoint reads:" -ForegroundColor Gray
    foreach ($k in $Script:fetchStats.Keys) {
        $f = $Script:fetchStats[$k]
        Write-Host ("    {0,-18} {1,8:N1}s  ({2} objects)" -f $k, $f.seconds, $f.count) -ForegroundColor DarkGray
    }
}
if ($Script:ingestStats.Count -gt 0) {
    Write-Host "  Ingest API (endpoint: time / calls / records → rec/s):" -ForegroundColor Gray
    $ingTotal = 0.0
    foreach ($k in $Script:ingestStats.Keys) {
        $s = $Script:ingestStats[$k]; $ingTotal += $s.seconds
        $rps = if ($s.seconds -gt 0) { [math]::Round($s.records / $s.seconds) } else { 0 }
        Write-Host ("    {0,-26} {1,7:N1}s / {2,3} / {3,7} → {4} rec/s" -f $k, $s.seconds, $s.calls, $s.records, $rps) -ForegroundColor DarkGray
    }
    Write-Host ("    {0,-26} {1,7:N1}s total" -f 'ingest TOTAL', $ingTotal) -ForegroundColor DarkGray
}

# ─── Summary ─────────────────────────────────────────────────────────────────
Update-CrawlerProgress -Step 'Complete' -Pct 100
if ($Script:phaseErrors.Count -gt 0) {
    Write-Host "`nmidPoint crawler completed with $($Script:phaseErrors.Count) phase error(s):" -ForegroundColor Yellow
    $Script:phaseErrors | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    throw "midPoint crawler completed with errors: $($Script:phaseErrors -join '; ')"
}
Write-Host "`nmidPoint crawler completed successfully." -ForegroundColor Green
#endregion Main
