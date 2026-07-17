<#
.SYNOPSIS
    Ingests the demo dataset into Identity Atlas via the Ingest API.

.DESCRIPTION
    Reads demo-company.json and POSTs each entity section to the appropriate
    Ingest API endpoint in dependency order.

    SYSTEM IDS ARE RESOLVED, NOT ASSUMED. Systems.id is a SERIAL, so the ids the
    database hands out depend on sequence state — they are only 1..N on a
    pristine database. This script therefore posts Systems first, reads the real
    ids back from the API response (`systemIds`, returned in record order), and
    remaps every placeholder id in the payload before posting anything else.
    The previous version hardcoded 1=EntraID / 2=HR / 3=Omada, which silently
    attached rows to the wrong system on any database that had ever seen another
    crawler.

    Rows are posted PER SYSTEM. A full sync reconciles (soft-deletes) rows that
    belong to the envelope's systemId and are absent from the batch, so each
    system's rows must go up under their own envelope — otherwise one system's
    full sync would be evaluated against another system's rows.

.PARAMETER ApiBaseUrl
    Base URL of the Ingest API (default: http://localhost:3001/api)

.PARAMETER ApiKey
    Crawler API key (fgc_...). Must not be scoped to a subset of systems — the
    demo dataset spans all five.

.PARAMETER DatasetPath
    Path to demo-company.json (default: same directory as this script)

.EXAMPLE
    .\Ingest-DemoDataset.ps1 -ApiKey "fgc_abc123..."
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [Parameter(Mandatory = $true)]
    [string]$ApiKey,
    [string]$DatasetPath = ''
)

$ErrorActionPreference = 'Continue'
if (-not $DatasetPath) { $DatasetPath = Join-Path $PSScriptRoot 'demo-company.json' }
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

if (-not (Test-Path $DatasetPath)) {
    Write-Host "Dataset not found at $DatasetPath — run Generate-DemoDataset.ps1 first" -ForegroundColor Red
    exit 1
}

$dataset = Get-Content $DatasetPath -Raw | ConvertFrom-Json
$headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }

