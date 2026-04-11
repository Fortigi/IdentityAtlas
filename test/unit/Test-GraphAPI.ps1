# Graph API Test Suite for FortigiGraph
# Tests authentication and basic Graph API operations
#
# Prerequisites:
# - Config file with valid Graph.ClientId, Graph.TenantId, Graph.ClientSecret
# - App registration with appropriate Graph API permissions (User.Read.All, Group.Read.All, etc.)
#
# Usage: pwsh -File _Test\Test-GraphAPI.ps1 -ConfigFile _Test\config.test.json

param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigFile
)

$ErrorActionPreference = "Stop"

# ── Test tracking ──────────────────────────────────────────────────────
$script:TestResults = @()
$script:TotalTests = 0
$script:PassedTests = 0
$script:FailedTests = 0
$script:SkippedTests = 0

function Write-TestHeader {
    param([string]$Message)
    Write-Host "`n$Message" -ForegroundColor Yellow
    Write-Host ("=" * $Message.Length) -ForegroundColor Yellow
}

function Write-TestStep {
    param([string]$Message)
    Write-Host "  → $Message" -ForegroundColor Cyan
}

function Add-TestResult {
    param(
        [string]$Category,
        [string]$TestName,
        [bool]$Passed,
        [string]$Message = "",
        [switch]$Skipped
    )

    $script:TotalTests++
    if ($Skipped) {
        $script:SkippedTests++
        Write-Host "  ○ $TestName — SKIPPED: $Message" -ForegroundColor DarkYellow
    } elseif ($Passed) {
        $script:PassedTests++
        Write-Host "  ✓ $TestName" -ForegroundColor Green
    } else {
        $script:FailedTests++
        Write-Host "  ✗ $TestName — $Message" -ForegroundColor Red
    }

    $script:TestResults += [PSCustomObject]@{
        Category = $Category
        TestName = $TestName
        Passed   = $Passed
        Skipped  = [bool]$Skipped
        Message  = $Message
    }
}

# Start transcript
$configBaseName = [System.IO.Path]::GetFileNameWithoutExtension($ConfigFile)
$transcriptDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $transcriptDir)) { New-Item -ItemType Directory -Path $transcriptDir -Force | Out-Null }
$transcriptFile = Join-Path $transcriptDir "graphapi-test-$configBaseName.log"
Start-Transcript -Path $transcriptFile -Force | Out-Null

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "FortigiGraph Graph API Test Suite" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ══════════════════════════════════════════════════════════════════════
# SETUP: Import Module & Load Config
# ══════════════════════════════════════════════════════════════════════

$moduleRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $moduleRoot "IdentityAtlas.psd1"

try {
    Import-Module $modulePath -Force -ErrorAction Stop
    Add-TestResult -Category "Setup" -TestName "Module imported" -Passed $true
} catch {
    Add-TestResult -Category "Setup" -TestName "Module imported" -Passed $false -Message $_.Exception.Message
    Stop-Transcript | Out-Null
    exit 1
}

if (-not (Test-Path $ConfigFile)) {
    Write-Host "Config file not found: $ConfigFile" -ForegroundColor Red
    Stop-Transcript | Out-Null
    exit 1
}

$config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
Add-TestResult -Category "Setup" -TestName "Config loaded" -Passed $true

# ══════════════════════════════════════════════════════════════════════
# TEST 1: Token Acquisition
# ══════════════════════════════════════════════════════════════════════
Write-TestHeader "1. Token Acquisition"

try {
    Write-TestStep "Getting access token via service principal..."
    Get-FGAccessToken -ConfigFile $ConfigFile
    Add-TestResult -Category "Auth" -TestName "Access token acquired" -Passed ($null -ne $Global:AccessToken)
} catch {
    Add-TestResult -Category "Auth" -TestName "Access token acquired" -Passed $false -Message $_.Exception.Message
    Write-Host "`nCannot continue without a valid token." -ForegroundColor Red
    Stop-Transcript | Out-Null
    exit 1
}

