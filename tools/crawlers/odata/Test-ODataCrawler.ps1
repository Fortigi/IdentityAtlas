<#
.SYNOPSIS
    Integration tests for the OData crawler library functions.

.DESCRIPTION
    Tests Connect-ODataAPI and Invoke-ODataGetRequest against a mock HTTP server.
    Covers all 6 auth methods, @odata.nextLink pagination, and 401 error handling.

    Does NOT test the full dispatcher pipeline — that is covered by Test-OmadaCrawler.ps1.
    Does NOT require a live OData endpoint — all tests run against a local mock server.

    Run as part of the crawler-colocated integration tests step in pr-integration.yml,
    or standalone: pwsh .\tools\crawlers\odata\Test-ODataCrawler.ps1

.CONVENTION
    Part of the per-crawler integration test convention.
    Parameters -ApiBaseUrl and -ApiKey are accepted (and required by the CI discovery loop)
    but not used by this test — the OData library functions talk directly to the mock server.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL (not used by this test, accepted for CI convention).

.PARAMETER ApiKey
    Identity Atlas crawler API key (not used by this test, accepted for CI convention).

.PARAMETER WriteResult
    Optional ScriptBlock callback { param($Name, $Passed, $Detail) } for nightly runner integration.
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ApiKey     = '',
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures    = 0

function Report-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color  = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) { & $WriteResult $Name $Passed $Detail }
    elseif (-not $Passed) { $script:standaloneFailures++ }
}

Write-Host "`n=== OData Crawler Library Tests ===" -ForegroundColor Cyan

# ── Load library functions ────────────────────────────────────────────────────
$crawlerDir = Split-Path $PSScriptRoot -Parent | Join-Path -ChildPath 'odata'
. (Join-Path $crawlerDir 'Invoke-ODataAuth.ps1')
. (Join-Path $crawlerDir 'Invoke-ODataGetRequest.ps1')
. (Join-Path $crawlerDir 'Invoke-ODataPagedRequest.ps1')

# ── Load mock server helper ───────────────────────────────────────────────────
. (Join-Path (Split-Path $crawlerDir -Parent) 'shared\Start-MockODataServer.ps1')

# ── Mock entity data ──────────────────────────────────────────────────────────
$mockEntity = @{ UId = 'test-entity-1'; DisplayName = 'Test Entity'; Name = 'Test' }

# ── Helper: run a single auth method test ────────────────────────────────────
function Test-AuthMethod {
    param(
        [string]$Method,
        [hashtable]$ConnectParams,
        [string]$BaseUrl,
        [string]$OAuthTokenEndpoint = ''
    )
    $mock = $null
    try {
        $mock = Start-MockODataServer -EntitySets @{ TestEntities = @($mockEntity) }
        $url  = "http://localhost:$($mock.Port)/odata/v4"

        $p = @{
            BaseUrl    = $url
            AuthMethod = $Method
        } + $ConnectParams
        if ($OAuthTokenEndpoint) {
            $p['TokenEndpoint'] = "http://localhost:$($mock.Port)/oauth/token"
        }

        try {
            Connect-ODataAPI @p
            $result = Invoke-ODataGetRequest -Path '/TestEntities'
            $passed = $null -ne $result -and $result.Count -gt 0
            Report-Result "OData/$Method — auth + data fetch" $passed `
                "($($result.Count) entities returned)"
        } catch {
            Report-Result "OData/$Method — auth + data fetch" $false $_.Exception.Message
        }
    } finally {
        if ($mock) { Stop-MockODataServer -Mock $mock }
    }
}

# ── Test all 6 auth methods ───────────────────────────────────────────────────
Test-AuthMethod -Method 'BasicAuth'    -ConnectParams @{ Username = 'testuser'; Password = 'testpass' }
Test-AuthMethod -Method 'ApiToken'     -ConnectParams @{ ApiToken = 'mock-api-token-12345' }
Test-AuthMethod -Method 'CookieString' -ConnectParams @{ CookieString = 'oisauthtoken=mock-cookie-value' }
Test-AuthMethod -Method 'FormCookie'   -ConnectParams @{ Username = 'testuser'; Password = 'testpass' }
Test-AuthMethod -Method 'OAuth2CC'     -ConnectParams @{ ClientId = 'mock-client'; ClientSecret = 'mock-secret' } -OAuthTokenEndpoint $true
Test-AuthMethod -Method 'OAuth2ROPC'   -ConnectParams @{ ClientId = 'mock-client'; ClientSecret = 'mock-secret'; Username = 'testuser'; Password = 'testpass' } -OAuthTokenEndpoint $true

# ── Test @odata.nextLink pagination ──────────────────────────────────────────
Write-Host "`n  Pagination tests:" -ForegroundColor Gray
$mock = $null
try {
    $mock = Start-MockODataServer -EntitySets @{}   # pagination handled by /Paginated path in mock
    Connect-ODataAPI -BaseUrl "http://localhost:$($mock.Port)/odata/v4" `
        -AuthMethod BasicAuth -Username testuser -Password testpass
    try {
        # /Paginated returns page 1 with @odata.nextLink → page 2 → empty → done
        $result = Invoke-ODataGetRequest -Path '/Paginated'
        $passed = $null -ne $result -and $result.Count -eq 2  # 1 entity per page, 2 pages
        Report-Result 'OData/Pagination — @odata.nextLink followed' $passed `
            "($($result.Count) total entities across pages)"
    } catch {
        Report-Result 'OData/Pagination — @odata.nextLink followed' $false $_.Exception.Message
    }
} finally {
    if ($mock) { Stop-MockODataServer -Mock $mock }
}

# ── Test 401 response causes error ───────────────────────────────────────────
Write-Host "`n  Error handling tests:" -ForegroundColor Gray
$mock = $null
try {
    $mock = Start-MockODataServer -AlwaysReturnStatus 401
    Connect-ODataAPI -BaseUrl "http://localhost:$($mock.Port)/odata/v4" `
        -AuthMethod ApiToken -ApiToken 'mock-api-token'
    try {
        Invoke-ODataGetRequest -Path '/TestEntities' -MaxRetries 0 | Out-Null
        Report-Result 'OData/Error — 401 throws exception' $false '(expected throw, but succeeded)'
    } catch {
        Report-Result 'OData/Error — 401 throws exception' $true "($($_.Exception.Message.Split('.')[0]))"
    }
} finally {
    if ($mock) { Stop-MockODataServer -Mock $mock }
}

# ── Test $skip pagination (Invoke-ODataPagedRequest) ─────────────────────────
$mock = $null
try {
    $entities = @(
        @{ UId = 'e1'; DisplayName = 'Entity 1' }
        @{ UId = 'e2'; DisplayName = 'Entity 2' }
        @{ UId = 'e3'; DisplayName = 'Entity 3' }
    )
    $mock = Start-MockODataServer -EntitySets @{ Items = $entities }
    Connect-ODataAPI -BaseUrl "http://localhost:$($mock.Port)/odata/v4" `
        -AuthMethod BasicAuth -Username testuser -Password testpass
    try {
        # Invoke-ODataPagedRequest with PageSize=2 should fetch page 1 (2 items) + page 2 (1 item)
        $result = Invoke-ODataPagedRequest -Path '/Items' -PageSize 2
        $passed = $null -ne $result -and $result.Count -eq 3
        Report-Result 'OData/Pagination — $skip walk (Invoke-ODataPagedRequest)' $passed `
            "($($result.Count) total entities)"
    } catch {
        Report-Result 'OData/Pagination — $skip walk (Invoke-ODataPagedRequest)' $false $_.Exception.Message
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
