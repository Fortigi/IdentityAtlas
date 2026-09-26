<#
.SYNOPSIS
    Pure record-shapers for the CSV crawler — one source row → one ingest record.

.DESCRIPTION
    Each ConvertTo-Csv*Record function maps a single parsed CSV row onto the
    Identity Atlas ingest schema for one entity. They are PURE: every input is an
    explicit parameter (the row, the resolved systemId, the set of present column
    names, or resolved column indices for the fast path), they do no I/O and read
    no script scope, and they `return` the record hashtable (or `$null` to signal
    "skip this row"). That makes them unit-testable against in-memory fixtures with
    zero mocks — the cheapest coverage in the crawler.

    Two row shapes are handled:
      • slow path (Read-CsvFile / Import-Csv) → $Row is a PSCustomObject; column
        presence is passed as a HashSet[string] $Cols.
      • fast path (Read-CsvFast) → $Row is a string[]; the caller passes the
        pre-resolved column indices (an index of -1 means "column absent").

    Orchestration that isn't per-row (dedup, systemId lookup, batching, sending)
    stays in CSVCrawler.Phases.ps1.
#>

# The $Cols set the slow-path shapers test for column presence. Case-INsensitive,
# like the Import-Csv row access that reads the values: with an ordinal set a
# "department" header read as absent (so the value was dropped) while the
# case-insensitive reserved-column check kept it out of the extras too — lost
# both ways.
function New-CsvColumnSet {
    [CmdletBinding()]
    param([string[]]$Names)
    return , [System.Collections.Generic.HashSet[string]]::new([string[]]@($Names), [System.StringComparer]::OrdinalIgnoreCase)
}

# ─── Systems.csv ─────────────────────────────────────────────────
function ConvertTo-CsvSystemRecord {
    [CmdletBinding()]
    param($Row, [string]$DefaultSystemType, [string[]]$Extra = @())
    if (-not $Row.DisplayName) { return $null }
    $props = $Row.PSObject.Properties.Name
    $rec = @{
        externalId  = $Row.ExternalId
        displayName = $Row.DisplayName
        enabled     = $true
        syncEnabled = $true
        systemType  = if ($props -contains 'SystemType' -and $Row.SystemType) { $Row.SystemType } else { $DefaultSystemType }
        description = if ($props -contains 'Description') { $Row.Description } else { $null }
    }
    Add-CsvExtendedAttributes -Row $Row -Extra $Extra -Record $rec
    return $rec
}

# ─── Contexts.csv ────────────────────────────────────────────────
function ConvertTo-CsvContextRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols, [string[]]$Extra = @())
    if (-not $Row.ExternalId) { return $null }
    $rec = @{
        _systemId        = $SystemId
        externalId       = $Row.ExternalId
        displayName      = $Row.DisplayName
        variant          = 'synced'
        targetType       = if ($Cols.Contains('TargetType') -and $Row.TargetType) { $Row.TargetType } else { 'Identity' }
        contextType      = if ($Cols.Contains('ContextType') -and $Row.ContextType) { $Row.ContextType } else { 'OrgUnit' }
        scopeSystemId    = $SystemId
        description      = if ($Cols.Contains('Description')) { $Row.Description } else { $null }
        parentExternalId = if ($Cols.Contains('ParentExternalId')) { $Row.ParentExternalId } else { $null }
        ownerUserId      = if ($Cols.Contains('OwnerUserId')) { $Row.OwnerUserId } else { $null }
    }
    Add-CsvExtendedAttributes -Row $Row -Extra $Extra -Record $rec
    return $rec
}

# ─── ContextMembers.csv ──────────────────────────────────────────
# Fast path: $Rows are string[]; $Idx: Ctx, Mem, Type (column positions). One call
# per batch — the file runs to ~800k rows when a context stands for a logical
# application with one membership row per entitlement.
function ConvertTo-CsvContextMemberRecordSet {
    [CmdletBinding()]
    param($Rows, [hashtable]$Idx, [int]$SystemId)
    $iCtx = $Idx.Ctx; $iMem = $Idx.Mem; $iType = $Idx.Type
    return , @(foreach ($cells in $Rows) {
        $ctx = $cells[$iCtx]; $mem = $cells[$iMem]
        if (-not $ctx -or -not $mem) { continue }
        @{ _systemId = $SystemId; contextExternalId = $ctx; memberExternalId = $mem; memberType = $cells[$iType]; addedBy = 'sync' }
    })
}

