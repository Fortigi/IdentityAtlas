<#
.SYNOPSIS
    End-to-end integration test for the SCIM 2.0 crawler.

.DESCRIPTION
    Starts a mock SCIM 2.0 server, runs SCIM crawler jobs through the Identity Atlas
    dispatch pipeline, and verifies that the right data landed in the database.

    Covers the fixture-backed acceptance criteria:
      0  feature gate    — creating a SCIM config is refused while experimental crawlers are off
      1  happy path      — users, groups, Direct memberships, Contains nesting, Indirect rows
      2  opt-in picker   — only the selected extra attribute is stored
      3  active:false    — the account lands disabled
      4  idempotency     — a second identical run updates rather than duplicates
      5  stale delete    — a user removed at the source is removed here, another system untouched
      6  pagination      — 25 users at count=10 is three advancing requests and 25 rows
      7  empty endpoint  — an emptied source clears its rows and the job still succeeds
      8  error paths     — a 401 fails the job; an unresolvable member does not
      9  delta request   — runs as a full sync

    Requires the full Identity Atlas Docker stack (postgres + web API + worker).

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL. Default: http://localhost:3001/api
.PARAMETER ApiKey
    Identity Atlas crawler API key (built-in worker key).
.PARAMETER WriteResult
    Optional ScriptBlock callback { param($Name,$Passed,$Detail) } for the nightly runner.
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$ApiBaseUrl            = $ApiBaseUrl.TrimEnd('/')
$standaloneFailures    = 0

. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Test-Helpers.ps1')
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Start-MockScimServer.ps1')

#region Helpers

