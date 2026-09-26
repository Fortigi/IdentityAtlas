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

# ─── Extra columns: resolve once per file, and say what happened ─
# The file's columns outside its schema, logged either as kept (they become
# extendedAttributes) or as ignored (the files that deliberately do not keep them
# — see CSVCrawler.Transform.ps1). Returns the kept ones; @() when there are none.
function Resolve-CsvExtraColumns {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]]$Columns, [string]$FileName)
    # @(): an empty result unrolls to $null through `return`, and `, $null` would
    # hand the caller a one-element array holding $null.
    $extra = [string[]]@(Get-CsvExtraColumns -Columns $Columns -FileName $FileName)
    if ($extra.Count) { Write-Host "  +$($extra.Count) extra attribute column(s) kept: $($extra -join ', ')" -ForegroundColor DarkGray }
    $ignored = @(Get-CsvIgnoredColumns -Columns $Columns -FileName $FileName)
    if ($ignored.Count) { Write-Host "  $($ignored.Count) column(s) outside the schema ignored ($FileName does not keep extra columns): $($ignored -join ', ')" -ForegroundColor Yellow }
    return , $extra
}

# The column names of a slow-path (Import-Csv) file, read from its first row.
function Get-CsvRowColumns {
    [CmdletBinding()]
    [OutputType([string[]])]
    param($Rows)
    return , [string[]]$Rows[0].PSObject.Properties.Name
}

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
    $extra = Resolve-CsvExtraColumns -Columns (Get-CsvRowColumns $systemsCsv) -FileName 'Systems.csv'
    $sysRecords = [System.Collections.Generic.List[object]]::new()
    $sysNames   = [System.Collections.Generic.List[string]]::new()
    foreach ($row in $systemsCsv) {
        if (-not $row.DisplayName -or $sysNames.Contains($row.DisplayName)) { continue }
        $rec = ConvertTo-CsvSystemRecord -Row $row -DefaultSystemType $SystemType -Extra $extra
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
    $names = Get-CsvRowColumns $contexts
    $cols = New-CsvColumnSet -Names $names
    $extra = Resolve-CsvExtraColumns -Columns $names -FileName 'Contexts.csv'
    $unknown = @{}
    $records = [System.Collections.Generic.List[object]]::new($contexts.Count)
    foreach ($r in $contexts) {
        $sid = Resolve-SystemId -Row $r -Unknown $unknown
        $rec = ConvertTo-CsvContextRecord -Row $r -SystemId $sid -Cols $cols -Extra $extra
        if ($rec) { [void]$records.Add($rec) }
    }
    Write-CsvUnknownSystems -FileName 'Contexts.csv' -Unknown $unknown
    Send-GroupedBySystem -Endpoint 'ingest/contexts' -Scope @{ variant = 'synced' } -Records $records
    [System.GC]::Collect()
}

# ─── Step 2b: ContextMembers.csv (optional) ──────────────────────
# Explicit (ContextExternalId, MemberExternalId, MemberType) rows. Only supplied
# when the source CSV has real membership data; otherwise memberships come from a
# later context-algorithm plugin run.
#
# Read through the fast parser a batch at a time and shaped as it goes, so only
# the records are ever held — not an Import-Csv object per row as well (at ~800k
# memberships that was the larger of two full copies).
#
# It is still ONE full sync, not a stream: ContextMembers has no systemId, so the
# timestamp reconcile refuses it, and a full sync of it removes the members of
# EVERY context the crawler's systems own. That is also why a SystemName column is
# ignored here: a member's system is its context's, and sending one full sync per
# system would have each one delete the others' memberships.
function Sync-CsvContextMembers {
    [CmdletBinding()]
    param()
    $f = Open-CsvFastReader -FileName 'ContextMembers.csv'
    if (-not $f) { return }
    $records = [System.Collections.Generic.List[object]]::new()
    try {
        if ($f.ColIdx.Count -eq 0) { return }
        $idx = Get-CsvContextMemberIndex -ColIdx $f.ColIdx -Columns $f.Columns
        while ($true) {
            $rows = Read-CsvDataRows -Parser $f.Parser -FileName 'ContextMembers.csv' -Max $script:CsvStreamBatchSize
            if ($rows.Count -eq 0) { break }
            $records.AddRange([object[]](ConvertTo-CsvContextMemberRecordSet -Rows $rows -Idx $idx -SystemId $fallbackSystemId))
        }
    } finally { $f.Parser.Dispose() }
    Write-Host "  ContextMembers.csv: $($records.Count) membership records" -ForegroundColor Gray
    if ($records.Count -eq 0) { return }
    Send-GroupedBySystem -Endpoint 'ingest/context-members' -Records $records
    [System.GC]::Collect()
}

