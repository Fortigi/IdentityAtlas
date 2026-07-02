<#
.SYNOPSIS
    Omada crawler sync-phase orchestrators, extracted from Start-OmadaCrawler.ps1.

.DESCRIPTION
    Each Sync-Omada* function owns one top-level sync phase: it runs the phase's
    OData reads (via the mockable Invoke-OData* helpers), shapes records through
    the pure ConvertTo-*/New-* functions in OmadaCrawler.Transform.ps1, POSTs them
    through Send-IngestBatch, and records timing/outcome via Write-Phase.

    Dot-sourced into Start-OmadaCrawler.ps1's own scope, so they read/write the
    same $Script:phases / $Script:phaseErrors state the inline blocks used to, and
    call the script-scope Test-EntitySetAvailable helper. Phase bodies are moved
    verbatim from the entry point; only the `if ($Sync...)` toggle stays there.

    Extracted so the phases can be unit-tested with Pester by mocking their
    command boundary (Invoke-ODataPagedRequest / Invoke-ODataGetRequest /
    Send-IngestBatch / Test-EntitySetAvailable) — see
    test/unit/OmadaCrawlerPhases.Tests.ps1 — and to pull cyclomatic complexity out
    of the entry point's untestable I/O-on-load script body.

    Cross-phase state (the $All* collections and lookup maps) is threaded through
    explicit params/return values instead of the entry point's shared script vars.
#>

# Prefetch Usergroup UId -> DisplayName for USERGROUPREF name lookup on Resources.
# Returns an empty map when the Usergroup entity set is unavailable or the fetch
# fails (names are a nice-to-have, not required).
function Get-OmadaUserGroupMap {
    [CmdletBinding()]
    param(
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $map = @{}
    if (Test-EntitySetAvailable 'Usergroup') {
        try {
            $Ugs = Invoke-ODataPagedRequest -Path '/Usergroup' `
                -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
            foreach ($Ug in $Ugs) { $map[[string]$Ug.UId] = $Ug.DisplayName }
            Write-Host "  Loaded $($map.Count) usergroups for USERGROUPREF lookup" -ForegroundColor Gray
        } catch {
            Write-Host "  Warning: Usergroup fetch failed — USERGROUPREF names unavailable" -ForegroundColor Yellow
        }
    }
    return $map
}

# ─── Phase: Resources ────────────────────────────────────────────
# OData entity: Resource. Groups records by connected system (SYSTEMREF) for
# correct per-system scoped-delete. RETURNS the raw Resource objects so the
# Entitlements phase can extract CHILDROLES relationships without a second fetch.
function Sync-OmadaResources {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        [hashtable]$OmadaSystemMap = @{},
        $AllOmadaSystems,
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $T = [datetime]::UtcNow
    Write-Host "`nResources:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 50
    $AllResources = $Null
    try {
        if (-not (Test-EntitySetAvailable 'Resource')) {
            throw "Resource entity set not found in OData metadata"
        }

        # Pre-fetch Usergroups for USERGROUPREF name lookup
        $UserGroupMap = Get-OmadaUserGroupMap -PageSize $PageSize -MaxRetries $MaxRetries

        Write-Step 'Fetching resources from Omada (this may take a few minutes)...'
        $AllResources = Invoke-ODataPagedRequest -Path '/Resource' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
        Write-Host "  $($AllResources.Count) resource records from Omada" -ForegroundColor Gray

        Write-Step "Building resource records from $($AllResources.Count) Omada resources..."
        # Group resources by connected system (SYSTEMREF) for correct scoped-delete.
        # Per-resource record shaping lives in ConvertTo-OmadaResourceRecord.
        $BySysUId = @{}
        foreach ($Item in $AllResources) {
            $Rec = ConvertTo-OmadaResourceRecord -Resource $Item -UserGroupMap $UserGroupMap
            if (-not $Rec) { continue }
            $SysUId = Get-OmadaRefUid -Ref $Item.SYSTEMREF
            $Key = if ($SysUId -and $OmadaSystemMap.ContainsKey($SysUId)) { $SysUId } else { '__main__' }
            if (-not $BySysUId.ContainsKey($Key)) { $BySysUId[$Key] = [System.Collections.Generic.List[object]]::new() }
            $BySysUId[$Key].Add($Rec)
        }

        Write-Step "Ingesting resources across $($BySysUId.Keys.Count) system(s)..."
        $TotalInserted = 0; $TotalUpdated = 0; $TotalDeleted = 0
        foreach ($Key in $BySysUId.Keys) {
            $SysId    = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
            $SysLabel = if ($Key -eq '__main__') { 'Omada' } else {
                ($AllOmadaSystems | Where-Object { $_.UId -eq $Key } | Select-Object -First 1).DisplayName
            }
            $Recs = @($BySysUId[$Key])
            $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SysId -SyncMode 'full' `
                -Scope @{} -Records $Recs
            Write-Host "  Resources ($SysLabel, $($Recs.Count) records): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
            $TotalInserted += ($R.inserted ?? 0); $TotalUpdated += ($R.updated ?? 0); $TotalDeleted += ($R.deleted ?? 0)
        }
        Write-Host "  Resources total: +$TotalInserted ~$TotalUpdated -$TotalDeleted" -ForegroundColor Green
        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $T) -Records @{ resources = $AllResources.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Resources phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Resources: $Msg")
        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
    return $AllResources
}

# ─── Phase: Entitlements (Resource Relationships) ─────────────────
# Omada stores child-role nesting in Resource.CHILDROLES; there's no separate
# endpoint, so Contains relationships are extracted from the $AllResources the
# Resources phase already fetched.
function Sync-OmadaEntitlements {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        $AllResources
    )
    $T = [datetime]::UtcNow
    Write-Host "`nEntitlements (Resource Relationships):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing entitlements' -Pct 65
    try {
        if (-not $AllResources) {
            Write-Host "  Skipping entitlements — resources were not synced" -ForegroundColor Yellow
            Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $T) -Records @{ relationships = 0 }
        } else {
            Write-Step "Extracting entitlements (CHILDROLES) from $($AllResources.Count) resources..."
            # CHILDROLES → Contains relationship extraction lives in
            # ConvertTo-OmadaEntitlementRelationships (OmadaCrawler.Transform.ps1).
            $RelRecords = [System.Collections.Generic.List[object]]::new()
            foreach ($Item in $AllResources) {
                foreach ($Rel in (ConvertTo-OmadaEntitlementRelationships -Resource $Item)) {
                    $RelRecords.Add($Rel)
                }
            }

            Write-Step "Ingesting $($RelRecords.Count) resource relationships (Contains)..."
            $R = Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ relationshipType = 'Contains' } -Records @($RelRecords)
            Write-Host "  Entitlements: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
            Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $T) -Records @{ relationships = $RelRecords.Count }
        }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Entitlements phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Entitlements: $Msg")
        Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
}

# ─── Phase: Refresh views ────────────────────────────────────────
function Sync-OmadaRefreshViews {
    [CmdletBinding()]
    param()
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null
        Write-Host "`nViews refreshed." -ForegroundColor Gray
    } catch {
        Write-Host "  Warning: view refresh failed — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}
