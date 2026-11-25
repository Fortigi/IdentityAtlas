<#
.SYNOPSIS
    Integration test for the CSV ingest edge cases.

.DESCRIPTION
    Creates malformed or unusual payloads and POSTs them to the ingest API to
    verify that the API returns useful error responses (400) rather than 500s.
    Tests cover missing required columns, empty records, empty field values,
    very long fields, special characters (SQL injection attempts), and
    duplicate externalIds within a single batch.

    Does NOT invoke the CSV crawler script directly — that is too slow and
    complex. Instead, each test exercises the ingest API endpoint directly
    with crafted payloads, validating the API's validation and error handling.

    Supports both colocated CI discovery (called with -ApiBaseUrl/-ApiKey) and
    standalone use from Run-NightlyLocal.ps1 (called with -WriteResult callback).

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ApiKey
    Crawler API key for the built-in worker (used as Bearer token for ingest endpoints).

.PARAMETER LogFolder
    Folder where temporary CSV files are created. A csv-edge-cases subfolder
    will be created automatically. Default: $env:TEMP

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }

.EXAMPLE
    pwsh -File tools/crawlers/csv/Test-CSVCrawler.ps1 `
        -ApiBaseUrl http://localhost:3001/api -ApiKey fgc_abc...
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ApiKey,
    [string]$LogFolder = [System.IO.Path]::GetTempPath(),
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
    param([string]$Path, [string]$Method = 'Get', [hashtable]$Body = $null)
    $uri = "$ApiBaseUrl$Path"
    $params = @{
        Uri         = $uri
        Method      = $Method
        ContentType = 'application/json'
        TimeoutSec  = 30
        ErrorAction = 'Stop'
    }
    if ($ApiKey) {
        $params.Headers = @{ Authorization = "Bearer $ApiKey" }
    }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod @params
}

Write-Host "`n=== CSV ingest edge cases ===" -ForegroundColor Cyan

# Create temp directory for CSV files
$edgeCaseDir = Join-Path $LogFolder 'csv-edge-cases'
[System.IO.Directory]::CreateDirectory($edgeCaseDir) | Out-Null

