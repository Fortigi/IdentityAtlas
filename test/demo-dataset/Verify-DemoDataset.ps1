<#
.SYNOPSIS
    Verifies the demo dataset was ingested correctly — row counts, relationships, business logic.

.DESCRIPTION
    Runs against the postgres database and the API to verify every aspect of the
    demo dataset. Returns exit code 0 if all checks pass, non-zero = number of failures.

    Database access goes through test/lib/PgQuery.psm1 (psql inside the postgres
    container). v5 has no SQL Server, and `System.Data.SqlClient` — which this
    script used until #707 — does not exist on PowerShell 7.

    Two v4-isms are gone from the queries below:
      * `ValidTo = '9999-12-31...'` — temporal tables were dropped in v5. The
        equivalent "current rows" filter is now `deletedAt IS NULL` on the
        soft-delete tables (Principals / Resources / ResourceAssignments); other
        tables have no lifecycle column. Get-PgLiveCount handles this per table.
      * `dbo.[Table]` — postgres has no `dbo` schema, and the migrations create
        tables with quoted PascalCase names, so identifiers must be
        double-quoted ("Resources", "principalType") or they fold to lowercase
        and fail to resolve.

.PARAMETER ApiBaseUrl
    API base URL (default: http://localhost:3001/api)

.PARAMETER PgService
    docker compose service name of the postgres container.

.EXAMPLE
    .\Verify-DemoDataset.ps1
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$PgService = 'postgres',
    [string]$PgUser = 'identity_atlas',
    [string]$PgPassword = 'identity_atlas_local',
    [string]$PgDatabase = 'identity_atlas',
    # CI runs its stack from docker-compose.ci.yml; empty = plain `docker compose`.
    [string]$ComposeFile = ''
)

$ErrorActionPreference = 'Continue'
$passed = 0
$failed = 0
$results = @()

Import-Module (Join-Path $PSScriptRoot '..' 'lib' 'PgQuery.psm1') -Force
Set-PgConnection -Service $PgService -User $PgUser -Password $PgPassword -Database $PgDatabase -ComposeFile $ComposeFile

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

# Every DB check funnels through here so a broken query is reported as a failed
# check rather than taking the whole run down — and never as a silent 0.
function Assert-Count {
    param([string]$Name, [string]$Query, [int]$Min, [int]$Max = [int]::MaxValue, [string]$Label = '')
    try {
        $count = Get-PgCount -Query $Query
        $expected = if ($Label) { $Label } elseif ($Max -eq [int]::MaxValue) { ">= $Min" } else { "$Min-$Max" }
        Assert-Check $Name ($count -ge $Min -and $count -le $Max) "Got $count (expected $expected)"
    }
    catch {
        Assert-Check $Name $false "Query failed: $($_.Exception.Message)"
    }
}

Write-Host "`n=== Demo Dataset Verification ===" -ForegroundColor Cyan

# ─── Row Counts ───────────────────────────────────────────────────

Write-Host "`n--- Row Counts ---" -ForegroundColor Yellow

$counts = @{
    'Systems'                = @{ Min = 3;  Max = 3 }
    'Principals'             = @{ Min = 27; Max = 30 }  # 22 employees + edge cases + omada account
    'Resources'              = @{ Min = 17; Max = 17 }  # 6 groups + 2 dir roles + 2 app roles + 4 business roles + 3 group-ownership (#713)
    'ResourceAssignments'    = @{ Min = 50; Max = 120 }
    'ResourceRelationships'  = @{ Min = 12; Max = 12 }  # 8 Contains + 1 GrantsAccessTo + 3 HasOwnership (#713)
    'Identities'             = @{ Min = 20; Max = 25 }
    'IdentityMembers'        = @{ Min = 20; Max = 40 }
    'GovernanceCatalogs'     = @{ Min = 2;  Max = 2 }
    'AssignmentPolicies'     = @{ Min = 3;  Max = 3 }
    'CertificationDecisions' = @{ Min = 2;  Max = 2 }
    'Crawlers'               = @{ Min = 1;  Max = 10 }
}

foreach ($table in $counts.Keys | Sort-Object) {
    try {
        $count = Get-PgLiveCount -Table $table
        $min = $counts[$table].Min
        $max = $counts[$table].Max
        Assert-Check "RowCount-$table" ($count -ge $min -and $count -le $max) "Got $count (expected $min-$max)"
    }
    catch {
        Assert-Check "RowCount-$table" $false "Query failed: $($_.Exception.Message)"
    }
}

# Contexts are counted separately, filtered to the dataset's own. In the v6
# model a Context carries a `variant`: the demo dataset ingests 8 'synced' ones
# (1 admin unit + 5 departments + 2 teams), while the API creates 'manual' Tag
# roots at bootstrap and the context-algorithm plugins emit 'generated' ones
# whenever the worker runs. A bare COUNT(*) therefore drifts with runtime state —
# it read 8 before the worker started and 9 after. Filtering by variant makes
# this deterministic.
Assert-Count 'RowCount-Contexts' -Min 8 -Max 8 -Query @'
SELECT COUNT(*) FROM "Contexts" WHERE "variant" = 'synced'
'@

# ─── Referential Integrity ────────────────────────────────────────

Write-Host "`n--- Referential Integrity ---" -ForegroundColor Yellow

# A live assignment must not point at a tombstoned or missing resource/principal.
Assert-Count 'FK-Assignments-Resources' -Max 0 -Min 0 -Label '0 orphans' -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
WHERE ra."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Resources" r WHERE r."id" = ra."resourceId" AND r."deletedAt" IS NULL)
'@

Assert-Count 'FK-Assignments-Principals' -Max 0 -Min 0 -Label '0 orphans' -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
WHERE ra."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Principals" p WHERE p."id" = ra."principalId" AND p."deletedAt" IS NULL)
'@

