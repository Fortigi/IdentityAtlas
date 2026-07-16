<#
.SYNOPSIS
    Ingests the demo dataset into FortigiGraph via the Ingest API.

.DESCRIPTION
    Reads demo-company.json and POSTs each entity section to the appropriate
    Ingest API endpoint in dependency order.

.PARAMETER ApiBaseUrl
    Base URL of the Ingest API (default: http://localhost:3001/api)

.PARAMETER ApiKey
    Crawler API key (fgc_...)

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

function Post-Ingest {
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

Write-Host "`n=== Ingesting Fortigi Demo Corp ===" -ForegroundColor Cyan
Write-Host "Dataset: $DatasetPath"
Write-Host "API:     $ApiBaseUrl"
Write-Host ""

# 1. Systems (no systemId needed)
Write-Host "[1/12] Systems ($($dataset.systems.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/systems' -Records $dataset.systems -SyncMode 'delta'

# Get system IDs (we assume 1=EntraID, 2=HR, 3=Omada based on insertion order)
$sysEntraId = 1
$sysHR = 2
$sysOmada = 3

# 2. Contexts
Write-Host "[2/12] Contexts ($($dataset.contexts.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/contexts' -Records $dataset.contexts -SystemId $sysHR -SyncMode 'full'

# 3. Principals
Write-Host "[3/12] Principals ($($dataset.principals.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/principals' -Records $dataset.principals -SystemId $sysEntraId -SyncMode 'full'

# 4. Context Members (department / team membership — depends on Contexts + Principals)
Write-Host "[4/12] Context Members ($($dataset.contextMembers.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/context-members' -Records $dataset.contextMembers -SystemId $sysHR -SyncMode 'full'

# 5. Resources
Write-Host "[5/12] Resources ($($dataset.resources.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/resources' -Records $dataset.resources -SystemId $sysEntraId -SyncMode 'full'

# 6. Resource Assignments
Write-Host "[6/12] Resource Assignments ($($dataset.resourceAssignments.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/resource-assignments' -Records $dataset.resourceAssignments -SystemId $sysEntraId -SyncMode 'full'

# 7. Resource Relationships
Write-Host "[7/12] Resource Relationships ($($dataset.resourceRelationships.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/resource-relationships' -Records $dataset.resourceRelationships -SystemId $sysEntraId -SyncMode 'full'

# 8. Identities
Write-Host "[8/12] Identities ($($dataset.identities.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/identities' -Records $dataset.identities -SystemId $sysHR -SyncMode 'full'

# 9. Identity Members
Write-Host "[9/12] Identity Members ($($dataset.identityMembers.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/identity-members' -Records $dataset.identityMembers -SystemId $sysHR -SyncMode 'full'

# 10. Governance Catalogs
Write-Host "[10/12] Governance Catalogs ($($dataset.governanceCatalogs.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/governance/catalogs' -Records $dataset.governanceCatalogs -SystemId $sysOmada -SyncMode 'full'

# 11. Assignment Policies
Write-Host "[11/12] Assignment Policies ($($dataset.assignmentPolicies.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/governance/policies' -Records $dataset.assignmentPolicies -SystemId $sysOmada -SyncMode 'full'

# 12. Certification Decisions
Write-Host "[12/12] Certification Decisions ($($dataset.certificationDecisions.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/governance/certifications' -Records $dataset.certificationDecisions -SystemId $sysOmada -SyncMode 'full'

# Refresh views
Write-Host "`nRefreshing views..." -ForegroundColor Cyan
try {
    Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 60
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
