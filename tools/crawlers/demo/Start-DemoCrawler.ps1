<#
.SYNOPSIS
    Demo dataset crawler — loads the built-in demo company dataset into Identity Atlas.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL.

.PARAMETER ApiKey
    Built-in crawler API key.

.PARAMETER JobId
    Job ID for progress reporting.

.PARAMETER ConfigPath
    Path to a temporary JSON file containing the crawler configuration. The demo
    crawler reads two optional keys from it:

      includeVolumeData  — when true, generate the dataset with its opt-in volume
                           slice (~520 extra groups with distinct descriptions),
                           so the environment holds more than 500 distinct
                           resource descriptions. See test/demo-dataset/parts/
                           DemoVolume.ps1.

      includeRealismData — when true, add the realism slice: ~600 staff in ten
                           departments with careers, guests, leavers, accounts in
                           several systems linked into one identity, ~180 groups
                           in naming families, nesting, business roles that grant
                           groups and application roles, and an attestation
                           campaign. For measuring reports and the chat assistant
                           against questions that have more than one possible
                           answer. See test/demo-dataset/parts/DemoRealism*.ps1,
                           and run test/demo-dataset/Simulate-AccessChanges.sql
                           afterwards to give the access history a past.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [string]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

# The demo job is normally queued with no config at all, so a missing or
# unreadable file simply means "all defaults" rather than an error.
$includeVolumeData = $false
$includeRealismData = $false
if (Test-Path $ConfigPath) {
    try {
        $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($config.PSObject.Properties.Name -contains 'includeVolumeData') {
            $includeVolumeData = [bool]$config.includeVolumeData
        }
        if ($config.PSObject.Properties.Name -contains 'includeRealismData') {
            $includeRealismData = [bool]$config.includeRealismData
        }
    } catch {
        Write-Host "  Warning: could not read crawler config — using defaults ($($_.Exception.Message))" -ForegroundColor Yellow
    }
}

$appRoot     = if ($env:IA_APP_ROOT) { $env:IA_APP_ROOT.TrimEnd('/\') } else { '/app' }
$datasetPath = "$appRoot/test/demo-dataset/demo-company.json"
$ingestScript = "$appRoot/test/demo-dataset/Ingest-DemoDataset.ps1"

function Update-DemoProgress {
    param([string]$Step, [int]$Pct = 0)
    try {
        $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $body = @{ jobId = $JobId; step = $Step; pct = $Pct; detail = '' } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -Headers $headers -Body $body -TimeoutSec 10 | Out-Null
    } catch {
        Write-Host "  Warning: failed to update progress — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Update-DemoProgress -Step 'Loading demo dataset' -Pct 10

# The demo dataset is a gitignored build artifact whose shape tracks the ingest
# script (e.g. metadata.systemKeys, which Ingest-DemoDataset.ps1 indexes to map
# placeholder system ids). A bundled or older on-disk copy can therefore be
# STALE — present but in an out-of-date format — which crashes the ingest with
# "Cannot index into a null array" and leaves a fresh Docker install with only a
# handful of systems loaded. So always regenerate from the deterministic
# generator (same GUIDs every run) so the dataset matches this build's ingest
# format; only fall back to an existing file when the generator isn't shipped.
$genScript = "$appRoot/test/demo-dataset/Generate-DemoDataset.ps1"
if (Test-Path $genScript) {
    Update-DemoProgress -Step 'Generating demo dataset' -Pct 5
    # Both slices are opt-in and independent, so the switches are passed through
    # rather than branched over every combination.
    $genArgs = @{ OutputPath = $datasetPath }
    if ($includeVolumeData) {
        Write-Host "  Including the high-cardinality volume slice" -ForegroundColor Cyan
        $genArgs['IncludeVolume'] = $true
    }
    if ($includeRealismData) {
        Write-Host "  Including the realism slice (~600 staff, several systems, business roles)" -ForegroundColor Cyan
        $genArgs['IncludeRealism'] = $true
    }
    & $genScript @genArgs
} elseif (-not (Test-Path $datasetPath)) {
    throw "Demo dataset not found at $datasetPath and generator not available"
}

Update-DemoProgress -Step 'Ingesting demo data' -Pct 30

& $ingestScript -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey -DatasetPath $datasetPath

Update-DemoProgress -Step 'Refreshing views' -Pct 90

try {
    $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post -Headers $headers -Body '{}' -ErrorAction SilentlyContinue
} catch {}

Update-DemoProgress -Step 'Complete' -Pct 100
Write-Host "  Demo data loaded successfully" -ForegroundColor Green
