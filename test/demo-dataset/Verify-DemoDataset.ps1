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

# The generator is deterministic, so these are exact. If one of them fails after
# a dataset change, that is the point: re-run Generate-DemoDataset.ps1, confirm
# the new number is intended, and update it here in the same PR.
$counts = @{
    'Systems'                = @{ Min = 5;  Max = 5 }   # EntraID + HR + IGA + SAP + AzureRM (#705)
    'Principals'             = @{ Min = 45; Max = 45 }  # 26 employees + 5 edge cases + IGA acct + 10 SAP + 3 app SPs
    'Resources'              = @{ Min = 43; Max = 43 }  # Entra 10 + ownership 3 + business roles 6 + Sales 4 + role drift 3 + consent 4 + SAP 4 + Azure 9
    'ResourceAssignments'    = @{ Min = 157; Max = 157 }
    'ResourceRelationships'  = @{ Min = 23; Max = 23 }  # 17 Contains + 1 GrantsAccessTo + 3 HasOwnership + 2 DelegatesScope
    'Identities'             = @{ Min = 27; Max = 27 }  # 26 employees + the leaver
    'IdentityMembers'        = @{ Min = 38; Max = 38 }  # 27 Entra + 1 IGA + 10 SAP
    'GovernanceCatalogs'     = @{ Min = 2;  Max = 2 }
    'AssignmentPolicies'     = @{ Min = 4;  Max = 4 }
    'CertificationDecisions' = @{ Min = 3;  Max = 3 }
    'Crawlers'               = @{ Min = 1;  Max = 10 }  # runtime state, not generated
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
# model a Context carries a `variant`: the demo dataset ingests 9 'synced' ones
# (1 root + 5 departments + 2 teams + 1 admin unit), while the API creates
# 'manual' Tag roots at bootstrap and the context-algorithm plugins emit
# 'generated' ones whenever the worker runs. A bare COUNT(*) therefore drifts
# with runtime state. Filtering by variant makes this deterministic.
Assert-Count 'RowCount-Contexts' -Min 9 -Max 9 -Query @'
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
Assert-Count 'BusinessRole-Count' -Min 5 -Max 5 -Query @'
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

# ─── Capture-the-Flag scenarios (#705) ────────────────────────────
# Each flag's answer, computed straight from the database. These are the
# data-level regression layer: if a dataset change moves an answer, the flag
# breaks here rather than in a participant's inbox. Update the published answer
# in the same PR as any change that trips one of these.

Write-Host "`n--- Capture-the-Flag scenarios ---" -ForegroundColor Yellow

# Flag 1 — Sales has 6 ACTIVE identities. The 7th (the disabled leaver) is the
# distractor, so assert both numbers: a naive count must differ from the answer.
Assert-Count 'CTF01-SalesActiveIdentities' -Min 6 -Max 6 -Query @'
SELECT COUNT(DISTINCT i."id") FROM "Identities" i
JOIN "IdentityMembers" im ON im."identityId" = i."id"
WHERE i."department" = 'Sales' AND im."accountEnabled" = true
'@

Assert-Count 'CTF01-SalesIdentitiesIncludingLeaver' -Min 7 -Max 7 -Query @'
SELECT COUNT(DISTINCT i."id") FROM "Identities" i WHERE i."department" = 'Sales'
'@

# Flag 4 — Piet's CRM access is role-derived only. A Direct grant would make the
# answer "because someone gave it to him", which is the wrong lesson.
Assert-Count 'CTF04-PietCrmNotDirect' -Min 0 -Max 0 -Label '0 direct grants' -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE p."displayName" = 'Piet Jansen' AND r."displayName" = 'SG-CRM-Users'
  AND ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL
'@

Assert-Count 'CTF04-PietCrmViaRole' -Min 1 -Max 1 -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE p."displayName" = 'Piet Jansen' AND r."displayName" = 'SG-CRM-Users'
  AND ra."assignmentType" = 'Indirect' AND ra."deletedAt" IS NULL
'@

# Flag 6 — the role candidate must NOT already be in BR-Sales, or there is
# nothing to recommend.
Assert-Count 'CTF06-SharePointNotInRole' -Min 0 -Max 0 -Label '0 Contains edges' -Query @'
SELECT COUNT(*) FROM "ResourceRelationships" rr
JOIN "Resources" parent ON parent."id" = rr."parentResourceId"
JOIN "Resources" child  ON child."id"  = rr."childResourceId"
WHERE parent."displayName" = 'BR-Sales' AND child."displayName" = 'SG-Sales-SharePoint'
  AND rr."relationshipType" = 'Contains'
'@

# Flag 7 — the trap must cross the department boundary; that (plus its
# sensitivity) is what distinguishes it from flag 6's clean candidate.
Assert-Count 'CTF07-TrapIsCrossDepartment' -Min 2 -Query @'
SELECT COUNT(DISTINCT p."department") FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE r."displayName" = 'SG-Finance-Reports' AND ra."deletedAt" IS NULL
'@

# Flag 8 — Finance has the most SAP accounts...
Assert-Count 'CTF08-SapFinanceCount' -Min 4 -Max 4 -Query @'
SELECT COUNT(*) FROM "Principals" p
JOIN "Systems" s ON s."id" = p."systemId"
JOIN "IdentityMembers" im ON im."principalId" = p."id"
JOIN "Identities" i ON i."id" = im."identityId"
WHERE s."systemType" = 'SAP' AND i."department" = 'Finance' AND p."deletedAt" IS NULL
'@

# ...and the flag is only hard because SAP accounts carry no department of their
# own. If this ever becomes non-zero the answer is readable straight off the
# account list and the flag is worthless.
Assert-Count 'CTF08-SapAccountsHaveNoDepartment' -Min 0 -Max 0 -Label '0 with department' -Query @'
SELECT COUNT(*) FROM "Principals" p
JOIN "Systems" s ON s."id" = p."systemId"
WHERE s."systemType" = 'SAP' AND p."department" IS NOT NULL AND p."deletedAt" IS NULL
'@

# Flag 9 — the never-expiring password set.
Assert-Count 'CTF09-NeverExpiringPasswords' -Min 5 -Max 5 -Query @'
SELECT COUNT(*) FROM "Principals"
WHERE "extendedAttributes"->>'passwordNeverExpires' = 'true' AND "deletedAt" IS NULL
'@

# Flag 10 — everyone holding an Azure US role. The westeurope distractor must
# also exist, or "filter by region" isn't a real step.
Assert-Count 'CTF10-AzureUsPrincipals' -Min 3 -Max 3 -Query @'
SELECT COUNT(DISTINCT ra."principalId") FROM "ResourceAssignments" ra
JOIN "Resources" r ON r."id" = ra."resourceId"
WHERE r."resourceType" = 'AzureRoleAssignment'
  AND r."extendedAttributes"->>'azureLocation' = 'eastus' AND ra."deletedAt" IS NULL
'@

Assert-Count 'CTF10-AzureEuDistractorExists' -Min 1 -Query @'
SELECT COUNT(*) FROM "Resources"
WHERE "resourceType" = 'AzureRoleAssignment'
  AND "extendedAttributes"->>'azureLocation' = 'westeurope' AND "deletedAt" IS NULL
'@

# Flag 11 — who consented to Files.ReadWrite.All.
Assert-Count 'CTF11-FilesReadWriteConsenters' -Min 5 -Max 5 -Query @'
SELECT COUNT(DISTINCT ra."principalId") FROM "ResourceAssignments" ra
JOIN "Resources" r ON r."id" = ra."resourceId"
WHERE r."resourceType" = 'DelegatedPermission'
  AND r."extendedAttributes"->>'scope' = 'Files.ReadWrite.All' AND ra."deletedAt" IS NULL
'@

# Flag 12 — the intersection: risky consent AND a never-expiring password.
Assert-Count 'CTF12-RiskyConsentAndNeverExpire' -Min 2 -Max 2 -Query @'
SELECT COUNT(DISTINCT ra."principalId") FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE r."resourceType" = 'DelegatedPermission'
  AND r."extendedAttributes"->>'scope' = 'Files.ReadWrite.All'
  AND p."extendedAttributes"->>'passwordNeverExpires' = 'true'
  AND ra."deletedAt" IS NULL
'@

# ...and the trap must stay bigger than the answer. If these ever match, the
# "risky" half of the question stopped mattering.
Assert-Count 'CTF12-TrapIsWiderThanAnswer' -Min 3 -Max 3 -Label '3 (answer is 2)' -Query @'
SELECT COUNT(DISTINCT ra."principalId") FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE r."resourceType" = 'DelegatedPermission'
  AND p."extendedAttributes"->>'passwordNeverExpires' = 'true'
  AND ra."deletedAt" IS NULL
'@

# The risky-consent context plugin joins clientSpId -> Principals to read the
# app's appId/publisher. A dangling clientSpId silently drops the grant from the
# plugin's output (the shape of issue #719), taking flags 11-12 with it.
Assert-Count 'CTF-ConsentGrantsResolveToClientSp' -Min 0 -Max 0 -Label '0 dangling clientSpId' -Query @'
SELECT COUNT(*) FROM "Resources" r
WHERE r."resourceType" = 'DelegatedPermission' AND r."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Principals" p WHERE p."id"::text = r."extendedAttributes"->>'clientSpId'
  )
