<#
.SYNOPSIS
    Pure row → ingest-record shapers for the SQL Database crawler.

.DESCRIPTION
    A row is an ordered hashtable (column name → value) as Read-SqlRow produced
    it. The shapers map it onto the ingest record for the slot's target by the
    column contract in tools/crawlers/sql/CLAUDE.md:

      * contract columns are matched case-insensitively with underscores ignored
        (display_name == DisplayName == displayname);
      * every column the target does not consume lands in extendedAttributes
        under its original name;
      * a row without its required columns yields $null (skip).

    Resolve-SqlColumnMap does the matching ONCE per result set — the shapers
    only index the row by the names it resolved, which is what keeps the
    per-row cost flat on a 40 M-row assignment table.

    No I/O, no script-scope reads: everything arrives as a parameter, so
    test/unit/SqlCrawlerTransform.Tests.ps1 runs these on in-memory rows.
#>

#region Column contract

# The contract per target: `core` columns become record fields and are NOT
# copied to extendedAttributes; `aux` columns are consumed (fallbacks, flags,
# links) but ALSO kept in extendedAttributes since they carry source detail.
$script:SqlContract = @{
    identities         = @{ core = @('id', 'displayName', 'email', 'givenName', 'surname', 'department', 'jobTitle', 'companyName', 'employeeId'); aux = @('name', 'userId', 'principalType', 'enabled', 'active', 'inactive', 'disabled') }
    principals         = @{ core = @('id', 'displayName', 'email', 'givenName', 'surname', 'department', 'jobTitle', 'companyName', 'employeeId'); aux = @('name', 'userId', 'principalType', 'enabled', 'active', 'inactive', 'disabled', 'identityId') }
    'identity-members' = @{ core = @('identityId', 'principalId', 'isPrimary', 'accountType'); aux = @() }
    resources          = @{ core = @('id', 'displayName', 'description'); aux = @('name', 'enabled', 'active', 'inactive', 'disabled') }
    assignments        = @{ core = @('resourceId', 'principalId', 'identityId'); aux = @() }
    relationships      = @{ core = @('parentId', 'childId'); aux = @() }
}

function ConvertTo-SqlColumnKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowEmptyString()] [string]$Name)
    return ($Name -replace '_', '').ToLowerInvariant()
}

# Resolve the result set's columns against a target's contract. Returns a
# hashtable: <contractName> → actual column name (or absent), plus `_extended`
# = the actual column names that go to extendedAttributes. A contract name that
# several columns satisfy (id and ID) takes the first one in column order.
function Resolve-SqlColumnMap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string[]]$Columns,
        [Parameter(Mandatory)] [string]$Target,
        # Operator overrides: source column name -> contract column name. Lets an
        # existing SELECT be used verbatim instead of being rewritten with aliases.
        [hashtable]$ColumnMap = @{}
    )
    $contract = $script:SqlContract[$Target]
    if (-not $contract) { throw "No column contract for target '$Target'" }
    $byKey      = Get-SqlColumnsByKey -Columns $Columns
    $overridden = Get-SqlColumnOverrides -ByKey $byKey -ColumnMap $ColumnMap

    $map = @{}
    $consumed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($name in $contract.core) {
        $src = Get-SqlSourceColumn -Name $name -ByKey $byKey -Overridden $overridden
        if ($src) { $map[$name] = $src; [void]$consumed.Add($src) }
    }
    foreach ($name in $contract.aux) {
        $src = Get-SqlSourceColumn -Name $name -ByKey $byKey -Overridden $overridden
        if ($src) { $map[$name] = $src }
    }
    $map['_extended'] = @($Columns | Where-Object { -not $consumed.Contains($_) })
    return $map
}

# The result set's columns indexed by their normalised key. A duplicate spelling
# keeps the first column in order.
function Get-SqlColumnsByKey {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)] [string[]]$Columns)
    $byKey = @{}
    foreach ($c in $Columns) {
        $k = ConvertTo-SqlColumnKey $c
        if (-not $byKey.ContainsKey($k)) { $byKey[$k] = $c }
    }
    return $byKey
}

# The operator's overrides as <contract key> -> <actual source column>. An entry
# naming a column the result set does not return is dropped here, so the caller
# simply sees no override for it.
function Get-SqlColumnOverrides {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)] [hashtable]$ByKey, [hashtable]$ColumnMap = @{})
    $overridden = @{}
    foreach ($e in $ColumnMap.GetEnumerator()) {
        $src = $ByKey[(ConvertTo-SqlColumnKey ([string]$e.Key))]
        if ($src) { $overridden[(ConvertTo-SqlColumnKey ([string]$e.Value))] = $src }
    }
    return $overridden
}