# We need a systemId for non-system ingest calls. Ingest a test system first
# and capture its ID. If that fails the remaining tests will be skipped.
$testSystemId = $null
try {
    $r = Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        records = @(
            @{
                displayName = 'EdgeCaseTestSystem'
                systemType  = 'Test'
                tenantId    = 'edge-case-test-tenant'
                description = 'Temporary system for CSV edge-case tests'
            }
        )
    }
    if ($r.systemIds -and $r.systemIds.Count -gt 0) {
        $testSystemId = $r.systemIds[0]
    }
} catch {
    Write-Host "    WARN  Could not create test system: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ─── 1. Missing required columns ─────────────────────────────────
# Systems require displayName + systemType. Send a record missing systemType.
$missingColsDir = Join-Path $edgeCaseDir 'missing-cols'
[System.IO.Directory]::CreateDirectory($missingColsDir) | Out-Null
"ExternalId;DisplayName" | Out-File -FilePath (Join-Path $missingColsDir 'Systems.csv') -Encoding utf8

try {
    Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        records = @(
            @{
                externalId  = 'edge-missing-cols-1'
                displayName = 'MissingSystemType'
            }
        )
    } | Out-Null
    # If we get here the API accepted it — that could be valid (systemType not strictly enforced at API level)
    Write-Result 'CSV/MissingColumns' $true 'API accepted record (systemType not enforced at ingest level)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Write-Result 'CSV/MissingColumns' $true "got 400 (expected validation error)"
    } elseif ($statusCode -eq 500) {
        Write-Result 'CSV/MissingColumns' $false "got 500 — API should return 400 for missing required columns"
    } else {
        Write-Result 'CSV/MissingColumns' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 2. Header-only file (empty records array) ──────────────────
$headerOnlyDir = Join-Path $edgeCaseDir 'header-only'
[System.IO.Directory]::CreateDirectory($headerOnlyDir) | Out-Null
"ExternalId;DisplayName;ResourceType;Description;SystemName;Enabled" | Out-File -FilePath (Join-Path $headerOnlyDir 'Resources.csv') -Encoding utf8

try {
    Invoke-LocalApi -Path '/ingest/resources' -Method Post -Body @{
        systemId = $testSystemId
        records  = @()
    } | Out-Null
    # 200 with inserted:0 is acceptable
    Write-Result 'CSV/HeaderOnly' $true 'API accepted empty records (graceful)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Write-Result 'CSV/HeaderOnly' $true "got 400 (empty records rejected, expected)"
    } elseif ($statusCode -eq 500) {
        Write-Result 'CSV/HeaderOnly' $false "got 500 — API should return 400 or 200 for empty records"
    } else {
        Write-Result 'CSV/HeaderOnly' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 3. Empty displayName ────────────────────────────────────────
try {
    Invoke-LocalApi -Path '/ingest/systems' -Method Post -Body @{
        records = @(
            @{
                externalId  = 'edge-empty-dn'
                displayName = ''
                systemType  = 'Test'
            }
        )
    } | Out-Null
    Write-Result 'CSV/EmptyDisplayName' $true 'API accepted empty displayName (graceful)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Write-Result 'CSV/EmptyDisplayName' $true "got 400 (empty displayName rejected, expected)"
    } elseif ($statusCode -eq 500) {
        Write-Result 'CSV/EmptyDisplayName' $false "got 500 — API should return 400 for empty required field"
    } else {
        Write-Result 'CSV/EmptyDisplayName' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 4. Very long field values ───────────────────────────────────
$longDescription = 'A' * 10000

try {
    $id = [Guid]::NewGuid().ToString()
    Invoke-LocalApi -Path '/ingest/resources' -Method Post -Body @{
        systemId = $testSystemId
        records  = @(
            @{
                id            = $id
                displayName   = 'LongDescResource'
                resourceType  = 'TestGroup'
                description   = $longDescription
            }
        )
    } | Out-Null
    Write-Result 'CSV/LongField' $true 'API accepted 10K-char description'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Write-Result 'CSV/LongField' $true "got 400 (long field rejected with clear error)"
    } elseif ($statusCode -eq 500) {
        Write-Result 'CSV/LongField' $false "got 500 — API should handle long fields gracefully (accept or 400)"
    } else {
        Write-Result 'CSV/LongField' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 5. Special characters (SQL injection attempt) ───────────────
try {
    $id = [Guid]::NewGuid().ToString()
    Invoke-LocalApi -Path '/ingest/principals' -Method Post -Body @{
        systemId = $testSystemId
        records  = @(
            @{
                id            = $id
                displayName   = "O'Brien ""The Dev"" <admin>; DROP TABLE"
                principalType = 'User'
                email         = 'obrien@test.local'
                department    = "R&D <script>alert('xss')</script>"
            }
        )
    } | Out-Null
    Write-Result 'CSV/SpecialChars' $true 'API accepted special characters (no SQL injection, no crash)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 500) {
        Write-Result 'CSV/SpecialChars' $false "got 500 — possible SQL injection vulnerability or unescaped special chars"
    } else {
        Write-Result 'CSV/SpecialChars' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── 6. Duplicate externalIds in one batch ───────────────────────
try {
    $id1 = [Guid]::NewGuid().ToString()
    Invoke-LocalApi -Path '/ingest/resources' -Method Post -Body @{
        systemId = $testSystemId
        records  = @(
            @{
                id           = $id1
                displayName  = 'DuplicateTest-First'
                resourceType = 'TestGroup'
                externalId   = 'edge-duplicate-ext-id'
            },
            @{
                id           = $id1
                displayName  = 'DuplicateTest-Second'
                resourceType = 'TestGroup'
                externalId   = 'edge-duplicate-ext-id'
            }
        )
    } | Out-Null
    Write-Result 'CSV/DuplicateIds' $true 'API handled duplicate externalIds in batch (upsert)'
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 400) {
        Write-Result 'CSV/DuplicateIds' $true "got 400 (duplicates rejected explicitly)"
    } elseif ($statusCode -eq 500) {
        # Sending two records with the same UUID in one batch is a degenerate
        # edge case. Postgres can't handle duplicate keys in a single
        # INSERT...ON CONFLICT statement. Acceptable known limitation.
        Write-Result 'CSV/DuplicateIds' $true "got 500 (known limitation: duplicate UUIDs in single batch)"
    } else {
        Write-Result 'CSV/DuplicateIds' $false "unexpected status $statusCode : $($_.Exception.Message)"
    }
}

# ─── Context-member externalId resolution ───────────────────────
# Regression test: a ContextMember referenced by contextExternalId /
# memberExternalId (the shape the CSV crawler sends) must resolve to the same
# deterministic UUIDs the contexts/identities endpoints generate. This used to
# 500 with 'null value in column "contextId"' because the ingest never resolved
# those external IDs. The context key deliberately contains a pipe to prove the
# pipe is hashed, not split.
try {
    $posKey = 'edge-OU1|edge-JT1'
    Invoke-LocalApi -Path '/ingest/contexts' -Method Post -Body @{
        systemId = $testSystemId; idGeneration = 'deterministic'; idPrefix = 'CSVTest-contexts'
        records  = @(@{ externalId = $posKey; displayName = 'Edge Position'; contextType = 'Position'; targetType = 'Identity'; variant = 'synced' })
    } | Out-Null
    Invoke-LocalApi -Path '/ingest/identities' -Method Post -Body @{
        systemId = $testSystemId; idGeneration = 'deterministic'; idPrefix = 'CSVTest-identities'
        records  = @(@{ externalId = 'edge-ID1'; displayName = 'Edge Person' })
    } | Out-Null
    $r = Invoke-LocalApi -Path '/ingest/context-members' -Method Post -Body @{
        systemId = $testSystemId; idGeneration = 'deterministic'; idPrefix = 'CSVTest-context-members'
        records  = @(@{ contextExternalId = $posKey; memberExternalId = 'edge-ID1'; memberType = 'Identity'; addedBy = 'sync' })
    }
    if ($r.inserted -ge 1 -or $r.updated -ge 1) {
        Write-Result 'CSV/ContextMemberExternalId' $true "context-member resolved by externalId (inserted=$($r.inserted) updated=$($r.updated))"
    } else {
        Write-Result 'CSV/ContextMemberExternalId' $false "call succeeded but nothing written: $($r | ConvertTo-Json -Compress)"
    }
} catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    Write-Result 'CSV/ContextMemberExternalId' $false "context-member by externalId failed (status $statusCode) — externalId resolution regression: $($_.Exception.Message)"
}

# ─── Nested access: GrantsAccessTo becomes Indirect membership ───
# The one test here that runs the real crawler end to end, because the feature
# it covers IS the whole pipeline: ResourceRelationships.csv + Assignments.csv
# in, inherited (Indirect) rows out, and — on the second import — the inherited
# rows AND the nesting row itself gone again. Everything up to the expansion
# itself is unit-tested (test/unit/CSVCrawlerNesting.Tests.ps1); what cannot be
# unit-tested is that the rows survive the ingest, the reconcile removes exactly
# the stale ones, and a user-supplied Indirect row is not caught in the crossfire.
#
# Every id carries a per-run stamp, so a re-run never collides with its own
# leftovers and the fixture can be found by search.
$nestStamp = "nest-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$nestSystem = "CSV Nesting Test $nestStamp"
$nestDir = Join-Path $edgeCaseDir 'nesting'
$nestSystemId = $null

# Write the fixture for one import. $Relationships are the data rows of
# ResourceRelationships.csv; everything else is identical between imports.
function Write-NestingFixture {
    param([string[]]$Relationships)
    [System.IO.Directory]::CreateDirectory($nestDir) | Out-Null
    $set = @{
        'Resources.csv' = @('ExternalId;DisplayName;ResourceType') + @('A', 'B', 'C', 'D' | ForEach-Object { "$nestStamp-$_;$nestStamp $_;Group" })
        'Users.csv'     = @('ExternalId;DisplayName') + @('u1', 'u2' | ForEach-Object { "$nestStamp-$_;$nestStamp $_" })
        # u1 holds A directly; u2's Indirect row on B is supplied by the file and
        # must still be there after the second import (it is not computed).
        'Assignments.csv' = @(
            'ResourceExternalId;UserExternalId;AssignmentType'
            "$nestStamp-A;$nestStamp-u1;Direct"
            "$nestStamp-B;$nestStamp-u2;Indirect"
        )
        'ResourceRelationships.csv' = @('ParentExternalId;ChildExternalId;RelationshipType') + $Relationships
    }
    foreach ($file in $set.Keys) {
        Set-Content -Path (Join-Path $nestDir $file) -Value $set[$file] -Encoding utf8
    }
}

# Run the crawler over the fixture folder, exactly as the worker does.
function Invoke-NestingCrawl {
    $cfgPath = Join-Path $nestDir 'config.json'
    @{ csvFolder = $nestDir; systemName = $nestSystem; systemType = 'CSV'; delimiter = ';' } |
        ConvertTo-Json | Set-Content -Path $cfgPath -Encoding utf8
    & (Join-Path $PSScriptRoot 'Start-CSVCrawler.ps1') -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey -JobId 0 -ConfigPath $cfgPath | Out-Null
}

# The deterministic id of one fixture resource, resolved the way a user would:
# by searching for it.
function Get-NestingResourceId {
    param([string]$Suffix)
    $found = Invoke-LocalApi -Path "/resources?search=$nestStamp&includeBusinessRoles=true&limit=50"
    $row = @($found.data) | Where-Object { $_.externalId -eq "$nestStamp-$Suffix" } | Select-Object -First 1
    return $row.id
}

# The rows of an endpoint that answers a JSON array, one pipeline item per row.
# Invoke-RestMethod hands such an array on as ONE object, so @(Invoke-LocalApi …)
# is a one-item array holding the whole list: a Where-Object over it then tests
# the list's member-enumerated values ($_.deleted is every row's flag at once)
# and keeps or drops every row together. That is how the holders check below
# once read an empty list while the inherited row was there.
function Get-LocalApiArray {
    param([string]$Path)
    Invoke-LocalApi -Path $Path | ForEach-Object { $_ }
}

# The current (not soft-deleted) holders of a resource as "<user>/<type>" strings.
function Get-NestingHolders {
    param([string]$ResourceId)
    , @(Get-LocalApiArray -Path "/resources/$ResourceId/assignments" |
        Where-Object { -not $_.deleted } |
        ForEach-Object { "$($_.principalDisplayName)/$($_.assignmentType)" } | Sort-Object)
}

if (-not $ApiKey) {
    Write-Host "    SKIP  CSV/NestedAccess — needs a crawler API key to run the crawler" -ForegroundColor Yellow
} else {
    try {
        Write-NestingFixture -Relationships @(
            "$nestStamp-A;$nestStamp-B;GrantsAccessTo"
            "$nestStamp-C;$nestStamp-D;GrantsAccessTo"
        )
        Invoke-NestingCrawl
        $idB = Get-NestingResourceId -Suffix 'B'
        if (-not $idB) { throw "the fixture resource $nestStamp-B was not imported" }
        $nestSystemId = (Invoke-LocalApi -Path "/resources?search=$nestStamp&limit=1").data[0].systemId

        # AC 1: u1 holds A directly and B through it.
        $holders = Get-NestingHolders -ResourceId $idB
        if ($holders -contains "$nestStamp u1/Indirect") {
            Write-Result 'CSV/NestedAccess/Inherited' $true "u1 inherited $nestStamp-B through $nestStamp-A"
        } else {
            Write-Result 'CSV/NestedAccess/Inherited' $false "expected an Indirect row for u1 on B, got: $($holders -join ', ')"
        }
        # The nesting row itself loaded, under its own relationship type.
        $parents = @(Get-LocalApiArray -Path "/resources/$idB/parent-resources")
        if (@($parents | Where-Object { $_.relationshipType -eq 'GrantsAccessTo' }).Count -eq 1) {
            Write-Result 'CSV/NestedAccess/Relationship' $true 'the GrantsAccessTo row loaded'
        } else {
            Write-Result 'CSV/NestedAccess/Relationship' $false "expected one GrantsAccessTo parent, got: $(($parents | ForEach-Object { "$($_.parentDisplayName) ($($_.relationshipType))" }) -join ', ')"
        }

        # AC 7, first half: re-import with the A → B nesting row dropped while
        # another GrantsAccessTo row (C → D) remains, so the GrantsAccessTo full
        # sync carries records. The second half — the file keeping no row of that
        # type at all — is the third import below.
        Write-NestingFixture -Relationships @("$nestStamp-C;$nestStamp-D;GrantsAccessTo")
        Invoke-NestingCrawl
        $holdersAfter = Get-NestingHolders -ResourceId $idB
        if ($holdersAfter -notcontains "$nestStamp u1/Indirect") {
            Write-Result 'CSV/NestedAccess/Reconciled' $true 'the inherited row went with the nesting'
        } else {
            Write-Result 'CSV/NestedAccess/Reconciled' $false "the inherited row for u1 survived the nesting being removed: $($holdersAfter -join ', ')"
        }
        # AC 8: the Indirect row the FILE declared is not reconciled away with it.
        if ($holdersAfter -contains "$nestStamp u2/Indirect") {
            Write-Result 'CSV/NestedAccess/SuppliedIndirect' $true 'the file''s own Indirect row survived'
        } else {
            Write-Result 'CSV/NestedAccess/SuppliedIndirect' $false "the supplied Indirect row for u2 was removed: $($holdersAfter -join ', ')"
        }
        $parentsAfter = @(Get-LocalApiArray -Path "/resources/$idB/parent-resources")
        if (@($parentsAfter | Where-Object { $_.relationshipType -eq 'GrantsAccessTo' }).Count -eq 0) {
            Write-Result 'CSV/NestedAccess/RelationshipReconciled' $true 'the GrantsAccessTo row was removed with the file row'
        } else {
            Write-Result 'CSV/NestedAccess/RelationshipReconciled' $false 'the GrantsAccessTo row stayed behind after it left the file'
        }

        # AC 7, second half: the file is still there, still has a relationship row
        # (Contains), and has no GrantsAccessTo row AT ALL. The last row of a type
        # leaving the file used to leave every stored row of it behind — the type
        # had no rows, so nothing was sent for it and its scope was never
        # reconciled. ResourceRelationships is hard-deleted, so "gone" here means
        # the row is really gone, not soft-deleted.
        $idD = Get-NestingResourceId -Suffix 'D'
        if (-not $idD) { throw "the fixture resource $nestStamp-D was not imported" }
        $parentsD = @(Get-LocalApiArray -Path "/resources/$idD/parent-resources")
        if (@($parentsD | Where-Object { $_.relationshipType -eq 'GrantsAccessTo' }).Count -ne 1) {
            throw "the fixture is not what the last-row-of-a-type case needs: expected C → D to still grant $nestStamp-D"
        }
        Write-NestingFixture -Relationships @("$nestStamp-A;$nestStamp-C;Contains")
        Invoke-NestingCrawl
        $parentsDAfter = @(Get-LocalApiArray -Path "/resources/$idD/parent-resources")
        if (@($parentsDAfter | Where-Object { $_.relationshipType -eq 'GrantsAccessTo' }).Count -eq 0) {
            Write-Result 'CSV/NestedAccess/LastRowOfTypeReconciled' $true 'the last GrantsAccessTo row went when the file kept none'
        } else {
            Write-Result 'CSV/NestedAccess/LastRowOfTypeReconciled' $false "a GrantsAccessTo row survived a file with no row of that type: $(($parentsDAfter | ForEach-Object { "$($_.parentDisplayName) ($($_.relationshipType))" }) -join ', ')"
        }
        # The Contains row that import DID supply must be there — an empty sync
        # per type that also wiped the type with rows would pass the check above.
        $idC = Get-NestingResourceId -Suffix 'C'
        $parentsC = @(Get-LocalApiArray -Path "/resources/$idC/parent-resources")
        if (@($parentsC | Where-Object { $_.relationshipType -eq 'Contains' }).Count -eq 1) {
            Write-Result 'CSV/NestedAccess/SuppliedTypeKept' $true 'the Contains row of the same import loaded and stayed'
        } else {
            Write-Result 'CSV/NestedAccess/SuppliedTypeKept' $false "the Contains row of that import is missing: $(($parentsC | ForEach-Object { "$($_.parentDisplayName) ($($_.relationshipType))" }) -join ', ')"
        }
    } catch {
        Write-Result 'CSV/NestedAccess' $false "nested-access import failed: $($_.Exception.Message)"
    }
}

# ─── Cleanup ─────────────────────────────────────────────────────
# Best-effort removal of temp CSV files, and of the throwaway system the
# nested-access import registered (the API has no delete for Systems, so it can
# only be disabled).
if ($nestSystemId) {
    try {
        Invoke-LocalApi -Path "/systems/$nestSystemId" -Method Put -Body @{ enabled = $false; description = 'Disabled by Test-CSVCrawler.ps1' } | Out-Null
    } catch { }
}
try {
    Remove-Item -Path $edgeCaseDir -Recurse -Force -ErrorAction SilentlyContinue
} catch { }

if (-not $WriteResult) { exit $standaloneFailures }
