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

# Normalise a list/scalar/null response into a row count without
# unrolling surprises: array -> element count, single object -> 1, else 0.
function Get-RowCount($Rows) {
    if ($Rows -is [array]) { return $Rows.Count }
    if ($Rows) { return 1 }
    return 0
}

# ── Sampling ─────────────────────────────────────────────────────────
# Pull member principalIds out of an identity's detail response, stopping
# once we have enough. Returns the (possibly grown) accumulator.
function Add-MemberPrincipalIds([array]$Acc, $Detail) {
    foreach ($m in $Detail.members) {
        if ($Acc.Count -ge $SampleSize) { break }
        if ($m.principalId) { $Acc += $m.principalId }
    }
    return ,$Acc
}

# Fallback user sampling: the permissions endpoint requires auth in some
# configurations. Pull member principalIds out of the identity detail
# responses — every identity has at least one linked account even when the
# summary row doesn't expose the primary account directly.
function Get-SampleUserIdsFromIdentities {
    $userIds = @()
    $idents = Get-Json "/identities?limit=10"
    if ((Test-IsError $idents) -or -not $idents.data) { return ,$userIds }
    foreach ($row in $idents.data) {
        if ($userIds.Count -ge $SampleSize) { break }
        $detail = Get-Json "/identities/$($row.id)"
        if (Test-IsError $detail) { continue }
        $userIds = Add-MemberPrincipalIds $userIds $detail
    }
    return ,$userIds
}

