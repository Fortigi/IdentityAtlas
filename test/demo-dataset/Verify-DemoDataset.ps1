<#
.SYNOPSIS
    Verifies the demo dataset was ingested correctly — row counts, relationships, business logic.

.DESCRIPTION
    Runs against the SQL database and API to verify every aspect of the demo dataset.
    Returns exit code 0 if all checks pass, non-zero = number of failures.

.PARAMETER SqlConnectionString
    SQL connection string (default: local Docker)

.PARAMETER ApiBaseUrl
    API base URL (default: http://localhost:3001/api)

.EXAMPLE
    .\Verify-DemoDataset.ps1
#>

[CmdletBinding()]
Param(
    [string]$SqlConnectionString = "Server=localhost;Database=GraphData;User Id=sa;Password=FortigiGraph_Local1!;TrustServerCertificate=True",
    [string]$ApiBaseUrl = 'http://localhost:3001/api'
)

$ErrorActionPreference = 'Continue'
$passed = 0
$failed = 0
$results = @()

function Assert-Check {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) {
        Write-Host "  PASS  $Name" -ForegroundColor Green
        $script:passed++
    } else {
        Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
        $script:failed++
    }
    $script:results += @{ Name = $Name; Passed = $Condition; Detail = $Detail }
}

function Invoke-Sql {
    param([string]$Query)
    $conn = New-Object System.Data.SqlClient.SqlConnection($SqlConnectionString)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $Query
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($cmd)
    $table = New-Object System.Data.DataTable
    $adapter.Fill($table) | Out-Null
    $conn.Close()
    return $table
}

function Get-SqlScalar {
    param([string]$Query)
    $conn = New-Object System.Data.SqlClient.SqlConnection($SqlConnectionString)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $Query
    $result = $cmd.ExecuteScalar()
    $conn.Close()
    return $result
}

$CURRENT = "'9999-12-31 23:59:59.9999999'"

Write-Host "`n=== Demo Dataset Verification ===" -ForegroundColor Cyan

# ─── Row Counts ───────────────────────────────────────────────────

Write-Host "`n--- Row Counts ---" -ForegroundColor Yellow

$counts = @{
    'Systems'                = @{ Min = 3;  Max = 3 }
    'Principals'             = @{ Min = 27; Max = 30 }  # 22 employees + edge cases + omada account
    'Resources'              = @{ Min = 14; Max = 14 }
    'ResourceAssignments'    = @{ Min = 50; Max = 120 }
    'ResourceRelationships'  = @{ Min = 9;  Max = 9 }
    'Identities'             = @{ Min = 20; Max = 25 }
    'IdentityMembers'        = @{ Min = 20; Max = 40 }
    'Contexts'               = @{ Min = 7;  Max = 8 }
    'GovernanceCatalogs'     = @{ Min = 2;  Max = 2 }
    'AssignmentPolicies'     = @{ Min = 3;  Max = 3 }
    'CertificationDecisions' = @{ Min = 2;  Max = 2 }
    'Crawlers'               = @{ Min = 1;  Max = 10 }
}

foreach ($table in $counts.Keys | Sort-Object) {
    try {
        $count = Get-SqlScalar "SELECT COUNT(*) FROM dbo.[$table] WHERE ValidTo = $CURRENT"
        if ($null -eq $count) { $count = Get-SqlScalar "SELECT COUNT(*) FROM dbo.[$table]" }  # Non-temporal tables
        $min = $counts[$table].Min
        $max = $counts[$table].Max
        Assert-Check "RowCount-$table" ($count -ge $min -and $count -le $max) "Got $count (expected $min-$max)"
    }
    catch {
        Assert-Check "RowCount-$table" $false "Query failed: $($_.Exception.Message)"
    }
}

# ─── Referential Integrity ────────────────────────────────────────

Write-Host "`n--- Referential Integrity ---" -ForegroundColor Yellow

# Assignments reference existing resources
$orphanAssignRes = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments ra WHERE ra.ValidTo = $CURRENT AND NOT EXISTS (SELECT 1 FROM Resources r WHERE r.id = ra.resourceId AND r.ValidTo = $CURRENT)"
Assert-Check 'FK-Assignments-Resources' ($orphanAssignRes -eq 0) "Orphaned: $orphanAssignRes"

