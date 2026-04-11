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
Write-Host "[1/11] Systems ($($dataset.systems.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/systems' -Records $dataset.systems -SyncMode 'delta'

# Get system IDs (we assume 1=EntraID, 2=HR, 3=Omada based on insertion order)
$sysEntraId = 1
$sysHR = 2
$sysOmada = 3

# 2. Contexts
Write-Host "[2/11] Contexts ($($dataset.contexts.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/contexts' -Records $dataset.contexts -SystemId $sysHR -SyncMode 'full'

# 3. Principals
Write-Host "[3/11] Principals ($($dataset.principals.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/principals' -Records $dataset.principals -SystemId $sysEntraId -SyncMode 'full'

# 4. Resources
Write-Host "[4/11] Resources ($($dataset.resources.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/resources' -Records $dataset.resources -SystemId $sysEntraId -SyncMode 'full'

# 5. Resource Assignments
Write-Host "[5/11] Resource Assignments ($($dataset.resourceAssignments.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/resource-assignments' -Records $dataset.resourceAssignments -SystemId $sysEntraId -SyncMode 'full'

# 6. Resource Relationships
Write-Host "[6/11] Resource Relationships ($($dataset.resourceRelationships.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/resource-relationships' -Records $dataset.resourceRelationships -SystemId $sysEntraId -SyncMode 'full'

# 7. Identities
Write-Host "[7/11] Identities ($($dataset.identities.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/identities' -Records $dataset.identities -SystemId $sysHR -SyncMode 'full'

# 8. Identity Members
Write-Host "[8/11] Identity Members ($($dataset.identityMembers.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/identity-members' -Records $dataset.identityMembers -SystemId $sysHR -SyncMode 'full'

# 9. Governance Catalogs
Write-Host "[9/11] Governance Catalogs ($($dataset.governanceCatalogs.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/governance/catalogs' -Records $dataset.governanceCatalogs -SystemId $sysOmada -SyncMode 'full'

# 10. Assignment Policies
Write-Host "[10/11] Assignment Policies ($($dataset.assignmentPolicies.Count))..." -ForegroundColor Cyan
Post-Ingest -Endpoint 'ingest/governance/policies' -Records $dataset.assignmentPolicies -SystemId $sysOmada -SyncMode 'full'

# 11. Certification Decisions
Write-Host "[11/11] Certification Decisions ($($dataset.certificationDecisions.Count))..." -ForegroundColor Cyan
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

Write-Host "`n=== Ingest Complete ===" -ForegroundColor Green
