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

. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot 'CSVCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'CSVCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'CSVCrawler.Phases.ps1')

# Resolve the job config into crawler settings the phases + helpers read from scope.
$CsvCfg     = Resolve-CsvConfig -ConfigPath $ConfigPath
$CsvFolder  = $CsvCfg.csvFolder
$SystemName = $CsvCfg.systemName
$SystemType = $CsvCfg.systemType
$Delimiter  = $CsvCfg.delimiter
$RefreshViews = $true

# ─── Main ─────────────────────────────────────────────────────────

Write-Host "`n=== Identity Atlas CSV Crawler ===" -ForegroundColor Cyan
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Folder: $CsvFolder" -ForegroundColor Gray

# Verify the API key and register the fallback system; seed the SystemName → id map.
$fallbackSystemId = Register-CsvFallbackSystem
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

# ─── Post-import: classify, refresh views, log the sync ──────────
Complete-CsvRun -SyncStart $syncStart -RefreshViews $RefreshViews