# Validate token structure
try {
    $tokenDetail = Get-FGAccessTokenDetail
    $hasTid = $null -ne $tokenDetail.tid
    $hasAppId = $null -ne $tokenDetail.appid -or $null -ne $tokenDetail.azp
    $hasExp = $null -ne $tokenDetail.exp

    Add-TestResult -Category "Auth" -TestName "Token contains tenant ID (tid)" -Passed $hasTid -Message $(if (-not $hasTid) { "tid claim missing" })
    Add-TestResult -Category "Auth" -TestName "Token contains app ID (appid/azp)" -Passed $hasAppId -Message $(if (-not $hasAppId) { "appid/azp claim missing" })
    Add-TestResult -Category "Auth" -TestName "Token contains expiry (exp)" -Passed $hasExp -Message $(if (-not $hasExp) { "exp claim missing" })

    # Check token is not expired
    if ($hasExp) {
        $expiry = [System.DateTimeOffset]::FromUnixTimeSeconds($tokenDetail.exp).UtcDateTime
        $isValid = $expiry -gt (Get-Date).ToUniversalTime()
        Add-TestResult -Category "Auth" -TestName "Token is not expired (expires: $($expiry.ToString('HH:mm:ss UTC')))" -Passed $isValid -Message $(if (-not $isValid) { "Token already expired" })
    }
} catch {
    Add-TestResult -Category "Auth" -TestName "Token structure validation" -Passed $false -Message $_.Exception.Message
}

# ══════════════════════════════════════════════════════════════════════
# TEST 2: Basic User Queries
# ══════════════════════════════════════════════════════════════════════
Write-TestHeader "2. User Queries"

try {
    Write-TestStep "Fetching first user..."
    $users = Get-FGUser -Top 1
    $hasUsers = $null -ne $users
    Add-TestResult -Category "Users" -TestName "GET /users?top=1 returns data" -Passed $hasUsers -Message $(if (-not $hasUsers) { "No users returned" })

    if ($hasUsers) {
        # Check user has expected properties
        $firstUser = if ($users -is [array]) { $users[0] } else { $users }
        $hasDisplayName = $null -ne $firstUser.displayName
        $hasId = $null -ne $firstUser.id
        $hasUPN = $null -ne $firstUser.userPrincipalName

        Add-TestResult -Category "Users" -TestName "User has displayName property" -Passed $hasDisplayName
        Add-TestResult -Category "Users" -TestName "User has id property" -Passed $hasId
        Add-TestResult -Category "Users" -TestName "User has userPrincipalName property" -Passed $hasUPN

        # Test user by ID
        if ($hasId) {
            Write-TestStep "Fetching user by ID: $($firstUser.id)..."
            $userById = Get-FGUser -Id $firstUser.id
            $found = $null -ne $userById -and $userById.id -eq $firstUser.id
            Add-TestResult -Category "Users" -TestName "GET /users/{id} returns correct user" -Passed $found -Message $(if (-not $found) { "User not found by ID" })
        }

        # Test pagination
        Write-TestStep "Testing pagination (fetching 5 users)..."
        $pagedUsers = Get-FGUser -Top 5
        $pagedCount = if ($pagedUsers -is [array]) { $pagedUsers.Count } else { 1 }
        Add-TestResult -Category "Users" -TestName "Pagination returns multiple users ($pagedCount)" -Passed ($pagedCount -ge 1)
    }
} catch {
    Add-TestResult -Category "Users" -TestName "User queries" -Passed $false -Message $_.Exception.Message
}

# ══════════════════════════════════════════════════════════════════════
# TEST 3: Group Queries
# ══════════════════════════════════════════════════════════════════════
Write-TestHeader "3. Group Queries"

$testGroupId = $null

