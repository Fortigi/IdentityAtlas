<#
.SYNOPSIS
    Nightly test step: validate account correlation (multi-system principals
    linked to a single identity).

.DESCRIPTION
    Verifies the ingest pipeline for systems, principals, identities, and
    identity-members, then confirms the correlated identity is queryable via
    the /identities endpoint.

    What it covers:
      1. POST /ingest/systems        - create two test systems
      2. POST /ingest/principals     - create one principal per system
      3. POST /ingest/identities     - create one correlated identity
      4. POST /ingest/identity-members - link both principals to the identity
      5. GET  /identities            - verify the identity exists
      6. Verify the identity is queryable

    Designed to be called from Run-NightlyLocal.ps1 with a `WriteResult` callback.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ApiKey
    Crawler API key for the built-in worker (Bearer token for ingest endpoints).

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

function Report-Result {
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
    param([string]$Path, [string]$Method = 'Get', [hashtable]$Body = $null)
    $uri = "$ApiBaseUrl$Path"
    $params = @{
        Uri         = $uri
        Method      = $Method
        ContentType = 'application/json'
        TimeoutSec  = 30
        ErrorAction = 'Stop'
    }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    if ($ApiKey) {
        $params.Headers = @{ Authorization = "Bearer $ApiKey" }
    }
    return Invoke-RestMethod @params
}

Write-Host "`n=== Account Correlation ===" -ForegroundColor Cyan

$systemAId = $null
$systemBId = $null

# --- 1. Create two test systems via /ingest/systems -------------------
try {
    $rA = Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        syncMode = 'delta'
        records  = @(
            @{
                externalId  = 'Correlation-System-A'
                displayName = 'Correlation-System-A'
                systemType  = 'Test'
            }
        )
    }
    $rB = Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        syncMode = 'delta'
        records  = @(
            @{
                externalId  = 'Correlation-System-B'
                displayName = 'Correlation-System-B'
                systemType  = 'Test'
            }
        )
    }

    # Extract system IDs from the response (ingest API returns systemIds array)
    if ($rA.systemIds -and @($rA.systemIds).Count -gt 0) {
        $systemAId = @($rA.systemIds)[0]
    }
    if ($rB.systemIds -and @($rB.systemIds).Count -gt 0) {
        $systemBId = @($rB.systemIds)[0]
    }

    if ($systemAId -and $systemBId) {
        Report-Result 'Correlation/SystemsCreated' $true "A=$systemAId B=$systemBId"
    } else {
        Report-Result 'Correlation/SystemsCreated' $false "could not resolve system IDs (A=$systemAId B=$systemBId)"
    }
} catch {
    Report-Result 'Correlation/SystemsCreated' $false $_.Exception.Message
}

# --- 2. Create 1 principal in each system via /ingest/principals ------
try {
    $rPA = Invoke-LocalApi -Path '/ingest/principals' -Method Post -Body @{
        systemId     = $systemAId
        syncMode     = 'delta'
        idGeneration = 'deterministic'
        idPrefix     = 'corr'
        records      = @(
            @{
                externalId     = 'corr-user-a1'
                displayName    = 'Alice Correlation'
                principalType  = 'User'
                accountEnabled = $true
            }
        )
    }
    $rPB = Invoke-LocalApi -Path '/ingest/principals' -Method Post -Body @{
        systemId     = $systemBId
        syncMode     = 'delta'
        idGeneration = 'deterministic'
        idPrefix     = 'corr'
        records      = @(
            @{
                externalId     = 'corr-user-b1'
                displayName    = 'A. Correlation'
                principalType  = 'User'
                accountEnabled = $true
            }
        )
    }
    Report-Result 'Correlation/PrincipalsCreated' $true "SystemA + SystemB principals ingested"
} catch {
    Report-Result 'Correlation/PrincipalsCreated' $false $_.Exception.Message
}

# --- 3. Create 1 identity via /ingest/identities ---------------------
try {
    $rI = Invoke-LocalApi -Path '/ingest/identities' -Method Post -Body @{
        syncMode     = 'delta'
        idGeneration = 'deterministic'
        idPrefix     = 'corr'
        records      = @(
            @{
                externalId  = 'corr-identity-1'
                displayName = 'Alice Correlation'
            }
        )
    }
    Report-Result 'Correlation/IdentityCreated' $true 'identity ingested'
} catch {
    Report-Result 'Correlation/IdentityCreated' $false $_.Exception.Message
}

# --- 4. Link both principals to the identity via /ingest/identity-members
try {
    $rM = Invoke-LocalApi -Path '/ingest/identity-members' -Method Post -Body @{
        syncMode     = 'delta'
        idGeneration = 'deterministic'
        idPrefix     = 'corr'
        records      = @(
            @{
                identityExternalId  = 'corr-identity-1'
                principalExternalId = 'corr-user-a1'
            },
            @{
                identityExternalId  = 'corr-identity-1'
                principalExternalId = 'corr-user-b1'
            }
        )
    }
    Report-Result 'Correlation/MembersLinked' $true '2 identity-members ingested'
} catch {
    Report-Result 'Correlation/MembersLinked' $false $_.Exception.Message
}

# --- 5. GET /identities and verify at least 1 identity exists --------
try {
    $rList = Invoke-LocalApi -Path '/identities?limit=100'
    $identities = if ($rList.data) { @($rList.data) } else { @($rList) }
    if ($identities.Count -ge 1) {
        Report-Result 'Correlation/IdentityExists' $true "count=$($identities.Count)"
    } else {
        Report-Result 'Correlation/IdentityExists' $false 'no identities returned'
    }
} catch {
    Report-Result 'Correlation/IdentityExists' $false $_.Exception.Message
}

# --- 6. Verify the identity is queryable -----------------------------
try {
    $rList2 = Invoke-LocalApi -Path '/identities?limit=100'
    $identities2 = if ($rList2.data) { @($rList2.data) } else { @($rList2) }
    $match = $identities2 | Where-Object {
        $_.displayName -eq 'Alice Correlation' -or $_.externalId -eq 'corr-identity-1'
    }
    if ($match) {
        Report-Result 'Correlation/IdentityQueryable' $true "found identity displayName=$($match.displayName)"
    } else {
        Report-Result 'Correlation/IdentityQueryable' $false 'corr-identity-1 not found in identity list'
    }
} catch {
    Report-Result 'Correlation/IdentityQueryable' $false $_.Exception.Message
}

if (-not $WriteResult) { exit $standaloneFailures }