# Which source column satisfies one contract column: the operator's override
# first (they said so explicitly), then a column of that name, else none.
function Get-SqlSourceColumn {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Name, [Parameter(Mandatory)] [hashtable]$ByKey, [hashtable]$Overridden = @{})
    $k = ConvertTo-SqlColumnKey $Name
    if ($Overridden.ContainsKey($k)) { return $Overridden[$k] }
    if ($ByKey.ContainsKey($k)) { return $ByKey[$k] }
    return $null
}

# The value of a contract column, or $null when the result set has none.
function Get-SqlMapped {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [string]$Name)
    if ($Map.ContainsKey($Name)) { return $Row[$Map[$Name]] }
    return $null
}

# The non-contract columns as a hashtable, or $null when there are none (an
# absent key serialises smaller than an empty object — it matters at 40 M rows).
function Get-SqlExtendedAttributes {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map)
    if ($Map._extended.Count -eq 0) { return $null }
    $ext = @{}
    foreach ($c in $Map._extended) { $ext[$c] = $Row[$c] }
    return $ext
}

# bit / int / 'Y' / 'true' / '1' → $true; 0 / 'N' / 'false' / '0' → $false; anything
# else (NULL, '') → -Default.
function ConvertTo-SqlBoolean {
    [CmdletBinding()]
    [OutputType([bool])]
    param($Value, [bool]$Default = $false)
    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { return $Value }
    if ($Value -is [System.ValueType]) { return ([double]$Value) -ne 0 }
    switch -Regex (([string]$Value).Trim()) {
        '^(?i:true|yes|y|1|t)$'  { return $true }
        '^(?i:false|no|n|0|f)$'  { return $false }
        default                  { return $Default }
    }
}

# Enabled-ness from whichever flag the row carries: enabled / active (positive)
# win over inactive / disabled (negative). No flag → enabled.
function Get-SqlEnabledFlag {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map)
    foreach ($n in @('enabled', 'active')) {
        if ($Map.ContainsKey($n) -and $null -ne $Row[$Map[$n]]) { return (ConvertTo-SqlBoolean -Value $Row[$Map[$n]] -Default $true) }
    }
    foreach ($n in @('inactive', 'disabled')) {
        if ($Map.ContainsKey($n) -and $null -ne $Row[$Map[$n]]) { return -not (ConvertTo-SqlBoolean -Value $Row[$Map[$n]] -Default $false) }
    }
    return $true
}

# displayName, then the target's fallback columns, then the id.
function Get-SqlDisplayName {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [string[]]$Fallbacks = @(), [string]$Id = '')
    foreach ($n in (@('displayName') + $Fallbacks)) {
        $v = Get-SqlMapped -Row $Row -Map $Map -Name $n
        if ($null -ne $v -and ([string]$v).Trim()) { return ([string]$v).Trim() }
    }
    return $Id
}

function Get-SqlPrincipalType {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [string]$Default = 'User')
    $v = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'principalType')
    if ($v -and $v -in $script:SqlPrincipalTypes) { return $v }
    return $Default
}

#endregion Column contract

#region Shapers

# The person/account fields identities and principals share.
function Add-SqlPersonFields {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] $Record)
    foreach ($f in @('email', 'givenName', 'surname', 'department', 'jobTitle', 'companyName', 'employeeId')) {
        $v = Get-SqlMapped -Row $Row -Map $Map -Name $f
        if ($null -ne $v -and [string]$v -ne '') { $Record[$f] = [string]$v }
    }
}

# One principals-target row (or the account half of an identities row) → a
# Principal record. $null when the row has no id.
function ConvertTo-SqlPrincipalRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Slot)
    $id = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'id')
    if (-not $id.Trim()) { return $null }
    $id = $id.Trim()
    $rec = [ordered]@{
        externalId     = $id
        displayName    = Get-SqlDisplayName -Row $Row -Map $Map -Fallbacks @('name', 'userId') -Id $id
        principalType  = Get-SqlPrincipalType -Row $Row -Map $Map -Default $Slot.principalType
        accountEnabled = Get-SqlEnabledFlag -Row $Row -Map $Map
    }
    Add-SqlPersonFields -Row $Row -Map $Map -Record $rec
    $ext = Get-SqlExtendedAttributes -Row $Row -Map $Map
    if ($ext) { $rec['extendedAttributes'] = $ext }
    return $rec
}

