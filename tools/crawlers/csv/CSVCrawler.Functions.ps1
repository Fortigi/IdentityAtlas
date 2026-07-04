<#
.SYNOPSIS
    Reusable CSV crawler helper functions, extracted from Start-CSVCrawler.ps1.

.DESCRIPTION
    These functions are dot-sourced into Start-CSVCrawler.ps1's own scope, which
    is equivalent to defining them inline. They read script-scope variables
    ($CsvFolder, $Delimiter, $SystemType, $fallbackSystemId, $systemLookup) from
    the calling crawler's scope at call time, exactly as before.

    Extracted into a standalone file so the functions can be unit-tested in
    isolation with Pester (see test/unit/CSVCrawlerFunctions.Tests.ps1). The
    function bodies are unchanged from their original inline definitions.

    Send-IngestBatch and Send-GroupedBySystem call Invoke-IngestAPI from
    tools/crawlers/shared/Invoke-CrawlerIngest.ps1 — dot-source that file too.
#>

# ─── Helpers ─────────────────────────────────────────────────────

function Send-IngestBatch {
    [CmdletBinding()]
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
    [CmdletBinding()]
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
# Read the data rows (everything after the header) with the perf-critical inline
# split/dequote loop. Extracted from Read-CsvFast to keep the reader flat; called
# exactly once per file, so this adds NO per-row/-cell function-call overhead to the
# hot path — $Delim/$Quote arrive as locals, resolved in microseconds.
function Read-CsvDataRows {
    [CmdletBinding()]
    param([System.IO.StreamReader]$Reader, [char[]]$Delim, [char]$Quote)
    $rows = [System.Collections.Generic.List[object]]::new()
    while ($true) {
        $line = $Reader.ReadLine()
        if ($null -eq $line) { break }
        if ($line.Length -eq 0) { continue }
        $cells = $line.Split($Delim)
        for ($j = 0; $j -lt $cells.Length; $j++) {
            $c = $cells[$j]
            if ($c.Length -ge 2 -and $c[0] -eq $Quote -and $c[$c.Length - 1] -eq $Quote) {
                $cells[$j] = $c.Substring(1, $c.Length - 2)
            }
        }
        [void]$rows.Add($cells)
    }
    return , $rows   # comma: return the List intact, do not unroll it into the pipeline
}

function Read-CsvFast {
    [CmdletBinding()]
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
    $rows = $null
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
        $rows = Read-CsvDataRows -Reader $reader -Delim $delim -Quote $dq
    } finally { $reader.Dispose() }
    Write-Host "  $FileName`: $($rows.Count) rows (fast path)" -ForegroundColor Gray
    return @{ rows = $rows; colIdx = $colIdx }
}

function Assert-Columns {
    [CmdletBinding()]
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

# Helper: resolve SystemName column → systemId
function Resolve-SystemId {
    [CmdletBinding()]
    param($Row)
    if ($Row.PSObject.Properties.Name -contains 'SystemName' -and $Row.SystemName -and $systemLookup.ContainsKey($Row.SystemName)) { return $systemLookup[$Row.SystemName] }
    return $fallbackSystemId
}

# Helper: resolve a column index by name, or -1 when the column is absent. Collapses
# the repeated `if ($colIdx.ContainsKey('X')) { $colIdx['X'] } else { -1 }` used when
# the phases build their per-file column-index maps.
function Get-CsvColIndex {
    [CmdletBinding()]
    param([hashtable]$ColIdx, [string]$Name)
    if ($ColIdx.ContainsKey($Name)) { $ColIdx[$Name] } else { -1 }
}

# Helper: dedup one per-system batch on externalId (or a composite key for keyless
# rows — relationship / identity-member / context-member shapes), using an ordinal
# Dictionary (~10x faster than @{} for large sets). Returns the original batch
# untouched when there were no duplicates. Extracted from Send-GroupedBySystem so its
# per-system loop stays flat.
function Get-CsvDedupedBatch {
    [CmdletBinding()]
    param($Batch)
    $seen = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $sb = [System.Text.StringBuilder]::new(128)
    foreach ($r in $Batch) {
        $k = $r['externalId']
        if (-not $k) {
            [void]$sb.Clear()
            [void]$sb.Append([string]$r['resourceExternalId']).Append('|')
            [void]$sb.Append([string]$r['principalExternalId']).Append('|')
            [void]$sb.Append([string]$r['parentExternalId']).Append('|')
            [void]$sb.Append([string]$r['childExternalId']).Append('|')
            [void]$sb.Append([string]$r['identityExternalId']).Append('|')
            [void]$sb.Append([string]$r['userExternalId']).Append('|')
            # Context-member rows key on (contextExternalId, memberExternalId,
            # memberType) — without these every membership row hashes to the
            # same empty key and the whole batch collapses to one record.
            [void]$sb.Append([string]$r['contextExternalId']).Append('|')
            [void]$sb.Append([string]$r['memberExternalId']).Append('|')
            [void]$sb.Append([string]$r['memberType'])
            $k = $sb.ToString()
        }
        $seen[$k] = $r
    }
    if ($seen.Count -eq $Batch.Count) { return , $Batch }   # comma: keep the collection intact
    $out = [System.Collections.Generic.List[object]]::new($seen.Count)
    foreach ($v in $seen.Values) { [void]$out.Add($v) }
    Write-Host "    Deduped: $($Batch.Count) → $($out.Count)" -ForegroundColor DarkGray
    return , $out
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
    [CmdletBinding()]
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
        $toSend = if ($SkipDedup) { $batch } else { Get-CsvDedupedBatch -Batch $batch }
        if ($sysCount -gt 1) { Write-Host "    System $sid`: $($toSend.Count) records" -ForegroundColor DarkGray }
        Send-IngestBatch -Endpoint $Endpoint -SystemId $sid -SyncMode $SyncMode -Scope $Scope -Records $toSend -BatchSize $BatchSize
        $grouped[$sid] = $null  # release early — we already snapshotted the keys
        $toSend = $null
        $batch = $null
    }
    $grouped.Clear()
    [System.GC]::Collect()
}