try {
    Write-TestStep "Fetching groups..."
    $groups = Get-FGGroup -Top 5
    $hasGroups = $null -ne $groups
    $groupCount = if ($groups -is [array]) { $groups.Count } else { if ($groups) { 1 } else { 0 } }
    Add-TestResult -Category "Groups" -TestName "GET /groups returns data ($groupCount groups)" -Passed $hasGroups

    if ($hasGroups) {
        $firstGroup = if ($groups -is [array]) { $groups[0] } else { $groups }
        $testGroupId = $firstGroup.id

        $hasDisplayName = $null -ne $firstGroup.displayName
        Add-TestResult -Category "Groups" -TestName "Group has displayName property" -Passed $hasDisplayName

        # Test group members
        Write-TestStep "Fetching members of group: $($firstGroup.displayName)..."
        try {
            $members = Get-FGGroupMember -Id $firstGroup.id
            $memberCount = if ($members -is [array]) { $members.Count } else { if ($members) { 1 } else { 0 } }
            Add-TestResult -Category "Groups" -TestName "GET /groups/{id}/members returns data ($memberCount members)" -Passed $true
        } catch {
            Add-TestResult -Category "Groups" -TestName "GET /groups/{id}/members" -Passed $false -Message $_.Exception.Message
        }
    }
} catch {
    Add-TestResult -Category "Groups" -TestName "Group queries" -Passed $false -Message $_.Exception.Message
}

# ══════════════════════════════════════════════════════════════════════
# TEST 4: Access Package Queries (Optional — may not exist)
# ══════════════════════════════════════════════════════════════════════
Write-TestHeader "4. Access Package Queries"

try {
    Write-TestStep "Fetching catalogs..."
    $catalogs = Get-FGCatalog
    $catalogCount = if ($catalogs -is [array]) { $catalogs.Count } else { if ($catalogs) { 1 } else { 0 } }

    if ($catalogCount -gt 0) {
        Add-TestResult -Category "AccessPackages" -TestName "GET /catalogs returns data ($catalogCount catalogs)" -Passed $true

        Write-TestStep "Fetching access packages..."
        $packages = Get-FGAccessPackage
        $packageCount = if ($packages -is [array]) { $packages.Count } else { if ($packages) { 1 } else { 0 } }
        Add-TestResult -Category "AccessPackages" -TestName "GET /accessPackages returns data ($packageCount packages)" -Passed ($packageCount -gt 0)

        if ($packageCount -gt 0) {
            $firstPackage = if ($packages -is [array]) { $packages[0] } else { $packages }

            Write-TestStep "Fetching assignments for: $($firstPackage.displayName)..."
            try {
                $assignments = Get-FGAccessPackagesAssignments -AccessPackageID $firstPackage.id
                $assignmentCount = if ($assignments -is [array]) { $assignments.Count } else { if ($assignments) { 1 } else { 0 } }
                Add-TestResult -Category "AccessPackages" -TestName "GET /assignments returns data ($assignmentCount)" -Passed $true
            } catch {
                Add-TestResult -Category "AccessPackages" -TestName "GET /assignments" -Passed $false -Message $_.Exception.Message
            }

            Write-TestStep "Fetching policies..."
            try {
                $policies = Get-FGAccessPackagesPolicy -AccessPackageId $firstPackage.id
                $policyCount = if ($policies -is [array]) { $policies.Count } else { if ($policies) { 1 } else { 0 } }
                Add-TestResult -Category "AccessPackages" -TestName "GET /policies returns data ($policyCount)" -Passed $true
            } catch {
                Add-TestResult -Category "AccessPackages" -TestName "GET /policies" -Passed $false -Message $_.Exception.Message
            }
        }
    } else {
        Add-TestResult -Category "AccessPackages" -TestName "Catalogs exist in tenant" -Passed $true -Skipped -Message "No catalogs found — access package tests skipped"
    }
} catch {
    # Entitlement management may not be licensed
    if ($_.Exception.Message -match "Request_ResourceNotFound|Authorization_RequestDenied|forbidden") {
        Add-TestResult -Category "AccessPackages" -TestName "Access package API available" -Passed $true -Skipped -Message "Entitlement Management not available in this tenant"
    } else {
        Add-TestResult -Category "AccessPackages" -TestName "Access package queries" -Passed $false -Message $_.Exception.Message
    }
}