# Assignments reference existing principals
$orphanAssignPrinc = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments ra WHERE ra.ValidTo = $CURRENT AND NOT EXISTS (SELECT 1 FROM Principals p WHERE p.id = ra.principalId AND p.ValidTo = $CURRENT)"
Assert-Check 'FK-Assignments-Principals' ($orphanAssignPrinc -eq 0) "Orphaned: $orphanAssignPrinc"

# Identity members reference existing identities
$orphanIdMem = Get-SqlScalar "SELECT COUNT(*) FROM IdentityMembers im WHERE im.ValidTo = $CURRENT AND NOT EXISTS (SELECT 1 FROM Identities i WHERE i.id = im.identityId AND i.ValidTo = $CURRENT)"
Assert-Check 'FK-IdentityMembers-Identities' ($orphanIdMem -eq 0) "Orphaned: $orphanIdMem"

# Identity members reference existing principals
$orphanIdPrinc = Get-SqlScalar "SELECT COUNT(*) FROM IdentityMembers im WHERE im.ValidTo = $CURRENT AND NOT EXISTS (SELECT 1 FROM Principals p WHERE p.id = im.principalId AND p.ValidTo = $CURRENT)"
Assert-Check 'FK-IdentityMembers-Principals' ($orphanIdPrinc -eq 0) "Orphaned: $orphanIdPrinc"

# Context parent references
$orphanCtxParent = Get-SqlScalar "SELECT COUNT(*) FROM Contexts c WHERE c.ValidTo = $CURRENT AND c.parentContextId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Contexts p WHERE p.id = c.parentContextId AND p.ValidTo = $CURRENT)"
Assert-Check 'FK-Contexts-ParentContext' ($orphanCtxParent -eq 0) "Orphaned: $orphanCtxParent"

# ─── Business Logic ───────────────────────────────────────────────

Write-Host "`n--- Business Logic ---" -ForegroundColor Yellow

# Principal types
$spCount = Get-SqlScalar "SELECT COUNT(*) FROM Principals WHERE principalType = 'ServicePrincipal' AND ValidTo = $CURRENT"
Assert-Check 'Has-ServicePrincipal' ($spCount -ge 1) "Count: $spCount"

$aiCount = Get-SqlScalar "SELECT COUNT(*) FROM Principals WHERE principalType = 'AIAgent' AND ValidTo = $CURRENT"
Assert-Check 'Has-AIAgent' ($aiCount -ge 1) "Count: $aiCount"

$extCount = Get-SqlScalar "SELECT COUNT(*) FROM Principals WHERE principalType = 'ExternalUser' AND ValidTo = $CURRENT"
Assert-Check 'Has-ExternalUser' ($extCount -ge 1) "Count: $extCount"

$disabledCount = Get-SqlScalar "SELECT COUNT(*) FROM Principals WHERE accountEnabled = 0 AND ValidTo = $CURRENT"
Assert-Check 'Has-DisabledAccount' ($disabledCount -ge 1) "Count: $disabledCount"

# Resource types
$brCount = Get-SqlScalar "SELECT COUNT(*) FROM Resources WHERE resourceType = 'BusinessRole' AND ValidTo = $CURRENT"
Assert-Check 'BusinessRole-Count' ($brCount -eq 4) "Got $brCount (expected 4)"

$dirRoleCount = Get-SqlScalar "SELECT COUNT(*) FROM Resources WHERE resourceType = 'EntraDirectoryRole' AND ValidTo = $CURRENT"
Assert-Check 'DirectoryRole-Count' ($dirRoleCount -eq 2) "Got $dirRoleCount (expected 2)"

# Assignment types
$govCount = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments WHERE assignmentType = 'Governed' AND ValidTo = $CURRENT"
Assert-Check 'Has-Governed-Assignments' ($govCount -ge 10) "Count: $govCount"

$ownerCount = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments WHERE assignmentType = 'Owner' AND ValidTo = $CURRENT"
Assert-Check 'Has-Owner-Assignments' ($ownerCount -ge 1) "Count: $ownerCount"