function Invoke-AtlasApi {
    param([string]$Method, [string]$Path, [hashtable]$Body = @{})
    $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $params  = @{ Uri = "$ApiBaseUrl$Path"; Method = $Method; Headers = $headers; ErrorAction = 'Stop' }
    if ($Body.Count -gt 0) { $params['Body'] = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    return Invoke-RestMethod @params
}

function Get-Atlas {
    param([string]$Path)
    return Invoke-RestMethod -Uri "$ApiBaseUrl$Path" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
}

# Queue a job for $configId and wait for it. Returns the finished job object (or $null).
# A one-line reason for a job that did not complete — without this a failed
# assertion only said "status: failed" and the run gave no way to find out why.
function Get-JobFailureDetail {
    param($Job)
    if (-not $Job) { return '(no job)' }
    if ($Job.status -eq 'completed') { return '' }
    $msg = @($Job.errorMessage, $Job.error, $Job.statusMessage) | Where-Object { $_ } | Select-Object -First 1
    if (-not $msg) { $msg = '(no error message on the job row)' }
    return " — $msg"
}

function Invoke-ScimJob {
    param([int]$ConfigId, [string]$SyncMode = 'full', [int]$TimeoutSec = 180)
    $body = @{ jobType = 'scim'; configId = $ConfigId }
    if ($SyncMode -ne 'full') { $body['syncMode'] = $SyncMode }
    $job = Invoke-AtlasApi -Method POST -Path '/admin/crawler-jobs' -Body $body
    return (Wait-JobComplete -JobId $job.id -TimeoutSec $TimeoutSec)
}

# The Identity Atlas system this run created, found by its unique display name.
function Get-ScimSystemId {
    param([string]$SystemName)
    $systems = Get-Atlas '/systems'
    $hit = @($systems) | Where-Object { $_.displayName -eq $SystemName } | Select-Object -First 1
    if ($hit) { return [int]$hit.id }
    return 0
}

function Get-SystemPrincipals {
    param([int]$SystemId)
    # GET /api/users has NO systemId query filter — parseListParams reads only
    # search/limit/offset/filters, so an unknown ?systemId= is silently ignored.
    # This used to pass it anyway, which scoped nothing: the assertions counted
    # every principal in a database shared with the other crawler integration
    # tests running in parallel, and drifted (56 -> 94 -> 200) as those ingested.
    # Scope by this run's unique tag, the way every other crawler test does
    # (midpoint: search=midpoint.citest, omada: search=integration.testuser),
    # then split by systemId — which each row does carry.
    $resp = Get-Atlas "/users?search=$script:runTag&limit=500"
    $rows = if ($resp.users) { @($resp.users) } elseif ($resp.data) { @($resp.data) } else { @($resp) }
    return @($rows | Where-Object { [int]$_.systemId -eq $SystemId })
}

function Get-SystemResources {
    param([int]$SystemId)
    $resp = Get-Atlas "/resources?systemId=$SystemId&limit=200"
    if ($resp.data) { return @($resp.data) }
    return @($resp)
}

function New-ScimConfig {
    param([string]$Name, [int]$Port, [hashtable]$Extra = @{})
    $config = @{
        baseUrl    = "http://host.docker.internal:$Port"
        authMethod = 'BasicAuth'
        username   = 'scim'
        password   = 'test'
        systemName = $Name
        pageSize   = 100
    }
    foreach ($kv in $Extra.GetEnumerator()) { $config[$kv.Key] = $kv.Value }
    $cfg = Invoke-AtlasApi -Method POST -Path '/admin/crawler-configs' -Body @{ crawlerType = 'scim'; displayName = $Name; config = $config }
    return $cfg.id
}

function Set-ExperimentalCrawlers {
    param([bool]$Enabled)
    Invoke-AtlasApi -Method POST -Path '/admin/features/toggle' `
        -Body @{ feature = 'experimentalCrawlers'; enabled = $Enabled } | Out-Null
}

function Get-AtlasRows {
    param([string]$Path)
    # For endpoints that answer with a bare JSON array. @(Get-Atlas ...) around
    # one of those yields a SINGLE element holding every row rather than one
    # element per row: each property then reads as an array, so a Where-Object
    # filter matches that one object no matter what it contains and .Count
    # always reports 1. Piping unrolls it, so counts and filters mean what they
    # say. The comma keeps an empty or single-row result an array.
    $rows = @()
    Get-Atlas $Path | ForEach-Object { $rows += $_ }
    return ,$rows
}

function Format-AssignmentRows {
    param($Rows)
    $items = @()
    foreach ($r in @($Rows)) {
        $name = if ($r.principalDisplayName) { $r.principalDisplayName } else { $r.principalId }
        $items += "$name/$($r.principalType)"
    }
    if ($items.Count -eq 0) { return '0[]' }
    return "$($items.Count)[$($items -join '; ')]"
}

#endregion Helpers

Write-Host "`n=== SCIM Crawler Integration Test ===" -ForegroundColor Cyan

$runTag     = [guid]::NewGuid().ToString('N').Substring(0, 8)
$systemName = "scim-it-$runTag"
$otherName  = "scim-it-other-$runTag"

# ── Fixture: 3 users, 2 groups (Inner nested in Outer), one unresolvable member ──
$uAlice = "u-alice-$runTag"
$uBob   = "u-bob-$runTag"
$uSvc   = "u-svc-$runTag"
$gOuter = "g-outer-$runTag"
$gInner = "g-inner-$runTag"

$users = @(
    @{ id = $uAlice; userName = "alice.$runTag"; displayName = "Alice $runTag"; active = $true
       userType = 'employee'; department = 'Finance'; title = 'Analyst'; costCenter = 'CC-42'
       name = @{ givenName = 'Alice'; familyName = 'Anderson' }
       emails = @( @{ value = "alias.$runTag@example.com"; type = 'other' }, @{ value = "alice.$runTag@example.com"; primary = $true } ) }
    @{ id = $uBob; userName = "bob.$runTag"; displayName = "Bob $runTag"; active = $false
       userType = 'employee'; department = 'HR' }
    @{ id = $uSvc; userName = "svc.$runTag"; displayName = "Service $runTag"; active = $true
       userType = 'service'; department = 'IT' }
)
$groups = @(
    @{ id = $gOuter; displayName = "Outer $runTag"; members = @(
        @{ value = $uAlice; type = 'User' }
        @{ value = $gInner; type = 'Group' }
        @{ value = "device-$runTag" }          # matches no synced user or group
    ) }
    @{ id = $gInner; displayName = "Inner $runTag"; members = @( @{ value = $uBob }, @{ value = $uSvc } ) }
)

# ── AC0: the experimental-crawler gate ───────────────────────────────────────
# SCIM ships as an experimental crawler, so with the flag OFF the API must refuse
# to create a config for it. Asserted first, and it also leaves the flag in the
# state the rest of this file needs. Restored to OFF in the finally block so a
# stack this test ran against is not left with the feature silently switched on.
#
# Note the CI stack sets FEATURE_EXPERIMENTAL_CRAWLERS=true (docker-compose.ci.yml),
# so the stored override below has to actually BEAT that env var for this to pass —
# which is the precedence rule worth asserting, not an accident of the default.
Set-ExperimentalCrawlers -Enabled $false
try {
    Invoke-AtlasApi -Method POST -Path '/admin/crawler-configs' `
        -Body @{ crawlerType = 'scim'; displayName = "scim-gate-$runTag"; config = @{ baseUrl = 'http://localhost:1'; authMethod = 'ApiToken'; apiToken = 'x' } } | Out-Null
    Write-Result 'Scim/Gate — refused while experimental crawlers are off' $false '(the config was created anyway)'
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Write-Result 'Scim/Gate — refused while experimental crawlers are off' ($status -eq 403) "(HTTP $status; expected 403)"
}
Set-ExperimentalCrawlers -Enabled $true

$mock = $null; $configId = $null; $otherConfigId = $null; $pagingMock = $null; $pagingConfigId = $null; $authMock = $null; $authConfigId = $null
try {
    $mock = Start-MockScimServer -Users $users -Groups $groups
    Write-Host "  Mock SCIM server started on port $($mock.Port)" -ForegroundColor Gray

    $configId = New-ScimConfig -Name $systemName -Port $mock.Port -Extra @{
        selectedAttributes = @{ user = @('department'); group = @() }
        userTypeMapping    = @(
            @{ userType = 'service'; principalType = 'ServicePrincipal' }
            @{ userType = '';        principalType = 'User' }
        )
    }
    Write-Host "  Crawler config registered: $configId" -ForegroundColor Gray

    # ── AC1: happy path ──────────────────────────────────────────────────────
    $completed = Invoke-ScimJob -ConfigId $configId
    if ($null -eq $completed) { Write-Result 'Scim/Job — completed within timeout' $false '(timed out)'; throw 'Job timed out' }
    Write-Result 'Scim/Job — completed successfully' ($completed.status -eq 'completed') "(status: $($completed.status))"

    $systemId = Get-ScimSystemId -SystemName $systemName
    Write-Result 'Scim/Data — system registered' ($systemId -gt 0) "(system id: $systemId)"

    $principals = Get-SystemPrincipals -SystemId $systemId
    Write-Result 'Scim/Data — 3 principals ingested' ($principals.Count -eq 3) "($($principals.Count) principal(s); expected 3)"

    $resources = Get-SystemResources -SystemId $systemId
    $groupRes  = @($resources | Where-Object { $_.resourceType -eq 'Group' })
    Write-Result 'Scim/Data — 2 group resources ingested' ($groupRes.Count -eq 2) "($($groupRes.Count) group(s); expected 2)"

    # ── AC1: Direct + Indirect assignments and the Contains nesting ──────────
    # Rows are keyed on the deterministic UUID derived from the SCIM id, not the raw
    # id, so look each group up by externalId rather than assuming its primary key.
    $outerRow = @($groupRes | Where-Object { $_.externalId -eq $gOuter }) | Select-Object -First 1
    $innerRow = @($groupRes | Where-Object { $_.externalId -eq $gInner }) | Select-Object -First 1
    try {
        $outerAssign = Get-AtlasRows "/resources/$($outerRow.id)/assignments"
        $innerAssign = Get-AtlasRows "/resources/$($innerRow.id)/assignments"

        $direct   = @($outerAssign | Where-Object { $_.assignmentType -eq 'Direct' })
        $indirect = @($outerAssign | Where-Object { $_.assignmentType -eq 'Indirect' })
        # Outer: Alice Direct; Bob + Service Indirect (reached through Inner).
        $innerDirect = @($innerAssign | Where-Object { $_.assignmentType -eq 'Direct' })
        $ok = ($direct.Count -eq 1) -and ($indirect.Count -eq 2) -and ($innerDirect.Count -eq 2)
        # Name WHO landed, not just how many: when this is wrong it is always a
        # specific member missing or duplicated, and a count never said which.
        # Built with an explicit foreach — interpolating the collection renders
        # every row into ONE string and hides how many rows there actually are.
        Write-Result 'Scim/Data — Direct memberships + Indirect rows from nesting' $ok `
            "(outer[$($outerRow.id)] Direct=$(Format-AssignmentRows $direct) Indirect=$(Format-AssignmentRows $indirect); inner[$($innerRow.id)] Direct=$(Format-AssignmentRows $innerDirect) — expected 1/2/2)"
    } catch { Write-Result 'Scim/Data — Direct memberships + Indirect rows from nesting' $false $_.Exception.Message }

    try {
        $parents = Get-AtlasRows "/resources/$($innerRow.id)/parent-resources"
        $contains = @($parents | Where-Object { $_.relationshipType -eq 'Contains' -and $_.parentResourceId -eq $outerRow.id })
        Write-Result 'Scim/Data — a nested group became a Contains relationship' ($contains.Count -eq 1) `
            "($($contains.Count) Contains edge(s) from Outer to Inner; expected 1)"
    } catch { Write-Result 'Scim/Data — a nested group became a Contains relationship' $false $_.Exception.Message }

    # ── AC2 + AC3 + AC10: opt-in attributes, active:false, userType mapping ──
    try {
        $alice = @($principals | Where-Object { $_.externalId -eq $uAlice }) | Select-Object -First 1
        $bob   = @($principals | Where-Object { $_.externalId -eq $uBob })   | Select-Object -First 1
        $svc   = @($principals | Where-Object { $_.externalId -eq $uSvc })   | Select-Object -First 1

        $ext = $alice.extendedAttributes
        if ($ext -is [string]) { $ext = $ext | ConvertFrom-Json }
        # 'department' is a real Principals column, so an opted-IN department is
        # normalised into that column rather than extendedAttributes — assert it
        # wherever it legitimately lands. 'costCenter' has no column, so an
        # opted-OUT one must appear nowhere: that is the half that discriminates.
        $hasSelected   = ($alice.department -eq 'Finance') -or ($ext.department -eq 'Finance')
        $hasUnselected = ($null -ne $ext.costCenter) -or ($null -ne $alice.costCenter)
        Write-Result 'Scim/Data — only the opt-in attribute is stored' ($hasSelected -and -not $hasUnselected) `
            "(department: '$($alice.department)$($ext.department)', costCenter present: $hasUnselected — expected 'Finance' / False)"

        # GET /api/users selects u."email" AS "userPrincipalName" — reading
        # .email off the response always yielded empty, which is why this failed
        # while the e-mail was in fact mapped correctly.
        $aliceEmail = $alice.userPrincipalName
        Write-Result 'Scim/Data — core mapping populated (display name, e-mail, name parts)' `
            ($alice.displayName -eq "Alice $runTag" -and $aliceEmail -eq "alice.$runTag@example.com" -and $alice.givenName -eq 'Alice') `
            "(display: '$($alice.displayName)', email: '$aliceEmail' — expected the primary e-mail, not the first)"

        Write-Result 'Scim/Data — active:false maps to a disabled account' ($bob.accountEnabled -eq $false) "(accountEnabled: $($bob.accountEnabled))"
        Write-Result 'Scim/Data — userType mapping drives principalType' `
            ($svc.principalType -eq 'ServicePrincipal' -and $alice.principalType -eq 'User') `
            "(service: '$($svc.principalType)', employee: '$($alice.principalType)')"
    } catch { Write-Result 'Scim/Data — attribute + type mapping' $false $_.Exception.Message }

    # ── AC5 prep: a SECOND SCIM system that must stay untouched ─────────────
    $otherMockUsers = @( @{ id = "u-other-$runTag"; userName = "other.$runTag"; displayName = "Other $runTag"; active = $true } )
    $otherMock = Start-MockScimServer -Users $otherMockUsers -Groups @()
    try {
        $otherConfigId = New-ScimConfig -Name $otherName -Port $otherMock.Port
        $otherJob = Invoke-ScimJob -ConfigId $otherConfigId
        $otherSystemId = Get-ScimSystemId -SystemName $otherName
        $otherPrincipals = Get-SystemPrincipals -SystemId $otherSystemId
        Write-Result 'Scim/Scoping — second SCIM system ingested' (($otherJob.status -eq 'completed') -and ($otherPrincipals.Count -eq 1)) `
            "(system $otherSystemId, status: $($otherJob.status)$(Get-JobFailureDetail $otherJob), $($otherPrincipals.Count) principal(s); expected 1)"

        # ── AC4: idempotency — an identical second run must not duplicate ────
        $second = Invoke-ScimJob -ConfigId $configId
        $afterSecond = Get-SystemPrincipals -SystemId $systemId
        Write-Result 'Scim/Idempotency — a repeated run updates rather than duplicates' `
            (($second.status -eq 'completed') -and ($afterSecond.Count -eq 3)) "(status: $($second.status)$(Get-JobFailureDetail $second), $($afterSecond.Count) principal(s) after run 2; expected 3)"

        # ── AC5: a user removed at the source is reconciled away ─────────────
        # The mock's data is swapped in place (same port, same base URL) so the
        # crawler keeps writing to the SAME Identity Atlas system — restarting on a
        # new port would create a second system and the delete assertions below
        # would be looking at rows nothing had touched.
        Set-MockScimData -Mock $mock -Users @($users[0], $users[2]) -Groups $groups   # Bob removed
        $third = Invoke-ScimJob -ConfigId $configId
        $afterDelete = Get-SystemPrincipals -SystemId $systemId
        $bobGone = @($afterDelete | Where-Object { $_.externalId -eq $uBob }).Count -eq 0
        Write-Result 'Scim/Reconcile — a user removed at the source is deleted here' `
            (($third.status -eq 'completed') -and $bobGone -and ($afterDelete.Count -eq 2)) `
            "(status: $($third.status)$(Get-JobFailureDetail $third), $($afterDelete.Count) principal(s), Bob gone: $bobGone — expected 2 / True)"
        Write-Result 'Scim/Reconcile — the other SCIM system is untouched' `
            ((Get-SystemPrincipals -SystemId $otherSystemId).Count -eq 1) "(expected 1 principal in system $otherSystemId)"

        # ── AC7: an emptied endpoint clears its rows, job still succeeds ─────
        Set-MockScimData -Mock $mock -Users @() -Groups @()
        $fourth = Invoke-ScimJob -ConfigId $configId
        $afterEmpty = Get-SystemPrincipals -SystemId $systemId
        $resAfterEmpty = @((Get-SystemResources -SystemId $systemId) | Where-Object { $_.resourceType -eq 'Group' })
        Write-Result 'Scim/Reconcile — an emptied endpoint clears its rows and still succeeds' `
            (($fourth.status -eq 'completed') -and ($afterEmpty.Count -eq 0) -and ($resAfterEmpty.Count -eq 0)) `
            "(status: $($fourth.status)$(Get-JobFailureDetail $fourth), $($afterEmpty.Count) principals, $($resAfterEmpty.Count) groups — all expected 0)"
        Write-Result 'Scim/Reconcile — the other SCIM system survives an empty sync' `
            ((Get-SystemPrincipals -SystemId $otherSystemId).Count -eq 1) "(expected 1)"
    } finally {
        if ($otherConfigId) { try { Invoke-AtlasApi -Method DELETE -Path "/admin/crawler-configs/$otherConfigId" | Out-Null } catch {} }
        Stop-MockScimServer -Mock $otherMock
    }

    # ── AC6: pagination — 25 users at count=10 is three advancing requests ───
    $pagedUsers = @(1..25 | ForEach-Object { @{ id = "u-page$_-$runTag"; userName = "page$_.$runTag"; displayName = "Page $_ $runTag"; active = $true } })
    $pagingMock = Start-MockScimServer -Users $pagedUsers -Groups @()
    $pagingName = "scim-it-paging-$runTag"
    try {
        $pagingConfigId = New-ScimConfig -Name $pagingName -Port $pagingMock.Port -Extra @{ pageSize = 10 }
        $pagingJob = Invoke-ScimJob -ConfigId $pagingConfigId
        $pagingSystemId = Get-ScimSystemId -SystemName $pagingName
        $pagedPrincipals = Get-SystemPrincipals -SystemId $pagingSystemId
        Write-Result 'Scim/Paging — every page is walked (25 users at count=10)' `
            (($pagingJob.status -eq 'completed') -and ($pagedPrincipals.Count -eq 25)) "(status: $($pagingJob.status)$(Get-JobFailureDetail $pagingJob), $($pagedPrincipals.Count) principal(s); expected 25)"

        $requests = @(Get-MockScimRequests -Mock $pagingMock | Where-Object { $_ -like '/Users*' })
        $expected = @('/Users?startIndex=1&count=10', '/Users?startIndex=11&count=10', '/Users?startIndex=21&count=10')
        $ok = ($requests.Count -eq 3) -and (-not (Compare-Object $requests $expected -SyncWindow 0))
        Write-Result 'Scim/Paging — exactly three requests with an advancing startIndex' $ok "(requests: $($requests -join ', '))"

        # ── AC9: a delta request runs as a full sync ─────────────────────────
        $deltaJob = Invoke-ScimJob -ConfigId $pagingConfigId -SyncMode 'delta'
        $afterDelta = Get-SystemPrincipals -SystemId $pagingSystemId
        Write-Result 'Scim/Delta — a delta request completes as a full sync' `
            (($deltaJob.status -eq 'completed') -and ($afterDelta.Count -eq 25)) "(status: $($deltaJob.status)$(Get-JobFailureDetail $deltaJob), $($afterDelta.Count) principal(s))"
    } finally {
        if ($pagingConfigId) { try { Invoke-AtlasApi -Method DELETE -Path "/admin/crawler-configs/$pagingConfigId" | Out-Null } catch {} }
        Stop-MockScimServer -Mock $pagingMock
        $pagingMock = $null
    }

    # ── AC8: a 401 from the endpoint fails the job with a clear message ──────
    $authMock = Start-MockScimServer -Users $users -Groups @() -Require401
    try {
        $authConfigId = New-ScimConfig -Name "scim-it-401-$runTag" -Port $authMock.Port
        $authJob = Invoke-ScimJob -ConfigId $authConfigId
        $msg = "$($authJob.errorMessage) $($authJob.error)"
        $ok  = ($authJob.status -eq 'failed') -and ($msg -notmatch 'test')   # the password must not be echoed
        Write-Result 'Scim/Errors — a 401 fails the job without echoing the credential' $ok "(status: $($authJob.status))"
    } finally {
        if ($authConfigId) { try { Invoke-AtlasApi -Method DELETE -Path "/admin/crawler-configs/$authConfigId" | Out-Null } catch {} }
        Stop-MockScimServer -Mock $authMock
        $authMock = $null
    }

} catch {
    Write-Host "  Fatal test error: $($_.Exception.Message)" -ForegroundColor Red
    $script:standaloneFailures++
} finally {
    if ($configId)  { try { Invoke-AtlasApi -Method DELETE -Path "/admin/crawler-configs/$configId" | Out-Null } catch {} }
    try { Set-ExperimentalCrawlers -Enabled $false } catch {}
    if ($mock)       { Stop-MockScimServer -Mock $mock }
    if ($pagingMock) { Stop-MockScimServer -Mock $pagingMock }
    if ($authMock)   { Stop-MockScimServer -Mock $authMock }
}

Write-Host ''
if (-not $WriteResult) {
    if ($standaloneFailures -gt 0) { Write-Host "SCIM integration tests: $standaloneFailures FAILED" -ForegroundColor Red; exit 1 }
    else { Write-Host 'SCIM integration tests: all passed' -ForegroundColor Green; exit 0 }
}
