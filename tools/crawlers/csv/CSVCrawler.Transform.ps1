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

# ─── Resources.csv (fast path) ───────────────────────────────────
# $Row is a string[]; $Idx maps the logical columns to their position (or -1 when
# the column is absent): Ext, DN, RT (ResourceType), Desc, En (Enabled).
function ConvertTo-CsvResourceRecord {
    [CmdletBinding()]
    param([string[]]$Row, [hashtable]$Idx, [int]$SystemId)
    $ext = $Row[$Idx.Ext]; $dn = $Row[$Idx.DN]
    if (-not $ext -or -not $dn) { return $null }
    $type = if ($Idx.RT -ge 0) { $Row[$Idx.RT] } else { $null }
    if ($type -eq 'Business Role') { $type = 'BusinessRole' }
    $on = $true
    if ($Idx.En -ge 0 -and $Row[$Idx.En] -in @('false', 'False', '0')) { $on = $false }
    return @{
        _systemId    = $SystemId
        externalId   = $ext
        displayName  = $dn
        resourceType = $type
        enabled      = $on
        description  = if ($Idx.Desc -ge 0) { $Row[$Idx.Desc] } else { $null }
    }
}

# ─── ResourceRelationships.csv ───────────────────────────────────
function ConvertTo-CsvRelationshipRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols)
    if (-not $Row.ParentExternalId -or -not $Row.ChildExternalId) { return $null }
    return @{
        _systemId        = $SystemId
        parentExternalId = $Row.ParentExternalId
        childExternalId  = $Row.ChildExternalId
        relationshipType = if ($Cols.Contains('RelationshipType') -and $Row.RelationshipType) { $Row.RelationshipType } else { 'Contains' }
    }
}

# ─── Users.csv ───────────────────────────────────────────────────
# principalType is validated against the canonical set (falls back to 'User').
function ConvertTo-CsvUserRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols)
    if (-not $Row.ExternalId -or -not $Row.DisplayName) { return $null }
    $validTypes = @('User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox')
    $pType = if ($Cols.Contains('PrincipalType') -and $Row.PrincipalType -in $validTypes) { $Row.PrincipalType } else { 'User' }
    $on = $true
    if ($Cols.Contains('Enabled') -and $Row.Enabled -in @('false', 'False', '0')) { $on = $false }
    return @{
        _systemId      = $SystemId
        externalId     = $Row.ExternalId
        displayName    = $Row.DisplayName
        principalType  = $pType
        accountEnabled = $on
        email          = if ($Cols.Contains('Email')) { $Row.Email } else { $null }
        jobTitle       = if ($Cols.Contains('JobTitle')) { $Row.JobTitle } else { $null }
        department     = if ($Cols.Contains('Department')) { $Row.Department } else { $null }
    }
}

# ─── Assignments.csv (fast path) ─────────────────────────────────
# $Idx: Res (ResourceExternalId), User (UserExternalId), Type (AssignmentType, -1 if absent).
function ConvertTo-CsvAssignmentRecord {
    [CmdletBinding()]
    param([string[]]$Row, [hashtable]$Idx, [int]$SystemId)
    $resId = $Row[$Idx.Res]; $usrId = $Row[$Idx.User]
    if (-not $resId -or -not $usrId) { return $null }
    $aType = 'Direct'
    if ($Idx.Type -ge 0) { $v = $Row[$Idx.Type]; if ($v) { $aType = $v } }
    return @{
        _systemId           = $SystemId
        resourceExternalId  = $resId
        principalExternalId = $usrId
        assignmentType      = $aType
    }
}

# ─── Identities.csv ──────────────────────────────────────────────
function ConvertTo-CsvIdentityRecord {
    [CmdletBinding()]
    param($Row, [int]$SystemId, [System.Collections.Generic.HashSet[string]]$Cols)
    if (-not $Row.ExternalId -or -not $Row.DisplayName) { return $null }
    return @{
        _systemId   = $SystemId
        externalId  = $Row.ExternalId
        displayName = $Row.DisplayName
        email       = if ($Cols.Contains('Email')) { $Row.Email } else { $null }
        employeeId  = if ($Cols.Contains('EmployeeId')) { $Row.EmployeeId } else { $null }
        department  = if ($Cols.Contains('Department')) { $Row.Department } else { $null }
        jobTitle    = if ($Cols.Contains('JobTitle')) { $Row.JobTitle } else { $null }
    }
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
# RDN (ReviewerDisplayName), RDT (ReviewedDateTime) — -1 when absent.
function ConvertTo-CsvCertificationRecord {
    [CmdletBinding()]
    param([string[]]$Row, [hashtable]$Idx, [int]$SystemId)
    $ext = $Row[$Idx.Ext]
    if (-not $ext) { return $null }
    return @{
        _systemId             = $SystemId
        externalId            = $ext
        resourceExternalId    = if ($Idx.Res -ge 0) { $Row[$Idx.Res] } else { $null }
        principalDisplayName  = if ($Idx.UDN -ge 0) { $Row[$Idx.UDN] } else { $null }
        decision              = if ($Idx.Dec -ge 0) { $Row[$Idx.Dec] } else { $null }
        reviewedByDisplayName = if ($Idx.RDN -ge 0) { $Row[$Idx.RDN] } else { $null }
        reviewedDateTime      = if ($Idx.RDT -ge 0) { $Row[$Idx.RDT] } else { $null }
    }
}