# ─── Resources.csv (fast path) ───────────────────────────────────
# $Row is a string[]; $Idx maps the logical columns to their position (or -1 when
# the column is absent): Ext, DN, RT (ResourceType), Desc, En (Enabled), plus the
# optional Extra / ExtraIdx pair (names, and their positions from Get-CsvColumnPositions).
function ConvertTo-CsvResourceRecord {
    [CmdletBinding()]
    param([string[]]$Row, [hashtable]$Idx, [int]$SystemId)
    $ext = $Row[$Idx.Ext]; $dn = $Row[$Idx.DN]
    if (-not $ext -or -not $dn) { return $null }
    $type = if ($Idx.RT -ge 0) { $Row[$Idx.RT] } else { $null }
    if ($type -eq 'Business Role') { $type = 'BusinessRole' }
    $on = $true
    if ($Idx.En -ge 0 -and $Row[$Idx.En] -in @('false', 'False', '0')) { $on = $false }
    $rec = @{
        _systemId    = $SystemId
        externalId   = $ext
        displayName  = $dn
        resourceType = $type
        enabled      = $on
        description  = if ($Idx.Desc -ge 0) { $Row[$Idx.Desc] } else { $null }
    }
    Add-CsvExtendedAttributes -Row $Row -Extra $Idx.Extra -ExtraIndex $Idx.ExtraIdx -Record $rec
    return $rec
}

# ─── ResourceRelationships.csv ───────────────────────────────────
function ConvertTo-CsvRelationshipRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols, [string[]]$Extra = @())
    if (-not $Row.ParentExternalId -or -not $Row.ChildExternalId) { return $null }
    $rec = @{
        _systemId        = $SystemId
        parentExternalId = $Row.ParentExternalId
        childExternalId  = $Row.ChildExternalId
        relationshipType = if ($Cols.Contains('RelationshipType') -and $Row.RelationshipType) { $Row.RelationshipType } else { 'Contains' }
    }
    Add-CsvExtendedAttributes -Row $Row -Extra $Extra -Record $rec
    return $rec
}

# ─── Extra columns → extendedAttributes ──────────────────────────
# Every file whose target table carries extendedAttributes keeps the columns
# outside its schema: the ingest API files any field it does not recognise as a
# real column into extendedAttributes (normalization.js), so the crawler only has
# to pass them through.
#
# Two files do NOT, deliberately:
#   • IdentityMembers.csv / ContextMembers.csv — their tables have no
#     extendedAttributes column, so there is nowhere to keep them.
#   • Assignments.csv — tens of millions of rows. Per-row attribute copying, a
#     JSON object per assignment on the wire and a JSONB value per row in the
#     largest table cost more than any assignment-level attribute is worth.
# Their extra columns are named in the job log instead of dropped silently.
#
# The columns listed per file are the schema itself plus SystemName, which routes
# a row to a system and is plumbing, not an attribute. Matching is
# case-insensitive (-notcontains), like the row access that reads them.
$script:CsvReservedColumns = @{
    'Systems.csv'               = @('ExternalId', 'DisplayName', 'SystemType', 'Description')
    'Contexts.csv'              = @('ExternalId', 'DisplayName', 'TargetType', 'ContextType', 'Description', 'ParentExternalId', 'OwnerUserId', 'SystemName')
    'Resources.csv'             = @('ExternalId', 'DisplayName', 'ResourceType', 'Description', 'SystemName', 'Enabled')
    'ResourceRelationships.csv' = @('ParentExternalId', 'ChildExternalId', 'RelationshipType', 'SystemName')
    'Users.csv'                 = @('ExternalId', 'DisplayName', 'Email', 'PrincipalType', 'JobTitle', 'Department', 'SystemName', 'Enabled')
    'Identities.csv'            = @('ExternalId', 'DisplayName', 'Email', 'EmployeeId', 'Department', 'JobTitle', 'SystemName')
    'Certifications.csv'        = @('ExternalId', 'ResourceExternalId', 'UserDisplayName', 'Decision', 'ReviewerDisplayName', 'ReviewedDateTime', 'SystemName')
}

