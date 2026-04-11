<#
.SYNOPSIS
    Orchestrates a full CSV data sync via the Identity Atlas Ingest API.

.DESCRIPTION
    Reads CSV files in the Identity Atlas canonical schema and POSTs them to the
    Ingest API. Files must follow the schema defined in tools/csv-templates/schema/.

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
    [Parameter(Mandatory = $true)]  [string]$ApiBaseUrl,
    [Parameter(Mandatory = $true)]  [string]$ApiKey,
    [Parameter(Mandatory = $true)]  [string]$CsvFolder,
    [Parameter(Mandatory = $false)] [string]$SystemName = 'CSV Import',
    [Parameter(Mandatory = $false)] [string]$SystemType = 'CSV',
    [Parameter(Mandatory = $false)] [string]$Delimiter = ';',
    [switch]$RefreshViews = $true,
    [int]$JobId = 0
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

# ─── Helpers ─────────────────────────────────────────────────────

function Invoke-IngestAPI {
    param([string]$Endpoint, [hashtable]$Body)
    $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    $uri = "$ApiBaseUrl/$Endpoint"
    $maxAttempts = 5; $attempt = 0
    while ($true) {
        $attempt++
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $json -TimeoutSec 300
            if ($attempt -gt 1) { Write-Host "  Recovered on attempt $attempt" -ForegroundColor Green }
            return $response
        } catch {
            $statusCode = try { $_.Exception.Response.StatusCode.value__ } catch { $null }
            $isTransient = (-not $statusCode) -or ($statusCode -ge 500) -or ($statusCode -eq 429)
            if ($isTransient -and $attempt -lt $maxAttempts) {
                $delay = [Math]::Pow(2, $attempt)
                Write-Host "  Transient ($statusCode) on $Endpoint — retry $attempt in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }
            $responseBody = $null
            try { $stream = $_.Exception.Response.GetResponseStream(); if ($stream) { $reader = [System.IO.StreamReader]::new($stream); $responseBody = $reader.ReadToEnd(); $reader.Close() } } catch {}
            Write-Host "  ERROR: $Endpoint → $statusCode after $attempt attempt(s)" -ForegroundColor Red
            if ($responseBody) { Write-Host "  $responseBody" -ForegroundColor Yellow }
            throw
        }
    }
}

function Send-IngestBatch {
    param([string]$Endpoint, [int]$SystemId, [string]$SyncMode = 'full', [hashtable]$Scope = @{}, [array]$Records, [int]$BatchSize = 10000)
    if (-not $Records -or $Records.Count -eq 0) { Write-Host "  No records to send" -ForegroundColor Yellow; return }
    Write-Host "  Sending $($Records.Count) records to $Endpoint..." -ForegroundColor Cyan
    if ($Records.Count -le $BatchSize) {
        $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = $Records; idGeneration = 'deterministic'; idPrefix = "$SystemType-$($Endpoint.Split('/')[-1])" }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        Write-Host "  → $($result.inserted) inserted, $($result.updated) updated, $($result.deleted) deleted" -ForegroundColor Green
        return
    }
    $syncId = $null
    for ($i = 0; $i -lt $Records.Count; $i += $BatchSize) {
        $batch = $Records[$i..([Math]::Min($i + $BatchSize - 1, $Records.Count - 1))]
        $isFirst = ($i -eq 0); $isLast = ($i + $BatchSize -ge $Records.Count)
        $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = $batch; idGeneration = 'deterministic'; idPrefix = "$SystemType-$($Endpoint.Split('/')[-1])"; syncSession = if ($isFirst) { 'start' } elseif ($isLast) { 'end' } else { 'continue' } }
        if ($syncId) { $body.syncId = $syncId }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        if ($isFirst) { $syncId = $result.syncId }
    }
    Write-Host "  Chunked sync complete" -ForegroundColor Green
}

function Read-CsvFile {
    param([string]$FileName)
    $path = Join-Path $CsvFolder $FileName
    if (-not (Test-Path $path)) { return $null }
    $rows = Import-Csv -Path $path -Delimiter $Delimiter -Encoding UTF8
    Write-Host "  $FileName`: $($rows.Count) rows" -ForegroundColor Gray
    return $rows
}

function Update-CrawlerProgress {
    param([string]$Step, [int]$Pct = -1, [string]$Detail)
    if (-not $JobId -or $JobId -le 0) { return }
    $body = @{ jobId = $JobId }
    if ($PSBoundParameters.ContainsKey('Step'))   { $body['step']   = $Step }
    if ($Pct -ge 0)                                { $body['pct']    = $Pct }
    if ($PSBoundParameters.ContainsKey('Detail')) { $body['detail'] = $Detail }
    try {
        $h = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -Headers $h -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10 | Out-Null
    } catch { }
}

