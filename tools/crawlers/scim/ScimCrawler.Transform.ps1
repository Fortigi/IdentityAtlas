<#
.SYNOPSIS
    Pure record-shapers for the SCIM 2.0 crawler.

.DESCRIPTION
    One SCIM object in, one Identity Atlas ingest record out. Every function here
    takes all of its input as explicit parameters, does no I/O, and returns the
    record (or $null to signal "skip"), so the whole file unit-tests against
    in-memory fixtures with zero mocks — see test/unit/ScimCrawlerTransform.Tests.ps1.

    Records use the deterministic-id contract: the raw SCIM `id` is sent as
    `externalId` and the ingest layer derives the UUID primary key from it
    (idGeneration='deterministic'), so re-runs are idempotent and cross-entity
    references (resourceExternalId / principalExternalId) resolve to the same rows.
#>

# The nested-group closure walk is shared with every other crawler that
# materialises Indirect assignments — see tools/crawlers/shared/.
. (Join-Path $PSScriptRoot '..' 'shared' 'Get-NestedGroupUserSet.ps1')

#region Value helpers

# Coerce a SCIM attribute value to something worth storing in extendedAttributes.
# Simple values (string / number / boolean) pass through; complex and multi-valued
# attributes are skipped — v1 syncs simple attributes only (see docs/sync/scim.md).
function Get-ScimScalar {
    [CmdletBinding()]
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        if ($Value.Length -eq 0) { return $null }
        return $Value
    }
    if ($Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
        return $Value
    }
    return $null
}

# RFC 7643 §4.1.2: emails is multi-valued; the entry flagged primary wins, else the
# first entry that carries a value. Returns $null when the user has no usable email.
function Get-ScimPrimaryEmail {
    [CmdletBinding()]
    param($Emails)
    $first = $null
    foreach ($e in @($Emails)) {
        if ($null -eq $e) { continue }
        $value = if ($e -is [string]) { $e } else { [string]$e.value }
        if (-not $value) { continue }
        if ($e -isnot [string] -and $e.primary -eq $true) { return $value }
        if (-not $first) { $first = $value }
    }
    return $first
}

# Read a possibly-nested attribute off a SCIM object. 'name.givenName' walks into
# the complex `name` attribute; a plain key reads the top-level attribute.
function Get-ScimAttribute {
    [CmdletBinding()]
    param($Object, [string]$Path)
    if (-not $Path) { return $null }
    $current = $Object
    foreach ($segment in $Path.Split('.')) {
        if ($null -eq $current) { return $null }
        $current = $current.$segment
    }
    return $current
}

# The opt-in attribute picker (S2): only attributes the operator selected are
# copied, and only when they resolve to a simple value. Returns a hashtable so
# the caller can merge it into the record — non-core keys are packed into
# extendedAttributes by the ingest normalization layer.
function Get-ScimSelectedAttributes {
    [CmdletBinding()]
    param($Object, $Selected)
    $out = @{}
    foreach ($name in @($Selected)) {
        if (-not $name) { continue }
        $scalar = Get-ScimScalar (Get-ScimAttribute -Object $Object -Path $name)
        if ($null -ne $scalar) { $out[$name] = $scalar }
    }
    return $out
}

#endregion Value helpers

#region Type mapping

# Map a SCIM userType onto an Identity Atlas principalType. Exact (case-insensitive)
# userType match wins; a row with a blank userType is the catch-all; with neither,
# the account is a plain User.
function Resolve-ScimPrincipalType {
    [CmdletBinding()]
    param([string]$UserType, $Mapping)
    $catchAll = $null
    foreach ($row in @($Mapping)) {
        if (-not $row) { continue }
        $key  = [string]$row.userType
        $type = [string]$row.principalType
        if (-not $type) { continue }
        if (-not $key) { if (-not $catchAll) { $catchAll = $type }; continue }
        if ($UserType -and $key.Equals($UserType, [System.StringComparison]::OrdinalIgnoreCase)) { return $type }
    }
    if ($catchAll) { return $catchAll }
    return 'User'
}

# Every principalType a run can produce, so the Users phase can flush an empty
# full-sync batch for a bucket that yielded no accounts this time — without it a
# type that lost its last account would keep stale rows forever. 'User' is always
# included: it is the fallback Resolve-ScimPrincipalType returns for an unmapped
# userType.
function Get-ScimPrincipalTypeBuckets {
    [CmdletBinding()]
    param($Mapping)
    $set = [System.Collections.Generic.List[string]]::new()
    [void]$set.Add('User')
    foreach ($row in @($Mapping)) {
        $type = if ($row) { [string]$row.principalType } else { '' }
        if ($type -and -not $set.Contains($type)) { [void]$set.Add($type) }
    }
    return @($set)
}

