<#
.SYNOPSIS
    Integration tests for the OData crawler library functions.

.DESCRIPTION
    Tests Connect-ODataAPI, Invoke-ODataGetRequest, Invoke-ODataPagedRequest, and Get-ODataEntitySets
    against a single shared mock HTTP server. The mock runs for the lifetime of the test and is
    reconfigured mid-run via its /_control endpoint.

    Covers all 6 auth methods, @odata.nextLink pagination, $skip pagination,
    401 error handling, and $metadata entity set discovery.

.PARAMETER ApiBaseUrl
    Not used by this test; accepted for CI discovery convention.

.PARAMETER ApiKey
    Not used by this test; accepted for CI discovery convention.

.PARAMETER WriteResult
    Optional ScriptBlock callback { param($Name, $Passed, $Detail) }.
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ApiKey     = '',
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures    = 0

. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Test-Helpers.ps1')

Write-Host "`n=== OData Crawler Library Tests ===" -ForegroundColor Cyan

# ── Load library and mock helper ─────────────────────────────────────────────
$crawlerDir = Split-Path $PSScriptRoot -Parent | Join-Path -ChildPath 'odata'
. (Join-Path $crawlerDir 'Invoke-ODataAuth.ps1')
. (Join-Path $crawlerDir 'Invoke-ODataGetRequest.ps1')
. (Join-Path $crawlerDir 'Invoke-ODataPagedRequest.ps1')
. (Join-Path (Split-Path $crawlerDir -Parent) 'shared' 'Start-MockODataServer.ps1')

# ── Start a single shared mock server ────────────────────────────────────────
$mock = Start-MockODataServer -EntitySets @{
    TestEntities = @( @{ UId = 'test-entity-1'; DisplayName = 'Test Entity'; Name = 'Test' } )
    Items        = @(
        @{ UId = 'e1'; DisplayName = 'Entity 1' }
        @{ UId = 'e2'; DisplayName = 'Entity 2' }
        @{ UId = 'e3'; DisplayName = 'Entity 3' }
    )
}
$baseUrl     = "http://localhost:$($mock.Port)/odata/v4"
$controlUrl  = "http://localhost:$($mock.Port)/_control"

