<#
.SYNOPSIS
    Orchestrates a full CSV data sync via the Identity Atlas Ingest API.

.DESCRIPTION
    Reads CSV files in the Identity Atlas canonical schema and POSTs them to the
    Ingest API. Files must follow the schema defined in tools/crawlers/csv/schema/.

    Source-specific transformation (Omada → Identity Atlas, SAP → Identity Atlas)
    happens BEFORE this script runs, via a separate transform script. This crawler
    handles exactly one format — no column-name guessing or auto-detection.

    See docs/architecture/csv-import-schema.md for the full specification.

.PARAMETER ApiBaseUrl
    Base URL of the Ingest API (e.g., http://localhost:3001/api)

.PARAMETER ApiKey
    Crawler API key (fgc_...)

.PARAMETER CsvFolder
    Path to folder containing Identity Atlas schema CSV files

.PARAMETER SystemName
    Display name for the fallback system. All data without a SystemName column
    gets scoped to this system. Default: "CSV Import"

.PARAMETER SystemType
    System type identifier (e.g., "CSV", "Omada"). Default: "CSV"

.PARAMETER Delimiter
    CSV delimiter. Default: ";"

.PARAMETER RefreshViews
    Refresh views after sync. Default: true

.EXAMPLE
    .\Start-CSVCrawler.ps1 -ApiBaseUrl "http://localhost:3001/api" -ApiKey "fgc_abc..." -CsvFolder ".\TransformedData"
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

$RawConfig  = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
$CsvFolder  = if ($RawConfig['csvFolder'])  { $RawConfig['csvFolder'] }  else { '/data/csv' }
$SystemName = if ($RawConfig['systemName']) { $RawConfig['systemName'] } else { 'CSV Import' }
$SystemType = if ($RawConfig['systemType']) { $RawConfig['systemType'] } else { 'CSV' }
$Delimiter  = if ($RawConfig['delimiter'])  { $RawConfig['delimiter'] }  else { ';' }
$RefreshViews = $true

. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot 'CSVCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'CSVCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'CSVCrawler.Phases.ps1')

# ─── Main ─────────────────────────────────────────────────────────

Write-Host "`n=== Identity Atlas CSV Crawler ===" -ForegroundColor Cyan
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Folder: $CsvFolder" -ForegroundColor Gray

$headers = @{ 'Authorization' = "Bearer $ApiKey" }
$whoami = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers $headers
Write-Host "Connected as: $($whoami.displayName)" -ForegroundColor Green

# ─── Fallback system ─────────────────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Registering fallback system ($SystemName)..." -ForegroundColor Cyan
$sysResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
    syncMode = 'delta'; records = @(@{ systemType = $SystemType; displayName = $SystemName; enabled = $true; syncEnabled = $true })
}
$fallbackSystemId = if ($sysResult.systemIds) { [int]$sysResult.systemIds[0] } elseif ($sysResult.systemId) { [int]$sysResult.systemId } else { 2 }
Write-Host "  Fallback system: ID $fallbackSystemId" -ForegroundColor Gray

$systemLookup = @{ $SystemName = $fallbackSystemId }
$syncStart = Get-Date
Update-CrawlerProgress -Step 'Reading CSV files' -Pct 5

# ─── 1. Systems.csv (optional) ───────────────────────────────────
Sync-CsvSystems

# ─── 2. Contexts.csv + 2b. ContextMembers.csv (optional) ─────────
Sync-CsvContexts
Sync-CsvContextMembers

# ─── 3. Resources.csv (required) + 4. ResourceRelationships.csv ──
Sync-CsvResources
Sync-CsvRelationships

# ─── 5. Users.csv (required) + 6. Assignments.csv (required) ─────
Sync-CsvUsers
Sync-CsvAssignments

# ─── 7. Identities + 8. IdentityMembers + 9. Certifications ──────
Sync-CsvIdentities
Sync-CsvIdentityMembers
Sync-CsvCertifications

# ─── Post-import: auto-classify BusinessRole assignments ─────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Auto-classifying BusinessRole assignments..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Classifying assignments' -Pct 85
try {
    Invoke-IngestAPI -Endpoint 'ingest/classify-business-role-assignments' -Body @{} | Out-Null
    Write-Host "  Done" -ForegroundColor Green
} catch { Write-Host "  (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow }

# ─── Refresh views ──────────────────────────────────────────────
# v6: /ingest/refresh-contexts is gone. Context generation (from Principals'
# department column, manager hierarchy, AD DNs, etc.) moved out of the crawler
# into context-algorithm plugin runs. An operator triggers those from the
# Contexts tab after the sync completes, or schedules them separately.
if ($RefreshViews) {
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 88
    try { Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null; Write-Host "  Views refreshed" -ForegroundColor Green } catch { }
}

# ─── Summary ─────────────────────────────────────────────────────
$elapsed = (Get-Date) - $syncStart
Write-Host "`n=== CSV Sync Complete ===" -ForegroundColor Green
Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds))s" -ForegroundColor Gray

try { Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{ syncType = 'CSV-FullCrawl'; startTime = $syncStart.ToString('o'); endTime = (Get-Date).ToString('o'); status = 'Success' } | Out-Null } catch { }
