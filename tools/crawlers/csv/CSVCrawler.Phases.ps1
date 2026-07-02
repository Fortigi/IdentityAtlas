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

# ─── Step 3: Resources.csv (required, fast path) ─────────────────
# The streaming reader (Read-CsvFast) is used because Resources can be large.
# 'Business Role' is normalised to the canonical 'BusinessRole' resourceType.
function Sync-CsvResources {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 3: Resources..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 20
    $fast = Read-CsvFast 'Resources.csv'
    if (-not $fast) { Write-Host "  WARNING: Resources.csv not found (required)" -ForegroundColor Red; return }
    $rows = $fast.rows; $colIdx = $fast.colIdx
    if (-not $colIdx.ContainsKey('ExternalId') -or -not $colIdx.ContainsKey('DisplayName')) {
        throw "Resources.csv missing required columns ExternalId / DisplayName"
    }
    $idx = @{
        Ext  = $colIdx['ExternalId']
        DN   = $colIdx['DisplayName']
        RT   = if ($colIdx.ContainsKey('ResourceType')) { $colIdx['ResourceType'] } else { -1 }
        Desc = if ($colIdx.ContainsKey('Description'))   { $colIdx['Description'] }   else { -1 }
        En   = if ($colIdx.ContainsKey('Enabled'))       { $colIdx['Enabled'] }       else { -1 }
    }
    $idxSys = if ($colIdx.ContainsKey('SystemName')) { $colIdx['SystemName'] } else { -1 }
    $records = [System.Collections.Generic.List[object]]::new($rows.Count)
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $sid = $fallbackSystemId
        if ($idxSys -ge 0) { $sn = $r[$idxSys]; if ($sn -and $systemLookup.ContainsKey($sn)) { $sid = $systemLookup[$sn] } }
        $rec = ConvertTo-CsvResourceRecord -Row $r -Idx $idx -SystemId $sid
        if ($rec) { [void]$records.Add($rec) }
    }
    $fast = $null; $rows = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) resource records" -ForegroundColor Gray
    Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records
    $records = $null; [System.GC]::Collect()
}

# ─── Step 4: ResourceRelationships.csv (optional) ────────────────
function Sync-CsvRelationships {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 4: Resource relationships..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing relationships' -Pct 32
    $rels = Read-CsvFile 'ResourceRelationships.csv'
    if (-not $rels) { return }
    Assert-Columns 'ResourceRelationships.csv' $rels @('ParentExternalId', 'ChildExternalId')
    $cols = [System.Collections.Generic.HashSet[string]]::new([string[]]$rels[0].PSObject.Properties.Name)
    $hSys = $cols.Contains('SystemName')
    $records = [System.Collections.Generic.List[object]]::new($rels.Count)
    foreach ($r in $rels) {
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        $rec = ConvertTo-CsvRelationshipRecord -Row $r -SystemId $sid -Cols $cols
        if ($rec) { [void]$records.Add($rec) }
    }
    Write-Host "  Built $($records.Count) relationship records" -ForegroundColor Gray
    Send-GroupedBySystem -Endpoint 'ingest/resource-relationships' -Scope @{ relationshipType = 'Contains' } -Records $records
    [System.GC]::Collect()
}

# ─── Step 5: Users.csv (required) ────────────────────────────────
function Sync-CsvUsers {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 5: Users..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing users' -Pct 42
    $users = Read-CsvFile 'Users.csv'
    if (-not $users) { Write-Host "  WARNING: Users.csv not found (required)" -ForegroundColor Red; return }
    Assert-Columns 'Users.csv' $users @('ExternalId', 'DisplayName')
    $cols = [System.Collections.Generic.HashSet[string]]::new([string[]]$users[0].PSObject.Properties.Name)
    $hSys = $cols.Contains('SystemName')
    $records = [System.Collections.Generic.List[object]]::new($users.Count)
    foreach ($r in $users) {
        $sid = if ($hSys -and $r.SystemName -and $systemLookup.ContainsKey($r.SystemName)) { $systemLookup[$r.SystemName] } else { $fallbackSystemId }
        $rec = ConvertTo-CsvUserRecord -Row $r -SystemId $sid -Cols $cols
        if ($rec) { [void]$records.Add($rec) }
    }
    Write-Host "  Built $($records.Count) principal records" -ForegroundColor Gray
    Send-GroupedBySystem -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' } -Records $records
    [System.GC]::Collect()
}

# ─── Step 6: Assignments.csv (required, fast path) ───────────────
# The hot path — streaming reader; the canonical schema trusts the caller to have
# deduped upstream, but Send-GroupedBySystem still dedups defensively.
function Sync-CsvAssignments {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 6: Assignments..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 55
    $fast = Read-CsvFast 'Assignments.csv'
    if (-not $fast) { Write-Host "  WARNING: Assignments.csv not found (required)" -ForegroundColor Red; return }
    $rows = $fast.rows; $colIdx = $fast.colIdx
    if (-not $colIdx.ContainsKey('ResourceExternalId') -or -not $colIdx.ContainsKey('UserExternalId')) {
        throw "Assignments.csv missing required columns ResourceExternalId / UserExternalId"
    }
    $idx = @{
        Res  = $colIdx['ResourceExternalId']
        User = $colIdx['UserExternalId']
        Type = if ($colIdx.ContainsKey('AssignmentType')) { $colIdx['AssignmentType'] } else { -1 }
    }
    $idxSys = if ($colIdx.ContainsKey('SystemName')) { $colIdx['SystemName'] } else { -1 }
    $records = [System.Collections.Generic.List[object]]::new($rows.Count)
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $sid = $fallbackSystemId
        if ($idxSys -ge 0) { $sn = $r[$idxSys]; if ($sn -and $systemLookup.ContainsKey($sn)) { $sid = $systemLookup[$sn] } }
        $rec = ConvertTo-CsvAssignmentRecord -Row $r -Idx $idx -SystemId $sid
        if ($rec) { [void]$records.Add($rec) }
    }
    $fast = $null; $rows = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) assignment records" -ForegroundColor Gray
    Send-GroupedBySystem -Endpoint 'ingest/resource-assignments' -Scope @{ assignmentType = 'Direct' } -Records $records
    $records = $null; [System.GC]::Collect()
}
