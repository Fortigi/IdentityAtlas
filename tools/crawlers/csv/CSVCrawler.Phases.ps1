<#
.SYNOPSIS
    Per-file sync phases for the CSV crawler, extracted from Start-CSVCrawler.ps1.

.DESCRIPTION
    One Sync-Csv* function per canonical CSV file. Each reads its file (via the
    Read-CsvFile / Read-CsvFast helpers), validates required columns, shapes rows
    into ingest records via the pure ConvertTo-Csv*Record functions in
    CSVCrawler.Transform.ps1, and sends them through Send-GroupedBySystem.

    Like CSVCrawler.Functions.ps1, these are dot-sourced into the entry point's
    scope and read the crawler's script-scope state at call time:
      $CsvFolder, $Delimiter  → used by the Read-Csv* helpers
      $SystemType             → deterministic idPrefix + Systems default type
      $fallbackSystemId       → default systemId when a row has no SystemName
      $systemLookup           → SystemName → systemId map (mutated by Sync-CsvSystems)

    Moving each phase into its own function keeps the entry-point body's cyclomatic
    complexity small and makes every phase independently unit-testable (mock the
    Read-Csv* / Send-GroupedBySystem boundary). Behaviour is unchanged from the
    original inline blocks.
#>

# ─── Step 1: Systems.csv (optional) ──────────────────────────────
# Registers each row as a System (delta upsert) and extends $systemLookup with the
# returned ids so later phases can scope SystemName-tagged rows to the right system.
function Sync-CsvSystems {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 1: Systems..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Processing systems' -Pct 8
    $systemsCsv = Read-CsvFile 'Systems.csv'
    if (-not $systemsCsv) { return }
    Assert-Columns 'Systems.csv' $systemsCsv @('ExternalId', 'DisplayName')
    $sysRecords = [System.Collections.Generic.List[object]]::new()
    $sysNames   = [System.Collections.Generic.List[string]]::new()
    foreach ($row in $systemsCsv) {
        if (-not $row.DisplayName -or $sysNames.Contains($row.DisplayName)) { continue }
        $rec = ConvertTo-CsvSystemRecord -Row $row -DefaultSystemType $SystemType
        if (-not $rec) { continue }
        $sysNames.Add($row.DisplayName)
        [void]$sysRecords.Add($rec)
    }
    if ($sysRecords.Count -gt 0) {
        $r = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{ syncMode = 'delta'; records = $sysRecords }
        if ($r.systemIds) {
            for ($i = 0; $i -lt [Math]::Min($sysNames.Count, $r.systemIds.Count); $i++) { $systemLookup[$sysNames[$i]] = [int]$r.systemIds[$i] }
        }
    }
    Write-Host "  $($systemLookup.Count) system(s) in lookup" -ForegroundColor Gray
}

# ─── Step 2: Contexts.csv (optional) ─────────────────────────────
# v6 context model: every row is a variant='synced' context with an explicit
# targetType (default Identity) and contextType (default OrgUnit). See
# docs/architecture/context-redesign.md.
function Sync-CsvContexts {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 2: Contexts..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing contexts' -Pct 12
    $contexts = Read-CsvFile 'Contexts.csv'
    if (-not $contexts) { return }
    Assert-Columns 'Contexts.csv' $contexts @('ExternalId', 'DisplayName')
    $cols = [System.Collections.Generic.HashSet[string]]::new([string[]]$contexts[0].PSObject.Properties.Name)
    $hSys = $cols.Contains('SystemName')
    $records = [System.Collections.Generic.List[object]]::new($contexts.Count)
    foreach ($r in $contexts) {
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        $rec = ConvertTo-CsvContextRecord -Row $r -SystemId $sid -Cols $cols
        if ($rec) { [void]$records.Add($rec) }
    }
    Send-GroupedBySystem -Endpoint 'ingest/contexts' -Scope @{ variant = 'synced' } -Records $records
    [System.GC]::Collect()
}

# ─── Step 2b: ContextMembers.csv (optional) ──────────────────────
# Explicit (ContextExternalId, MemberExternalId, MemberType) rows. Only supplied
# when the source CSV has real membership data; otherwise memberships come from a
# later context-algorithm plugin run.
function Sync-CsvContextMembers {
    [CmdletBinding()]
    param()
    $cmembers = Read-CsvFile 'ContextMembers.csv'
    if (-not $cmembers) { return }
    Assert-Columns 'ContextMembers.csv' $cmembers @('ContextExternalId', 'MemberExternalId', 'MemberType')
    $records = [System.Collections.Generic.List[object]]::new($cmembers.Count)
    foreach ($r in $cmembers) {
        $rec = ConvertTo-CsvContextMemberRecord -Row $r -SystemId $fallbackSystemId
        if ($rec) { [void]$records.Add($rec) }
    }
    Send-GroupedBySystem -Endpoint 'ingest/context-members' -Records $records
    [System.GC]::Collect()
}