'@

# ─── Role drift: fewer / more access than the business role assigns ───────
# The matrix shows both directions of drift against a business role, so the
# dataset has to contain both. These guard the scenario the grid renders (see
# parts/DemoRoleDrift.ps1 and docs/architecture/matrix.md).

Write-Host "`n--- Role drift ---" -ForegroundColor Yellow

# BR-Service-Desk grants three resources, one of them just-in-time only.
Assert-Count 'Drift-RoleGrantsThreeResources' -Min 3 -Max 3 -Query @'
SELECT COUNT(*) FROM "ResourceRelationships" rr
JOIN "Resources" parent ON parent."id" = rr."parentResourceId"
WHERE parent."displayName" = 'BR-Service-Desk' AND rr."relationshipType" = 'Contains'
'@

Assert-Count 'Drift-AdminIsEligibleOnly' -Min 1 -Max 1 -Query @'
SELECT COUNT(*) FROM "ResourceRelationships" rr
JOIN "Resources" parent ON parent."id" = rr."parentResourceId"
JOIN "Resources" child  ON child."id"  = rr."childResourceId"
WHERE parent."displayName" = 'BR-Service-Desk' AND child."displayName" = 'SG-Servicedesk-Admin'
  AND lower(rr."roleName") LIKE '%eligible%'
