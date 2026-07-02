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

# ─── 3. Resources.csv (required) ─────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 3: Resources..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing resources' -Pct 20
$fast = Read-CsvFast 'Resources.csv'
if ($fast) {
    $rows = $fast.rows; $colIdx = $fast.colIdx
    if (-not $colIdx.ContainsKey('ExternalId') -or -not $colIdx.ContainsKey('DisplayName')) {
        throw "Resources.csv missing required columns ExternalId / DisplayName"
    }
    $idxExt   = $colIdx['ExternalId']
    $idxDN    = $colIdx['DisplayName']
    $idxRT    = if ($colIdx.ContainsKey('ResourceType')) { $colIdx['ResourceType'] } else { -1 }
    $idxDesc  = if ($colIdx.ContainsKey('Description'))  { $colIdx['Description'] }  else { -1 }
    $idxEn    = if ($colIdx.ContainsKey('Enabled'))      { $colIdx['Enabled'] }      else { -1 }
    $idxSys   = if ($colIdx.ContainsKey('SystemName'))   { $colIdx['SystemName'] }   else { -1 }

    $records = [System.Collections.Generic.List[object]]::new($rows.Count)
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $ext = $r[$idxExt]; $dn = $r[$idxDN]
        if (-not $ext -or -not $dn) { continue }
        $type = if ($idxRT -ge 0) { $r[$idxRT] } else { $null }
        if ($type -eq 'Business Role') { $type = 'BusinessRole' }
        $on = $true
        if ($idxEn -ge 0) { $ev = $r[$idxEn]; if ($ev -in @('false','False','0')) { $on = $false } }
        $sid = $fallbackSystemId
        if ($idxSys -ge 0) { $sn = $r[$idxSys]; if ($sn -and $systemLookup.ContainsKey($sn)) { $sid = $systemLookup[$sn] } }
        [void]$records.Add(@{
            _systemId = $sid; externalId = $ext; displayName = $dn; resourceType = $type; enabled = $on
            description = if ($idxDesc -ge 0) { $r[$idxDesc] } else { $null }
        })
    }
    $fast = $null; $rows = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) resource records" -ForegroundColor Gray
    Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records
    $records = $null; [System.GC]::Collect()
} else { Write-Host "  WARNING: Resources.csv not found (required)" -ForegroundColor Red }

# ─── 4. ResourceRelationships.csv (optional) ─────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 4: Resource relationships..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing relationships' -Pct 32
$rels = Read-CsvFile 'ResourceRelationships.csv'
if ($rels) {
    Assert-Columns 'ResourceRelationships.csv' $rels @('ParentExternalId','ChildExternalId')
    $cols = $rels[0].PSObject.Properties.Name
    $hRT = $cols -contains 'RelationshipType'; $hSys = $cols -contains 'SystemName'
    $records = [System.Collections.Generic.List[object]]::new($rels.Count)
    foreach ($r in $rels) {
        if (-not $r.ParentExternalId -or -not $r.ChildExternalId) { continue }
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        [void]$records.Add(@{
            _systemId = $sid; parentExternalId = $r.ParentExternalId; childExternalId = $r.ChildExternalId
            relationshipType = if ($hRT -and $r.RelationshipType) { $r.RelationshipType } else { 'Contains' }
        })
    }
    $rels = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) relationship records" -ForegroundColor Gray
    Send-GroupedBySystem -Endpoint 'ingest/resource-relationships' -Scope @{ relationshipType = 'Contains' } -Records $records
    $records = $null; [System.GC]::Collect()
}