# One identities-target row → the Identity record. $null when the row has no id.
function ConvertTo-SqlIdentityRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map)
    $id = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'id')
    if (-not $id.Trim()) { return $null }
    $id = $id.Trim()
    $rec = [ordered]@{
        externalId  = $id
        displayName = Get-SqlDisplayName -Row $Row -Map $Map -Fallbacks @('name', 'userId') -Id $id
    }
    Add-SqlPersonFields -Row $Row -Map $Map -Record $rec
    $ext = Get-SqlExtendedAttributes -Row $Row -Map $Map
    if ($ext) { $rec['extendedAttributes'] = $ext }
    return $rec
}

# The IdentityMember link between an identity and one of its accounts.
function New-SqlIdentityMemberRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$IdentityId, [Parameter(Mandatory)] [string]$PrincipalId, [bool]$IsPrimary = $true, [string]$AccountType = 'Primary')
    return [ordered]@{
        identityExternalId  = $IdentityId
        principalExternalId = $PrincipalId
        accountType         = $AccountType
        isPrimary           = $IsPrimary
    }
}

# One identity-members-target row → an IdentityMember record, or $null.
function ConvertTo-SqlIdentityMemberRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map)
    $iid = ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'identityId')).Trim()
    $principalRef = ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'principalId')).Trim()
    if (-not $iid -or -not $principalRef) { return $null }
    $isPrimary   = ConvertTo-SqlBoolean -Value (Get-SqlMapped -Row $Row -Map $Map -Name 'isPrimary') -Default $true
    $accountType = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'accountType')
    return New-SqlIdentityMemberRecord -IdentityId $iid -PrincipalId $principalRef -IsPrimary $isPrimary -AccountType $(if ($accountType) { $accountType } else { 'Primary' })
}

# One resources-target row → a Resource record, or $null when it has no id.
function ConvertTo-SqlResourceRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Slot)
    $id = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'id')
    if (-not $id.Trim()) { return $null }
    $id = $id.Trim()
    $rec = [ordered]@{
        externalId   = $id
        displayName  = Get-SqlDisplayName -Row $Row -Map $Map -Fallbacks @('name') -Id $id
        resourceType = $Slot.resourceType
        enabled      = Get-SqlEnabledFlag -Row $Row -Map $Map
    }
    if ($Slot.resourceType -eq 'BusinessRole') { $rec['governanceResource'] = $true }
    $desc = Get-SqlMapped -Row $Row -Map $Map -Name 'description'
    if ($null -ne $desc -and [string]$desc -ne '') { $rec['description'] = [string]$desc }
    $ext = Get-SqlExtendedAttributes -Row $Row -Map $Map
    if ($ext) { $rec['extendedAttributes'] = $ext }
    return $rec
}

# One assignments-target row → a ResourceAssignment record, or $null when either
# side is missing. `identityId` is accepted for principalId because an
# identities-target row's account shares the identity's id. Hot path: indexes the
# row directly rather than through Get-SqlMapped.
function ConvertTo-SqlAssignmentRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Slot)
    $resourceRef = if ($Map.resourceId) { [string]$Row[$Map.resourceId] } else { '' }
    $principalRef = if ($Map.principalId) { [string]$Row[$Map.principalId] } elseif ($Map.identityId) { [string]$Row[$Map.identityId] } else { '' }
    $resourceRef = $resourceRef.Trim(); $principalRef = $principalRef.Trim()
    if (-not $resourceRef -or -not $principalRef) { return $null }
    $rec = [ordered]@{
        resourceExternalId  = $resourceRef
        principalExternalId = $principalRef
        assignmentType      = $Slot.assignmentType
        resourceType        = $Slot.resourceType
        governed            = [bool]$Slot.governed
    }
    $ext = Get-SqlExtendedAttributes -Row $Row -Map $Map
    if ($ext) { $rec['extendedAttributes'] = $ext }
    return $rec
}

# One relationships-target row → a ResourceRelationship record, or $null.
function ConvertTo-SqlRelationshipRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Slot)
    $parent = if ($Map.parentId) { ([string]$Row[$Map.parentId]).Trim() } else { '' }
    $child  = if ($Map.childId)  { ([string]$Row[$Map.childId]).Trim() }  else { '' }
    if (-not $parent -or -not $child) { return $null }
    $rec = [ordered]@{
        parentExternalId = $parent
        childExternalId  = $child
        relationshipType = $Slot.relationshipType
    }
    $ext = Get-SqlExtendedAttributes -Row $Row -Map $Map
    if ($ext) { $rec['extendedAttributes'] = $ext }
    return $rec
}

#endregion Shapers