function Get-SampleUserIds {
    $usersResp = Get-Json "/permissions/users?limit=$SampleSize"
    $userIds = @()
    if (-not (Test-IsError $usersResp) -and $usersResp.users) {
        $userIds = @(($usersResp.users | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)
    }
    if ($userIds.Count -eq 0) {
        $userIds = Get-SampleUserIdsFromIdentities
    }
    return ,$userIds
}

# Sample up to SampleSize entities of each kind from the running stack.
function Get-EntitySamples {
    $userIds = Get-SampleUserIds

    $resourcesResp = Get-Json "/resources?limit=$SampleSize"
    $resourceIds   = @(($resourcesResp.data  | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)

    $identitiesResp = Get-Json "/identities?limit=$SampleSize"
    $identityIds    = @(($identitiesResp.data | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)

    # Business roles: sample from /resources?resourceType=BusinessRole (first few)
    $brResp = Get-Json "/resources?limit=$SampleSize&resourceType=BusinessRole"
    $brIds  = @(($brResp.data | Where-Object { $_.id }) | Select-Object -First $SampleSize -ExpandProperty id)

    return @{
        UserIds     = @($userIds)
        ResourceIds = @($resourceIds)
        IdentityIds = @($identityIds)
        BrIds       = @($brIds)
    }
}

# ── User graph nodes ─────────────────────────────────────────────────
function Invoke-UserNodeSpec([string]$UserName, $Spec) {
    if ([int]$Spec.count -le 0) { return }  # only test active nodes — dimmed ones stay dim

    $resp = Get-Json $Spec.url
    if (Test-IsError $resp) { Record "User/$UserName/$($Spec.node)/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; return }

    $rows = $resp
    if ($Spec.unwrap)    { $rows = $resp.$($Spec.unwrap) }
    elseif ($Spec.unwrapObj) { $rows = if ($resp) { @($resp) } else { @() } }
    if ($Spec.filter)    { $rows = @($rows | Where-Object { $_.membershipType -eq $Spec.filter }) }

    $rowCount = Get-RowCount $rows
    Record "User/$UserName/$($Spec.node)/Clickable" ($rowCount -gt 0) "count=$($Spec.count) rows=$rowCount"

    if ($rowCount -gt 0) {
        $name = Get-DisplayNameField (@($rows)[0])
        Record "User/$UserName/$($Spec.node)/RowHasName" ([bool]$name) "first row name='$name'"
    }
}

function Test-UserGraphNodes([array]$UserIds) {
    Write-Host "`n  -- User graph nodes --" -ForegroundColor Gray
    foreach ($uid in $UserIds) {
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

        foreach ($spec in $specs) { Invoke-UserNodeSpec $userName $spec }
    }
}

# ── Resource graph nodes ─────────────────────────────────────────────
function Invoke-ResourceNodeSpec([string]$ResName, $Spec) {
    if ([int]$Spec.count -le 0) { return }
    $resp = Get-Json $Spec.url
    if (Test-IsError $resp) { Record "Resource/$ResName/$($Spec.node)/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; return }

    $rows = if ($Spec.filter) { @($resp | Where-Object { $_.assignmentType -eq $Spec.filter }) } else { $resp }
    $rowCount = Get-RowCount $rows

    Record "Resource/$ResName/$($Spec.node)/Clickable" ($rowCount -gt 0) "count=$($Spec.count) rows=$rowCount"
    if ($rowCount -gt 0) {
        $name = Get-DisplayNameField (($rows | Select-Object -First 1))
        Record "Resource/$ResName/$($Spec.node)/RowHasName" ([bool]$name) "first row name='$name'"
    }
}

function Test-ResourceGraphNodes([array]$ResourceIds) {
    Write-Host "`n  -- Resource graph nodes --" -ForegroundColor Gray
    foreach ($rid in $ResourceIds) {
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

        foreach ($spec in $specs) { Invoke-ResourceNodeSpec $resName $spec }
    }
}

# ── Identity graph nodes ─────────────────────────────────────────────
function Invoke-IdentityTypeNode([string]$Iid, [string]$IdName, $Agg, [string]$Type) {
    $count = [int]($Agg.$Type)
    if ($count -le 0) { return }
    $resp = Get-Json "/identities/$Iid/assignments?type=$Type"
    if (Test-IsError $resp) { Record "Identity/$IdName/$Type/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; return }
    $rowCount = Get-RowCount $resp
    Record "Identity/$IdName/$Type/Clickable" ($rowCount -gt 0) "count=$count rows=$rowCount"
    if ($rowCount -gt 0) {
        $name = Get-DisplayNameField $resp[0]
        Record "Identity/$IdName/$Type/RowHasName" ([bool]$name) "first='$name'"
    }
}

function Test-IdentityGraphNodes([array]$IdentityIds) {
    Write-Host "`n  -- Identity graph nodes --" -ForegroundColor Gray
    foreach ($iid in $IdentityIds) {
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
            Invoke-IdentityTypeNode $iid $idName $agg $type
        }
    }
}

# ── Business Role (Access Package) graph nodes ────────────────────────
function Invoke-BusinessRoleNodeSpec([string]$BrName, $Spec) {
    if ([int]$Spec.count -le 0) { return }
    $resp = Get-Json $Spec.url
    if (Test-IsError $resp) { Record "BR/$BrName/$($Spec.node)/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"; return }
    $rowCount = Get-RowCount $resp
    Record "BR/$BrName/$($Spec.node)/Clickable" ($rowCount -gt 0) "count=$($Spec.count) rows=$rowCount"
    if ($rowCount -gt 0) {
        $name = Get-DisplayNameField $resp[0]
        Record "BR/$BrName/$($Spec.node)/RowHasName" ([bool]$name) "first='$name'"
    }
}

function Test-BusinessRoleGraphNodes([array]$BrIds) {
    Write-Host "`n  -- Business Role graph nodes --" -ForegroundColor Gray
    foreach ($bid in $BrIds) {
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

        foreach ($spec in $specs) { Invoke-BusinessRoleNodeSpec $brName $spec }
    }
}

# ── Recent-changes endpoints ─────────────────────────────────────────
# Every entity detail page now fetches a relationship-change timeline;
# this probe makes sure the endpoint shape is correct for each kind
# even if the instance has no actual changes yet (empty events array
# is still a valid 200 response).
function Invoke-RecentChangeProbe($Probe) {
    $resp = Get-Json $Probe.url
    if (Test-IsError $resp) {
        Record "RecentChanges/$($Probe.kind)/Http" $false "HTTP $($resp.__statusCode) $($resp.__error)"
        return
    }
    Record "RecentChanges/$($Probe.kind)/ShapeOk"     ([bool]($resp.PSObject.Properties['events'] -and $resp.PSObject.Properties['addedCount'] -and $resp.PSObject.Properties['removedCount'])) "fields present"
    Record "RecentChanges/$($Probe.kind)/ArrayEvents" ($resp.events -is [array] -or $null -eq $resp.events) "events is array"
    Record "RecentChanges/$($Probe.kind)/SinceDays"   ([int]$resp.sinceDays -gt 0) "sinceDays=$($resp.sinceDays)"
}

function Test-RecentChangesEndpoints([array]$UserIds, [array]$ResourceIds, [array]$IdentityIds, [array]$BrIds) {
    Write-Host "`n  -- Recent-changes endpoints --" -ForegroundColor Gray

    $recentProbes = @()
    if ($UserIds.Count -gt 0)     { $recentProbes += @{ kind = 'User';     url = "/user/$($UserIds[0])/recent-changes" } }
    if ($ResourceIds.Count -gt 0) { $recentProbes += @{ kind = 'Resource'; url = "/resources/$($ResourceIds[0])/recent-changes" } }
    if ($IdentityIds.Count -gt 0) { $recentProbes += @{ kind = 'Identity'; url = "/identities/$($IdentityIds[0])/recent-changes" } }
    if ($BrIds.Count -gt 0)       { $recentProbes += @{ kind = 'BR';       url = "/access-package/$($BrIds[0])/recent-changes" } }

    foreach ($p in $recentProbes) { Invoke-RecentChangeProbe $p }
}

# ── Orchestrator ─────────────────────────────────────────────────────
function Invoke-EntityGraphNodeChecks {
    Write-Host "`n=== Entity Detail Graph Node Clickthrough ===" -ForegroundColor Cyan
    Write-Host ("  API base: {0}" -f $ApiBaseUrl)

    Write-Host "`n  Sampling entities from the running stack..." -ForegroundColor Gray
    $samples     = Get-EntitySamples
    $userIds     = @($samples.UserIds)
    $resourceIds = @($samples.ResourceIds)
    $identityIds = @($samples.IdentityIds)
    $brIds       = @($samples.BrIds)

    Write-Host ("    users:         {0}" -f $userIds.Count)
    Write-Host ("    resources:     {0}" -f $resourceIds.Count)
    Write-Host ("    identities:    {0}" -f $identityIds.Count)
    Write-Host ("    businessRoles: {0}" -f $brIds.Count)

    if ($userIds.Count -eq 0 -and $resourceIds.Count -eq 0 -and $identityIds.Count -eq 0) {
        Record 'EntityGraphNodes/HasData' $false 'no sample entities returned by the API — load demo or run the crawler first'
        return 1
    }

    Test-UserGraphNodes $userIds
    Test-ResourceGraphNodes $resourceIds
    Test-IdentityGraphNodes $identityIds
    Test-BusinessRoleGraphNodes $brIds
    Test-RecentChangesEndpoints $userIds $resourceIds $identityIds $brIds

    Write-Host ("`n  Results: {0} pass / {1} fail" -f $passes, $failures) -ForegroundColor $(if ($failures -eq 0) { 'Green' } else { 'Red' })
    return $failures
}

$code = Invoke-EntityGraphNodeChecks
exit $code