# Column positions for ContextMembers.csv; throws when a required one is missing.
function Get-CsvContextMemberIndex {
    [CmdletBinding()]
    param([hashtable]$ColIdx, [string[]]$Columns)
    $missing = @('ContextExternalId', 'MemberExternalId', 'MemberType' | Where-Object { -not $ColIdx.ContainsKey($_) })
    if ($missing.Count) { throw "ContextMembers.csv schema mismatch: missing $($missing -join ', ')" }
    [void](Resolve-CsvExtraColumns -Columns $Columns -FileName 'ContextMembers.csv')
    return @{ Ctx = $ColIdx['ContextExternalId']; Mem = $ColIdx['MemberExternalId']; Type = $ColIdx['MemberType'] }
}

# ─── Step 3: Resources.csv (required, streamed) ──────────────────
# ~800k rows for the motivating export. Streamed exactly like Assignments (see
# Sync-CsvStreamedFile): it used to hold every parsed row AND every record at
# once. 'Business Role' is normalised to the canonical 'BusinessRole' resourceType.
function Sync-CsvResources {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 3: Resources..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 20
    $found = Sync-CsvStreamedFile -Spec @{
        FileName   = 'Resources.csv'
        Endpoint   = 'ingest/resources'
        Scope      = @{}
        KeyFields  = @('externalId')
        Prepare    = ${function:Get-CsvResourceIndex}
        ShapeSet   = ${function:ConvertTo-CsvResourceRecordSet}
        SkipReason = 'missing ExternalId or DisplayName'
    }
    if (-not $found) { Write-Host "  WARNING: Resources.csv not found (required)" -ForegroundColor Red }
}

# Column positions for Resources.csv; throws when a required one is missing.
function Get-CsvResourceIndex {
    [CmdletBinding()]
    param([hashtable]$ColIdx, [string[]]$Columns)
    if (-not $ColIdx.ContainsKey('ExternalId') -or -not $ColIdx.ContainsKey('DisplayName')) {
        throw "Resources.csv missing required columns ExternalId / DisplayName"
    }
    $extra = Resolve-CsvExtraColumns -Columns $Columns -FileName 'Resources.csv'
    return @{
        Ext      = $ColIdx['ExternalId']
        DN       = $ColIdx['DisplayName']
        RT       = Get-CsvColIndex $ColIdx 'ResourceType'
        Desc     = Get-CsvColIndex $ColIdx 'Description'
        En       = Get-CsvColIndex $ColIdx 'Enabled'
        Sys      = Get-CsvColIndex $ColIdx 'SystemName'
        Extra    = $extra
        ExtraIdx = Get-CsvColumnPositions -ColIdx $ColIdx -Names $extra
    }
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
    $names = Get-CsvRowColumns $rels
    $cols = New-CsvColumnSet -Names $names
    $extra = Resolve-CsvExtraColumns -Columns $names -FileName 'ResourceRelationships.csv'
    $unknown = @{}
    $records = [System.Collections.Generic.List[object]]::new($rels.Count)
    foreach ($r in $rels) {
        $sid = Resolve-SystemId -Row $r -Unknown $unknown
        $rec = ConvertTo-CsvRelationshipRecord -Row $r -SystemId $sid -Cols $cols -Extra $extra
        if ($rec) { [void]$records.Add($rec) }
    }
    Write-Host "  Built $($records.Count) relationship records" -ForegroundColor Gray
    Write-CsvUnknownSystems -FileName 'ResourceRelationships.csv' -Unknown $unknown
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
    $names = Get-CsvRowColumns $users
    $cols = New-CsvColumnSet -Names $names
    $extra = Resolve-CsvExtraColumns -Columns $names -FileName 'Users.csv'
    $unknown = @{}
    $records = [System.Collections.Generic.List[object]]::new($users.Count)
    foreach ($r in $users) {
        $sid = Resolve-SystemId -Row $r -Unknown $unknown
        $rec = ConvertTo-CsvUserRecord -Row $r -SystemId $sid -Cols $cols -Extra $extra
        if ($rec) { [void]$records.Add($rec) }
    }
    Write-Host "  Built $($records.Count) principal records" -ForegroundColor Gray
    Write-CsvUnknownSystems -FileName 'Users.csv' -Unknown $unknown
    Send-GroupedBySystem -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' } -Records $records
    [System.GC]::Collect()
}