function Invoke-IngestPost {
    param(
        [string]$Endpoint,
        [object]$Records,
        [int]$SystemId = 0,
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{}
    )

    $body = @{
        records  = @($Records)
        syncMode = $SyncMode
    }
    if ($SystemId -gt 0) { $body.systemId = $SystemId }
    if ($Scope.Count -gt 0) { $body.scope = $Scope }

    $json = $body | ConvertTo-Json -Depth 10 -Compress
    $uri = "$ApiBaseUrl/$Endpoint"

    try {
        $result = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $json -TimeoutSec 120
        Write-Host "  $Endpoint`: $($result.inserted) inserted, $($result.updated) updated, $($result.deleted ?? 0) deleted" -ForegroundColor Green
        return $result
    }
    catch {
        Write-Host "  $Endpoint`: FAILED — $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}

# Rewrite every placeholder system reference to the real id the API assigned.
function Convert-SystemIds {
    param([object]$Records, [hashtable]$Map)
    foreach ($rec in $Records) {
        foreach ($field in @('systemId', 'scopeSystemId')) {
            if (($rec.PSObject.Properties.Name -contains $field) -and $null -ne $rec.$field) {
                $placeholder = [int]$rec.$field
                if (-not $Map.ContainsKey($placeholder)) {
                    throw "Record references unknown placeholder systemId $placeholder"
                }
                $rec.$field = $Map[$placeholder]
            }
        }
    }
}

# Post a section one batch per system, so each full sync reconciles only within
# the system it is syncing.
function Invoke-IngestPerSystem {
    param([string]$Endpoint, [object]$Records, [string]$Label)
    $groups = @($Records | Group-Object -Property systemId)
    foreach ($g in $groups) {
        Write-Host "  $Label — system $($g.Name): $($g.Count) record(s)" -ForegroundColor DarkGray
        Invoke-IngestPost -Endpoint $Endpoint -Records $g.Group -SystemId ([int]$g.Name) -SyncMode 'full' | Out-Null
    }
}

Write-Host "`n=== Ingesting Fortigi Demo Corp ===" -ForegroundColor Cyan
Write-Host "Dataset: $DatasetPath"
Write-Host "API:     $ApiBaseUrl"
Write-Host ""

# 1. Systems (no systemId needed) — and resolve the real ids.
Write-Host "[1/12] Systems ($($dataset.systems.Count))..." -ForegroundColor Cyan
$sysResult = Invoke-IngestPost -Endpoint 'ingest/systems' -Records $dataset.systems -SyncMode 'delta'

$realIds = @($sysResult.systemIds)
if ($realIds.Count -ne $dataset.systems.Count) {
    Write-Host "  Expected $($dataset.systems.Count) system ids back, got $($realIds.Count). Cannot map placeholders." -ForegroundColor Red
    exit 1
}

# metadata.systemKeys is emitted parallel to the systems array, and the API
# returns systemIds in record order — so index i lines up across all three.
$systemMap = @{}
$byKey = @{}
for ($i = 0; $i -lt $realIds.Count; $i++) {
    $systemMap[$i + 1] = [int]$realIds[$i]
    $byKey[$dataset.metadata.systemKeys[$i].key] = [int]$realIds[$i]
}
Write-Host "  System ids: $(($byKey.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', ')" -ForegroundColor DarkGray

foreach ($section in @(
    $dataset.contexts, $dataset.principals, $dataset.resources,
    $dataset.resourceAssignments, $dataset.resourceRelationships,
    $dataset.governanceCatalogs, $dataset.assignmentPolicies, $dataset.certificationDecisions
)) {
    Convert-SystemIds -Records $section -Map $systemMap
}

$sysEntra = $byKey['entra']
$sysHR    = $byKey['hr']
$sysIga   = $byKey['iga']

# 2. Contexts
Write-Host "[2/12] Contexts ($($dataset.contexts.Count))..." -ForegroundColor Cyan
Invoke-IngestPost -Endpoint 'ingest/contexts' -Records $dataset.contexts -SystemId $sysHR -SyncMode 'full' | Out-Null

# 3. Principals — span Entra, IGA and SAP.
Write-Host "[3/12] Principals ($($dataset.principals.Count))..." -ForegroundColor Cyan
Invoke-IngestPerSystem -Endpoint 'ingest/principals' -Records $dataset.principals -Label 'principals'

# 4. Context Members (depends on Contexts + Principals)
Write-Host "[4/12] Context Members ($($dataset.contextMembers.Count))..." -ForegroundColor Cyan
Invoke-IngestPost -Endpoint 'ingest/context-members' -Records $dataset.contextMembers -SystemId $sysHR -SyncMode 'full' | Out-Null

# 5. Resources — span Entra, IGA, SAP and AzureRM.
Write-Host "[5/12] Resources ($($dataset.resources.Count))..." -ForegroundColor Cyan
Invoke-IngestPerSystem -Endpoint 'ingest/resources' -Records $dataset.resources -Label 'resources'

# 6. Resource Assignments — carry the system of the resource they hang off.
Write-Host "[6/12] Resource Assignments ($($dataset.resourceAssignments.Count))..." -ForegroundColor Cyan
Invoke-IngestPerSystem -Endpoint 'ingest/resource-assignments' -Records $dataset.resourceAssignments -Label 'assignments'

# 7. Resource Relationships
Write-Host "[7/12] Resource Relationships ($($dataset.resourceRelationships.Count))..." -ForegroundColor Cyan
Invoke-IngestPerSystem -Endpoint 'ingest/resource-relationships' -Records $dataset.resourceRelationships -Label 'relationships'

# 8. Identities
Write-Host "[8/12] Identities ($($dataset.identities.Count))..." -ForegroundColor Cyan
Invoke-IngestPost -Endpoint 'ingest/identities' -Records $dataset.identities -SystemId $sysHR -SyncMode 'full' | Out-Null

# 9. Identity Members — the cross-system correlation (Entra + IGA + SAP).
Write-Host "[9/12] Identity Members ($($dataset.identityMembers.Count))..." -ForegroundColor Cyan
Invoke-IngestPost -Endpoint 'ingest/identity-members' -Records $dataset.identityMembers -SystemId $sysHR -SyncMode 'full' | Out-Null

# 10-12. Governance — sourced from the IGA system.
Write-Host "[10/12] Governance Catalogs ($($dataset.governanceCatalogs.Count))..." -ForegroundColor Cyan
Invoke-IngestPost -Endpoint 'ingest/governance/catalogs' -Records $dataset.governanceCatalogs -SystemId $sysIga -SyncMode 'full' | Out-Null

Write-Host "[11/12] Assignment Policies ($($dataset.assignmentPolicies.Count))..." -ForegroundColor Cyan
Invoke-IngestPost -Endpoint 'ingest/governance/policies' -Records $dataset.assignmentPolicies -SystemId $sysIga -SyncMode 'full' | Out-Null

Write-Host "[12/12] Certification Decisions ($($dataset.certificationDecisions.Count))..." -ForegroundColor Cyan
Invoke-IngestPost -Endpoint 'ingest/governance/certifications' -Records $dataset.certificationDecisions -SystemId $sysIga -SyncMode 'full' | Out-Null

# Refresh views
Write-Host "`nRefreshing views..." -ForegroundColor Cyan
try {
    Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 60 | Out-Null
    Write-Host "  Views refreshed" -ForegroundColor Green
}
catch {
    Write-Host "  View refresh skipped (non-critical)" -ForegroundColor Yellow
}

# Seed default matrix filter so the Matrix tab shows data immediately on first visit
Write-Host "`nSeeding default matrix filter..." -ForegroundColor Cyan
$defaultFilter = @{
    name        = 'Fortigi Demo Corp — All'
    description = 'Demo default: all users and resources'
    filter      = @{
        rowType     = 'principal'
        orientation = 'rows-as-resources'
        subject     = @{ include = @(); exclude = @() }
        resource    = @{ include = @(); exclude = @() }
    }
} | ConvertTo-Json -Depth 10 -Compress
try {
    $result = Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/matrix-default-filter" -Method Post -Headers $headers -Body $defaultFilter -ContentType 'application/json' -TimeoutSec 30
    Write-Host "  Default matrix filter set: '$($result.name)'" -ForegroundColor Green
}
catch {
    Write-Host "  Default matrix filter skipped (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`n=== Ingest Complete ===" -ForegroundColor Green
Write-Host "Next, for the full demo experience (issue #705):" -ForegroundColor Cyan
Write-Host "  - run the 'department-from-principal' and 'risky-consent' context plugins" -ForegroundColor DarkGray
Write-Host "  - apply Simulate-History.sql to back-date the timeline" -ForegroundColor DarkGray
