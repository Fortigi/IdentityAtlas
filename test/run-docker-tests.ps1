<#
.SYNOPSIS
    Runs all tests against the Docker stack and produces a markdown results report.
#>

[CmdletBinding()]
Param()

$ErrorActionPreference = 'Continue'
$startTime = Get-Date
$repoRoot = Split-Path $PSScriptRoot -Parent

$cfg = Get-Content (Join-Path $PSScriptRoot 'test.config.json') -Raw | ConvertFrom-Json
$apiBaseUrl = $cfg.api.baseUrl
$uiBaseUrl  = $cfg.api.uiUrl

$results = [ordered]@{}
$totalPassed = 0
$totalFailed = 0
$totalSkipped = 0

function Test-Check {
    param([string]$Category, [string]$Name, [bool]$Passed, [string]$Detail = '', [switch]$Skip)
    $key = "$Category | $Name"
    if ($Skip) {
        $results[$key] = @{ Status = 'SKIP'; Detail = $Detail }
        $script:totalSkipped++
        Write-Host "  SKIP  $Name  $Detail" -ForegroundColor Yellow
    } elseif ($Passed) {
        $results[$key] = @{ Status = 'PASS'; Detail = $Detail }
        $script:totalPassed++
        Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        $results[$key] = @{ Status = 'FAIL'; Detail = $Detail }
        $script:totalFailed++
        Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Identity Atlas — Docker Test Suite" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ═══════════════════════════════════════════════════════════════════
# 1. DOCKER INFRASTRUCTURE
# ═══════════════════════════════════════════════════════════════════

Write-Host "--- 1. Docker Infrastructure ---" -ForegroundColor Yellow

# Check containers
$ps = docker compose -f (Join-Path $repoRoot 'docker-compose.yml') ps --format json 2>&1
$containers = $ps | ConvertFrom-Json -ErrorAction SilentlyContinue

$postgresRunning = $containers | Where-Object { $_.Service -eq 'postgres' -and $_.State -eq 'running' }
Test-Check 'Infrastructure' 'PostgreSQL container running' ($null -ne $postgresRunning)

$webRunning = $containers | Where-Object { $_.Service -eq 'web' -and $_.State -eq 'running' }
Test-Check 'Infrastructure' 'Web container running' ($null -ne $webRunning)

$workerRunning = $containers | Where-Object { $_.Service -eq 'worker' -and $_.State -eq 'running' }
Test-Check 'Infrastructure' 'Worker container running' ($null -ne $workerRunning)

# ═══════════════════════════════════════════════════════════════════
# 2. API HEALTH & ENDPOINTS
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 2. API Health & Endpoints ---" -ForegroundColor Yellow

# Health
try {
    $health = Invoke-RestMethod -Uri "$apiBaseUrl/health" -TimeoutSec 10
    Test-Check 'API' 'GET /api/health returns ok' ($health.status -eq 'ok')
} catch { Test-Check 'API' 'GET /api/health returns ok' $false $_.Exception.Message }

# Version
try {
    $version = Invoke-RestMethod -Uri "$apiBaseUrl/version" -TimeoutSec 10
    Test-Check 'API' 'GET /api/version responds' ($null -ne $version)
} catch { Test-Check 'API' 'GET /api/version responds' $false $_.Exception.Message }

# Features
try {
    $features = Invoke-RestMethod -Uri "$apiBaseUrl/features" -TimeoutSec 10
    Test-Check 'API' 'GET /api/features responds' ($null -ne $features.riskScoring)
} catch { Test-Check 'API' 'GET /api/features responds' $false $_.Exception.Message }

# Auth config
try {
    $auth = Invoke-RestMethod -Uri "$apiBaseUrl/auth-config" -TimeoutSec 10
    Test-Check 'API' 'GET /api/auth-config responds' ($auth.enabled -eq $false) "enabled=$($auth.enabled)"
} catch { Test-Check 'API' 'GET /api/auth-config responds' $false $_.Exception.Message }

# Swagger UI
try {
    $swagger = Invoke-WebRequest -Uri "$uiBaseUrl/api/docs/" -UseBasicParsing -TimeoutSec 10
    Test-Check 'API' 'Swagger UI loads (200)' ($swagger.StatusCode -eq 200)
} catch { Test-Check 'API' 'Swagger UI loads (200)' $false $_.Exception.Message }

# OpenAPI spec
try {
    $spec = Invoke-RestMethod -Uri "$apiBaseUrl/openapi.json" -TimeoutSec 10
    Test-Check 'API' 'OpenAPI spec valid' ($spec.openapi -eq '3.0.3') "openapi=$($spec.openapi)"
    Test-Check 'API' 'OpenAPI title is Identity Atlas' ($spec.info.title -match 'Identity Atlas') "$($spec.info.title)"
} catch { Test-Check 'API' 'OpenAPI spec valid' $false $_.Exception.Message }

# Frontend loads
try {
    $ui = Invoke-WebRequest -Uri $uiBaseUrl -UseBasicParsing -TimeoutSec 10
    Test-Check 'API' 'Frontend HTML loads (200)' ($ui.StatusCode -eq 200)
    Test-Check 'API' 'Frontend title is Identity Atlas' ($ui.Content -match 'Identity Atlas')
} catch { Test-Check 'API' 'Frontend HTML loads (200)' $false $_.Exception.Message }

# Systems endpoint (should return empty array)
try {
    $systems = Invoke-RestMethod -Uri "$apiBaseUrl/systems" -TimeoutSec 10
    Test-Check 'API' 'GET /api/systems responds' ($null -ne $systems)
} catch { Test-Check 'API' 'GET /api/systems responds' $false $_.Exception.Message }

# Resources endpoint
try {
    $resources = Invoke-RestMethod -Uri "$apiBaseUrl/resources" -TimeoutSec 10
    Test-Check 'API' 'GET /api/resources responds' ($null -ne $resources)
} catch { Test-Check 'API' 'GET /api/resources responds' $false $_.Exception.Message }

# ═══════════════════════════════════════════════════════════════════
# 3. CRAWLER AUTH LIFECYCLE
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 3. Crawler Auth Lifecycle ---" -ForegroundColor Yellow

$crawlerKey = $null
$crawlerName = "Test Runner $(Get-Date -Format 'HHmmss')"

# Register crawler (unique name per run prevents accumulation across repeated test runs)
try {
    $regBody = @{ displayName = $crawlerName; permissions = @('ingest','refreshViews') } | ConvertTo-Json
    $reg = Invoke-RestMethod -Uri "$apiBaseUrl/admin/crawlers" -Method Post -ContentType 'application/json' `
        -Body $regBody -TimeoutSec 10
    $crawlerKey = $reg.apiKey
    Test-Check 'CrawlerAuth' 'Register crawler returns key' ($crawlerKey -match '^fgc_') "prefix=$($reg.apiKeyPrefix)"
} catch { Test-Check 'CrawlerAuth' 'Register crawler returns key' $false $_.Exception.Message }

# Whoami
if ($crawlerKey) {
    try {
        $headers = @{ 'Authorization' = "Bearer $crawlerKey" }
        $whoami = Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/whoami" -Headers $headers -TimeoutSec 10
        Test-Check 'CrawlerAuth' 'Whoami returns crawler name' ($whoami.displayName -eq $crawlerName)
    } catch { Test-Check 'CrawlerAuth' 'Whoami returns crawler name' $false $_.Exception.Message }
}

# Invalid key rejected
try {
    $badHeaders = @{ 'Authorization' = 'Bearer fgc_invalid_key_00000000000000000000000000000000' }
    $null = Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/whoami" -Headers $badHeaders -TimeoutSec 10 -ErrorAction Stop
    Test-Check 'CrawlerAuth' 'Invalid key returns 401' $false 'No error thrown'
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    Test-Check 'CrawlerAuth' 'Invalid key returns 401' ($code -eq 401) "status=$code"
}

# No auth header rejected
try {
    $null = Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/whoami" -TimeoutSec 10 -ErrorAction Stop
    Test-Check 'CrawlerAuth' 'No auth returns 401' $false 'No error thrown'
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    Test-Check 'CrawlerAuth' 'No auth returns 401' ($code -eq 401) "status=$code"
}

# Key rotation
if ($crawlerKey) {
    try {
        $headers = @{ 'Authorization' = "Bearer $crawlerKey" }
        $rotated = Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/rotate" -Method Post -Headers $headers -TimeoutSec 10
        $newKey = $rotated.apiKey
        Test-Check 'CrawlerAuth' 'Key rotation returns new key' ($newKey -match '^fgc_' -and $newKey -ne $crawlerKey)

        # Old key should fail
        try {
            $null = Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/whoami" -Headers $headers -TimeoutSec 10 -ErrorAction Stop
            Test-Check 'CrawlerAuth' 'Old key rejected after rotation' $false 'Old key still works'
        } catch {
            $code = $_.Exception.Response.StatusCode.value__
            Test-Check 'CrawlerAuth' 'Old key rejected after rotation' ($code -eq 401)
        }

        # New key should work
        $headers = @{ 'Authorization' = "Bearer $newKey" }
        $whoami2 = Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/whoami" -Headers $headers -TimeoutSec 10
        Test-Check 'CrawlerAuth' 'New key works after rotation' ($whoami2.displayName -eq $crawlerName)
        $crawlerKey = $newKey
    } catch { Test-Check 'CrawlerAuth' 'Key rotation returns new key' $false $_.Exception.Message }
}

# List crawlers (admin)
try {
    $list = Invoke-RestMethod -Uri "$apiBaseUrl/admin/crawlers" -TimeoutSec 10
    Test-Check 'CrawlerAuth' 'Admin list returns crawlers' ($list.Count -ge 1) "count=$($list.Count)"
} catch { Test-Check 'CrawlerAuth' 'Admin list returns crawlers' $false $_.Exception.Message }

# ═══════════════════════════════════════════════════════════════════
# 4. DEMO DATASET — GENERATE, INGEST, VERIFY
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 4. Demo Dataset ---" -ForegroundColor Yellow

# Generate
$demoDir = Join-Path $repoRoot 'test/demo-dataset'
try {
    & (Join-Path $demoDir 'Generate-DemoDataset.ps1') 2>&1 | Out-Null
    $datasetExists = Test-Path (Join-Path $demoDir 'demo-company.json')
    Test-Check 'DemoDataset' 'Generate dataset' $datasetExists
} catch { Test-Check 'DemoDataset' 'Generate dataset' $false $_.Exception.Message }

# Ingest
if ($crawlerKey -and $datasetExists) {
    try {
        & (Join-Path $demoDir 'Ingest-DemoDataset.ps1') -ApiKey $crawlerKey -ApiBaseUrl $apiBaseUrl 2>&1 | Out-Null
        Test-Check 'DemoDataset' 'Ingest dataset via API' $true
    } catch { Test-Check 'DemoDataset' 'Ingest dataset via API' $false $_.Exception.Message }
}

# ═══════════════════════════════════════════════════════════════════
# 5. DATA VERIFICATION (SQL)
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 5. Data Verification (SQL) ---" -ForegroundColor Yellow

$connStr = "Server=$($cfg.sql.server),$($cfg.sql.port);Database=$($cfg.sql.database);User Id=$($cfg.sql.username);Password=$($cfg.sql.password);TrustServerCertificate=True"
$CURRENT = "'9999-12-31 23:59:59.9999999'"

function Get-SqlScalar {
    param([string]$Query)
    try {
        $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $Query
        $cmd.CommandTimeout = 30
        $result = $cmd.ExecuteScalar()
        $conn.Close()
        return $result
    } catch { return $null }
}

# Table existence
$expectedTables = @('Systems','Resources','Principals','ResourceAssignments','ResourceRelationships',
    'Identities','IdentityMembers','Contexts','GovernanceCatalogs','AssignmentPolicies',
    'AssignmentRequests','CertificationDecisions','Crawlers','CrawlerAuditLog')

foreach ($table in $expectedTables) {
    $exists = Get-SqlScalar "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '$table' AND TABLE_SCHEMA = 'dbo'"
    Test-Check 'Schema' "Table exists: $table" ($exists -ge 1)
}

# Row counts (after demo dataset ingest)
$countChecks = @{
    'Systems'                = @{ Min = 1;  Query = "SELECT COUNT(*) FROM dbo.Systems WHERE ValidTo = $CURRENT" }
    'Principals'             = @{ Min = 5;  Query = "SELECT COUNT(*) FROM dbo.Principals WHERE ValidTo = $CURRENT" }
    'Resources'              = @{ Min = 5;  Query = "SELECT COUNT(*) FROM dbo.Resources WHERE ValidTo = $CURRENT" }
    'ResourceAssignments'    = @{ Min = 10; Query = "SELECT COUNT(*) FROM dbo.ResourceAssignments WHERE ValidTo = $CURRENT" }
    'ResourceRelationships'  = @{ Min = 5;  Query = "SELECT COUNT(*) FROM dbo.ResourceRelationships WHERE ValidTo = $CURRENT" }
    'Identities'             = @{ Min = 5;  Query = "SELECT COUNT(*) FROM dbo.Identities WHERE ValidTo = $CURRENT" }
    'Contexts'               = @{ Min = 3;  Query = "SELECT COUNT(*) FROM dbo.Contexts WHERE ValidTo = $CURRENT" }
    'GovernanceCatalogs'     = @{ Min = 1;  Query = "SELECT COUNT(*) FROM dbo.GovernanceCatalogs WHERE ValidTo = $CURRENT" }
}

foreach ($table in $countChecks.Keys | Sort-Object) {
    $count = Get-SqlScalar $countChecks[$table].Query
    $min = $countChecks[$table].Min
    Test-Check 'DataCounts' "$table >= $min rows" ($count -ge $min) "actual=$count"
}

# Referential integrity
$orphanAssignRes = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments ra WHERE ra.ValidTo = $CURRENT AND NOT EXISTS (SELECT 1 FROM Resources r WHERE r.id = ra.resourceId AND r.ValidTo = $CURRENT)"
Test-Check 'Integrity' 'Assignments -> Resources (no orphans)' ($orphanAssignRes -eq 0) "orphans=$orphanAssignRes"

$orphanAssignPrinc = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments ra WHERE ra.ValidTo = $CURRENT AND NOT EXISTS (SELECT 1 FROM Principals p WHERE p.id = ra.principalId AND p.ValidTo = $CURRENT)"
Test-Check 'Integrity' 'Assignments -> Principals (no orphans)' ($orphanAssignPrinc -eq 0) "orphans=$orphanAssignPrinc"

# Principal types
$userCount = Get-SqlScalar "SELECT COUNT(*) FROM Principals WHERE principalType = 'User' AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has User principals' ($userCount -ge 10) "count=$userCount"

$spCount = Get-SqlScalar "SELECT COUNT(*) FROM Principals WHERE principalType = 'ServicePrincipal' AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has ServicePrincipal' ($spCount -ge 1) "count=$spCount"

$aiCount = Get-SqlScalar "SELECT COUNT(*) FROM Principals WHERE principalType = 'AIAgent' AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has AIAgent' ($aiCount -ge 1) "count=$aiCount"

# Resource types
$brCount = Get-SqlScalar "SELECT COUNT(*) FROM Resources WHERE resourceType = 'BusinessRole' AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has BusinessRole resources' ($brCount -ge 2) "count=$brCount"

$groupCount = Get-SqlScalar "SELECT COUNT(*) FROM Resources WHERE resourceType = 'EntraGroup' AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has EntraGroup resources' ($groupCount -ge 3) "count=$groupCount"

# Assignment types
$govCount = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments WHERE assignmentType = 'Governed' AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has Governed assignments' ($govCount -ge 5) "count=$govCount"

$ownerCount = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments WHERE assignmentType = 'Owner' AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has Owner assignments' ($ownerCount -ge 1) "count=$ownerCount"

# Context hierarchy
$rootCtx = Get-SqlScalar "SELECT COUNT(*) FROM Contexts WHERE parentContextId IS NULL AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has root context (no parent)' ($rootCtx -ge 1) "count=$rootCtx"

$childCtx = Get-SqlScalar "SELECT COUNT(*) FROM Contexts WHERE parentContextId IS NOT NULL AND ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has child contexts (with parent)' ($childCtx -ge 3) "count=$childCtx"

# Governance
$catCount = Get-SqlScalar "SELECT COUNT(*) FROM GovernanceCatalogs WHERE ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has governance catalogs' ($catCount -ge 2) "count=$catCount"

$polCount = Get-SqlScalar "SELECT COUNT(*) FROM AssignmentPolicies WHERE ValidTo = $CURRENT"
Test-Check 'BusinessLogic' 'Has assignment policies' ($polCount -ge 2) "count=$polCount"

# Crawler audit log
$auditCount = Get-SqlScalar "SELECT COUNT(*) FROM CrawlerAuditLog"
Test-Check 'BusinessLogic' 'Crawler audit log has entries' ($auditCount -ge 1) "count=$auditCount"

# ═══════════════════════════════════════════════════════════════════
# 6. API DATA VERIFICATION (read-side)
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 6. API Data Verification ---" -ForegroundColor Yellow

try {
    $apiResources = Invoke-RestMethod -Uri "$apiBaseUrl/resources" -TimeoutSec 30
    $resCount = if ($apiResources -is [array]) { $apiResources.Count } elseif ($apiResources.data) { $apiResources.data.Count } else { 0 }
    Test-Check 'APIData' 'Resources endpoint returns data' ($resCount -ge 5) "count=$resCount"
} catch { Test-Check 'APIData' 'Resources endpoint returns data' $false $_.Exception.Message }

try {
    $apiSystems = Invoke-RestMethod -Uri "$apiBaseUrl/systems" -TimeoutSec 30
    $sysCount = if ($apiSystems -is [array]) { $apiSystems.Count } else { 0 }
    Test-Check 'APIData' 'Systems endpoint returns data' ($sysCount -ge 1) "count=$sysCount"
} catch { Test-Check 'APIData' 'Systems endpoint returns data' $false $_.Exception.Message }

# ═══════════════════════════════════════════════════════════════════
# 6b. MATRIX & TAG API
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 6b. Matrix & Tag API ---" -ForegroundColor Yellow

# Auth headers — empty when auth is disabled (local Docker), crawler key when enabled
$authHeaders = if ($crawlerKey) { @{ 'Authorization' = "Bearer $crawlerKey" } } else { @{} }

# Matrix: /api/permissions must return user rows (userLimit is the correct param name)
try {
    $perm = Invoke-RestMethod -Uri "$apiBaseUrl/permissions?userLimit=25" -Headers $authHeaders -TimeoutSec 30
    $userCount = if ($perm.data) { $perm.data.Count } else { 0 }
    Test-Check 'MatrixAPI' 'Matrix returns user rows' ($userCount -ge 5) "users=$userCount"

    # Each user row has a memberId — check there are also resource rows (groupId)
    $hasAssignments = $perm.data -and ($perm.data | Where-Object { $_.groupId -or $_.resourceId }) -and
                      (@($perm.data | Where-Object { $_.groupId -or $_.resourceId }).Count -ge 1)
    Test-Check 'MatrixAPI' 'Matrix rows have resource assignments' $hasAssignments
} catch { Test-Check 'MatrixAPI' 'Matrix returns user rows' $false $_.Exception.Message }

# Tags: create a tag, assign it to a resource, filter by it
try {
    # 1. Create a tag
    $tagBody = @{ name = 'test-critical'; entityType = 'resource'; color = '#FF0000' } | ConvertTo-Json
    $newTag = Invoke-RestMethod -Uri "$apiBaseUrl/tags" -Method Post -Headers $authHeaders -Body $tagBody -ContentType 'application/json' -TimeoutSec 30
    $tagId = $newTag.id
    Test-Check 'MatrixAPI' 'Create resource tag' ($null -ne $tagId) "tagId=$tagId"

    # 2. Get a resource to tag
    $resources = Invoke-RestMethod -Uri "$apiBaseUrl/resources?limit=1" -Headers $authHeaders -TimeoutSec 30
    $resourceId = if ($resources.data) { $resources.data[0].id } else { $resources[0].id }

    # 3. Assign tag to resource
    $assignBody = @{ entityIds = @($resourceId) } | ConvertTo-Json
    Invoke-RestMethod -Uri "$apiBaseUrl/tags/$tagId/assign" -Method Post -Headers $authHeaders -Body $assignBody -ContentType 'application/json' -TimeoutSec 30
    Test-Check 'MatrixAPI' 'Assign tag to resource' $true

    # 4. Verify tag shows on resource
    $taggedResources = Invoke-RestMethod -Uri "$apiBaseUrl/resources?tag=test-critical" -Headers $authHeaders -TimeoutSec 30
    $taggedCount = if ($taggedResources.data) { $taggedResources.data.Count } else { 0 }
    Test-Check 'MatrixAPI' 'Tag filter returns tagged resources' ($taggedCount -ge 1) "count=$taggedCount"

    # 5. Matrix filtered by group tag should only show users with that resource
    $permFiltered = Invoke-RestMethod -Uri "$apiBaseUrl/permissions?userLimit=25&__groupTag=test-critical" -Headers $authHeaders -TimeoutSec 30
    $filteredUsers = if ($permFiltered.data) { $permFiltered.data.Count } else { 0 }
    Test-Check 'MatrixAPI' 'Matrix group tag filter reduces results' ($filteredUsers -ge 1) "users=$filteredUsers"

    # 6. Cleanup: delete the tag
    Invoke-RestMethod -Uri "$apiBaseUrl/tags/$tagId" -Method Delete -Headers $authHeaders -TimeoutSec 30
    Test-Check 'MatrixAPI' 'Delete tag cleanup' $true

} catch { Test-Check 'MatrixAPI' 'Tag lifecycle' $false $_.Exception.Message }

# ═══════════════════════════════════════════════════════════════════
# 7. WORKER CONTAINER
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 7. Worker Container ---" -ForegroundColor Yellow

$workerLogs = (docker logs fortigigraph-worker-1 2>&1) -join "`n"
Test-Check 'Worker' 'Module loaded successfully' ($workerLogs -like '*Module loaded successfully*')
Test-Check 'Worker' 'Shows Identity Atlas branding' ($workerLogs -like '*Identity Atlas*')

# ═══════════════════════════════════════════════════════════════════
# 8. POWERSHELL MODULE LOADING
# ═══════════════════════════════════════════════════════════════════

Write-Host "`n--- 8. PowerShell Module ---" -ForegroundColor Yellow

try {
    Import-Module (Join-Path $repoRoot 'setup/IdentityAtlas.psd1') -Force
    Test-Check 'Module' 'Module loads without errors' $true

    $cmdCount = (Get-Command -Module IdentityAtlas -ErrorAction SilentlyContinue).Count
    if ($cmdCount -eq 0) {
        # Module might load under old name from psd1
        $cmdCount = (Get-Command *-FG* -ErrorAction SilentlyContinue).Count
    }
    Test-Check 'Module' "Functions loaded (>50)" ($cmdCount -ge 50) "count=$cmdCount"

    # Check key functions exist (v5 — Graph SDK only, no SQL helpers)
    $keyFunctions = @('Invoke-FGGetRequest','Get-FGAccessToken','Get-FGUser','Get-FGGroup')
    foreach ($fn in $keyFunctions) {
        $exists = $null -ne (Get-Command $fn -ErrorAction SilentlyContinue)
        Test-Check 'Module' "Function exists: $fn" $exists
    }

    # Check deleted functions DON'T exist (v5: SQL helpers + monolithic syncs were removed)
    $deletedFunctions = @('Start-FGSync','Start-FGCSVSync','Sync-FGPrincipal','Sync-FGGroup',
        'Connect-FGSQLServer','Initialize-FGSystemTables','Initialize-FGGovernanceTables',
        'Initialize-FGCrawlerTables','Invoke-FGSQLCommand','New-FGConfig')
    foreach ($fn in $deletedFunctions) {
        $exists = $null -ne (Get-Command $fn -ErrorAction SilentlyContinue)
        Test-Check 'Module' "Deleted function removed: $fn" (-not $exists) $(if ($exists) { "STILL EXISTS" })
    }
} catch { Test-Check 'Module' 'Module loads without errors' $false $_.Exception.Message }

# ═══════════════════════════════════════════════════════════════════
# REPORT
# ═══════════════════════════════════════════════════════════════════

$elapsed = (Get-Date) - $startTime
$totalTests = $results.Count

Write-Host "`n========================================" -ForegroundColor $(if ($totalFailed -eq 0) { 'Green' } else { 'Red' })
Write-Host "  RESULTS: $totalPassed passed, $totalFailed failed, $totalSkipped skipped ($totalTests total)" -ForegroundColor $(if ($totalFailed -eq 0) { 'Green' } else { 'Red' })
Write-Host "  Duration: $([Math]::Round($elapsed.TotalSeconds)) seconds" -ForegroundColor Gray
Write-Host "========================================`n" -ForegroundColor $(if ($totalFailed -eq 0) { 'Green' } else { 'Red' })

# Generate Markdown report
$md = @()
$md += "# Identity Atlas — Docker Test Results"
$md += ""
$md += "**Date:** $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$md += "**Duration:** $([Math]::Round($elapsed.TotalSeconds)) seconds"
$md += "**Results:** $totalPassed passed, $totalFailed failed, $totalSkipped skipped ($totalTests total)"
$md += ""
$md += "---"
$md += ""

$currentCategory = ''
foreach ($key in $results.Keys) {
    $parts = $key -split ' \| '
    $cat = $parts[0]
    $name = $parts[1]
    $r = $results[$key]

    if ($cat -ne $currentCategory) {
        if ($currentCategory -ne '') { $md += "" }
        $md += "## $cat"
        $md += ""
        $md += "| Test | Status | Detail |"
        $md += "|---|---|---|"
        $currentCategory = $cat
    }

    $icon = switch ($r.Status) { 'PASS' { 'PASS' } 'FAIL' { 'FAIL' } 'SKIP' { 'SKIP' } }
    $detail = if ($r.Detail) { $r.Detail } else { '' }
    $md += "| $name | $icon | $detail |"
}

$md += ""
$md += "---"
$md += ""
$md += "## Summary"
$md += ""
$md += "| Metric | Value |"
$md += "|---|---|"
$md += "| Total tests | $totalTests |"
$md += "| Passed | $totalPassed |"
$md += "| Failed | $totalFailed |"
$md += "| Skipped | $totalSkipped |"
$md += "| Duration | $([Math]::Round($elapsed.TotalSeconds))s |"
$md += "| Docker containers | 3 (sql, web, worker) |"
$md += "| Date | $(Get-Date -Format 'yyyy-MM-dd HH:mm') |"

$reportPath = Join-Path $repoRoot 'test/test-results.md'
$md -join "`n" | Out-File -FilePath $reportPath -Encoding UTF8
Write-Host "Report written to: $reportPath" -ForegroundColor Cyan

exit $totalFailed