function Assert-Columns {
    param([string]$FileName, [array]$Rows, [string[]]$Required)
    if (-not $Rows -or $Rows.Count -eq 0) { return }
    $cols = $Rows[0].PSObject.Properties.Name
    $missing = @($Required | Where-Object { $cols -notcontains $_ })
    if ($missing.Count -gt 0) {
        Write-Host "  ERROR: $FileName is missing required column(s): $($missing -join ', ')" -ForegroundColor Red
        Write-Host "  Found: $($cols -join ', ')" -ForegroundColor Yellow
        Write-Host "  Download the schema templates from Admin → Crawlers." -ForegroundColor Yellow
        throw "$FileName schema mismatch: missing $($missing -join ', ')"
    }
}

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

# Helper: resolve SystemName column → systemId
function Resolve-SystemId { param($Row)
    if ($Row.PSObject.Properties.Name -contains 'SystemName' -and $Row.SystemName -and $systemLookup.ContainsKey($Row.SystemName)) { return $systemLookup[$Row.SystemName] }
    return $fallbackSystemId
}

# Helper: group by system, deduplicate, send
function Send-GroupedBySystem {
    param([string]$Endpoint, [string]$SyncMode = 'full', [hashtable]$Scope = @{}, [array]$Records, [int]$BatchSize = 10000)
    $grouped = @{}
    foreach ($rec in $Records) {
        $sid = $rec['_systemId']; if (-not $sid) { $sid = $fallbackSystemId }; $rec.Remove('_systemId')
        if (-not $grouped.ContainsKey($sid)) { $grouped[$sid] = @() }; $grouped[$sid] += $rec
    }
    foreach ($sid in $grouped.Keys) {
        $batch = $grouped[$sid]; $seen = @{}
        foreach ($r in $batch) {
            $key = $r['externalId']
            if (-not $key) { $key = "$($r['resourceExternalId'])|$($r['principalExternalId'])|$($r['parentExternalId'])|$($r['childExternalId'])|$($r['identityExternalId'])|$($r['userExternalId'])" }
            $seen[$key] = $r
        }
        $deduped = @($seen.Values)
        if ($deduped.Count -ne $batch.Count) { Write-Host "    Deduped: $($batch.Count) → $($deduped.Count)" -ForegroundColor DarkGray }
        if ($grouped.Count -gt 1) { Write-Host "    System $sid`: $($deduped.Count) records" -ForegroundColor DarkGray }
        Send-IngestBatch -Endpoint $Endpoint -SystemId $sid -SyncMode $SyncMode -Scope $Scope -Records $deduped -BatchSize $BatchSize
    }
}

# ─── 1. Systems.csv (optional) ───────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 1: Systems..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Processing systems' -Pct 8
$systemsCsv = Read-CsvFile 'Systems.csv'
if ($systemsCsv) {
    Assert-Columns 'Systems.csv' $systemsCsv @('ExternalId','DisplayName')
    $sysRecords = @(); $sysNames = @()
    foreach ($row in $systemsCsv) {
        if (-not $row.DisplayName -or $sysNames -contains $row.DisplayName) { continue }
        $sysNames += $row.DisplayName
        $sysRecords += @{
            externalId = $row.ExternalId; displayName = $row.DisplayName; enabled = $true; syncEnabled = $true
            systemType = if ($row.PSObject.Properties.Name -contains 'SystemType' -and $row.SystemType) { $row.SystemType } else { $SystemType }
            description = if ($row.PSObject.Properties.Name -contains 'Description') { $row.Description } else { $null }
        }
    }
    if ($sysRecords.Count -gt 0) {
        $r = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{ syncMode = 'delta'; records = $sysRecords }
        if ($r.systemIds) { for ($i = 0; $i -lt [Math]::Min($sysNames.Count, $r.systemIds.Count); $i++) { $systemLookup[$sysNames[$i]] = [int]$r.systemIds[$i] } }
    }
    Write-Host "  $($systemLookup.Count) system(s) in lookup" -ForegroundColor Gray
}

# ─── 2. Contexts.csv (optional) ──────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 2: Contexts..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing contexts' -Pct 12
$contexts = Read-CsvFile 'Contexts.csv'
if ($contexts) {
    Assert-Columns 'Contexts.csv' $contexts @('ExternalId','DisplayName')
    $records = @($contexts | ForEach-Object {
        @{ _systemId = Resolve-SystemId $_; externalId = $_.ExternalId; displayName = $_.DisplayName
           contextType = if ($_.PSObject.Properties.Name -contains 'ContextType' -and $_.ContextType) { $_.ContextType } else { 'OrgUnit' }
           department = if ($_.PSObject.Properties.Name -contains 'Description') { $_.Description } else { $null }
           parentExternalId = if ($_.PSObject.Properties.Name -contains 'ParentExternalId') { $_.ParentExternalId } else { $null }
        }
    } | Where-Object { $_.externalId })
    Send-GroupedBySystem -Endpoint 'ingest/contexts' -Scope @{ contextType = 'OrgUnit' } -Records $records
}

