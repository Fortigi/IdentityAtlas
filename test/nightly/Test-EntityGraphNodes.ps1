<#
.SYNOPSIS
    Validates that every clickable node on every entity detail graph
    (User / Identity / Resource / Business Role) returns a matching list
    from the API — i.e. "Count = 5" on a node implies clicking it yields
    >= 1 list row. Also checks that the list rows carry displayName
    fields, not raw GUIDs.

.DESCRIPTION
    The new entity-detail pages render a radial graph with one node per
    relationship type. Each node shows a count derived from the core
    endpoint; clicking it fetches a list endpoint. If the shapes drift
    (unquoted aliases folding to lowercase, broken joins, non-existent
    columns), the page shows a count but "Nothing to show" — confusing
    and near-impossible to spot without a walk of the whole graph.

    This test samples up to N entities of each kind from real data, reads
    the core endpoint to learn which nodes claim to have rows, then fetches
    the matching list endpoint and asserts:

      * HTTP 200
      * Non-empty array (when the count on the core response > 0)
      * Every row has a human-readable name field populated (no bare GUIDs)

    Runs standalone or via the nightly harness callback.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER SampleSize
    How many entities of each kind to test. Default: 5.

.PARAMETER WriteResult
    Optional callback { param($Name, $Passed, $Detail) ... } for the
    nightly runner.
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [int]$SampleSize = 5,
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$failures = 0
$passes   = 0

function Record([string]$name, [bool]$passed, [string]$detail = '') {
    if ($passed) {
        Write-Host ("    PASS  {0}  {1}" -f $name, $detail) -ForegroundColor Green
        $script:passes++
    } else {
        Write-Host ("    FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red
        $script:failures++
    }
    if ($WriteResult) { & $WriteResult $name $passed $detail }
}

function Get-Json([string]$path) {
    $url = "$ApiBaseUrl$path"
    # Two retries with short backoff. The pg pool + perf middleware
    # occasionally races on the first hit from a cold test process.
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            return Invoke-RestMethod -Uri $url -Method GET -TimeoutSec 30 -DisableKeepAlive
        } catch {
            $status = $null
            if ($_.Exception.Response) { $status = $_.Exception.Response.StatusCode.value__ }
            if ($attempt -lt 3 -and ($null -eq $status -or $status -ge 500)) {
                Start-Sleep -Milliseconds 300
                continue
            }
            return [pscustomobject]@{
                __error = $_.Exception.Message
                __statusCode = $status
            }
        }
    }
}

# Row-display-name heuristic: pick the first populated string field from a
# short priority list. If we can't find one, the row is just a GUID.
function Test-IsError($x) {
    # An array returned by Invoke-RestMethod exposes `.__error` on each
    # element, which lights up as a whitespace-joined string of nulls and
    # evaluates truthy — masking the real success path. Only the sentinel
    # PSCustomObject we return from Get-Json carries an actual __error
    # property, so check for that specifically.
    if ($null -eq $x) { return $false }
    if ($x -is [array]) { return $false }
    if ($x -isnot [System.Management.Automation.PSCustomObject]) { return $false }
    return ($null -ne $x.PSObject.Properties['__error'])
}

function Get-DisplayNameField($row) {
    foreach ($key in @(
        'displayName', 'principalDisplayName', 'targetDisplayName',
        'resourceDisplayName', 'parentDisplayName', 'businessRoleName',
        'accessPackageName', 'groupDisplayName', 'contextDisplayName'
    )) {
        $v = $row.$key
        if ($null -ne $v -and "$v".Trim().Length -gt 0) { return $v }
    }
    return $null
}

Write-Host "`n=== Entity Detail Graph Node Clickthrough ===" -ForegroundColor Cyan
Write-Host ("  API base: {0}" -f $ApiBaseUrl)

# ── Collect sample entities ──────────────────────────────────────────
Write-Host "`n  Sampling entities from the running stack..." -ForegroundColor Gray