# ─── Streamed files: Resources.csv and Assignments.csv ───────────
# Assignments is the only file that routinely runs to tens of millions of rows —
# an IdentityIQ entitlement-assignment extract is ~40M rows / 1.8 GB — and
# Resources to ~800k.
#
# Both used to be read whole: every parsed row in one list, then a second full
# list of records, before anything was sent. At 40M rows that is many gigabytes
# and the job dies before its first request. Sending was no better: past the batch
# size, Invoke-CrawlerIngestBatch switches to the chunked sync SESSION protocol,
# which pins one database connection for the whole upload and applies the entire
# payload in a single upsert at the end — a 30-minute ceiling that 40M rows cannot
# meet.
#
# So these stream: rows are read, shaped and buffered a batch at a time, and every
# batch goes out as an independent delta upsert that commits on its own. Memory
# stays flat at one batch per system whatever the file size. A full sync then
# reconciles by timestamp — the rows of this system and scope that this run did
# not touch — which is the same set the old scoped delete removed, without needing
# the whole key set inside one transaction. The mechanism is
# tools/crawlers/shared/Invoke-CrawlerIngestStream.ps1.
#
# Per-row work never costs a function call on the assignments path: rows are read
# (Read-CsvDataRows), shaped (ConvertTo-CsvStreamBatch) and buffered
# (Add-CrawlerIngestStreamRecords) one 10,000-row batch per call.
$script:CsvStreamBatchSize = 10000

# Stream one fast-path file into $Spec.Endpoint and reconcile every system it fed.
# $Spec: FileName, Endpoint, Scope, KeyFields, SkipReason, and two scriptblocks —
# Prepare (ColIdx, Columns → the column-position table, throwing when a required
# column is missing) and ShapeSet (rows of one system, Idx → @{ Records; Skipped }).
# Returns $false when the file does not exist.
function Sync-CsvStreamedFile {
    [CmdletBinding()]
    [OutputType([bool])]
    param([hashtable]$Spec)
    $f = Open-CsvFastReader -FileName $Spec.FileName
    if (-not $f) { return $false }
    $run = $null
    try {
        if ($f.ColIdx.Count -eq 0) { Write-Host "  $($Spec.FileName) is empty" -ForegroundColor Yellow; return $true }
        $run = New-CsvStreamRun -Spec $Spec -Idx (& $Spec.Prepare $f.ColIdx $f.Columns)
        while ($true) {
            $rows = Read-CsvDataRows -Parser $f.Parser -FileName $Spec.FileName -Max $script:CsvStreamBatchSize
            if ($rows.Count -eq 0) { break }
            Add-CsvStreamRows -Run $run -Rows $rows
        }
    }
    finally { $f.Parser.Dispose() }
    Complete-CsvStreamRun -Run $run
    return $true
}

# Start a run once the header is known-good. Only then is the API's own clock
# read — before the first row, so the reconcile keeps every row this run touches
# however long the upload takes.
function New-CsvStreamRun {
    [CmdletBinding()]
    param([hashtable]$Spec, [hashtable]$Idx)
    return [pscustomobject]@{
        Spec    = $Spec
        Idx     = $Idx
        Before  = Get-CrawlerServerTime
        Streams = @{}
        Unknown = @{}
        Rows    = 0
        Skipped = 0
    }
}