$eligCount = Get-SqlScalar "SELECT COUNT(*) FROM ResourceAssignments WHERE assignmentType = 'Eligible' AND ValidTo = $CURRENT"
Assert-Check 'Has-Eligible-Assignments' ($eligCount -ge 1) "Count: $eligCount"

# Relationship types
$containsCount = Get-SqlScalar "SELECT COUNT(*) FROM ResourceRelationships WHERE relationshipType = 'Contains' AND ValidTo = $CURRENT"
Assert-Check 'Contains-Relationships' ($containsCount -ge 8) "Count: $containsCount"

$grantsCount = Get-SqlScalar "SELECT COUNT(*) FROM ResourceRelationships WHERE relationshipType = 'GrantsAccessTo' AND ValidTo = $CURRENT"
Assert-Check 'GrantsAccessTo-Relationships' ($grantsCount -ge 1) "Count: $grantsCount"

# Context hierarchy
$rootCtx = Get-SqlScalar "SELECT COUNT(*) FROM Contexts WHERE displayName = 'Fortigi Demo Corp' AND parentContextId IS NULL AND ValidTo = $CURRENT"
Assert-Check 'Context-RootExists' ($rootCtx -eq 1) "Count: $rootCtx"

$engCtx = Get-SqlScalar "SELECT COUNT(*) FROM Contexts c1 INNER JOIN Contexts c2 ON c1.parentContextId = c2.id WHERE c1.displayName = 'Engineering' AND c2.displayName = 'Fortigi Demo Corp' AND c1.ValidTo = $CURRENT AND c2.ValidTo = $CURRENT"
Assert-Check 'Context-EngineeringUnderRoot' ($engCtx -eq 1) "Count: $engCtx"

# Governance
$certApprove = Get-SqlScalar "SELECT COUNT(*) FROM CertificationDecisions WHERE decision = 'Approve' AND ValidTo = $CURRENT"
Assert-Check 'Certification-HasApprove' ($certApprove -ge 1) "Count: $certApprove"

$certDeny = Get-SqlScalar "SELECT COUNT(*) FROM CertificationDecisions WHERE decision = 'Deny' AND ValidTo = $CURRENT"
Assert-Check 'Certification-HasDeny' ($certDeny -ge 1) "Count: $certDeny"

# Multi-system identity
$multiAccount = Get-SqlScalar "SELECT COUNT(*) FROM IdentityMembers WHERE ValidTo = $CURRENT GROUP BY identityId HAVING COUNT(*) > 1"
Assert-Check 'Has-MultiSystem-Identity' ($multiAccount -ge 1) "Identities with 2+ accounts: $multiAccount"

# ─── API Verification ─────────────────────────────────────────────

Write-Host "`n--- API Verification ---" -ForegroundColor Yellow

$apiChecks = @(
    @{ Name = 'API-Resources';  Url = "$ApiBaseUrl/resources"; MinItems = 10 }
    @{ Name = 'API-Systems';    Url = "$ApiBaseUrl/systems";   MinItems = 1 }
)

foreach ($check in $apiChecks) {
    try {
        $data = Invoke-RestMethod -Uri $check.Url -TimeoutSec 30
        $count = if ($data -is [array]) { $data.Count } elseif ($data.data) { $data.data.Count } else { 0 }
        Assert-Check $check.Name ($count -ge $check.MinItems) "Got $count items (min: $($check.MinItems))"
    }
    catch {
        Assert-Check $check.Name $false $_.Exception.Message
    }
}

# Swagger
try {
    $swagger = Invoke-WebRequest -Uri "$ApiBaseUrl/docs" -UseBasicParsing -TimeoutSec 10
    Assert-Check 'API-Swagger-Loads' ($swagger.StatusCode -eq 200)
}
catch {
    Assert-Check 'API-Swagger-Loads' $false $_.Exception.Message
}

# ─── Summary ──────────────────────────────────────────────────────

Write-Host "`n╔══════════════════════════════════════╗" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
Write-Host "║  Verification: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })

# Write results JSON
$results | ConvertTo-Json -Depth 3 | Out-File -FilePath (Join-Path $PSScriptRoot 'verify-results.json') -Encoding UTF8

exit $failed