# Field names the ingest API treats as bookkeeping, never as attributes. A record
# field named like a real column lands IN that column, so a customer column that
# happens to be called "systemId" or "id" must not be forwarded: it would try to
# re-home the row or overwrite its key.
$script:CsvIngestOwnedFields = @('id', 'systemId', 'extendedAttributes', 'deletedAt', 'updatedAt', 'createdAt')

# The schema of the files whose extra columns are NOT kept. Used only to NAME
# those columns in the job log (Get-CsvIgnoredColumns), so dropping them is a
# stated decision rather than a silent one.
$script:CsvUnkeptColumnsSchema = @{
    'Assignments.csv'     = @('ResourceExternalId', 'UserExternalId', 'AssignmentType', 'SystemName')
    'IdentityMembers.csv' = @('IdentityExternalId', 'UserExternalId', 'AccountType', 'SystemName')
    'ContextMembers.csv'  = @('ContextExternalId', 'MemberExternalId', 'MemberType', 'SystemName')
}

# The columns of $Columns outside $Schema, minus the ingest-owned field names.
function Get-CsvNonSchemaColumns {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]]$Columns, [string[]]$Schema)
    $owned = $script:CsvIngestOwnedFields
    return @($Columns | Where-Object { $_ -and $Schema -notcontains $_ -and $owned -notcontains $_ })
}

# The columns that are NOT part of the file's schema — the ones kept as
# extendedAttributes. Computed ONCE per file by the phase, never per row. Returns
# @() when the file is pure schema, or its extras are not kept at all (see above),
# which lets every caller skip the work entirely.
function Get-CsvExtraColumns {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]]$Columns, [string]$FileName)
    $reserved = $script:CsvReservedColumns[$FileName]
    if (-not $reserved) { return @() }
    return Get-CsvNonSchemaColumns -Columns $Columns -Schema $reserved
}

# The non-schema columns of a file that does NOT keep them; @() for every other
# file. For the job log only.
function Get-CsvIgnoredColumns {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]]$Columns, [string]$FileName)
    $schema = $script:CsvUnkeptColumnsSchema[$FileName]
    if (-not $schema) { return @() }
    return Get-CsvNonSchemaColumns -Columns $Columns -Schema $schema
}

# Copy the extra columns of one row onto the record. Handles both row shapes: a
# PSCustomObject (slow path) is read by name; a string[] (fast path) by the
# positions in $ExtraIndex, which parallels $Extra. A blank value is skipped, not
# stored as '', and a field the shaper already set is never overwritten (the
# record is a case-insensitive hashtable, so "accountenabled" would clobber it).
function Add-CsvExtendedAttributes {
    [CmdletBinding()]
    param($Row, [string[]]$Extra, $Record, [int[]]$ExtraIndex)
    if (-not $Extra -or $Extra.Count -eq 0) { return }
    # Not `if ($ExtraIndex)`: a one-element array takes its element's truth, so an
    # extra column in position 0 would silently fall through to $Row.$c.
    $byIndex = $null -ne $ExtraIndex
    for ($i = 0; $i -lt $Extra.Count; $i++) {
        $c = $Extra[$i]
        if ($Record.ContainsKey($c)) { continue }
        $v = if ($byIndex) { $Row[$ExtraIndex[$i]] } else { $Row.$c }
        if (-not [string]::IsNullOrWhiteSpace($v)) { $Record[$c] = $v }
    }
}

# The positions of $Names in a fast-path row, for Add-CsvExtendedAttributes
# -ExtraIndex. Resolved once per file.
function Get-CsvColumnPositions {
    [CmdletBinding()]
    [OutputType([int[]])]
    param([hashtable]$ColIdx, [string[]]$Names)
    return , [int[]]@($Names | ForEach-Object { $ColIdx[$_] })
}

# ─── Users.csv ───────────────────────────────────────────────────
# principalType is validated against the canonical set (falls back to 'User').

function ConvertTo-CsvUserRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols, [string[]]$Extra = @())
    if (-not $Row.ExternalId -or -not $Row.DisplayName) { return $null }
    $validTypes = @('User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox')
    $pType = if ($Cols.Contains('PrincipalType') -and $Row.PrincipalType -in $validTypes) { $Row.PrincipalType } else { 'User' }
    $on = $true
    if ($Cols.Contains('Enabled') -and $Row.Enabled -in @('false', 'False', '0')) { $on = $false }
    $rec = @{
        _systemId      = $SystemId
        externalId     = $Row.ExternalId
        displayName    = $Row.DisplayName
        principalType  = $pType
        accountEnabled = $on
        email          = if ($Cols.Contains('Email')) { $Row.Email } else { $null }
        jobTitle       = if ($Cols.Contains('JobTitle')) { $Row.JobTitle } else { $null }
        department     = if ($Cols.Contains('Department')) { $Row.Department } else { $null }
    }
    Add-CsvExtendedAttributes -Row $Row -Extra $Extra -Record $rec
    return $rec
}