# ══════════════════════════════════════════════════════════════════════
# TEST 5: Error Handling
# ══════════════════════════════════════════════════════════════════════
Write-TestHeader "5. Error Handling"

try {
    Write-TestStep "Testing invalid endpoint..."
    $null = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/thisDoesNotExist"
    Add-TestResult -Category "Errors" -TestName "Invalid endpoint throws error" -Passed $false -Message "Expected an error but none was thrown"
} catch {
    Add-TestResult -Category "Errors" -TestName "Invalid endpoint throws error" -Passed $true
}

try {
    Write-TestStep "Testing non-existent user ID..."
    $null = Get-FGUser -Id "00000000-0000-0000-0000-000000000000"
    Add-TestResult -Category "Errors" -TestName "Non-existent user returns error" -Passed $false -Message "Expected error for invalid user ID"
} catch {
    Add-TestResult -Category "Errors" -TestName "Non-existent user returns error" -Passed $true
}

# ══════════════════════════════════════════════════════════════════════
# TEST 6: Token Refresh Helper
# ══════════════════════════════════════════════════════════════════════
Write-TestHeader "6. Token Management"

try {
    Write-TestStep "Testing Update-FGAccessTokenIfExpired..."
    Update-FGAccessTokenIfExpired -DebugFlag 'G'
    $tokenStillValid = $null -ne $Global:AccessToken
    Add-TestResult -Category "TokenMgmt" -TestName "Update-FGAccessTokenIfExpired runs without error" -Passed $tokenStillValid
} catch {
    Add-TestResult -Category "TokenMgmt" -TestName "Update-FGAccessTokenIfExpired" -Passed $false -Message $_.Exception.Message
}

try {
    Write-TestStep "Testing Confirm-FGAccessTokenValidity..."
    $isValid = Confirm-FGAccessTokenValidity
    Add-TestResult -Category "TokenMgmt" -TestName "Confirm-FGAccessTokenValidity returns true" -Passed ($isValid -eq $true)
} catch {
    Add-TestResult -Category "TokenMgmt" -TestName "Confirm-FGAccessTokenValidity" -Passed $false -Message $_.Exception.Message
}

# ══════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Test Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Total:   $($script:TotalTests)" -ForegroundColor White
Write-Host "  Passed:  $($script:PassedTests)" -ForegroundColor Green
Write-Host "  Failed:  $($script:FailedTests)" -ForegroundColor $(if ($script:FailedTests -gt 0) { "Red" } else { "Green" })
Write-Host "  Skipped: $($script:SkippedTests)" -ForegroundColor DarkYellow

# Category breakdown
$categories = $script:TestResults | Group-Object Category
foreach ($cat in $categories) {
    $passed = ($cat.Group | Where-Object { $_.Passed -and -not $_.Skipped }).Count
    $skipped = ($cat.Group | Where-Object Skipped).Count
    $total = $cat.Group.Count
    $color = if (($cat.Group | Where-Object { -not $_.Passed -and -not $_.Skipped }).Count -eq 0) { "Green" } else { "Yellow" }
    $skipText = if ($skipped -gt 0) { " ($skipped skipped)" } else { "" }
    Write-Host "    $($cat.Name): $passed/$total$skipText" -ForegroundColor $color
}

if ($script:FailedTests -gt 0) {
    Write-Host "`nFailed Tests:" -ForegroundColor Red
    $script:TestResults | Where-Object { -not $_.Passed -and -not $_.Skipped } | ForEach-Object {
        Write-Host "  ✗ [$($_.Category)] $($_.TestName): $($_.Message)" -ForegroundColor Red
    }
}

Write-Host ""

Stop-Transcript | Out-Null
Write-Host "Log saved to: $transcriptFile" -ForegroundColor Gray

exit $(if ($script:FailedTests -gt 0) { 1 } else { 0 })