# ─── 3. Resources.csv (required) ─────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 3: Resources..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing resources' -Pct 20
$resources = Read-CsvFile 'Resources.csv'
if ($resources) {
    Assert-Columns 'Resources.csv' $resources @('ExternalId','DisplayName')
    $records = @($resources | ForEach-Object {
        $type = $_.ResourceType; if ($type -eq 'Business Role') { $type = 'BusinessRole' }
        $on = $true; if ($_.PSObject.Properties.Name -contains 'Enabled' -and $_.Enabled -in @('false','False','0')) { $on = $false }
        @{ _systemId = Resolve-SystemId $_; externalId = $_.ExternalId; displayName = $_.DisplayName; resourceType = $type; enabled = $on
           description = if ($_.PSObject.Properties.Name -contains 'Description') { $_.Description } else { $null }
        }
    } | Where-Object { $_.externalId -and $_.displayName })
    Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records
} else { Write-Host "  WARNING: Resources.csv not found (required)" -ForegroundColor Red }

# ─── 4. ResourceRelationships.csv (optional) ─────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 4: Resource relationships..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing relationships' -Pct 32
$rels = Read-CsvFile 'ResourceRelationships.csv'
if ($rels) {
    Assert-Columns 'ResourceRelationships.csv' $rels @('ParentExternalId','ChildExternalId')
    $records = @($rels | ForEach-Object {
        @{ _systemId = Resolve-SystemId $_; parentExternalId = $_.ParentExternalId; childExternalId = $_.ChildExternalId
           relationshipType = if ($_.PSObject.Properties.Name -contains 'RelationshipType' -and $_.RelationshipType) { $_.RelationshipType } else { 'Contains' }
        }
    } | Where-Object { $_.parentExternalId -and $_.childExternalId })
    Send-GroupedBySystem -Endpoint 'ingest/resource-relationships' -Scope @{ relationshipType = 'Contains' } -Records $records
}

# ─── 5. Users.csv (required) ─────────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 5: Users..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing users' -Pct 42
$users = Read-CsvFile 'Users.csv'
if ($users) {
    Assert-Columns 'Users.csv' $users @('ExternalId','DisplayName')
    $validTypes = @('User','ServicePrincipal','ManagedIdentity','WorkloadIdentity','AIAgent','ExternalUser','SharedMailbox')
    $records = @($users | ForEach-Object {
        $pType = if ($_.PSObject.Properties.Name -contains 'PrincipalType' -and $_.PrincipalType -in $validTypes) { $_.PrincipalType } else { 'User' }
        $on = $true; if ($_.PSObject.Properties.Name -contains 'Enabled' -and $_.Enabled -in @('false','False','0')) { $on = $false }
        @{ _systemId = Resolve-SystemId $_; externalId = $_.ExternalId; displayName = $_.DisplayName; principalType = $pType; accountEnabled = $on
           email = if ($_.PSObject.Properties.Name -contains 'Email') { $_.Email } else { $null }
           jobTitle = if ($_.PSObject.Properties.Name -contains 'JobTitle') { $_.JobTitle } else { $null }
           department = if ($_.PSObject.Properties.Name -contains 'Department') { $_.Department } else { $null }
        }
    } | Where-Object { $_.externalId -and $_.displayName })
    Send-GroupedBySystem -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' } -Records $records
} else { Write-Host "  WARNING: Users.csv not found (required)" -ForegroundColor Red }

# ─── 6. Assignments.csv (required) ───────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 6: Assignments..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing assignments' -Pct 55
$assignments = Read-CsvFile 'Assignments.csv'
if ($assignments) {
    Assert-Columns 'Assignments.csv' $assignments @('ResourceExternalId','UserExternalId')
    $records = @($assignments | ForEach-Object {
        $aType = if ($_.PSObject.Properties.Name -contains 'AssignmentType' -and $_.AssignmentType) { $_.AssignmentType } else { 'Direct' }
        @{ _systemId = Resolve-SystemId $_; resourceExternalId = $_.ResourceExternalId; principalExternalId = $_.UserExternalId; assignmentType = $aType }
    } | Where-Object { $_.resourceExternalId -and $_.principalExternalId })
    Send-GroupedBySystem -Endpoint 'ingest/resource-assignments' -Scope @{ assignmentType = 'Direct' } -Records $records
} else { Write-Host "  WARNING: Assignments.csv not found (required)" -ForegroundColor Red }