# Shape one batch of rows and hand each system's records to its stream, opening a
# stream the first time a system appears.
function Add-CsvStreamRows {
    [CmdletBinding()]
    param($Run, $Rows)
    $spec = $Run.Spec
    $shaped = ConvertTo-CsvStreamBatch -Rows $Rows -Idx $Run.Idx -SystemLookup $systemLookup -FallbackSystemId $fallbackSystemId `
        -ShapeSet $spec.ShapeSet -Unknown $Run.Unknown
    foreach ($sid in $shaped.BySystem.Keys) {
        $stream = $Run.Streams[$sid]
        if (-not $stream) {
            $stream = New-CrawlerIngestStream -Endpoint $spec.Endpoint -SystemId $sid -IdPrefix $SystemType `
                -Scope $spec.Scope -BatchSize $script:CsvStreamBatchSize -KeyFields $spec.KeyFields
            $Run.Streams[$sid] = $stream
        }
        Add-CrawlerIngestStreamRecords -Stream $stream -Records $shaped.BySystem[$sid]
    }
    $before = [Math]::Floor($Run.Rows / 250000)
    $Run.Rows += $Rows.Count
    $Run.Skipped += $shaped.Skipped
    if ([Math]::Floor($Run.Rows / 250000) -gt $before) {
        Write-Host "    $($Run.Rows.ToString('N0')) rows streamed..." -ForegroundColor DarkGray
        Update-CrawlerProgress -Detail "$($spec.FileName): $($Run.Rows.ToString('N0')) rows"
    }
}

# Flush every stream, then — for a full sync — drop the rows the file no longer
# contains. The reconcile is skipped when the run read no rows (or never started),
# and only a system that received records has a stream, so an empty or unreadable
# file can never wipe a system: the same fail-safe the scoped delete had.
function Complete-CsvStreamRun {
    [CmdletBinding()]
    param($Run)
    if (-not $Run) { return }
    $spec = $Run.Spec
    $sent = 0
    foreach ($s in $Run.Streams.Values) { $sent += (Complete-CrawlerIngestStream -Stream $s).sent }
    $skippedNote = if ($Run.Skipped) { ", $($Run.Skipped.ToString('N0')) skipped ($($spec.SkipReason))" } else { '' }
    Write-Host "  $($Run.Rows.ToString('N0')) rows read, $($sent.ToString('N0')) sent$skippedNote" -ForegroundColor Gray
    Write-CsvUnknownSystems -FileName $spec.FileName -Unknown $Run.Unknown
    if ($Run.Rows -gt 0) {
        foreach ($sid in @($Run.Streams.Keys)) {
            Invoke-CrawlerReconcile -Endpoint $spec.Endpoint -SystemId $sid -Scope $spec.Scope -Before $Run.Before | Out-Null
        }
    }
    $Run.Streams.Clear()
    [System.GC]::Collect()
}

# Warn — with the total and the names — when rows named a SystemName that
# Systems.csv did not declare and so went into the fallback system. A blank
# SystemName is the documented single-system case and is never counted.
function Write-CsvUnknownSystems {
    [CmdletBinding()]
    param([string]$FileName, [hashtable]$Unknown)
    if (-not $Unknown -or $Unknown.Count -eq 0) { return }
    $total = ($Unknown.Values | Measure-Object -Sum).Sum
    $top = $Unknown.GetEnumerator() | Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, Name | Select-Object -First 10
    $names = ($top | ForEach-Object { "$($_.Name) ($($_.Value))" }) -join ', '
    $more = if ($Unknown.Count -gt 10) { ", and $($Unknown.Count - 10) more" } else { '' }
    Write-Host "  WARNING: $total row(s) in $FileName name a SystemName that Systems.csv does not declare, and were loaded into the fallback system '$SystemName' instead: $names$more" -ForegroundColor Yellow
}

# ─── Step 6: Assignments.csv (required, streamed) ────────────────
# The dedup key is the ingest conflict key minus `governed` (never set by a CSV):
# a pair held both Direct and Eligible is two assignments, not a duplicate.
function Sync-CsvAssignments {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 6: Assignments..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 55
    $found = Sync-CsvStreamedFile -Spec @{
        FileName   = 'Assignments.csv'
        Endpoint   = 'ingest/resource-assignments'
        Scope      = @{ assignmentType = 'Direct' }
        KeyFields  = @('resourceExternalId', 'principalExternalId', 'assignmentType')
        Prepare    = ${function:Get-CsvAssignmentIndex}
        ShapeSet   = ${function:ConvertTo-CsvAssignmentRecordSet}
        SkipReason = 'missing resource or user id'
    }
    if (-not $found) { Write-Host "  WARNING: Assignments.csv not found (required)" -ForegroundColor Red }
}

