<#
.SYNOPSIS
    End-to-end integration test for the midPoint crawler.

.DESCRIPTION
    Starts a mock midPoint REST server, runs a full midPoint crawler job through the
    Identity Atlas dispatch pipeline, and verifies that data landed in the database.

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
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Start-MockMidpointServer.ps1')

function Invoke-AtlasApi {
    param([string]$Method, [string]$Path, [hashtable]$Body = @{})
    $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $params  = @{ Uri = "$ApiBaseUrl$Path"; Method = $Method; Headers = $headers; ErrorAction = 'Stop' }
    if ($Body.Count -gt 0) { $params['Body'] = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    return Invoke-RestMethod @params
}

function Wait-JobComplete {
    param([int]$JobId, [int]$TimeoutSec = 120)
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSec)
    while ([datetime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 3
        $j = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/crawler-jobs/$JobId" `
            -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction SilentlyContinue
        if ($j.status -in @('completed', 'failed')) { return $j }
    }
    return $null
}

Write-Host "`n=== midPoint Crawler Integration Test ===" -ForegroundColor Cyan

# ── Mock fixtures (unique names so assertions can't be satisfied by other data) ──
$orgOid  = 'aaaa1111-0000-4000-8000-000000000001'
$roleOid = 'aaaa1111-0000-4000-8000-000000000002'
$svcOid  = 'aaaa1111-0000-4000-8000-000000000003'
$userOid = 'aaaa1111-0000-4000-8000-000000000004'
$resOid  = 'aaaa1111-0000-4000-8000-000000000005'
$acctOid = 'aaaa1111-0000-4000-8000-000000000006'
$entOid  = 'aaaa1111-0000-4000-8000-000000000007'

$mockObjects = @{
    resources = @(@{ oid = $resOid; name = 'midpoint-ci-resource' })
    orgs      = @(@{ oid = $orgOid; name = 'midpoint-ci-org'; displayName = 'midPoint CI Org' })
    roles     = @(@{ oid = $roleOid; name = 'midpoint-ci-role'; displayName = 'midPoint CI Role' })
    services  = @(@{ oid = $svcOid; name = 'midpoint-ci-service'; displayName = 'midPoint CI Service' })
    users     = @(@{
        oid = $userOid; name = 'midpoint.citest'; fullName = 'midPoint CITest'
        givenName = 'midPoint'; familyName = 'CITest'; emailAddress = 'midpoint.citest@example.com'
        activation = @{ effectiveStatus = 'enabled' }
        assignment   = @( @{ targetRef = @{ oid = $roleOid; type = 'RoleType' } } )
        parentOrgRef = @{ oid = $orgOid; type = 'OrgType' }
        linkRef      = @{ oid = $acctOid; type = 'ShadowType' }
    })
    # An account shadow (→ Principal) with an association to an entitlement shadow (→ Resource),
    # plus a generic shadow that MUST be skipped (not imported as a user).
    shadows = @(
        @{ oid = $acctOid; name = 'midpoint.citest@ci'; kind = 'account'; resourceRef = @{ oid = $resOid; type = 'ResourceType' }
           association = @( @{ name = 'ri:group'; shadowRef = @{ oid = $entOid; type = 'ShadowType' } } ) }
        @{ oid = $entOid; name = 'CN=midPoint CI Entitlement,OU=Groups'; kind = 'entitlement'; resourceRef = @{ oid = $resOid; type = 'ResourceType' } }
        @{ oid = 'aaaa1111-0000-4000-8000-000000000008'; name = '99999'; kind = 'generic'; resourceRef = @{ oid = $resOid; type = 'ResourceType' } }
    )
}

$mock = $null; $configId = $null
try {
    $mock = Start-MockMidpointServer -Objects $mockObjects
    Write-Host "  Mock midPoint server started on port $($mock.Port)" -ForegroundColor Gray

    $runTag  = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $config  = @{ baseUrl = "http://host.docker.internal:$($mock.Port)/midpoint"; authMethod = 'BasicAuth'; username = 'administrator'; password = 'test'; pageSize = 100 }
    try {
        $cfg = Invoke-AtlasApi -Method POST -Path '/admin/crawler-configs' -Body @{ crawlerType = 'midpoint'; displayName = "midpoint-it-$runTag"; config = $config }
        $configId = $cfg.id
        Write-Host "  Crawler config registered: $configId" -ForegroundColor Gray
    } catch { Report-Result 'Midpoint/Setup — register crawler config' $false $_.Exception.Message; throw }

    $job = Invoke-AtlasApi -Method POST -Path '/admin/crawler-jobs' -Body @{ jobType = 'midpoint'; configId = $configId }
    Write-Host "  Job queued: $($job.id)" -ForegroundColor Gray

    $completed = Wait-JobComplete -JobId $job.id -TimeoutSec 120
    if ($null -eq $completed) { Report-Result 'Midpoint/Job — completed within 120s' $false '(timed out)'; throw 'Job timed out' }
    Report-Result 'Midpoint/Job — completed successfully' ($completed.status -eq 'completed') "(status: $($completed.status))"

    # ── Assert: midPoint system registered (identified by the unique mock port) ──
    $thisSystem = $null
    try {
        $systems    = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $thisSystem = @($systems) | Where-Object { $_.displayName -like "*:$($mock.Port)*" } | Select-Object -First 1
        Report-Result 'Midpoint/Data — system registered' ($null -ne $thisSystem) "$(if ($thisSystem) { "($($thisSystem.displayName))" } else { '(not found)' })"
    } catch { Report-Result 'Midpoint/Data — system registered' $false $_.Exception.Message }

    # ── Assert: user principal ingested (unique email) ──
    try {
        $usersResp = Invoke-RestMethod -Uri "$ApiBaseUrl/users?search=midpoint.citest&limit=5" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $cnt = if ($usersResp.users) { $usersResp.users.Count } elseif ($usersResp.data) { $usersResp.data.Count } elseif ($usersResp -is [array]) { $usersResp.Count } else { 0 }
        Report-Result 'Midpoint/Data — user principal ingested' ($cnt -ge 1) "($cnt matching 'midpoint.citest')"
    } catch { Report-Result 'Midpoint/Data — user principal ingested' $false $_.Exception.Message }

    # ── Assert: role resource ingested (scoped to this run's system) ──
    try {
        $sid = if ($thisSystem) { $thisSystem.id } else { 0 }
        $res = Invoke-RestMethod -Uri "$ApiBaseUrl/resources?systemId=$sid&limit=20" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $rcnt = if ($res.data) { $res.data.Count } elseif ($res -is [array]) { $res.Count } else { 0 }
        Report-Result 'Midpoint/Data — resource ingested' ($rcnt -ge 1) "($rcnt resource(s) in system $sid)"
    } catch { Report-Result 'Midpoint/Data — resource ingested' $false $_.Exception.Message }

    # ── Assert: entitlement shadow became a Resource (Entitlement), not a user ──
    try {
        $sid = if ($thisSystem) { $thisSystem.id } else { 0 }
        $res = Invoke-RestMethod -Uri "$ApiBaseUrl/resources?systemId=$sid&limit=50" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $list = if ($res.data) { $res.data } elseif ($res -is [array]) { $res } else { @() }
        $ent  = @($list) | Where-Object { $_.resourceType -eq 'Entitlement' } | Select-Object -First 1
        Report-Result 'Midpoint/Data — entitlement mapped as resource (not user)' ($null -ne $ent) "$(if ($ent) { "($($ent.displayName))" } else { '(no Entitlement resource)' })"
    } catch { Report-Result 'Midpoint/Data — entitlement mapped as resource' $false $_.Exception.Message }

} catch {
    Write-Host "  Fatal test error: $($_.Exception.Message)" -ForegroundColor Red
    $script:standaloneFailures++
} finally {
    if ($configId) { try { Invoke-AtlasApi -Method DELETE -Path "/admin/crawler-configs/$configId" | Out-Null } catch {} }
    if ($mock) { Stop-MockMidpointServer -Mock $mock }
}

Write-Host ''
if (-not $WriteResult) {
    if ($standaloneFailures -gt 0) { Write-Host "midPoint integration tests: $standaloneFailures FAILED" -ForegroundColor Red; exit 1 }
    else { Write-Host 'midPoint integration tests: all passed' -ForegroundColor Green; exit 0 }
}
