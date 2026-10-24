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

# Thin adapter over the shared Invoke-CrawlerIngestBatch (tools/crawlers/shared/
# Invoke-CrawlerIngest.ps1). CSV uses deterministic ids (idPrefix becomes
# "<SystemType>-<entity>", matching normalization.js's idGeneration contract), a
# 10000 batch size, and skips empty batches. The original returned nothing, so
# the shared result is swallowed here.
function Send-IngestBatch {
    [CmdletBinding()]
    param([string]$Endpoint, [int]$SystemId, [string]$SyncMode = 'full', [hashtable]$Scope = @{}, $Records, [int]$BatchSize = 10000)
    Invoke-CrawlerIngestBatch -Endpoint $Endpoint -SystemId $SystemId -SyncMode $SyncMode -Scope $Scope `
        -Records $Records -BatchSize $BatchSize -IdGeneration 'deterministic' -IdPrefix $SystemType -SkipWhenEmpty | Out-Null
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

# ─── Fast-path reader ────────────────────────────────────────────
# Streams rows as string[] instead of PSCustomObjects: 5-10× faster than
# Import-Csv past ~100k rows, and the only reader that can walk a multi-GB file
# (Assignments.csv) without holding it.
#
# Parsing is .NET's own RFC 4180 parser (Microsoft.VisualBasic.FileIO.
# TextFieldParser, part of the runtime — no module to install). It used to be a
# line Split with the surrounding quotes stripped per cell, which tore a quoted
# field containing the delimiter in two and shifted every later column by one —
# silently, on exactly the values an identity export is full of: LDAP
# distinguished names ("CN=x,OU=y,DC=z") in a comma-delimited file.
#
# Measured on this workstation: 500k unquoted rows parse in 3.5 s, the same as the
# old Split; 100k rows each holding a quoted DN in 1.1 s, where a quote-aware
# parser written in PowerShell took 257 s. Malformed input — a quote that never
# closes, text after a closing quote — throws with its line number, so the job
# fails instead of loading shifted rows, and a failed run never reconciles.
Add-Type -AssemblyName Microsoft.VisualBasic

# A TextFieldParser over $Path for $Delimiter. Whitespace is data, not padding.
# The StreamReader drops a UTF-8 byte order mark.
function New-CsvFieldParser {
    [CmdletBinding()]
    param([string]$Path, [string]$Delimiter)
    $reader = [System.IO.StreamReader]::new($Path, [System.Text.Encoding]::UTF8, $true)
    $parser = [Microsoft.VisualBasic.FileIO.TextFieldParser]::new($reader)
    $parser.TextFieldType = [Microsoft.VisualBasic.FileIO.FieldType]::Delimited
    $parser.SetDelimiters([string[]]@([string]$Delimiter[0]))
    $parser.HasFieldsEnclosedInQuotes = $true
    $parser.TrimWhiteSpace = $false
    return $parser
}

# Read up to $Max data rows as an object[] of string[]. Called once per file by
# Read-CsvFast, and once per batch by the streamed phases. Blank lines are
# skipped by the parser. Rows are collected as the loop's output rather than
# Add()-ed: in PowerShell a .NET method call like List.Add costs ~10 µs, an
# operator well under one — at 40M rows that is minutes.
function Read-CsvDataRows {
    [CmdletBinding()]
    param($Parser, [string]$FileName, [int]$Max = [int]::MaxValue)
    $n = 0
    try {
        $rows = @(while ($n -lt $Max -and -not $Parser.EndOfData) {
            $n++
            , $Parser.ReadFields()   # comma: emit the row as ONE item, not its cells
        })
    }
    catch {
        $bad = $_.Exception.InnerException
        if ($bad -isnot [Microsoft.VisualBasic.FileIO.MalformedLineException]) { throw }
        $line = [string]$Parser.ErrorLine
        throw "$FileName line $($Parser.ErrorLineNumber) is not valid CSV — a quote that is never closed, or text after a closing quote. Nothing after it was loaded. The line starts: $($line.Substring(0, [Math]::Min(120, $line.Length)))"
    }
    return , $rows   # comma: return the array intact, do not unroll it into the pipeline
}

# Open a CSV for the fast path and read its header. $null when the file does not
# exist; otherwise @{ Parser; ColIdx; Columns }, where ColIdx is empty for a file
# with no header line. The CALLER owns the Parser and must Dispose it. Header
# names are trimmed (and a stray byte order mark removed), matching the wizard's
# upload-time check.
function Open-CsvFastReader {
    [CmdletBinding()]
    param([string]$FileName)
    $path = Join-Path $CsvFolder $FileName
    if (-not (Test-Path $path)) { return $null }
    $parser = New-CsvFieldParser -Path $path -Delimiter $Delimiter
    $colIdx = @{}
    $columns = [string[]]@()
    $header = if ($parser.EndOfData) { $null } else { (Read-CsvDataRows -Parser $parser -FileName $FileName -Max 1)[0] }
    if ($header) {
        $columns = [string[]]@($header | ForEach-Object { $_.Trim().TrimStart([char]0xFEFF) })
        for ($i = 0; $i -lt $columns.Length; $i++) { $colIdx[$columns[$i]] = $i }
    }
    return @{ Parser = $parser; ColIdx = $colIdx; Columns = $columns }
}

function Read-CsvFast {
    [CmdletBinding()]
    param([string]$FileName)
    $f = Open-CsvFastReader -FileName $FileName
    if (-not $f) { return $null }
    try {
        if ($f.ColIdx.Count -eq 0) { return $null }
        $rows = Read-CsvDataRows -Parser $f.Parser -FileName $FileName
    } finally { $f.Parser.Dispose() }
    Write-Host "  $FileName`: $($rows.Count) rows (fast path)" -ForegroundColor Gray
    return @{ rows = $rows; colIdx = $f.ColIdx; columns = $f.Columns }
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

# Helper: resolve a row's SystemName → systemId. Pass -Name for a fast-path row
# (a string[] has no SystemName property); a slow-path row is read by property,
# and a row without the column (or a short row, where it is $null) falls back.
#
# A NAMED system that the lookup does not know also falls back — but is counted in
# -Unknown (name → rows), so the phase can say so. Loading rows into the fallback
# system without a word is how an import reported success while most of its data
# quietly went somewhere else. A blank name is the documented single-system case
# and is not counted.
function Resolve-SystemId {
    [CmdletBinding()]
    param($Row, [hashtable]$Unknown, [string]$Name)
    if (-not $PSBoundParameters.ContainsKey('Name')) { $Name = $Row.SystemName }
    if (-not $Name) { return $fallbackSystemId }
    $sid = $systemLookup[$Name]
    if ($null -ne $sid) { return $sid }
    if ($null -ne $Unknown) { $Unknown[$Name] = 1 + [int]$Unknown[$Name] }
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