# ─── Streamed files (Resources.csv, Assignments.csv), one batch at a time ──
# Shapes a whole batch of string[] rows in ONE call. Assignments is the hot path
# of the largest file (tens of millions of rows), where a function call per row
# costs more than all the shaping it wraps, so its loop lives in a per-system set
# shaper rather than around a per-row one.
#
# $Idx carries the file's column positions (-1 when absent), including Sys
# (SystemName). A row's SystemName picks its system when $SystemLookup knows it,
# else $FallbackSystemId.
#
# Returns @{ BySystem = @{ <systemId> = object[] of records }; Skipped = <rows
# without a resource or user id> }. Records carry no _systemId: the system is
# which array they are in. A system whose rows were ALL skipped is left out
# entirely: it must not get a stream, because a stream's system is reconciled at
# the end, and a reconcile after touching nothing would delete everything.
#
# Only operators and indexers inside the per-row loops — a .NET method call costs
# several microseconds in PowerShell (List.Add ~10 µs, TryGetValue([ref]) ~20 µs),
# which at 40M rows is the difference between minutes and hours.
#
# The per-system shaping is $ShapeSet (ConvertTo-CsvAssignmentRecordSet,
# ConvertTo-CsvResourceRecordSet): called once per system per batch, never per
# row. Named systems the lookup does not know are counted into $Unknown.
function ConvertTo-CsvStreamBatch {
    [CmdletBinding()]
    param($Rows, [hashtable]$Idx, [hashtable]$SystemLookup, [int]$FallbackSystemId, [scriptblock]$ShapeSet, [hashtable]$Unknown = @{})
    $groups = Split-CsvRowsBySystem -Rows $Rows -SysIndex $Idx.Sys -SystemLookup $SystemLookup -FallbackSystemId $FallbackSystemId -Unknown $Unknown
    $bySystem = @{}
    $skipped = 0
    foreach ($sid in @($groups.Keys)) {
        $set = & $ShapeSet $groups[$sid] $Idx
        $skipped += $set.Skipped
        if ($set.Records.Length -gt 0) { $bySystem[$sid] = $set.Records }
    }
    return @{ BySystem = $bySystem; Skipped = $skipped }
}

# Group a batch's rows by the system their SystemName resolves to (unknown or
# blank → the fallback; an unknown NAME is counted into $Unknown). Without a
# SystemName column every row is the fallback's, and the batch is returned as-is.
# Each system's array is sized for the whole batch, filled by index and trimmed once.
function Split-CsvRowsBySystem {
    [CmdletBinding()]
    param($Rows, [int]$SysIndex, [hashtable]$SystemLookup, [int]$FallbackSystemId, [hashtable]$Unknown = @{})
    if ($SysIndex -lt 0) { return @{ $FallbackSystemId = $Rows } }
    $size = $Rows.Count
    $groups = @{}
    $counts = @{}
    foreach ($cells in $Rows) {
        $name = [string]$cells[$SysIndex]     # [string]: a short row's $null would throw as a key
        $sid = $SystemLookup[$name]
        if ($null -eq $sid) {
            $sid = $FallbackSystemId
            if ($name) { $Unknown[$name] = 1 + [int]$Unknown[$name] }
        }
        $arr = $groups[$sid]
        if ($null -eq $arr) { $arr = [object[]]::new($size); $groups[$sid] = $arr; $counts[$sid] = 0 }
        $arr[$counts[$sid]] = $cells
        $counts[$sid]++
    }
    foreach ($sid in @($groups.Keys)) { $groups[$sid] = Get-CsvArrayPrefix -Array $groups[$sid] -Count $counts[$sid] }
    return $groups
}