# ─── 5. Users.csv (required) ─────────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 5: Users..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing users' -Pct 42
$users = Read-CsvFile 'Users.csv'
if ($users) {
    Assert-Columns 'Users.csv' $users @('ExternalId','DisplayName')
    $validTypes = @('User','ServicePrincipal','ManagedIdentity','WorkloadIdentity','AIAgent','ExternalUser','SharedMailbox')
    $cols = $users[0].PSObject.Properties.Name
    $hPT = $cols -contains 'PrincipalType'; $hEn = $cols -contains 'Enabled'
    $hE = $cols -contains 'Email'; $hJT = $cols -contains 'JobTitle'; $hDep = $cols -contains 'Department'
    $hSys = $cols -contains 'SystemName'
    $records = [System.Collections.Generic.List[object]]::new($users.Count)
    foreach ($r in $users) {
        if (-not $r.ExternalId -or -not $r.DisplayName) { continue }
        $pType = if ($hPT -and $r.PrincipalType -in $validTypes) { $r.PrincipalType } else { 'User' }
        $on = $true; if ($hEn -and $r.Enabled -in @('false','False','0')) { $on = $false }
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        [void]$records.Add(@{
            _systemId = $sid; externalId = $r.ExternalId; displayName = $r.DisplayName; principalType = $pType; accountEnabled = $on
            email = if ($hE) { $r.Email } else { $null }
            jobTitle = if ($hJT) { $r.JobTitle } else { $null }
            department = if ($hDep) { $r.Department } else { $null }
        })
    }
    $users = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) principal records" -ForegroundColor Gray
    Send-GroupedBySystem -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' } -Records $records
    $records = $null; [System.GC]::Collect()
} else { Write-Host "  WARNING: Users.csv not found (required)" -ForegroundColor Red }

# ─── 6. Assignments.csv (required) ───────────────────────────────
# The hot path of the crawler. We use the streaming CSV reader and skip
# dedup entirely — the canonical schema trusts the caller to dedupe upstream.
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 6: Assignments..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing assignments' -Pct 55
$fast = Read-CsvFast 'Assignments.csv'
if ($fast) {
    $rows = $fast.rows; $colIdx = $fast.colIdx
    if (-not $colIdx.ContainsKey('ResourceExternalId') -or -not $colIdx.ContainsKey('UserExternalId')) {
        throw "Assignments.csv missing required columns ResourceExternalId / UserExternalId"
    }
    $idxRes  = $colIdx['ResourceExternalId']
    $idxUser = $colIdx['UserExternalId']
    $idxType = if ($colIdx.ContainsKey('AssignmentType')) { $colIdx['AssignmentType'] } else { -1 }
    $idxSys  = if ($colIdx.ContainsKey('SystemName'))     { $colIdx['SystemName'] }     else { -1 }

    $records = [System.Collections.Generic.List[object]]::new($rows.Count)
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $resId = $r[$idxRes]; $usrId = $r[$idxUser]
        if (-not $resId -or -not $usrId) { continue }
        $sid = $fallbackSystemId
        if ($idxSys -ge 0) {
            $sn = $r[$idxSys]
            if ($sn -and $systemLookup.ContainsKey($sn)) { $sid = $systemLookup[$sn] }
        }
        $aType = 'Direct'
        if ($idxType -ge 0) {
            $v = $r[$idxType]
            if ($v) { $aType = $v }
        }
        [void]$records.Add(@{ _systemId = $sid; resourceExternalId = $resId; principalExternalId = $usrId; assignmentType = $aType })
    }
    $fast = $null; $rows = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) assignment records" -ForegroundColor Gray
    # Keep dedup enabled — even a handful of duplicate (resource, user) pairs
    # blow up the server-side upsert ("ON CONFLICT DO UPDATE command cannot
    # affect row a second time"). The Dictionary-based dedup is fast enough.
    Send-GroupedBySystem -Endpoint 'ingest/resource-assignments' -Scope @{ assignmentType = 'Direct' } -Records $records
    $records = $null; [System.GC]::Collect()
} else { Write-Host "  WARNING: Assignments.csv not found (required)" -ForegroundColor Red }

# ─── 7. Identities.csv (optional) ────────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 7: Identities..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing identities' -Pct 65
$identities = Read-CsvFile 'Identities.csv'
if ($identities) {
    Assert-Columns 'Identities.csv' $identities @('ExternalId','DisplayName')
    $cols = $identities[0].PSObject.Properties.Name
    $hE = $cols -contains 'Email'; $hEmp = $cols -contains 'EmployeeId'
    $hDep = $cols -contains 'Department'; $hJT = $cols -contains 'JobTitle'; $hSys = $cols -contains 'SystemName'
    $records = [System.Collections.Generic.List[object]]::new($identities.Count)
    foreach ($r in $identities) {
        if (-not $r.ExternalId -or -not $r.DisplayName) { continue }
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        [void]$records.Add(@{
            _systemId = $sid; externalId = $r.ExternalId; displayName = $r.DisplayName
            email = if ($hE) { $r.Email } else { $null }
            employeeId = if ($hEmp) { $r.EmployeeId } else { $null }
            department = if ($hDep) { $r.Department } else { $null }
            jobTitle = if ($hJT) { $r.JobTitle } else { $null }
        })
    }
    $identities = $null; [System.GC]::Collect()
    Send-GroupedBySystem -Endpoint 'ingest/identities' -Records $records
    $records = $null; [System.GC]::Collect()
}