Assert-Count 'FK-IdentityMembers-Identities' -Max 0 -Min 0 -Label '0 orphans' -Query @'
SELECT COUNT(*) FROM "IdentityMembers" im
WHERE NOT EXISTS (SELECT 1 FROM "Identities" i WHERE i."id" = im."identityId")
'@

Assert-Count 'FK-IdentityMembers-Principals' -Max 0 -Min 0 -Label '0 orphans' -Query @'
SELECT COUNT(*) FROM "IdentityMembers" im
WHERE NOT EXISTS (SELECT 1 FROM "Principals" p WHERE p."id" = im."principalId" AND p."deletedAt" IS NULL)
'@

Assert-Count 'FK-Contexts-ParentContext' -Max 0 -Min 0 -Label '0 orphans' -Query @'
SELECT COUNT(*) FROM "Contexts" c
WHERE c."parentContextId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Contexts" p WHERE p."id" = c."parentContextId")
'@

# ─── Business Logic ───────────────────────────────────────────────

Write-Host "`n--- Business Logic ---" -ForegroundColor Yellow

# Principal types
Assert-Count 'Has-ServicePrincipal' -Min 1 -Query @'
SELECT COUNT(*) FROM "Principals" WHERE "principalType" = 'ServicePrincipal' AND "deletedAt" IS NULL
'@

Assert-Count 'Has-AIAgent' -Min 1 -Query @'
SELECT COUNT(*) FROM "Principals" WHERE "principalType" = 'AIAgent' AND "deletedAt" IS NULL
'@

Assert-Count 'Has-ExternalUser' -Min 1 -Query @'
SELECT COUNT(*) FROM "Principals" WHERE "principalType" = 'ExternalUser' AND "deletedAt" IS NULL
'@

# accountEnabled is a real boolean in postgres — `= 0` is a type error, not a filter.
Assert-Count 'Has-DisabledAccount' -Min 1 -Query @'
SELECT COUNT(*) FROM "Principals" WHERE "accountEnabled" = false AND "deletedAt" IS NULL
'@

# Resource types
Assert-Count 'BusinessRole-Count' -Min 4 -Max 4 -Query @'
SELECT COUNT(*) FROM "Resources" WHERE "resourceType" = 'BusinessRole' AND "deletedAt" IS NULL
'@

Assert-Count 'DirectoryRole-Count' -Min 2 -Max 2 -Query @'
SELECT COUNT(*) FROM "Resources" WHERE "resourceType" = 'EntraDirectoryRole' AND "deletedAt" IS NULL
'@

# Assignment types — governance is the `governed` flag, not a 'Governed' type.
Assert-Count 'Has-Governed-Assignments' -Min 10 -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" WHERE "governed" = true AND "deletedAt" IS NULL
'@

Assert-Count 'Has-Eligible-Assignments' -Min 1 -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" WHERE "assignmentType" = 'Eligible' AND "deletedAt" IS NULL
'@

# Ownership: a Direct assignment on a synthetic GroupOwnership resource, not the
# retired 'Owner' assignmentType (#713).
Assert-Count 'Has-GroupOwnership-Resources' -Min 1 -Query @'
SELECT COUNT(*) FROM "Resources" WHERE "resourceType" = 'GroupOwnership' AND "deletedAt" IS NULL
'@

Assert-Count 'Has-Owner-Assignments' -Min 1 -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
JOIN "Resources" r ON r."id" = ra."resourceId"
WHERE r."resourceType" = 'GroupOwnership' AND ra."deletedAt" IS NULL
'@

# Relationship types (ResourceRelationships has no soft-delete column)
Assert-Count 'Contains-Relationships' -Min 8 -Query @'
SELECT COUNT(*) FROM "ResourceRelationships" WHERE "relationshipType" = 'Contains'
'@

Assert-Count 'GrantsAccessTo-Relationships' -Min 1 -Query @'
SELECT COUNT(*) FROM "ResourceRelationships" WHERE "relationshipType" = 'GrantsAccessTo'
'@

Assert-Count 'HasOwnership-Relationships' -Min 1 -Query @'
SELECT COUNT(*) FROM "ResourceRelationships" WHERE "relationshipType" = 'HasOwnership'
'@

# Context hierarchy
Assert-Count 'Context-RootExists' -Min 1 -Max 1 -Query @'
SELECT COUNT(*) FROM "Contexts" WHERE "displayName" = 'Fortigi Demo Corp' AND "parentContextId" IS NULL
'@

Assert-Count 'Context-EngineeringUnderRoot' -Min 1 -Max 1 -Query @'
SELECT COUNT(*) FROM "Contexts" c1
INNER JOIN "Contexts" c2 ON c1."parentContextId" = c2."id"
WHERE c1."displayName" = 'Engineering' AND c2."displayName" = 'Fortigi Demo Corp'
'@

# Governance
Assert-Count 'Certification-HasApprove' -Min 1 -Query @'
SELECT COUNT(*) FROM "CertificationDecisions" WHERE "decision" = 'Approve'
'@

Assert-Count 'Certification-HasDeny' -Min 1 -Query @'
SELECT COUNT(*) FROM "CertificationDecisions" WHERE "decision" = 'Deny'
'@

# Multi-system identity. The v4 query ran GROUP BY ... HAVING through a scalar
# read, which returns the FIRST GROUP'S member count — not the number of
# multi-account identities it claimed to report. Wrap it and count the groups.
Assert-Count 'Has-MultiSystem-Identity' -Min 1 -Label 'identities with 2+ accounts' -Query @'
SELECT COUNT(*) FROM (
  SELECT "identityId" FROM "IdentityMembers" GROUP BY "identityId" HAVING COUNT(*) > 1
) multi
'@

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