# Shape one system's Resources.csv rows; the per-row shaper is fine at ~800k rows.
# The system is which stream the set joins, so _systemId is dropped — sent, it
# would be stored as an attribute.
function ConvertTo-CsvResourceRecordSet {
    [CmdletBinding()]
    param($Rows, [hashtable]$Idx)
    $skipped = 0
    $records = @(foreach ($cells in $Rows) {
        $rec = ConvertTo-CsvResourceRecord -Row $cells -Idx $Idx -SystemId 0
        if (-not $rec) { $skipped++; continue }
        $rec.Remove('_systemId')
        $rec
    })
    return @{ Records = $records; Skipped = $skipped }
}

# Shape one system's Assignments.csv rows. $Idx: Res, User, Type (-1 when absent).
function ConvertTo-CsvAssignmentRecordSet {
    [CmdletBinding()]
    param($Rows, [hashtable]$Idx)
    $iRes = $Idx.Res; $iUser = $Idx.User; $iType = $Idx.Type
    $skipped = 0
    $records = @(foreach ($cells in $Rows) {
        $res = $cells[$iRes]; $usr = $cells[$iUser]
        if (-not $res -or -not $usr) { $skipped++; continue }
        $type = if ($iType -ge 0 -and $cells[$iType]) { $cells[$iType] } else { 'Direct' }
        @{ resourceExternalId = $res; principalExternalId = $usr; assignmentType = $type }
    })
    return @{ Records = $records; Skipped = $skipped }
}

# The first $Count items of $Array as a new array (the array itself when full).
function Get-CsvArrayPrefix {
    [CmdletBinding()]
    param([object[]]$Array, [int]$Count)
    if ($Count -eq $Array.Length) { return , $Array }
    $out = [object[]]::new($Count)
    [Array]::Copy($Array, $out, $Count)
    return , $out
}

# ─── Identities.csv ──────────────────────────────────────────────
function ConvertTo-CsvIdentityRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols, [string[]]$Extra = @())
    if (-not $Row.ExternalId -or -not $Row.DisplayName) { return $null }
    $rec = @{
        _systemId   = $SystemId
        externalId  = $Row.ExternalId
        displayName = $Row.DisplayName
        email       = if ($Cols.Contains('Email')) { $Row.Email } else { $null }
        employeeId  = if ($Cols.Contains('EmployeeId')) { $Row.EmployeeId } else { $null }
        department  = if ($Cols.Contains('Department')) { $Row.Department } else { $null }
        jobTitle    = if ($Cols.Contains('JobTitle')) { $Row.JobTitle } else { $null }
    }
    Add-CsvExtendedAttributes -Row $Row -Extra $Extra -Record $rec
    return $rec
}

# ─── IdentityMembers.csv ─────────────────────────────────────────
function ConvertTo-CsvIdentityMemberRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols)
    if (-not $Row.IdentityExternalId -or -not $Row.UserExternalId) { return $null }
    return @{
        _systemId           = $SystemId
        identityExternalId  = $Row.IdentityExternalId
        principalExternalId = $Row.UserExternalId
        accountType         = if ($Cols.Contains('AccountType')) { $Row.AccountType } else { $null }
    }
}

# ─── Certifications.csv (fast path) ──────────────────────────────
# $Idx: Ext (ExternalId), and optional Res, UDN (UserDisplayName), Dec (Decision),
# RDN (ReviewerDisplayName), RDT (ReviewedDateTime) — -1 when absent — plus the
# optional Extra / ExtraIdx pair (names, and their positions from Get-CsvColumnPositions).
function ConvertTo-CsvCertificationRecord {
    [CmdletBinding()]
    param([string[]]$Row, [hashtable]$Idx, [int]$SystemId)
    $ext = $Row[$Idx.Ext]
    if (-not $ext) { return $null }
    $rec = @{
        _systemId             = $SystemId
        externalId            = $ext
        resourceExternalId    = if ($Idx.Res -ge 0) { $Row[$Idx.Res] } else { $null }
        principalDisplayName  = if ($Idx.UDN -ge 0) { $Row[$Idx.UDN] } else { $null }
        decision              = if ($Idx.Dec -ge 0) { $Row[$Idx.Dec] } else { $null }
        reviewedByDisplayName = if ($Idx.RDN -ge 0) { $Row[$Idx.RDN] } else { $null }
        reviewedDateTime      = if ($Idx.RDT -ge 0) { $Row[$Idx.RDT] } else { $null }
    }
    Add-CsvExtendedAttributes -Row $Row -Extra $Idx.Extra -ExtraIndex $Idx.ExtraIdx -Record $rec
    return $rec
}
