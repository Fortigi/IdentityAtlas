<#
.SYNOPSIS
    Nightly test step: validate the Identity Atlas Ingest API endpoints.

.DESCRIPTION
    Tests the ingest pipeline that crawlers use to push data into Identity Atlas.
    Covers happy-path ingestion of systems, principals, resources, and resource
    assignments, as well as error-handling for malformed or unauthenticated
    requests.

    What it covers:
      1. POST /ingest/systems        — create a test system (happy path)
      2. POST /ingest/principals     — create a test principal (happy path)
      3. POST /ingest/resources      — create a test resource (happy path)
      4. POST /ingest/resource-assignments — create a test assignment (happy path)
      5. POST /ingest/systems        — empty body must 400
      6. POST /ingest/principals     — missing systemId must 400
      7. POST /ingest/principals     — invalid syncMode must 400
      8. POST /ingest/resources      — no Authorization header must 401

    Designed to be called from Run-NightlyLocal.ps1 with a `WriteResult` callback.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ApiKey
    Crawler API key (starts with fgc_). Sent as Bearer token in Authorization
    header for authenticated requests.

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ApiKey,
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures = 0

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) {
        & $WriteResult $Name $Passed $Detail
    } elseif (-not $Passed) {
        $script:standaloneFailures++
    }
}

function Invoke-LocalApi {
    param(
        [string]$Path,
        [string]$Method = 'Get',
        [hashtable]$Body = $null,
        [switch]$NoAuth
    )
    $uri = "$ApiBaseUrl$Path"
    $headers = @{}
    if ($ApiKey -and -not $NoAuth) {
        $headers['Authorization'] = "Bearer $ApiKey"
    }
    $params = @{
        Uri         = $uri
        Method      = $Method
        ContentType = 'application/json'
        Headers     = $headers
        TimeoutSec  = 30
        ErrorAction = 'Stop'
    }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod @params
}

# Shared error-path assertion: run a request that must fail with a given status.
function Assert-IngestError {
    param(
        [string]$Name,
        [int]$ExpectedStatus,
        [scriptblock]$Request
    )
    try {
        & $Request | Out-Null
        Write-Result $Name $false "expected $ExpectedStatus, got success"
    } catch {
        $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($statusCode -eq $ExpectedStatus) {
            Write-Result $Name $true "got $ExpectedStatus (expected)"
        } else {
            Write-Result $Name $false "got $statusCode (expected $ExpectedStatus)"
        }
    }
}

# 1. POST /ingest/systems — happy path
function Invoke-SystemsHappyPath {
    try {
        $r = Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
            syncMode = 'delta'
            records  = @(
                @{
                    displayName = 'Ingest-Test-System'
                    systemType  = 'Test'
                    enabled     = $true
                    syncEnabled = $true
                }
            )
        }
        if ($r.systemIds -and @($r.systemIds).Count -ge 1) {
            $script:systemId = @($r.systemIds)[0]
            Write-Result 'Ingest/Systems/HappyPath' $true "systemId=$($script:systemId)"
        } else {
            Write-Result 'Ingest/Systems/HappyPath' $false 'response missing systemIds'
        }
    } catch {
        Write-Result 'Ingest/Systems/HappyPath' $false $_.Exception.Message
    }
}

# 2. POST /ingest/principals — happy path
function Invoke-PrincipalsHappyPath {
    try {
        if (-not $script:systemId) { throw 'skipped — no systemId from previous step' }
        $r = Invoke-LocalApi -Path '/ingest/principals' -Method Post -Body @{
            systemId     = $script:systemId
            syncMode     = 'delta'
            idGeneration = 'deterministic'
            idPrefix     = 'itest-principals'
            records      = @(
                @{
                    externalId     = 'ingest-test-user-1'
                    displayName    = 'Ingest Test User'
                    principalType  = 'User'
                    accountEnabled = $true
                }
            )
        }
        $inserted = if ($r.PSObject.Properties.Name -contains 'inserted') { $r.inserted } else { 0 }
        if ($inserted -ge 1) {
            Write-Result 'Ingest/Principals/HappyPath' $true "inserted=$inserted"
        } else {
            Write-Result 'Ingest/Principals/HappyPath' $false "inserted=$inserted (expected >= 1)"
        }
    } catch {
        Write-Result 'Ingest/Principals/HappyPath' $false $_.Exception.Message
    }
}