# Column positions for Assignments.csv; throws when a required one is missing.
function Get-CsvAssignmentIndex {
    [CmdletBinding()]
    param([hashtable]$ColIdx, [string[]]$Columns)
    if (-not $ColIdx.ContainsKey('ResourceExternalId') -or -not $ColIdx.ContainsKey('UserExternalId')) {
        throw "Assignments.csv missing required columns ResourceExternalId / UserExternalId"
    }
    [void](Resolve-CsvExtraColumns -Columns $Columns -FileName 'Assignments.csv')
    return @{
        Res  = $ColIdx['ResourceExternalId']
        User = $ColIdx['UserExternalId']
        Type = Get-CsvColIndex $ColIdx 'AssignmentType'
        Sys  = Get-CsvColIndex $ColIdx 'SystemName'
    }
}

# ─── Step 7: Identities.csv (optional) ───────────────────────────
function Sync-CsvIdentities {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 7: Identities..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing identities' -Pct 65
    $identities = Read-CsvFile 'Identities.csv'
    if (-not $identities) { return }
    Assert-Columns 'Identities.csv' $identities @('ExternalId', 'DisplayName')
    $names = Get-CsvRowColumns $identities
    $cols = New-CsvColumnSet -Names $names
    $extra = Resolve-CsvExtraColumns -Columns $names -FileName 'Identities.csv'
    $unknown = @{}
    $records = [System.Collections.Generic.List[object]]::new($identities.Count)
    foreach ($r in $identities) {
        $sid = Resolve-SystemId -Row $r -Unknown $unknown
        $rec = ConvertTo-CsvIdentityRecord -Row $r -SystemId $sid -Cols $cols -Extra $extra
        if ($rec) { [void]$records.Add($rec) }
    }
    Write-CsvUnknownSystems -FileName 'Identities.csv' -Unknown $unknown
    Send-GroupedBySystem -Endpoint 'ingest/identities' -Records $records
    [System.GC]::Collect()
}

# ─── Step 8: IdentityMembers.csv (optional) ──────────────────────
function Sync-CsvIdentityMembers {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 8: Identity members..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing identity members' -Pct 72
    $idMembers = Read-CsvFile 'IdentityMembers.csv'
    if (-not $idMembers) { return }
    Assert-Columns 'IdentityMembers.csv' $idMembers @('IdentityExternalId', 'UserExternalId')
    $names = Get-CsvRowColumns $idMembers
    $cols = New-CsvColumnSet -Names $names
    [void](Resolve-CsvExtraColumns -Columns $names -FileName 'IdentityMembers.csv')
    $unknown = @{}
    $records = [System.Collections.Generic.List[object]]::new($idMembers.Count)
    foreach ($r in $idMembers) {
        $sid = Resolve-SystemId -Row $r -Unknown $unknown
        $rec = ConvertTo-CsvIdentityMemberRecord -Row $r -SystemId $sid -Cols $cols
        if ($rec) { [void]$records.Add($rec) }
    }
    Write-CsvUnknownSystems -FileName 'IdentityMembers.csv' -Unknown $unknown
    Send-GroupedBySystem -Endpoint 'ingest/identity-members' -Records $records
    [System.GC]::Collect()
}