#endregion Type mapping

#region Record shapers

# SCIM User → Principals record. The core mapping (D10) is always synced;
# $SelectedAttributes adds the operator's opt-in extras on top.
function ConvertTo-ScimPrincipalRecord {
    [CmdletBinding()]
    param($User, $Mapping, $SelectedAttributes)
    if (-not $User) { return $null }
    $externalId = [string]$User.id
    if (-not $externalId) { return $null }

    $userName = [string]$User.userName
    $display  = [string]$User.displayName
    if (-not $display) { $display = $userName }
    if (-not $display) { $display = $externalId }

    $record = @{
        externalId     = $externalId
        displayName    = $display
        principalType  = Resolve-ScimPrincipalType -UserType ([string]$User.userType) -Mapping $Mapping
        accountEnabled = ($User.active -ne $false)
        userName       = $userName
    }
    $email = Get-ScimPrimaryEmail -Emails $User.emails
    if ($email) { $record['email'] = $email }
    $given = Get-ScimScalar (Get-ScimAttribute -Object $User -Path 'name.givenName')
    if ($given) { $record['givenName'] = $given }
    $family = Get-ScimScalar (Get-ScimAttribute -Object $User -Path 'name.familyName')
    if ($family) { $record['surname'] = $family }
    $title = Get-ScimScalar $User.title
    if ($title) { $record['jobTitle'] = $title }

    foreach ($kv in (Get-ScimSelectedAttributes -Object $User -Selected $SelectedAttributes).GetEnumerator()) {
        $record[$kv.Key] = $kv.Value
    }
    return $record
}

# SCIM Group → Resources record (resourceType='Group').
function ConvertTo-ScimGroupRecord {
    [CmdletBinding()]
    param($Group, $SelectedAttributes)
    if (-not $Group) { return $null }
    $externalId = [string]$Group.id
    if (-not $externalId) { return $null }

    $display = [string]$Group.displayName
    if (-not $display) { $display = $externalId }

    $record = @{
        externalId   = $externalId
        displayName  = $display
        resourceType = 'Group'
        enabled      = $true
    }
    foreach ($kv in (Get-ScimSelectedAttributes -Object $Group -Selected $SelectedAttributes).GetEnumerator()) {
        $record[$kv.Key] = $kv.Value
    }
    return $record
}

#endregion Record shapers

#region Membership

# Classify one `members` entry as a user, a nested group, or unresolved.
#
# RFC 7643 §4.2 makes the `type` sub-attribute OPTIONAL, so it is never trusted on
# its own: the member id is matched against the user and group id-sets this run
# actually fetched. `type` only breaks the tie in the pathological case where the
# same id exists in both sets. An id in neither set is 'unknown' — the caller
# counts and logs it rather than silently dropping it.
function Resolve-ScimMemberKind {
    [CmdletBinding()]
    param($Member, $UserIds, $GroupIds)
    $value = if ($Member -is [string]) { $Member } else { [string]$Member.value }
    if (-not $value) { return @{ kind = 'unknown'; value = '' } }

    $isUser  = $UserIds.Contains($value)
    $isGroup = $GroupIds.Contains($value)
    if ($isUser -and $isGroup) {
        $hint = if ($Member -is [string]) { '' } else { [string]$Member.type }
        $kind = if ($hint -and $hint.Equals('Group', [System.StringComparison]::OrdinalIgnoreCase)) { 'group' } else { 'user' }
        return @{ kind = $kind; value = $value }
    }
    if ($isUser)  { return @{ kind = 'user';  value = $value } }
    if ($isGroup) { return @{ kind = 'group'; value = $value } }
    return @{ kind = 'unknown'; value = $value }
}