# 3. POST /ingest/resources — happy path
function Invoke-ResourcesHappyPath {
    try {
        if (-not $script:systemId) { throw 'skipped — no systemId from previous step' }
        $r = Invoke-LocalApi -Path '/ingest/resources' -Method Post -Body @{
            systemId     = $script:systemId
            syncMode     = 'delta'
            idGeneration = 'deterministic'
            idPrefix     = 'itest-resources'
            records      = @(
                @{
                    externalId   = 'ingest-test-res-1'
                    displayName  = 'Ingest Test Resource'
                    resourceType = 'Group'
                    enabled      = $true
                }
            )
        }
        $inserted = if ($r.PSObject.Properties.Name -contains 'inserted') { $r.inserted } else { 0 }
        if ($inserted -ge 1) {
            Write-Result 'Ingest/Resources/HappyPath' $true "inserted=$inserted"
        } else {
            Write-Result 'Ingest/Resources/HappyPath' $false "inserted=$inserted (expected >= 1)"
        }
    } catch {
        Write-Result 'Ingest/Resources/HappyPath' $false $_.Exception.Message
    }
}

# 4. POST /ingest/resource-assignments — happy path
function Invoke-ResourceAssignmentsHappyPath {
    try {
        if (-not $script:systemId) { throw 'skipped — no systemId from previous step' }
        $r = Invoke-LocalApi -Path '/ingest/resource-assignments' -Method Post -Body @{
            systemId     = $script:systemId
            syncMode     = 'delta'
            idGeneration = 'deterministic'
            idPrefix     = 'itest-resource-assignments'
            records      = @(
                @{
                    resourceExternalId  = 'ingest-test-res-1'
                    principalExternalId = 'ingest-test-user-1'
                    assignmentType      = 'Direct'
                }
            )
        }
        Write-Result 'Ingest/ResourceAssignments/HappyPath' $true "ok"
    } catch {
        Write-Result 'Ingest/ResourceAssignments/HappyPath' $false $_.Exception.Message
    }
}

# 5. POST /ingest/systems — empty body → 400
function Invoke-SystemsEmptyBody {
    Assert-IngestError 'Ingest/Systems/EmptyBody' 400 {
        Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{}
    }
}

# 6. POST /ingest/principals — missing systemId → 400
function Invoke-PrincipalsMissingSysId {
    Assert-IngestError 'Ingest/Principals/MissingSysId' 400 {
        Invoke-LocalApi -Path '/ingest/principals' -Method Post -Body @{
            syncMode = 'delta'
            records  = @(
                @{ externalId = 'x'; displayName = 'X'; principalType = 'User' }
            )
        }
    }
}

# 7. POST /ingest/principals — invalid syncMode → 400
function Invoke-PrincipalsInvalidSyncMode {
    Assert-IngestError 'Ingest/Principals/InvalidSyncMode' 400 {
        Invoke-LocalApi -Path '/ingest/principals' -Method Post -Body @{
            systemId = 'does-not-matter'
            syncMode = 'invalid'
            records  = @(
                @{ externalId = 'x'; displayName = 'X'; principalType = 'User' }
            )
        }
    }
}

# 8. POST /ingest/resources — no auth header → 401
function Invoke-ResourcesNoAuth {
    Assert-IngestError 'Ingest/Resources/NoAuth' 401 {
        Invoke-LocalApi -Path '/ingest/resources' -Method Post -NoAuth -Body @{
            systemId = 'does-not-matter'
            syncMode = 'delta'
            records  = @(
                @{ externalId = 'x'; displayName = 'X'; resourceType = 'Group' }
            )
        }
    }
}

function Invoke-IngestApiTests {
    Write-Host "`n=== Ingest API ===" -ForegroundColor Cyan
    $script:systemId = $null

    Invoke-SystemsHappyPath
    Invoke-PrincipalsHappyPath
    Invoke-ResourcesHappyPath
    Invoke-ResourceAssignmentsHappyPath
    Invoke-SystemsEmptyBody
    Invoke-PrincipalsMissingSysId
    Invoke-PrincipalsInvalidSyncMode
    Invoke-ResourcesNoAuth
}

Invoke-IngestApiTests

if (-not $WriteResult) { exit $standaloneFailures }