$usersResp = Get-Json "/permissions/users?limit=$SampleSize"
$userIds = @()
if (-not (Test-IsError $usersResp) -and $usersResp.users) {
    $userIds = @(($usersResp.users | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)
}
# Permissions endpoint requires auth in some configurations. Fall back to
# pulling member principalIds out of the identity detail responses —
# every identity has at least one linked account even when the summary
# row doesn't expose the primary account directly.
if ($userIds.Count -eq 0) {
    $idents = Get-Json "/identities?limit=10"
    if (-not (Test-IsError $idents) -and $idents.data) {
        foreach ($row in $idents.data) {
            if ($userIds.Count -ge $SampleSize) { break }
            $detail = Get-Json "/identities/$($row.id)"
            if (Test-IsError $detail) { continue }
            foreach ($m in $detail.members) {
                if ($userIds.Count -ge $SampleSize) { break }
                if ($m.principalId) { $userIds += $m.principalId }
            }
        }
    }
}

$resourcesResp = Get-Json "/resources?limit=$SampleSize"
$resourceIds   = @(($resourcesResp.data  | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)

$identitiesResp = Get-Json "/identities?limit=$SampleSize"
$identityIds    = @(($identitiesResp.data | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)

# Business roles: sample from /resources?resourceType=BusinessRole (first few)
$brResp = Get-Json "/resources?limit=$SampleSize&resourceType=BusinessRole"
$brIds  = @(($brResp.data | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)

Write-Host ("    users:         {0}" -f $userIds.Count)
Write-Host ("    resources:     {0}" -f $resourceIds.Count)
Write-Host ("    identities:    {0}" -f $identityIds.Count)
Write-Host ("    businessRoles: {0}" -f $brIds.Count)

if ($userIds.Count -eq 0 -and $resourceIds.Count -eq 0 -and $identityIds.Count -eq 0) {
    Record 'EntityGraphNodes/HasData' $false 'no sample entities returned by the API — load demo or run the crawler first'
    exit 1
}

# ── User graph nodes ─────────────────────────────────────────────────
Write-Host "`n  -- User graph nodes --" -ForegroundColor Gray
foreach ($uid in $userIds) {
    $core = Get-Json "/user/$uid"
    if (Test-IsError $core) { Record "User/$uid/Core" $false "HTTP $($core.__statusCode): $($core.__error)"; continue }
    $userName = $core.attributes.displayName

    # Node → (expected count source, list endpoint, filter in list)
    $specs = @(
        @{ node='manager';           count = $(if ($core.attributes.managerId) { 1 } else { 0 });                       url = "/org-chart/user/$uid/manager";     unwrap = 'manager' }
        @{ node='reports';           count = $core.directReportCount;                                                    url = "/org-chart/user/$uid/reports";      unwrap = 'reports' }
        @{ node='context';           count = $(if ($core.attributes.contextId) { 1 } else { 0 });                        url = "/contexts/$($core.attributes.contextId)"; unwrap = 'attributes' }
        @{ node='groups-direct';     count = $core.membershipByType.Direct;                                              url = "/user/$uid/memberships";            filter = 'Direct' }
        @{ node='groups-indirect';   count = $core.membershipByType.Indirect;                                            url = "/user/$uid/memberships";            filter = 'Indirect' }
        @{ node='groups-owner';      count = $core.membershipByType.Owner;                                               url = "/user/$uid/memberships";            filter = 'Owner' }
        @{ node='groups-eligible';   count = $core.membershipByType.Eligible;                                            url = "/user/$uid/memberships";            filter = 'Eligible' }
        @{ node='access-packages';   count = $core.accessPackageCount;                                                   url = "/user/$uid/access-packages" }
        @{ node='oauth2-grants';     count = $core.oauth2GrantCount;                                                     url = "/user/$uid/oauth2-grants" }
    )

    foreach ($spec in $specs) {
        if ([int]$spec.count -le 0) { continue }  # only test active nodes — dimmed ones stay dim

        $resp = Get-Json $spec.url
        if (Test-IsError $resp) { Record "User/$userName/$($spec.node)/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; continue }

        $rows = $resp
        if ($spec.unwrap)    { $rows = $resp.$($spec.unwrap) }
        elseif ($spec.unwrapObj) { $rows = if ($resp) { @($resp) } else { @() } }
        if ($spec.filter)    { $rows = @($rows | Where-Object { $_.membershipType -eq $spec.filter }) }

        $rowCount = if ($rows -is [array]) { $rows.Count } elseif ($rows) { 1 } else { 0 }
        Record "User/$userName/$($spec.node)/Clickable" ($rowCount -gt 0) "count=$($spec.count) rows=$rowCount"

        if ($rowCount -gt 0) {
            $firstRow = if ($rows -is [array]) { $rows[0] } else { $rows }
            $name = Get-DisplayNameField $firstRow
            Record "User/$userName/$($spec.node)/RowHasName" ([bool]$name) "first row name='$name'"
        }
    }
}

# ── Resource graph nodes ─────────────────────────────────────────────
Write-Host "`n  -- Resource graph nodes --" -ForegroundColor Gray
foreach ($rid in $resourceIds) {
    $core = Get-Json "/resources/$rid"
    if (Test-IsError $core) { Record "Resource/$rid/Core" $false "HTTP $($core.__statusCode)"; continue }
    $resName = $core.attributes.displayName

    $specs = @(
        @{ node='members-direct';    count = $core.assignmentByType.Direct;    url = "/resources/$rid/assignments"; filter = 'Direct' }
        @{ node='members-governed';  count = $core.assignmentByType.Governed;  url = "/resources/$rid/assignments"; filter = 'Governed' }
        @{ node='members-owner';     count = $core.assignmentByType.Owner;     url = "/resources/$rid/assignments"; filter = 'Owner' }
        @{ node='members-eligible';  count = $core.assignmentByType.Eligible;  url = "/resources/$rid/assignments"; filter = 'Eligible' }
        @{ node='business-roles';    count = $core.accessPackageCount;         url = "/resources/$rid/business-roles" }
        @{ node='parents';           count = $core.parentResourceCount;        url = "/resources/$rid/parent-resources" }
    )

    foreach ($spec in $specs) {
        if ([int]$spec.count -le 0) { continue }
        $resp = Get-Json $spec.url
        if (Test-IsError $resp) { Record "Resource/$resName/$($spec.node)/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; continue }

        $rows = if ($spec.filter) { @($resp | Where-Object { $_.assignmentType -eq $spec.filter }) } else { $resp }
        $rowCount = if ($rows -is [array]) { $rows.Count } else { if ($rows) { 1 } else { 0 } }

        Record "Resource/$resName/$($spec.node)/Clickable" ($rowCount -gt 0) "count=$($spec.count) rows=$rowCount"
        if ($rowCount -gt 0) {
            $name = Get-DisplayNameField (($rows | Select-Object -First 1))
            Record "Resource/$resName/$($spec.node)/RowHasName" ([bool]$name) "first row name='$name'"
        }
    }
}

# ── Identity graph nodes ─────────────────────────────────────────────
Write-Host "`n  -- Identity graph nodes --" -ForegroundColor Gray
foreach ($iid in $identityIds) {
    $core = Get-Json "/identities/$iid"
    if (Test-IsError $core) { Record "Identity/$iid/Core" $false "HTTP $($core.__statusCode)"; continue }
    $idName = $core.identity.displayName

    Record "Identity/$idName/accounts/Clickable" ($core.members.Count -gt 0) "accounts=$($core.members.Count)"
    if ($core.members.Count -gt 0) {
        $m0 = $core.members[0]
        Record "Identity/$idName/accounts/RowHasName" ([bool]$m0.displayName) "first='$($m0.displayName)'"
        Record "Identity/$idName/accounts/RowHasUPN"  ([bool]$m0.userPrincipalName) "upn='$($m0.userPrincipalName)'"
    }

    $agg = $core.aggregateAssignments
    foreach ($type in 'Direct','Governed','Owner','Eligible','OAuth2Grant') {
        $count = [int]($agg.$type)
        if ($count -le 0) { continue }
        $resp = Get-Json "/identities/$iid/assignments?type=$type"
        if (Test-IsError $resp) { Record "Identity/$idName/$type/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; continue }
        $rowCount = if ($resp -is [array]) { $resp.Count } else { if ($resp) { 1 } else { 0 } }
        Record "Identity/$idName/$type/Clickable" ($rowCount -gt 0) "count=$count rows=$rowCount"
        if ($rowCount -gt 0) {
            $name = Get-DisplayNameField $resp[0]
            Record "Identity/$idName/$type/RowHasName" ([bool]$name) "first='$name'"
        }
    }
}

# ── Business Role (Access Package) graph nodes ────────────────────────
Write-Host "`n  -- Business Role graph nodes --" -ForegroundColor Gray
foreach ($bid in $brIds) {
    $core = Get-Json "/access-package/$bid"
    if (Test-IsError $core) { Record "BR/$bid/Core" $false "HTTP $($core.__statusCode)"; continue }
    $brName = $core.attributes.displayName

    $specs = @(
        @{ node='assignments'; count = $core.assignmentCount;     url = "/access-package/$bid/assignments" }
        @{ node='resources';   count = $core.groupCount;          url = "/access-package/$bid/resource-roles" }
        @{ node='policies';    count = $core.policyCount;         url = "/access-package/$bid/policies" }
        @{ node='reviews';     count = $core.reviewCount;         url = "/access-package/$bid/reviews" }
        @{ node='requests';    count = $core.pendingRequestCount; url = "/access-package/$bid/requests" }
    )

    foreach ($spec in $specs) {
        if ([int]$spec.count -le 0) { continue }
        $resp = Get-Json $spec.url
        if (Test-IsError $resp) { Record "BR/$brName/$($spec.node)/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; continue }
        $rowCount = if ($resp -is [array]) { $resp.Count } else { if ($resp) { 1 } else { 0 } }
        Record "BR/$brName/$($spec.node)/Clickable" ($rowCount -gt 0) "count=$($spec.count) rows=$rowCount"
        if ($rowCount -gt 0) {
            $name = Get-DisplayNameField $resp[0]
            Record "BR/$brName/$($spec.node)/RowHasName" ([bool]$name) "first='$name'"
        }
    }
}

Write-Host ("`n  Results: {0} pass / {1} fail" -f $passes, $failures) -ForegroundColor $(if ($failures -eq 0) { 'Green' } else { 'Red' })
exit $failures
