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

# ─── Systems.csv ─────────────────────────────────────────────────
function ConvertTo-CsvSystemRecord {
    [CmdletBinding()]
    param($Row, [string]$DefaultSystemType)
    if (-not $Row.DisplayName) { return $null }
    $props = $Row.PSObject.Properties.Name
    return @{
        externalId  = $Row.ExternalId
        displayName = $Row.DisplayName
        enabled     = $true
        syncEnabled = $true
        systemType  = if ($props -contains 'SystemType' -and $Row.SystemType) { $Row.SystemType } else { $DefaultSystemType }
        description = if ($props -contains 'Description') { $Row.Description } else { $null }
    }
}

# ─── Contexts.csv ────────────────────────────────────────────────
function ConvertTo-CsvContextRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols)
    if (-not $Row.ExternalId) { return $null }
    return @{
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
}

# ─── ContextMembers.csv ──────────────────────────────────────────
function ConvertTo-CsvContextMemberRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId)
    if (-not $Row.ContextExternalId -or -not $Row.MemberExternalId) { return $null }
    return @{
        _systemId         = $SystemId
        contextExternalId = $Row.ContextExternalId
        memberExternalId  = $Row.MemberExternalId
        memberType        = $Row.MemberType
        addedBy           = 'sync'
    }
}
