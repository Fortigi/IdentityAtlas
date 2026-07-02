<#
.SYNOPSIS
    midPoint crawler sync-phase orchestrators, extracted from Start-MidpointCrawler.ps1.

.DESCRIPTION
    Each Sync-Midpoint* function owns one top-level sync phase: it runs the phase's
    midPoint reads (via the mockable Invoke-Midpoint* helpers), shapes records
    through the pure ConvertTo-*/New-* functions in MidpointCrawler.Transform.ps1,
    POSTs them through Send-IngestBatch, and records failures via Add-PhaseError.

    Dot-sourced into Start-MidpointCrawler.ps1's own scope, so they read/write the
    same $Script:phaseErrors / $Script:fetchStats state the inline blocks used to.
    Phase bodies are moved verbatim from the entry point; only the `if ($Sync...)`
    toggle stays there.

    Extracted so the phases can be unit-tested with Pester by mocking their command
    boundary (Invoke-MidpointSearch / Invoke-MidpointSearchStream / Send-IngestBatch
    / Invoke-IngestAPI) — see test/unit/MidpointCrawlerPhases.Tests.ps1 — and to
    pull cyclomatic complexity out of the entry point's untestable I/O-on-load body.

    Cross-phase state (system-id maps, synced-id sets, the $All* collections) is
    threaded through explicit params/return values instead of shared script vars.
#>

# ─── Phase: Systems ──────────────────────────────────────────────
# midPoint itself + each ResourceType that actually holds account/entitlement
# shadows become Identity Atlas Systems. RETURNS @{ midpointSystemId;
# resourceSystemId (OID -> system.id); resourceOidToName }. Critical phase —
# re-throws on failure (nothing downstream works without the system id).
function Sync-MidpointSystems {
    [CmdletBinding()]
    param(
        [string]$RestRoot,
        [string]$ApiBaseUrl,
        [string]$ApiKey,
        [int]$PageSize = 100
    )
    Write-Host "`nSystems:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Registering systems' -Pct 5
    $MidpointSystemId  = 0
    $ResourceSystemId  = @{}
    $ResourceOidToName = @{}
    try {
        $hostLabel = ([System.Uri]$RestRoot).Authority
        $sysRecords = [System.Collections.Generic.List[object]]::new()
        $sysRecords.Add([PSCustomObject]@{ systemType = 'Midpoint'; displayName = "midPoint ($hostLabel)"; tenantId = $RestRoot; enabled = $true; syncEnabled = $true })

        $resources = @(Invoke-MidpointSearch -Type 'resources' -PageSize $PageSize)
        Write-Host "  $($resources.Count) connected resources in midPoint" -ForegroundColor Gray

        # STREAM shadows (do NOT retain) to learn which resources actually hold
        # account/entitlement shadows — resources whose shadows are all generic
        # aren't registered as systems (avoids empty, confusing systems in the UI).
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
            $sysRecords.Add([PSCustomObject]@{ systemType = 'Midpoint'; displayName = $rName; tenantId = $roid; enabled = $true; syncEnabled = $false })
        }

        Write-Step "Registering $($sysRecords.Count) systems..."
        # Systems is cross-system (no per-system scope) → delta, never deletes other sources.
        Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{ syncMode = 'delta'; records = ConvertTo-JsonArray $sysRecords } | Out-Null

        # Build tenantId(OID) → system.id map.
        $atlasSystems = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
        foreach ($s in $atlasSystems) {
            if ($s.systemType -ne 'Midpoint' -or -not $s.tenantId) { continue }
            if ($s.tenantId -eq $RestRoot) { $MidpointSystemId = [int]$s.id }
            else { $ResourceSystemId[[string]$s.tenantId] = [int]$s.id }
        }
        if ($MidpointSystemId -eq 0) { throw "Could not resolve midPoint system id after registration" }
        Write-Host "  midPoint system id: $MidpointSystemId; resource systems: $($ResourceSystemId.Count)" -ForegroundColor Green
    } catch { Add-PhaseError 'Systems' $_.Exception.Message; throw }

    return @{ midpointSystemId = $MidpointSystemId; resourceSystemId = $ResourceSystemId; resourceOidToName = $ResourceOidToName }
}

# ─── Phase: Orgs → Contexts ──────────────────────────────────────
# OrgType → Contexts (topo-sorted parent-before-child). RETURNS @{ syncedOrgIds;
# orgOidToName } for the ContextMembers + Users (department) phases.
function Sync-MidpointOrgs {
    [CmdletBinding()]
    param(
        [int]$MidpointSystemId,
        $OrgContextMapping,
        [int]$PageSize = 100
    )
    Write-Host "`nOrgs (Contexts):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing orgs' -Pct 15
    $SyncedOrgIds = [System.Collections.Generic.HashSet[string]]::new()
    $OrgOidToName = @{}
    try {
        $orgs = @(Invoke-MidpointSearch -Type 'orgs' -PageSize $PageSize)
        Write-Host "  $($orgs.Count) orgs from midPoint" -ForegroundColor Gray
        # Per-org record shaping + the parent-before-child topo-sort live in the Transform file.
        $raw = @($orgs | ForEach-Object {
            ConvertTo-MidpointOrgContextRecord -Org $_ -OrgContextMapping $OrgContextMapping -SystemId $MidpointSystemId
        } | Where-Object { $_.id -and $_.displayName })
        $records = Sort-MidpointContextsTopologically -Records $raw

        # Scope the reconcile by variant + scopeSystemId only (a single sync can emit
        # several context types under org->contextType remapping; the crawler owns
        # every synced context for its own scopeSystemId).
        $R = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $MidpointSystemId `
            -Scope @{ variant = 'synced'; scopeSystemId = $MidpointSystemId } -Records @($records)
        $records | ForEach-Object { [void]$SyncedOrgIds.Add($_.id); $OrgOidToName[$_.id] = $_.displayName }
        Write-Host "  Contexts: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
    } catch { Add-PhaseError 'Orgs' $_.Exception.Message }

    return @{ syncedOrgIds = $SyncedOrgIds; orgOidToName = $OrgOidToName }
}

# ─── Refresh matrix views ────────────────────────────────────────
# The matrix + several derived pages read materialized views that are stale until
# refreshed; non-critical (a failure is a warning, not a phase error).
function Sync-MidpointRefreshViews {
    [CmdletBinding()]
    param([string]$ApiBaseUrl, [string]$ApiKey)
    Write-Host "`nRefreshing matrix views:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try {
        Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post `
            -Headers @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } -TimeoutSec 180 | Out-Null
        Write-Host "  Views refreshed." -ForegroundColor Green
    } catch {
        Write-Host "  Warning: refresh-views failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}