# ─── 8. IdentityMembers.csv (optional) ───────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 8: Identity members..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing identity members' -Pct 72
$idMembers = Read-CsvFile 'IdentityMembers.csv'
if ($idMembers) {
    Assert-Columns 'IdentityMembers.csv' $idMembers @('IdentityExternalId','UserExternalId')
    $cols = $idMembers[0].PSObject.Properties.Name
    $hAT = $cols -contains 'AccountType'; $hSys = $cols -contains 'SystemName'
    $records = [System.Collections.Generic.List[object]]::new($idMembers.Count)
    foreach ($r in $idMembers) {
        if (-not $r.IdentityExternalId -or -not $r.UserExternalId) { continue }
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        [void]$records.Add(@{
            _systemId = $sid; identityExternalId = $r.IdentityExternalId; principalExternalId = $r.UserExternalId
            accountType = if ($hAT) { $r.AccountType } else { $null }
        })
    }
    $idMembers = $null; [System.GC]::Collect()
    Send-GroupedBySystem -Endpoint 'ingest/identity-members' -Records $records
    $records = $null; [System.GC]::Collect()
}

# ─── 9. Certifications.csv (optional) ────────────────────────────
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 9: Certifications..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing certifications' -Pct 78
$fast = Read-CsvFast 'Certifications.csv'
if ($fast) {
    $rows = $fast.rows; $colIdx = $fast.colIdx
    if (-not $colIdx.ContainsKey('ExternalId')) {
        throw "Certifications.csv missing required column ExternalId"
    }
    $idxExt  = $colIdx['ExternalId']
    $idxRes  = if ($colIdx.ContainsKey('ResourceExternalId'))  { $colIdx['ResourceExternalId'] }  else { -1 }
    $idxUDN  = if ($colIdx.ContainsKey('UserDisplayName'))      { $colIdx['UserDisplayName'] }      else { -1 }
    $idxDec  = if ($colIdx.ContainsKey('Decision'))             { $colIdx['Decision'] }             else { -1 }
    $idxRDN  = if ($colIdx.ContainsKey('ReviewerDisplayName'))  { $colIdx['ReviewerDisplayName'] }  else { -1 }
    $idxRDT  = if ($colIdx.ContainsKey('ReviewedDateTime'))     { $colIdx['ReviewedDateTime'] }     else { -1 }
    $idxSys  = if ($colIdx.ContainsKey('SystemName'))           { $colIdx['SystemName'] }           else { -1 }

    $records = [System.Collections.Generic.List[object]]::new($rows.Count)
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $ext = $r[$idxExt]
        if (-not $ext) { continue }
        $sid = $fallbackSystemId
        if ($idxSys -ge 0) {
            $sn = $r[$idxSys]
            if ($sn -and $systemLookup.ContainsKey($sn)) { $sid = $systemLookup[$sn] }
        }
        [void]$records.Add(@{
            _systemId = $sid; externalId = $ext
            resourceExternalId    = if ($idxRes -ge 0) { $r[$idxRes] } else { $null }
            principalDisplayName  = if ($idxUDN -ge 0) { $r[$idxUDN] } else { $null }
            decision              = if ($idxDec -ge 0) { $r[$idxDec] } else { $null }
            reviewedByDisplayName = if ($idxRDN -ge 0) { $r[$idxRDN] } else { $null }
            reviewedDateTime      = if ($idxRDT -ge 0) { $r[$idxRDT] } else { $null }
        })
    }
    $fast = $null; $rows = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) certification records" -ForegroundColor Gray
    # Smaller batches to avoid oversized INSERT statements. Dedup is cheap
    # (Dictionary-based) and protects against the "ON CONFLICT cannot affect
    # row twice" postgres error on duplicate externalIds in a single batch.
    Send-GroupedBySystem -Endpoint 'ingest/governance/certifications' -Records $records -BatchSize 3000
    $records = $null; [System.GC]::Collect()
}

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