# ─── Step 9: Certifications.csv (optional, fast path) ────────────
function Sync-CsvCertifications {
    [CmdletBinding()]
    param()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 9: Certifications..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing certifications' -Pct 78
    $fast = Read-CsvFast 'Certifications.csv'
    if (-not $fast) { return }
    $rows = $fast.rows; $colIdx = $fast.colIdx
    if (-not $colIdx.ContainsKey('ExternalId')) {
        throw "Certifications.csv missing required column ExternalId"
    }
    $extra = Resolve-CsvExtraColumns -Columns $fast.columns -FileName 'Certifications.csv'
    $idx = @{
        Ext      = $colIdx['ExternalId']
        Res      = Get-CsvColIndex $colIdx 'ResourceExternalId'
        UDN      = Get-CsvColIndex $colIdx 'UserDisplayName'
        Dec      = Get-CsvColIndex $colIdx 'Decision'
        RDN      = Get-CsvColIndex $colIdx 'ReviewerDisplayName'
        RDT      = Get-CsvColIndex $colIdx 'ReviewedDateTime'
        Extra    = $extra
        ExtraIdx = Get-CsvColumnPositions -ColIdx $colIdx -Names $extra
    }
    $idxSys = Get-CsvColIndex $colIdx 'SystemName'
    $unknown = @{}
    $records = [System.Collections.Generic.List[object]]::new($rows.Count)
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $sid = if ($idxSys -ge 0) { Resolve-SystemId -Name $r[$idxSys] -Unknown $unknown } else { $fallbackSystemId }
        $rec = ConvertTo-CsvCertificationRecord -Row $r -Idx $idx -SystemId $sid
        if ($rec) { [void]$records.Add($rec) }
    }
    $fast = $null; $rows = $null; [System.GC]::Collect()
    Write-Host "  Built $($records.Count) certification records" -ForegroundColor Gray
    Write-CsvUnknownSystems -FileName 'Certifications.csv' -Unknown $unknown
    Send-GroupedBySystem -Endpoint 'ingest/governance/certifications' -Records $records -BatchSize 3000
    $records = $null; [System.GC]::Collect()
}

# ─── Setup: resolve the job config into crawler settings ─────────
function Resolve-CsvConfig {
    [CmdletBinding()]
    param([string]$ConfigPath)
    $raw = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
    return @{
        csvFolder  = if ($raw['csvFolder'])  { $raw['csvFolder'] }  else { '/data/csv' }
        systemName = if ($raw['systemName']) { $raw['systemName'] } else { 'CSV Import' }
        systemType = if ($raw['systemType']) { $raw['systemType'] } else { 'CSV' }
        delimiter  = if ($raw['delimiter'])  { $raw['delimiter'] }  else { ';' }
    }
}

# ─── Setup: verify the key + register the fallback system ────────
# All rows without a SystemName column are scoped to this fallback system.
# Reads $ApiBaseUrl / $ApiKey / $SystemName / $SystemType from scope; returns its id.
function Register-CsvFallbackSystem {
    [CmdletBinding()]
    param()
    $headers = @{ 'Authorization' = "Bearer $ApiKey" }
    $whoami = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers $headers
    Write-Host "Connected as: $($whoami.displayName)" -ForegroundColor Green
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Registering fallback system ($SystemName)..." -ForegroundColor Cyan
    $sysResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'delta'; records = @(@{ systemType = $SystemType; displayName = $SystemName; enabled = $true; syncEnabled = $true })
    }
    $id = if ($sysResult.systemIds) { [int]$sysResult.systemIds[0] } elseif ($sysResult.systemId) { [int]$sysResult.systemId } else { 0 }
    # Every full-sync reconcile below is scoped to this id. Guessing one would point
    # those deletes at whichever system happens to own it. (SEC-2026-09 M-11)
    if ($id -le 0) { throw "Could not resolve the CSV fallback system id after registration" }
    Write-Host "  Fallback system: ID $id" -ForegroundColor Gray
    return $id
}

# ─── Finalize: classify, refresh, and log the sync ──────────────
# BusinessRole auto-classification + matrix view refresh (both non-critical) and
# the sync-log entry. Context generation moved to context-algorithm plugin runs.
function Complete-CsvRun {
    [CmdletBinding()]
    param([datetime]$SyncStart, [bool]$RefreshViews = $true)
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Auto-classifying BusinessRole assignments..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Classifying assignments' -Pct 85
    try {
        Invoke-IngestAPI -Endpoint 'ingest/classify-business-role-assignments' -Body @{} | Out-Null
        Write-Host "  Done" -ForegroundColor Green
    } catch { Write-Host "  (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow }
    if ($RefreshViews) {
        Update-CrawlerProgress -Step 'Refreshing views' -Pct 88
        try { Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null; Write-Host "  Views refreshed" -ForegroundColor Green } catch { }
    }
    $elapsed = (Get-Date) - $SyncStart
    Write-Host "`n=== CSV Sync Complete ===" -ForegroundColor Green
    Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds))s" -ForegroundColor Gray
    try { Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{ syncType = 'CSV-FullCrawl'; startTime = $SyncStart.ToString('o'); endTime = (Get-Date).ToString('o'); status = 'Success' } | Out-Null } catch { }
}