'@

# FEWER — Tom Bakker holds the role but only one of the three resources.
Assert-Count 'Drift-HolderShortOfWhatRoleAssigns' -Min 1 -Max 1 -Label '1 of 3 resources held' -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE p."displayName" = 'Tom Bakker' AND ra."deletedAt" IS NULL
  AND r."displayName" IN ('SG-Servicedesk-Tools', 'SG-Servicedesk-KB', 'SG-Servicedesk-Admin')
'@

# BOTH AT ONCE — Wendy Xu is missing the KB the role assigns...
Assert-Count 'Drift-BothDirections-MissingKb' -Min 0 -Max 0 -Label '0 KB memberships' -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE p."displayName" = 'Wendy Xu' AND r."displayName" = 'SG-Servicedesk-KB' AND ra."deletedAt" IS NULL
'@

# ...while holding permanently what the role only makes her eligible for.
Assert-Count 'Drift-BothDirections-StandingOnEligible' -Min 1 -Max 1 -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE p."displayName" = 'Wendy Xu' AND r."displayName" = 'SG-Servicedesk-Admin'
  AND ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL
'@

# Both role holders who match their role exactly must stay clean, or the
# deviations above read as the norm rather than as findings.
Assert-Count 'Drift-CleanHoldersMatchTheRole' -Min 6 -Max 6 -Label '2 holders × 3 resources' -Query @'
SELECT COUNT(*) FROM "ResourceAssignments" ra
JOIN "Resources"  r ON r."id" = ra."resourceId"
JOIN "Principals" p ON p."id" = ra."principalId"
WHERE p."displayName" IN ('Ursula Visser', 'Victor Wang') AND ra."deletedAt" IS NULL
  AND r."displayName" IN ('SG-Servicedesk-Tools', 'SG-Servicedesk-KB', 'SG-Servicedesk-Admin')
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
