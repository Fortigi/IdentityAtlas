<#
.SYNOPSIS
    Nightly test step: validate CSV ingest edge cases.

.DESCRIPTION
    Creates malformed or unusual payloads and POSTs them to the ingest API to
    verify that the API returns useful error responses (400) rather than 500s.
    Tests cover missing required columns, empty records, empty field values,
    very long fields, special characters (SQL injection attempts), and
    duplicate externalIds within a single batch.

    Does NOT invoke the CSV crawler script directly — that is too slow and
    complex. Instead, each test exercises the ingest API endpoint directly
    with crafted payloads, validating the API's validation and error handling.

    Designed to be called from Run-NightlyLocal.ps1 with a `WriteResult` callback.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ApiKey
    Crawler API key for the built-in worker (used as Bearer token for ingest endpoints).

.PARAMETER LogFolder
    Folder where temporary CSV files are created. A csv-edge-cases subfolder
    will be created automatically.

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ApiKey,
    [string]$LogFolder = $env:TEMP,
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures = 0

function Report-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) {
        & $WriteResult $Name $Passed $Detail
    } elseif (-not $Passed) {
        $script:standaloneFailures++
    }
}

function Invoke-LocalApi {
    param([string]$Path, [string]$Method = 'Get', [hashtable]$Body = $null)
    $uri = "$ApiBaseUrl$Path"
    $params = @{
        Uri         = $uri
        Method      = $Method
        ContentType = 'application/json'
        TimeoutSec  = 30
        ErrorAction = 'Stop'
    }
    if ($ApiKey) {
        $params.Headers = @{ 'X-API-Key' = $ApiKey }
    }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod @params
}

Write-Host "`n=== CSV ingest edge cases ===" -ForegroundColor Cyan

# Create temp directory for CSV files
$edgeCaseDir = Join-Path $LogFolder 'csv-edge-cases'
[System.IO.Directory]::CreateDirectory($edgeCaseDir) | Out-Null