# ─── 7. Identities.csv (optional) ────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 7: Identities..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing identities' -Pct 65
$identities = Read-CsvFile 'Identities.csv'
if ($identities) {
    Assert-Columns 'Identities.csv' $identities @('ExternalId','DisplayName')
    $records = @($identities | ForEach-Object {
        @{ _systemId = Resolve-SystemId $_; externalId = $_.ExternalId; displayName = $_.DisplayName
           email = if ($_.PSObject.Properties.Name -contains 'Email') { $_.Email } else { $null }
           employeeId = if ($_.PSObject.Properties.Name -contains 'EmployeeId') { $_.EmployeeId } else { $null }
           department = if ($_.PSObject.Properties.Name -contains 'Department') { $_.Department } else { $null }
           jobTitle = if ($_.PSObject.Properties.Name -contains 'JobTitle') { $_.JobTitle } else { $null }
        }
    } | Where-Object { $_.externalId -and $_.displayName })
    Send-GroupedBySystem -Endpoint 'ingest/identities' -Records $records
}

# ─── 8. IdentityMembers.csv (optional) ───────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 8: Identity members..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing identity members' -Pct 72
$idMembers = Read-CsvFile 'IdentityMembers.csv'
if ($idMembers) {
    Assert-Columns 'IdentityMembers.csv' $idMembers @('IdentityExternalId','UserExternalId')
    $records = @($idMembers | ForEach-Object {
        @{ _systemId = Resolve-SystemId $_; identityExternalId = $_.IdentityExternalId; principalExternalId = $_.UserExternalId
           accountType = if ($_.PSObject.Properties.Name -contains 'AccountType') { $_.AccountType } else { $null }
        }
    } | Where-Object { $_.identityExternalId -and $_.principalExternalId })
    Send-GroupedBySystem -Endpoint 'ingest/identity-members' -Records $records
}

# ─── 9. Certifications.csv (optional) ────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 9: Certifications..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing certifications' -Pct 78
$certs = Read-CsvFile 'Certifications.csv'
if ($certs) {
    Assert-Columns 'Certifications.csv' $certs @('ExternalId')
    $records = @($certs | ForEach-Object {
        @{ _systemId = Resolve-SystemId $_; externalId = $_.ExternalId
           resourceExternalId = if ($_.PSObject.Properties.Name -contains 'ResourceExternalId') { $_.ResourceExternalId } else { $null }
           principalDisplayName = if ($_.PSObject.Properties.Name -contains 'UserDisplayName') { $_.UserDisplayName } else { $null }
           decision = if ($_.PSObject.Properties.Name -contains 'Decision') { $_.Decision } else { $null }
           reviewedByDisplayName = if ($_.PSObject.Properties.Name -contains 'ReviewerDisplayName') { $_.ReviewerDisplayName } else { $null }
           reviewedDateTime = if ($_.PSObject.Properties.Name -contains 'ReviewedDateTime') { $_.ReviewedDateTime } else { $null }
        }
    } | Where-Object { $_.externalId })
    # Certifications can be large (30k+ rows) — use smaller batches to avoid
    # OOM in the web container's COPY stream.
    Send-GroupedBySystem -Endpoint 'ingest/governance/certifications' -Records $records -BatchSize 3000
}

# ─── Post-import: auto-classify BusinessRole assignments ─────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Auto-classifying BusinessRole assignments..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Classifying assignments' -Pct 85
try {
    Invoke-IngestAPI -Endpoint 'ingest/classify-business-role-assignments' -Body @{} | Out-Null
    Write-Host "  Done" -ForegroundColor Green
} catch { Write-Host "  (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow }

# ─── Refresh views + contexts ────────────────────────────────────
if ($RefreshViews) {
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 88
    try { Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null; Write-Host "  Views refreshed" -ForegroundColor Green } catch { }
}
Update-CrawlerProgress -Step 'Refreshing contexts' -Pct 92
try { $ctx = Invoke-IngestAPI -Endpoint 'ingest/refresh-contexts' -Body @{}; Write-Host "  Contexts: $($ctx.contextsCreated) row(s)" -ForegroundColor Green } catch { Write-Host "  Context refresh failed (non-critical)" -ForegroundColor Yellow }

# ─── Summary ─────────────────────────────────────────────────────
$elapsed = (Get-Date) - $syncStart
Write-Host "`n=== CSV Sync Complete ===" -ForegroundColor Green
Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds))s" -ForegroundColor Gray

try { Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{ syncType = 'CSV-FullCrawl'; startTime = $syncStart.ToString('o'); endTime = (Get-Date).ToString('o'); status = 'Success' } | Out-Null } catch { }
