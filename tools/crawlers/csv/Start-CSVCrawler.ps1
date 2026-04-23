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
    param([string]$Endpoint, [int]$SystemId, [string]$SyncMode = 'full', [hashtable]$Scope = @{}, $Records, [int]$BatchSize = 10000)
    $count = if ($null -eq $Records) { 0 } else { $Records.Count }
    if ($count -eq 0) { Write-Host "  No records to send" -ForegroundColor Yellow; return }
    Write-Host "  Sending $count records to $Endpoint..." -ForegroundColor Cyan
    if ($count -le $BatchSize) {
        $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = $Records; idGeneration = 'deterministic'; idPrefix = "$SystemType-$($Endpoint.Split('/')[-1])" }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        Write-Host "  → $($result.inserted) inserted, $($result.updated) updated, $($result.deleted) deleted" -ForegroundColor Green
        return
    }
    $syncId = $null
    $totalIns = 0; $totalUpd = 0; $totalDel = 0
    $batch = [System.Collections.Generic.List[object]]::new($BatchSize)
    for ($i = 0; $i -lt $count; $i += $BatchSize) {
        $end = [Math]::Min($i + $BatchSize - 1, $count - 1)
        $batch.Clear()
        for ($j = $i; $j -le $end; $j++) { [void]$batch.Add($Records[$j]) }
        $isFirst = ($i -eq 0); $isLast = ($i + $BatchSize -ge $count)
        $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = $batch; idGeneration = 'deterministic'; idPrefix = "$SystemType-$($Endpoint.Split('/')[-1])"; syncSession = if ($isFirst) { 'start' } elseif ($isLast) { 'end' } else { 'continue' } }
        if ($syncId) { $body.syncId = $syncId }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        if ($isFirst) { $syncId = $result.syncId }
        $totalIns += [int]$result.inserted; $totalUpd += [int]$result.updated; $totalDel += [int]$result.deleted
        Write-Host "    batch $([int]($i / $BatchSize) + 1): +$($result.inserted) ins, $($result.updated) upd ($([int]($end + 1))/$count)" -ForegroundColor DarkGray
    }
    Write-Host "  → $totalIns inserted, $totalUpd updated, $totalDel deleted (chunked)" -ForegroundColor Green
}

function Read-CsvFile {
    param([string]$FileName)
    $path = Join-Path $CsvFolder $FileName
    if (-not (Test-Path $path)) { return $null }
    $rows = Import-Csv -Path $path -Delimiter $Delimiter -Encoding UTF8
    Write-Host "  $FileName`: $($rows.Count) rows" -ForegroundColor Gray
    return $rows
}

