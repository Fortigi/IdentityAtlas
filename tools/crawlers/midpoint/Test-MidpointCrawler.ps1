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
$entOid  = 'aaaa1111-0000-4000-8000-000000000007'   # reached via legacy association[]
$entOid2 = 'aaaa1111-0000-4000-8000-000000000009'   # reached via 4.9 referenceAttributes.group[]
$inhRoleOid = 'aaaa1111-0000-4000-8000-00000000000a' # NOT directly assigned — only via roleMembershipRef
$mgrRoleOid = 'aaaa1111-0000-4000-8000-00000000000b' # only a manager-relation membership → must be ignored

$mockObjects = @{
    resources = @(@{ oid = $resOid; name = 'midpoint-ci-resource' })
    orgs      = @(@{ oid = $orgOid; name = 'midpoint-ci-org'; displayName = 'midPoint CI Org' })
    roles     = @(
        # The main role grants two AD groups via construction inducements — one resolved by
        # an associationTargetSearch DN filter, one by a literal shadowRef — so both
        # construction → Contains code paths are exercised.
        @{ oid = $roleOid;    name = 'midpoint-ci-role';          displayName = 'midPoint CI Role'
           inducement = @(
               @{ construction = @{
                   resourceRef = @{ oid = $resOid; type = 'ResourceType' }; kind = 'account'; intent = 'default'
                   association = @{ ref = 'ri:group'; outbound = @{ expression = @{
                       associationTargetSearch = @{ filter = @{ equal = @{ path = 'attributes/ri:dn'; value = 'CN=midPoint CI Entitlement,OU=Groups' } } } } } }
               } }
               @{ construction = @{
                   resourceRef = @{ oid = $resOid; type = 'ResourceType' }; kind = 'account'; intent = 'default'
                   association = @{ ref = 'ri:group'; shadowRef = @{ oid = $entOid2; type = 'ShadowType' } }
               } }
           ) }
        @{ oid = $inhRoleOid; name = 'midpoint-ci-inherited-role'; displayName = 'midPoint CI Inherited Role' }
        @{ oid = $mgrRoleOid; name = 'midpoint-ci-manager-role';   displayName = 'midPoint CI Manager Role' }
    )
    services  = @(@{ oid = $svcOid; name = 'midpoint-ci-service'; displayName = 'midPoint CI Service' })
    users     = @(@{
        oid = $userOid; name = 'midpoint.citest'; fullName = 'midPoint CITest'
        givenName = 'midPoint'; familyName = 'CITest'; emailAddress = 'midpoint.citest@example.com'
        activation = @{ effectiveStatus = 'enabled' }
        assignment   = @( @{ targetRef = @{ oid = $roleOid; type = 'RoleType' } } )
        # midPoint's fully-computed membership set: the directly-assigned role plus an
        # INHERITED role (e.g. via nesting/archetype) — both default relation — and a
        # manager-relation entry that grants the role for governance, not access.
        roleMembershipRef = @(
            @{ oid = $roleOid;    relation = 'org:default'; type = 'RoleType' }   # = direct (also in assignment[])
            @{ oid = $inhRoleOid; relation = 'org:default'; type = 'RoleType' }   # inherited → grant=inherited
            @{ oid = $mgrRoleOid; relation = 'org:manager'; type = 'RoleType' }   # manager → excluded
        )
        parentOrgRef = @{ oid = $orgOid; type = 'OrgType' }
        linkRef      = @{ oid = $acctOid; type = 'ShadowType' }
    })
    # An account shadow (→ Principal) that reaches two entitlement shadows (→ Resources) two
    # different ways: the legacy association[] element AND the midPoint 4.9 native reference
    # attribute (referenceAttributes.group[]). Both must yield a Direct entitlement membership.
    # Plus a generic shadow that MUST be skipped (not imported as a user).
    shadows = @(
        @{ oid = $acctOid; name = 'midpoint.citest@ci'; kind = 'account'; resourceRef = @{ oid = $resOid; type = 'ResourceType' }
           association = @( @{ name = 'ri:group'; shadowRef = @{ oid = $entOid; type = 'ShadowType' } } )
           referenceAttributes = @{ group = @( @{ oid = $entOid2; relation = 'org:default'; type = 'ShadowType' } ) } }
        @{ oid = $entOid; name = 'CN=midPoint CI Entitlement,OU=Groups'; kind = 'entitlement'; resourceRef = @{ oid = $resOid; type = 'ResourceType' } }
        @{ oid = $entOid2; name = 'CN=midPoint CI RefAttr Group,OU=Groups'; kind = 'entitlement'; resourceRef = @{ oid = $resOid; type = 'ResourceType' } }
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
    } catch { Write-Result 'Midpoint/Setup — register crawler config' $false $_.Exception.Message; throw }

    $job = Invoke-AtlasApi -Method POST -Path '/admin/crawler-jobs' -Body @{ jobType = 'midpoint'; configId = $configId }
    Write-Host "  Job queued: $($job.id)" -ForegroundColor Gray

    $completed = Wait-JobComplete -JobId $job.id -TimeoutSec 120
    if ($null -eq $completed) { Write-Result 'Midpoint/Job — completed within 120s' $false '(timed out)'; throw 'Job timed out' }
    Write-Result 'Midpoint/Job — completed successfully' ($completed.status -eq 'completed') "(status: $($completed.status))"

    # ── Assert: midPoint system registered (identified by the unique mock port) ──
    $thisSystem = $null
    try {
        $systems    = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $thisSystem = @($systems) | Where-Object { $_.displayName -like "*:$($mock.Port)*" } | Select-Object -First 1
        Write-Result 'Midpoint/Data — system registered' ($null -ne $thisSystem) "$(if ($thisSystem) { "($($thisSystem.displayName))" } else { '(not found)' })"
    } catch { Write-Result 'Midpoint/Data — system registered' $false $_.Exception.Message }

    # ── Assert: user principal ingested (unique email) ──
    try {
        $usersResp = Invoke-RestMethod -Uri "$ApiBaseUrl/users?search=midpoint.citest&limit=5" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $cnt = if ($usersResp.users) { $usersResp.users.Count } elseif ($usersResp.data) { $usersResp.data.Count } elseif ($usersResp -is [array]) { $usersResp.Count } else { 0 }
        Write-Result 'Midpoint/Data — user principal ingested' ($cnt -ge 1) "($cnt matching 'midpoint.citest')"
    } catch { Write-Result 'Midpoint/Data — user principal ingested' $false $_.Exception.Message }

    # ── Assert: department derived from the user's org membership (parentOrgRef → org name) ──
    # The mock user sits in 'midPoint CI Org' via parentOrgRef; Resolve-MidpointDepartment
    # must have stamped that org's display name onto both the Identity and its focus Principal.
    try {
        $ident    = Invoke-RestMethod -Uri "$ApiBaseUrl/identities/$userOid" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $identDept = $ident.identity.department
        $focus     = @($ident.members) | Where-Object { $_.principalId -eq $userOid } | Select-Object -First 1
        $princDept = if ($focus) { $focus.department } else { $null }
        $ok = ($identDept -eq 'midPoint CI Org') -and ($princDept -eq 'midPoint CI Org')
        Write-Result 'Midpoint/Data — department from org membership (Identity + Principal)' $ok "(identity: '$identDept', principal: '$princDept'; expected 'midPoint CI Org')"
    } catch { Write-Result 'Midpoint/Data — department from org membership (Identity + Principal)' $false $_.Exception.Message }

    # ── Assert: role resource ingested (scoped to this run's system) ──
    try {
        $sid = if ($thisSystem) { $thisSystem.id } else { 0 }
        $res = Invoke-RestMethod -Uri "$ApiBaseUrl/resources?systemId=$sid&limit=20" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $rcnt = if ($res.data) { $res.data.Count } elseif ($res -is [array]) { $res.Count } else { 0 }
        Write-Result 'Midpoint/Data — resource ingested' ($rcnt -ge 1) "($rcnt resource(s) in system $sid)"
    } catch { Write-Result 'Midpoint/Data — resource ingested' $false $_.Exception.Message }

    # ── Assert: entitlement shadow became a Resource (Entitlement), not a user ──
    try {
        # Entitlements belong to the *connector resource* system (tenantId = resource OID),
        # not the midPoint host system — look it up by tenantId.
        $resSys = @($systems) | Where-Object { $_.tenantId -eq $resOid } | Select-Object -First 1
        $resSid = if ($resSys) { $resSys.id } else { 0 }
        $res = Invoke-RestMethod -Uri "$ApiBaseUrl/resources?systemId=$resSid&limit=50" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $list = if ($res.data) { $res.data } elseif ($res -is [array]) { $res } else { @() }
        $ents = @($list) | Where-Object { $_.resourceType -eq 'Entitlement' }
        # Two entitlements expected: one reached via legacy association[], one via 4.9
        # referenceAttributes.group[]. Both code paths must have produced a resource.
        Write-Result 'Midpoint/Data — entitlements mapped as resources (assoc + referenceAttributes)' ($ents.Count -ge 2) "($($ents.Count) Entitlement resource(s) in system $resSid; expected >= 2)"
    } catch { Write-Result 'Midpoint/Data — entitlement mapped as resource' $false $_.Exception.Message }

    # ── Assert: inherited role membership imported as a Direct membership ──
    # The user is only DIRECTLY assigned $roleOid, but midPoint's roleMembershipRef also
    # lists $inhRoleOid (default relation, inherited) and $mgrRoleOid (manager relation).
    # The crawler's two-pass Assignments phase must import the inherited role as a real
    # Direct membership (governed=false), while excluding the manager-relation one.
    try {
        $inhAssign = Invoke-RestMethod -Uri "$ApiBaseUrl/resources/$inhRoleOid/assignments" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $mgrAssign = Invoke-RestMethod -Uri "$ApiBaseUrl/resources/$mgrRoleOid/assignments" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $inhHit = @($inhAssign) | Where-Object { $_.principalId -eq $userOid -and $_.assignmentType -eq 'Direct' }
        $mgrHit = @($mgrAssign) | Where-Object { $_.principalId -eq $userOid }
        $ok = ($inhHit.Count -ge 1) -and ($mgrHit.Count -eq 0)
        Write-Result 'Midpoint/Data — inherited role membership imported (manager relation excluded)' $ok "(inherited: $($inhHit.Count) Direct; manager: $($mgrHit.Count) — expected inherited>=1, manager=0)"
    } catch { Write-Result 'Midpoint/Data — inherited role membership imported (manager relation excluded)' $false $_.Exception.Message }

    # ── Assert: construction inducements became Contains edges (role → entitlements) ──
    # The role grants two AD groups via construction: $entOid by associationTargetSearch DN
    # filter, $entOid2 by literal shadowRef. Both must surface as a BusinessRole that the
    # entitlement belongs to (vw → /resources/:id/business-roles).
    try {
        $brSearch = Invoke-RestMethod -Uri "$ApiBaseUrl/resources/$entOid/business-roles"  -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $brLiteral = Invoke-RestMethod -Uri "$ApiBaseUrl/resources/$entOid2/business-roles" -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $searchHit  = @($brSearch)  | Where-Object { $_.businessRoleId -eq $roleOid }
        $literalHit = @($brLiteral) | Where-Object { $_.businessRoleId -eq $roleOid }
        $ok = ($searchHit.Count -ge 1) -and ($literalHit.Count -ge 1)
        Write-Result 'Midpoint/Data — construction inducements → Contains edges (associationTargetSearch + shadowRef)' $ok "(targetSearch: $($searchHit.Count), shadowRef: $($literalHit.Count) — both expected >= 1)"
    } catch { Write-Result 'Midpoint/Data — construction inducements → Contains edges (associationTargetSearch + shadowRef)' $false $_.Exception.Message }

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