# One group's `members` → direct membership edges. User members become Direct
# ResourceAssignments; nested groups become Contains ResourceRelationships. The
# returned `edges` list is the flat input the Indirect expansion below consumes.
# RETURNS @{ assignments; relationships; edges; unresolved }.
function ConvertTo-ScimGroupMembership {
    [CmdletBinding()]
    param($Group, $UserIds, $GroupIds, $PrincipalTypeById)
    $assignments   = [System.Collections.Generic.List[object]]::new()
    $relationships = [System.Collections.Generic.List[object]]::new()
    $edges         = [System.Collections.Generic.List[object]]::new()
    $unresolved    = [System.Collections.Generic.List[string]]::new()

    $groupId = if ($Group) { [string]$Group.id } else { '' }
    if (-not $groupId) { return @{ assignments = @(); relationships = @(); edges = @(); unresolved = @() } }

    foreach ($m in @($Group.members)) {
        if ($null -eq $m) { continue }
        $resolved = Resolve-ScimMemberKind -Member $m -UserIds $UserIds -GroupIds $GroupIds
        if ($resolved.kind -eq 'user') {
            $principalType = if ($PrincipalTypeById -and $PrincipalTypeById.ContainsKey($resolved.value)) { $PrincipalTypeById[$resolved.value] } else { 'User' }
            [void]$assignments.Add(@{
                resourceExternalId  = $groupId
                principalExternalId = $resolved.value
                assignmentType      = 'Direct'
                resourceType        = 'Group'
                principalType       = $principalType
            })
            [void]$edges.Add(@{ groupId = $groupId; memberId = $resolved.value; memberKind = 'user'; principalType = $principalType })
        }
        elseif ($resolved.kind -eq 'group') {
            [void]$relationships.Add(@{
                parentExternalId = $groupId
                childExternalId  = $resolved.value
                relationshipType = 'Contains'
            })
            [void]$edges.Add(@{ groupId = $groupId; memberId = $resolved.value; memberKind = 'group'; principalType = $null })
        }
        elseif ($resolved.value) {
            [void]$unresolved.Add($resolved.value)
        }
    }
    return @{ assignments = @($assignments); relationships = @($relationships); edges = @($edges); unresolved = @($unresolved) }
}

# Split the flat membership edges into the two adjacency maps the downward walk
# needs: nested-group children per group, and direct user members per group.
function Get-ScimGroupAdjacency {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] $Edges)
    $childGroups = @{}
    $directUsers = @{}
    foreach ($e in @($Edges)) {
        if ($null -eq $e) { continue }
        $gid = [string]$e.groupId
        $mid = [string]$e.memberId
        if (-not $gid -or -not $mid) { continue }
        if ($e.memberKind -eq 'group') {
            if (-not $childGroups.ContainsKey($gid)) { $childGroups[$gid] = [System.Collections.Generic.List[string]]::new() }
            $childGroups[$gid].Add($mid)
        }
        else {
            if (-not $directUsers.ContainsKey($gid)) { $directUsers[$gid] = [System.Collections.Generic.HashSet[string]]::new() }
            [void]$directUsers[$gid].Add($mid)
        }
    }
    return @{ ChildGroups = $childGroups; DirectUsers = $directUsers }
}

# Every user reachable below a set of seed child groups, walking the nesting graph
# downward. Cycle-safe ($visited), so a membership cycle (A∈B, B∈A) or a diamond
# neither loops nor double-counts.

# Expand group-in-group nesting into per-user Indirect assignments, so the matrix
# shows inherited members. The matrix reads a declared-only matview and never walks
# nesting itself, which is why the rows have to be materialised here — the same
# reason Entra materialises them (ConvertTo-EntraNestedGroupIndirectAssignments).
# A user who is ALSO a direct member of the outer group is skipped: the Direct row
# is the stronger statement and is already emitted by ConvertTo-ScimGroupMembership.
function ConvertTo-ScimNestedGroupIndirectAssignments {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] $Edges, $PrincipalTypeById)
    $adj         = Get-ScimGroupAdjacency -Edges $Edges
    $childGroups = $adj.ChildGroups
    $directUsers = $adj.DirectUsers
    $out         = [System.Collections.Generic.List[object]]::new()

    foreach ($rootId in $childGroups.Keys) {
        $transitive = Get-NestedGroupUserSet -SeedGroups $childGroups[$rootId] -ChildGroups $childGroups -DirectUsers $directUsers
        $rootDirect = if ($directUsers.ContainsKey($rootId)) { $directUsers[$rootId] } else { $null }
        foreach ($u in $transitive) {
            if ($rootDirect -and $rootDirect.Contains($u)) { continue }
            $principalType = if ($PrincipalTypeById -and $PrincipalTypeById.ContainsKey($u)) { $PrincipalTypeById[$u] } else { 'User' }
            [void]$out.Add(@{
                resourceExternalId  = $rootId
                principalExternalId = $u
                assignmentType      = 'Indirect'
                resourceType        = 'Group'
                principalType       = $principalType
            })
        }
    }
    # Leading comma: return the array intact. Without it PowerShell unwraps a
    # single-element result back into the bare hashtable, and every caller that
    # reads .Count or indexes [0] silently gets the record's key count instead.
    return ,@($out)
}

#endregion Membership