# Streaming CSV reader — returns a List[object[]] plus a hashtable mapping
# column name to index. 5-10× faster than Import-Csv for files with >100k
# rows because it skips PSCustomObject allocation entirely.
#
# Supported quoting: each field MAY be wrapped in plain double quotes
# ("foo";"bar"), which PowerShell's Export-Csv does by default. Surrounding
# quotes are stripped from both headers and data cells. NOT supported:
# embedded delimiters inside a quoted field ("foo;bar"), embedded newlines,
# or "" escape sequences. If your data needs any of those, use the slow
# path (Read-CsvFile / Import-Csv) — Resources.csv is the only file that
# uses Read-CsvFast and the canonical schema doesn't put delimiters inside
# Resource descriptions.
function Read-CsvFast {
    param([string]$FileName)
    $path = Join-Path $CsvFolder $FileName
    if (-not (Test-Path $path)) { return $null }
    # IMPORTANT: cache $Delimiter in a local (with a type-constrained char[] for
    # the Split call). PowerShell's scope walk on outer-scope variables inside
    # a tight loop is catastrophic — for 1.5M lines the scope lookup alone is
    # 30+ minutes. Locals are resolved in microseconds.
    [char[]]$delim = @([char]($Delimiter[0]))
    [char]$dq = '"'
    $reader = [System.IO.StreamReader]::new($path, [System.Text.Encoding]::UTF8)
    $rows = [System.Collections.Generic.List[object]]::new()
    $colIdx = @{}
    try {
        $headerLine = $reader.ReadLine()
        if (-not $headerLine) { return $null }
        if ($headerLine[0] -eq [char]0xFEFF) { $headerLine = $headerLine.Substring(1) }
        $headers = $headerLine.Split($delim)
        for ($i = 0; $i -lt $headers.Length; $i++) {
            $h = $headers[$i]
            if ($h.Length -ge 2 -and $h[0] -eq $dq -and $h[$h.Length - 1] -eq $dq) {
                $h = $h.Substring(1, $h.Length - 2)
            }
            $colIdx[$h] = $i
        }
        while ($true) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }
            if ($line.Length -eq 0) { continue }
            $cells = $line.Split($delim)
            for ($j = 0; $j -lt $cells.Length; $j++) {
                $c = $cells[$j]
                if ($c.Length -ge 2 -and $c[0] -eq $dq -and $c[$c.Length - 1] -eq $dq) {
                    $cells[$j] = $c.Substring(1, $c.Length - 2)
                }
            }
            [void]$rows.Add($cells)
        }
    } finally { $reader.Dispose() }
    Write-Host "  $FileName`: $($rows.Count) rows (fast path)" -ForegroundColor Gray
    return @{ rows = $rows; colIdx = $colIdx }
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