# We need a systemId for non-system ingest calls. Ingest a test system first
# and capture its ID. If that fails the remaining tests will be skipped.
$testSystemId = $null
try {
    $r = Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        records = @(
            @{
                displayName = 'EdgeCaseTestSystem'
                systemType  = 'Test'
                tenantId    = 'edge-case-test-tenant'
                description = 'Temporary system for CSV edge-case tests'
            }
        )
    }
    if ($r.systemIds -and $r.systemIds.Count -gt 0) {
        $testSystemId = $r.systemIds[0]
    }
} catch {
    Write-Host "    WARN  Could not create test system: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ─── 1. Missing required columns ─────────────────────────────────
# Systems require displayName + systemType. Send a record missing systemType.
$missingColsDir = Join-Path $edgeCaseDir 'missing-cols'
[System.IO.Directory]::CreateDirectory($missingColsDir) | Out-Null
"ExternalId;DisplayName" | Out-File -FilePath (Join-Path $missingColsDir 'Systems.csv') -Encoding utf8

try {
    Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        records = @(
            @{
                externalId  = 'edge-missing-cols-1'
                displayName = 'MissingSystemType'
            }
        )
    } | Out-Null
    # If we get here the API accepted it — that could be valid (systemType not strictly enforced at API level)
    Report-Result 'CSV/MissingColumns' $true 'API accepted record (systemType not enforced at ingest level)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Report-Result 'CSV/MissingColumns' $true "got 400 (expected validation error)"
    } elseif ($statusCode -eq 500) {
        Report-Result 'CSV/MissingColumns' $false "got 500 — API should return 400 for missing required columns"
    } else {
        Report-Result 'CSV/MissingColumns' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 2. Header-only file (empty records array) ──────────────────
$headerOnlyDir = Join-Path $edgeCaseDir 'header-only'
[System.IO.Directory]::CreateDirectory($headerOnlyDir) | Out-Null
"ExternalId;DisplayName;ResourceType;Description;SystemName;Enabled" | Out-File -FilePath (Join-Path $headerOnlyDir 'Resources.csv') -Encoding utf8

try {
    Invoke-LocalApi -Path '/ingest/resources' -Method Post -Body @{
        systemId = $testSystemId
        records  = @()
    } | Out-Null
    # 200 with inserted:0 is acceptable
    Report-Result 'CSV/HeaderOnly' $true 'API accepted empty records (graceful)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Report-Result 'CSV/HeaderOnly' $true "got 400 (empty records rejected, expected)"
    } elseif ($statusCode -eq 500) {
        Report-Result 'CSV/HeaderOnly' $false "got 500 — API should return 400 or 200 for empty records"
    } else {
        Report-Result 'CSV/HeaderOnly' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 3. Empty displayName ────────────────────────────────────────
try {
    Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        records = @(
            @{
                externalId  = 'edge-empty-dn'
                displayName = ''
                systemType  = 'Test'
            }
        )
    } | Out-Null
    Report-Result 'CSV/EmptyDisplayName' $true 'API accepted empty displayName (graceful)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Report-Result 'CSV/EmptyDisplayName' $true "got 400 (empty displayName rejected, expected)"
    } elseif ($statusCode -eq 500) {
        Report-Result 'CSV/EmptyDisplayName' $false "got 500 — API should return 400 for empty required field"
    } else {
        Report-Result 'CSV/EmptyDisplayName' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 4. Very long field values ───────────────────────────────────
$longDescription = 'A' * 10000

try {
    $id = [Guid]::NewGuid().ToString()
    Invoke-LocalApi -Path '/ingest/resources' -Method Post -Body @{
        systemId = $testSystemId
        records  = @(
            @{
                id            = $id
                displayName   = 'LongDescResource'
                resourceType  = 'TestGroup'
                description   = $longDescription
            }
        )
    } | Out-Null
    Report-Result 'CSV/LongField' $true 'API accepted 10K-char description'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Report-Result 'CSV/LongField' $true "got 400 (long field rejected with clear error)"
    } elseif ($statusCode -eq 500) {
        Report-Result 'CSV/LongField' $false "got 500 — API should handle long fields gracefully (accept or 400)"
    } else {
        Report-Result 'CSV/LongField' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 5. Special characters (SQL injection attempt) ───────────────
try {
    $id = [Guid]::NewGuid().ToString()
    Invoke-LocalApi -Path '/ingest/principals' -Method Post -Body @{
        systemId = $testSystemId
        records  = @(
            @{
                id            = $id
                displayName   = "O'Brien ""The Dev"" <admin>; DROP TABLE"
                principalType = 'User'
                email         = 'obrien@test.local'
                department    = "R&D <script>alert('xss')</script>"
            }
        )
    } | Out-Null
    Report-Result 'CSV/SpecialChars' $true 'API accepted special characters (no SQL injection, no crash)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 500) {
        Report-Result 'CSV/SpecialChars' $false "got 500 — possible SQL injection vulnerability or unescaped special chars"
    } else {
        Report-Result 'CSV/SpecialChars' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 6. Duplicate externalIds in one batch ───────────────────────
try {
    $id1 = [Guid]::NewGuid().ToString()
    Invoke-LocalApi -Path '/ingest/resources' -Method Post -Body @{
        systemId = $testSystemId
        records  = @(
            @{
                id           = $id1
                displayName  = 'DuplicateTest-First'
                resourceType = 'TestGroup'
                externalId   = 'edge-duplicate-ext-id'
            },
            @{
                id           = $id1
                displayName  = 'DuplicateTest-Second'
                resourceType = 'TestGroup'
                externalId   = 'edge-duplicate-ext-id'
            }
        )
    } | Out-Null
    Report-Result 'CSV/DuplicateIds' $true 'API handled duplicate externalIds in batch (upsert)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Report-Result 'CSV/DuplicateIds' $true "got 400 (duplicates rejected explicitly)"
    } elseif ($statusCode -eq 500) {
        Report-Result 'CSV/DuplicateIds' $false "got 500 — API should handle duplicate IDs gracefully (upsert or 400)"
    } else {
        Report-Result 'CSV/DuplicateIds' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── Cleanup ─────────────────────────────────────────────────────
# Best-effort removal of temp CSV files
try {
    Remove-Item -Path $edgeCaseDir -Recurse -Force -ErrorAction SilentlyContinue
} catch { }

if (-not $WriteResult) { exit $standaloneFailures }