function Set-MockControl {
    param([hashtable]$Body)
    Invoke-RestMethod -Uri $controlUrl -Method POST -ContentType 'application/json' `
        -Body ($Body | ConvertTo-Json -Compress) -TimeoutSec 5 | Out-Null
}

try {
    # ── Auth method tests (all use the same mock, same entity set) ────────────
    $authCases = @(
        @{ Method = 'BasicAuth';    Extra = @{ Username = 'testuser'; Password = 'testpass' } }
        @{ Method = 'ApiToken';     Extra = @{ ApiToken = 'mock-api-token-12345' } }
        @{ Method = 'CookieString'; Extra = @{ CookieString = 'oisauthtoken=mock-cookie-value' } }
        @{ Method = 'FormCookie';   Extra = @{ Username = 'testuser'; Password = 'testpass' } }
        @{ Method = 'OAuth2CC';     Extra = @{ ClientId = 'mock-client'; ClientSecret = 'mock-secret'
                                               TokenEndpoint = "http://localhost:$($mock.Port)/oauth/token" } }
        @{ Method = 'OAuth2ROPC';   Extra = @{ ClientId = 'mock-client'; ClientSecret = 'mock-secret'
                                               Username = 'testuser'; Password = 'testpass'
                                               TokenEndpoint = "http://localhost:$($mock.Port)/oauth/token" } }
    )

    Write-Host "`n  Auth method tests:" -ForegroundColor Gray
    foreach ($case in $authCases) {
        try {
            $extraParams = $case.Extra
            Connect-ODataAPI -BaseUrl $baseUrl -AuthMethod $case.Method @extraParams
            $result = Invoke-ODataGetRequest -Path '/TestEntities'
            $passed = $null -ne $result -and $result.Count -gt 0
            Write-Result "OData/$($case.Method) — auth + data fetch" $passed "($($result.Count) entities returned)"
        } catch {
            Write-Result "OData/$($case.Method) — auth + data fetch" $false $_.Exception.Message
        }
    }

    # ── @odata.nextLink pagination ────────────────────────────────────────────
    Write-Host "`n  Pagination tests:" -ForegroundColor Gray
    try {
        Connect-ODataAPI -BaseUrl $baseUrl -AuthMethod BasicAuth -Username testuser -Password testpass
        $result = Invoke-ODataGetRequest -Path '/Paginated'
        $passed = $null -ne $result -and $result.Count -eq 2
        Write-Result 'OData/Pagination — @odata.nextLink followed' $passed "($($result.Count) total entities across pages)"
    } catch {
        Write-Result 'OData/Pagination — @odata.nextLink followed' $false $_.Exception.Message
    }

    # ── 401 error handling ────────────────────────────────────────────────────
    Write-Host "`n  Error handling tests:" -ForegroundColor Gray
    Set-MockControl @{ alwaysReturnStatus = 401 }
    try {
        Connect-ODataAPI -BaseUrl $baseUrl -AuthMethod ApiToken -ApiToken 'mock-api-token'
        Invoke-ODataGetRequest -Path '/TestEntities' -MaxRetries 0 | Out-Null
        Write-Result 'OData/Error — 401 throws exception' $false '(expected throw, but succeeded)'
    } catch {
        Write-Result 'OData/Error — 401 throws exception' $true "($($_.Exception.Message.Split('.')[0]))"
    }
    Set-MockControl @{ reset = $true }

    # ── OAuth2 proactive token refresh ────────────────────────────────────────
    # Mock issues a token with expires_in=0, so the library's session clock sees
    # it as already expired. No waiting needed: Update-ODataSessionIfExpired runs
    # before every request and refreshes when UtcNow >= ExpiresAt - 2min.
    # With ExpiresAt = UtcNow+0s that condition is immediately true, triggering a
    # silent re-fetch before the GET. The request must still succeed.
    Write-Host "`n  Token refresh test:" -ForegroundColor Gray
    try {
        Set-MockControl @{ tokenExpiresIn = 0 }
        Connect-ODataAPI -BaseUrl $baseUrl -AuthMethod OAuth2CC `
            -ClientId 'mock-client' -ClientSecret 'mock-secret' `
            -TokenEndpoint "http://localhost:$($mock.Port)/oauth/token"
        $result = Invoke-ODataGetRequest -Path '/TestEntities'
        $passed = $null -ne $result -and $result.Count -gt 0
        Write-Result 'OData/TokenRefresh — OAuth2CC proactive refresh on expired token' $passed `
            "($($result.Count) entities returned after auto-refresh)"
    } catch {
        Write-Result 'OData/TokenRefresh — OAuth2CC proactive refresh on expired token' $false $_.Exception.Message
    } finally {
        Set-MockControl @{ reset = $true }   # restore default token TTL for remaining tests
    }

    # ── $skip pagination (Invoke-ODataPagedRequest) ───────────────────────────
    try {
        Connect-ODataAPI -BaseUrl $baseUrl -AuthMethod BasicAuth -Username testuser -Password testpass
        $result = Invoke-ODataPagedRequest -Path '/Items' -PageSize 2
        $passed = $null -ne $result -and $result.Count -eq 3
        Write-Result 'OData/Pagination — $skip walk (Invoke-ODataPagedRequest)' $passed "($($result.Count) total entities)"
    } catch {
        Write-Result 'OData/Pagination — $skip walk (Invoke-ODataPagedRequest)' $false $_.Exception.Message
    }

} finally {
    Stop-MockODataServer -Mock $mock
}

# ── Test empty entity-set response ───────────────────────────────────────────
# Regression: early versions threw or returned $null on {"value":[]}.
$mock = $null
try {
    $mock = Start-MockODataServer -EntitySets @{ Empty = @() }
    Connect-ODataAPI -BaseUrl "http://localhost:$($mock.Port)/odata/v4" `
        -AuthMethod BasicAuth -Username testuser -Password testpass
    try {
        $result = Invoke-ODataGetRequest -Path '/Empty'
        $passed = $null -ne $result -and $result -is [array] -and $result.Count -eq 0
        $detail = if ($null -eq $result) { '(null — function returned $null for empty collection)' }
                  else { "(type: $($result.GetType().Name), count: $($result.Count))" }
        Write-Result 'OData/EdgeCase — empty value array returns empty array (not null/throw)' $passed $detail
    } catch {
        Write-Result 'OData/EdgeCase — empty value array returns empty array (not null/throw)' $false $_.Exception.Message
    }
} finally {
    if ($mock) { Stop-MockODataServer -Mock $mock }
}

# ── Test Get-ODataEntitySets — $metadata discovery ───────────────────────────
$mock = $null
try {
    $mock = Start-MockODataServer -EntitySets @{ Users = @(); Roles = @() }
    Connect-ODataAPI -BaseUrl "http://localhost:$($mock.Port)/odata/v4" `
        -AuthMethod BasicAuth -Username testuser -Password testpass
    try {
        $sets = Get-ODataEntitySets
        $passed = $sets -contains 'Users' -and $sets -contains 'Roles'
        Write-Result 'OData/EntitySets — $metadata discovery' $passed `
            "($($sets.Count) entity sets: $($sets -join ', '))"
    } catch {
        Write-Result 'OData/EntitySets — $metadata discovery' $false $_.Exception.Message
    }
} finally {
    if ($mock) { Stop-MockODataServer -Mock $mock }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ''
if (-not $WriteResult) {
    if ($standaloneFailures -gt 0) {
        Write-Host "OData tests: $standaloneFailures FAILED" -ForegroundColor Red
        exit 1
    } else {
        Write-Host 'OData tests: all passed' -ForegroundColor Green
        exit 0
    }
}