# Helper: group records by systemId and send each system's batch to the API.
#
# Design notes (learned the hard way on a 1.5M-row load test):
#  - PowerShell hashtables use OrdinalIgnoreCase string comparison by default
#    and become painfully slow past ~500k entries. We use
#    System.Collections.Generic.Dictionary[string,object] with an ordinal
#    comparer instead — roughly 5-10× faster for large sets.
#  - `@() += $x` is O(N²). Always use List[object].Add().
#  - Dedup is entirely optional when the caller trusts the input. Callers can
#    pass -SkipDedup to bypass the hash-pass for very large inputs.
function Send-GroupedBySystem {
    param(
        [string]$Endpoint,
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{},
        $Records,
        [int]$BatchSize = 10000,
        [switch]$SkipDedup
    )
    # Group into per-system List[object] in one O(N) pass
    $grouped = [System.Collections.Generic.Dictionary[int, object]]::new()
    foreach ($rec in $Records) {
        $sid = [int]($rec['_systemId']); if (-not $sid) { $sid = $fallbackSystemId }
        $rec.Remove('_systemId')
        $list = $null
        if (-not $grouped.TryGetValue($sid, [ref]$list)) {
            $list = [System.Collections.Generic.List[object]]::new()
            $grouped[$sid] = $list
        }
        [void]$list.Add($rec)
    }

    $sysIds = [int[]]@($grouped.Keys)
    $sysCount = $sysIds.Length
    foreach ($sid in $sysIds) {
        $batch = $grouped[$sid]
        $origCount = $batch.Count
        $toSend = $batch
        if (-not $SkipDedup) {
            # Fast ordinal string comparer; Dictionary is ~10x faster than @{} for large sets.
            $seen = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
            $sb = [System.Text.StringBuilder]::new(128)
            foreach ($r in $batch) {
                $k = $r['externalId']
                if (-not $k) {
                    [void]$sb.Clear()
                    [void]$sb.Append([string]$r['resourceExternalId']).Append('|')
                    [void]$sb.Append([string]$r['principalExternalId']).Append('|')
                    [void]$sb.Append([string]$r['parentExternalId']).Append('|')
                    [void]$sb.Append([string]$r['childExternalId']).Append('|')
                    [void]$sb.Append([string]$r['identityExternalId']).Append('|')
                    [void]$sb.Append([string]$r['userExternalId'])
                    $k = $sb.ToString()
                }
                $seen[$k] = $r
            }
            if ($seen.Count -ne $origCount) {
                $toSend = [System.Collections.Generic.List[object]]::new($seen.Count)
                foreach ($v in $seen.Values) { [void]$toSend.Add($v) }
                Write-Host "    Deduped: $origCount → $($toSend.Count)" -ForegroundColor DarkGray
            }
            $seen = $null
        }
        if ($sysCount -gt 1) { Write-Host "    System $sid`: $($toSend.Count) records" -ForegroundColor DarkGray }
        Send-IngestBatch -Endpoint $Endpoint -SystemId $sid -SyncMode $SyncMode -Scope $Scope -Records $toSend -BatchSize $BatchSize
        $grouped[$sid] = $null  # release early — we already snapshotted the keys
        $toSend = $null
        $batch = $null
    }
    $grouped.Clear()
    [System.GC]::Collect()
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
#
# v6 context model: every row is a `variant='synced'` context with an
# explicit `targetType` and `contextType`. The CSV defaults targetType
# to Identity and contextType to OrgUnit so legacy CSV feeds keep working;
# richer CSVs can set both columns per-row. See
# docs/architecture/context-redesign.md for the data model.
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 2: Contexts..." -ForegroundColor Cyan
Update-CrawlerProgress -Step 'Syncing contexts' -Pct 12
$contexts = Read-CsvFile 'Contexts.csv'
if ($contexts) {
    Assert-Columns 'Contexts.csv' $contexts @('ExternalId','DisplayName')
    $cols = $contexts[0].PSObject.Properties.Name
    $hCT  = $cols -contains 'ContextType'
    $hTT  = $cols -contains 'TargetType'
    $hD   = $cols -contains 'Description'
    $hP   = $cols -contains 'ParentExternalId'
    $hSys = $cols -contains 'SystemName'
    $hOwn = $cols -contains 'OwnerUserId'
    $records = [System.Collections.Generic.List[object]]::new($contexts.Count)
    foreach ($r in $contexts) {
        if (-not $r.ExternalId) { continue }
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        [void]$records.Add(@{
            _systemId        = $sid
            externalId       = $r.ExternalId
            displayName      = $r.DisplayName
            variant          = 'synced'
            targetType       = if ($hTT -and $r.TargetType) { $r.TargetType } else { 'Identity' }
            contextType      = if ($hCT -and $r.ContextType) { $r.ContextType } else { 'OrgUnit' }
            scopeSystemId    = $sid
            description      = if ($hD) { $r.Description } else { $null }
            parentExternalId = if ($hP) { $r.ParentExternalId } else { $null }
            ownerUserId      = if ($hOwn) { $r.OwnerUserId } else { $null }
        })
    }
    $contexts = $null
    Send-GroupedBySystem -Endpoint 'ingest/contexts' -Scope @{ variant = 'synced' } -Records $records
    $records = $null; [System.GC]::Collect()
}

# ─── 2b. ContextMembers.csv (optional) ───────────────────────────
#
# Explicit membership rows: (ContextExternalId, MemberExternalId, MemberType).
# The ingest engine resolves externalIds to UUIDs within the referenced system
# before writing to ContextMembers. Only supplied when the source CSV has real
# membership data — otherwise memberships come from a later plugin run
# (manager-hierarchy, department-tree, etc.).
$cmembers = Read-CsvFile 'ContextMembers.csv'
if ($cmembers) {
    Assert-Columns 'ContextMembers.csv' $cmembers @('ContextExternalId','MemberExternalId','MemberType')
    $cmRec = [System.Collections.Generic.List[object]]::new($cmembers.Count)
    foreach ($r in $cmembers) {
        if (-not $r.ContextExternalId -or -not $r.MemberExternalId) { continue }
        [void]$cmRec.Add(@{
            _systemId         = $fallbackSystemId
            contextExternalId = $r.ContextExternalId
            memberExternalId  = $r.MemberExternalId
            memberType        = $r.MemberType
            addedBy           = 'sync'
        })
    }
    $cmembers = $null
    Send-GroupedBySystem -Endpoint 'ingest/context-members' -Records $cmRec
    $cmRec = $null; [System.GC]::Collect()
}

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
