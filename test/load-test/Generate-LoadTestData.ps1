<#
.SYNOPSIS
    Generates a large synthetic CSV dataset for load testing the Identity Atlas
    Ingest API and CSV crawler.

.DESCRIPTION
    Produces a full set of Identity Atlas canonical-schema CSV files sized for
    stress testing:

        - 20 systems
        - 80,000 users
        - 80,000 resources
        - 15,000 contexts (departments)
        - 1,500,000 user/resource assignments
        - 100,000 resource relationships (parent/child role nesting)
        - 25,000 identities
        - ~76,000 identity members (95% of users linked to an identity)
        - 300,000 certification decisions

    Files are semicolon-delimited, UTF-8 with BOM, matching the canonical schema
    in docs/architecture/csv-import-schema.md.

    Uses System.IO.StreamWriter for throughput (Export-Csv would take much
    longer for 1.5M rows). A fixed random seed makes output reproducible.

.PARAMETER OutputFolder
    Where to write the CSV files. Default: .\data next to the script.

.PARAMETER UserCount
    Number of users to generate. Default: 80000.

.PARAMETER ResourceCount
    Number of resources to generate. Default: 80000.

.PARAMETER SystemCount
    Number of source systems. Default: 20.

.PARAMETER ContextCount
    Number of department contexts. Default: 15000.

.PARAMETER IdentityCount
    Number of identities (real people). Default: 25000.

.PARAMETER AssignmentCount
    Number of user→resource assignments. Default: 1500000.

.PARAMETER RelationshipCount
    Number of parent/child resource relationships. Default: 100000.

.PARAMETER CertificationCount
    Number of certification decisions. Default: 300000.

.PARAMETER IdentityMemberRatio
    Fraction of users linked to an identity. Default: 0.95 (95%).

.PARAMETER Seed
    Random seed for reproducibility. Default: 20260411.

.EXAMPLE
    .\Generate-LoadTestData.ps1
    # Full load test dataset in .\data

.EXAMPLE
    .\Generate-LoadTestData.ps1 -UserCount 1000 -ResourceCount 1000 -AssignmentCount 10000
    # Small dataset for quick sanity checks
#>

[CmdletBinding()]
Param(
    [string]$OutputFolder = (Join-Path $PSScriptRoot 'data'),
    [int]$UserCount = 80000,
    [int]$ResourceCount = 80000,
    [int]$SystemCount = 20,
    [int]$ContextCount = 15000,
    [int]$IdentityCount = 25000,
    [int]$AssignmentCount = 1500000,
    [int]$RelationshipCount = 100000,
    [int]$CertificationCount = 300000,
    [double]$IdentityMemberRatio = 0.95,
    [int]$Seed = 20260411
)

$ErrorActionPreference = 'Stop'
$swatch = [System.Diagnostics.Stopwatch]::StartNew()

if (-not (Test-Path $OutputFolder)) {
    New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null
}

Write-Host "`n=== Identity Atlas load test dataset generator ===" -ForegroundColor Cyan
Write-Host "Output folder: $OutputFolder" -ForegroundColor Gray
Write-Host "Seed: $Seed" -ForegroundColor Gray
Write-Host ""

$rng = [System.Random]::new($Seed)
$encoding = [System.Text.UTF8Encoding]::new($true)  # with BOM — matches schema

function New-Writer {
    param([string]$FileName)
    $path = Join-Path $OutputFolder $FileName
    # FileStream + StreamWriter with 1 MB buffer — fastest safe option for large files
    $fs = [System.IO.FileStream]::new($path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read, 1048576)
    $sw = [System.IO.StreamWriter]::new($fs, $encoding, 1048576)
    return $sw
}

# ─── Reference data pools ────────────────────────────────────────
$systemTypes       = @('EntraID','ActiveDirectory','SAP','Omada','ServiceNow','CSV','Custom')
$resourceTypes     = @('EntraGroup','SAPRole','BusinessRole','AppRole','DirectoryRole','ApplicationRole')
$assignmentTypes   = @('Direct','Eligible','Owner','Governed')
$relationshipTypes = @('Contains','Contains','Contains','GrantsAccessTo')  # 75% Contains
$principalTypes    = @('User','User','User','User','User','User','User','User','ServicePrincipal','ExternalUser')  # 80% User
$contextTypes      = @('Department','CostCenter','Division','Team')
$accountTypes      = @('Primary','Secondary','Service','Admin')
$decisions         = @('Approved','Approved','Approved','Approved','Denied','NotReviewed')  # 66% Approved, 16% Denied, 16% NotReviewed
$jobTitles         = @('Software Engineer','Senior Engineer','Staff Engineer','Architect','Manager','Director','Analyst','Consultant','Administrator','Specialist','Team Lead','Product Manager','Data Scientist','DevOps Engineer','Security Analyst','Business Analyst','Project Manager','Controller','Accountant','Auditor')

# ─── 1. Systems.csv ──────────────────────────────────────────────
Write-Host "[1/9] Generating Systems.csv ($SystemCount rows)..." -ForegroundColor Cyan
$sw = New-Writer 'Systems.csv'
try {
    $sw.WriteLine('ExternalId;DisplayName;SystemType;Description')
    for ($i = 1; $i -le $SystemCount; $i++) {
        $type = $systemTypes[$rng.Next(0, $systemTypes.Count)]
        $sw.WriteLine(("SYS{0};System {0};{1};Load test system {0}" -f $i, $type))
    }
} finally { $sw.Close() }

# ─── 2. Contexts.csv ─────────────────────────────────────────────
Write-Host "[2/9] Generating Contexts.csv ($ContextCount rows)..." -ForegroundColor Cyan
$sw = New-Writer 'Contexts.csv'
try {
    $sw.WriteLine('ExternalId;DisplayName;ContextType;Description;ParentExternalId;SystemName')
    for ($i = 1; $i -le $ContextCount; $i++) {
        $type = $contextTypes[$rng.Next(0, $contextTypes.Count)]
        # ~30% of contexts are children of another context (hierarchy)
        $parent = ''
        if ($i -gt 100 -and $rng.NextDouble() -lt 0.3) {
            $parent = "CTX{0}" -f $rng.Next(1, [Math]::Min($i, 100) + 1)
        }
        $sw.WriteLine(("CTX{0};Department{0};{1};Load test department {0};{2};" -f $i, $type, $parent))
    }
} finally { $sw.Close() }

# ─── 3. Resources.csv ────────────────────────────────────────────
Write-Host "[3/9] Generating Resources.csv ($ResourceCount rows)..." -ForegroundColor Cyan
$sw = New-Writer 'Resources.csv'
try {
    $sw.WriteLine('ExternalId;DisplayName;ResourceType;Description;SystemName;Enabled')
    for ($i = 1; $i -le $ResourceCount; $i++) {
        $rtype = $resourceTypes[$rng.Next(0, $resourceTypes.Count)]
        $sysIdx = $rng.Next(1, $SystemCount + 1)
        $enabled = if ($rng.NextDouble() -lt 0.95) { 'true' } else { 'false' }
        $sw.WriteLine(("RES{0};Resource {0};{1};Load test {1} resource {0};System {2};{3}" -f $i, $rtype, $sysIdx, $enabled))
        if ($i % 20000 -eq 0) { Write-Host "      $i / $ResourceCount" -ForegroundColor DarkGray }
    }
} finally { $sw.Close() }

# ─── 4. ResourceRelationships.csv ────────────────────────────────
Write-Host "[4/9] Generating ResourceRelationships.csv ($RelationshipCount rows)..." -ForegroundColor Cyan
$sw = New-Writer 'ResourceRelationships.csv'
try {
    $sw.WriteLine('ParentExternalId;ChildExternalId;RelationshipType;SystemName')
    for ($i = 1; $i -le $RelationshipCount; $i++) {
        # Pick two distinct resources — parent != child, no self-loops
        $parentIdx = $rng.Next(1, $ResourceCount + 1)
        $childIdx = $rng.Next(1, $ResourceCount + 1)
        if ($childIdx -eq $parentIdx) {
            $childIdx = ($childIdx % $ResourceCount) + 1
        }
        $rtype = $relationshipTypes[$rng.Next(0, $relationshipTypes.Count)]
        $sysIdx = $rng.Next(1, $SystemCount + 1)
        $sw.WriteLine(("RES{0};RES{1};{2};System {3}" -f $parentIdx, $childIdx, $rtype, $sysIdx))
        if ($i % 20000 -eq 0) { Write-Host "      $i / $RelationshipCount" -ForegroundColor DarkGray }
    }
} finally { $sw.Close() }

# ─── 5. Users.csv ────────────────────────────────────────────────
Write-Host "[5/9] Generating Users.csv ($UserCount rows)..." -ForegroundColor Cyan
$sw = New-Writer 'Users.csv'
try {
    $sw.WriteLine('ExternalId;DisplayName;Email;PrincipalType;JobTitle;Department;ManagerExternalId;SystemName;Enabled')
    for ($i = 1; $i -le $UserCount; $i++) {
        $ptype = $principalTypes[$rng.Next(0, $principalTypes.Count)]
        $job = $jobTitles[$rng.Next(0, $jobTitles.Count)]
        $deptIdx = $rng.Next(1, $ContextCount + 1)
        $sysIdx = $rng.Next(1, $SystemCount + 1)
        $enabled = if ($rng.NextDouble() -lt 0.97) { 'true' } else { 'false' }
        # 80% of users have a manager (another user with a lower index)
        $mgr = ''
        if ($i -gt 50 -and $rng.NextDouble() -lt 0.8) {
            $mgr = "USR{0}" -f $rng.Next(1, [Math]::Min($i, 50) + 1)
        }
        $sw.WriteLine(("USR{0};User {0};user{0}@loadtest.local;{1};{2};Department{3};{4};System {5};{6}" -f $i, $ptype, $job, $deptIdx, $mgr, $sysIdx, $enabled))
        if ($i % 20000 -eq 0) { Write-Host "      $i / $UserCount" -ForegroundColor DarkGray }
    }
} finally { $sw.Close() }

# ─── 6. Assignments.csv ──────────────────────────────────────────
Write-Host "[6/9] Generating Assignments.csv ($AssignmentCount rows)..." -ForegroundColor Cyan
$sw = New-Writer 'Assignments.csv'
try {
    $sw.WriteLine('ResourceExternalId;UserExternalId;AssignmentType;SystemName')
    for ($i = 1; $i -le $AssignmentCount; $i++) {
        $resIdx = $rng.Next(1, $ResourceCount + 1)
        $usrIdx = $rng.Next(1, $UserCount + 1)
        $atype = $assignmentTypes[$rng.Next(0, $assignmentTypes.Count)]
        $sysIdx = $rng.Next(1, $SystemCount + 1)
        $sw.WriteLine(("RES{0};USR{1};{2};System {3}" -f $resIdx, $usrIdx, $atype, $sysIdx))
        if ($i % 100000 -eq 0) { Write-Host "      $i / $AssignmentCount" -ForegroundColor DarkGray }
    }
} finally { $sw.Close() }

# ─── 7. Identities.csv ───────────────────────────────────────────
Write-Host "[7/9] Generating Identities.csv ($IdentityCount rows)..." -ForegroundColor Cyan
$sw = New-Writer 'Identities.csv'
try {
    $sw.WriteLine('ExternalId;DisplayName;Email;EmployeeId;Department;JobTitle')
    for ($i = 1; $i -le $IdentityCount; $i++) {
        $job = $jobTitles[$rng.Next(0, $jobTitles.Count)]
        $deptIdx = $rng.Next(1, $ContextCount + 1)
        $sw.WriteLine(("IDN{0};Identity {0};identity{0}@loadtest.local;EMP{0};Department{1};{2}" -f $i, $deptIdx, $job))
        if ($i % 10000 -eq 0) { Write-Host "      $i / $IdentityCount" -ForegroundColor DarkGray }
    }
} finally { $sw.Close() }

# ─── 8. IdentityMembers.csv ──────────────────────────────────────
# Link 95% of users to a random identity. Shuffle user indices so the
# sample is spread across the whole user range.
$memberCount = [int]($UserCount * $IdentityMemberRatio)
Write-Host "[8/9] Generating IdentityMembers.csv ($memberCount rows, $([Math]::Round($IdentityMemberRatio*100))% of users)..." -ForegroundColor Cyan

# Fisher–Yates shuffle of [1..UserCount] — allocate as an int[] for speed
$userIdxArray = [int[]]::new($UserCount)
for ($i = 0; $i -lt $UserCount; $i++) { $userIdxArray[$i] = $i + 1 }
for ($i = $UserCount - 1; $i -gt 0; $i--) {
    $j = $rng.Next(0, $i + 1)
    $tmp = $userIdxArray[$i]
    $userIdxArray[$i] = $userIdxArray[$j]
    $userIdxArray[$j] = $tmp
}

$sw = New-Writer 'IdentityMembers.csv'
try {
    $sw.WriteLine('IdentityExternalId;UserExternalId;AccountType')
    for ($i = 0; $i -lt $memberCount; $i++) {
        $usr = $userIdxArray[$i]
        $idn = $rng.Next(1, $IdentityCount + 1)
        $acct = $accountTypes[$rng.Next(0, $accountTypes.Count)]
        $sw.WriteLine(("IDN{0};USR{1};{2}" -f $idn, $usr, $acct))
        if (($i + 1) % 20000 -eq 0) { Write-Host "      $($i + 1) / $memberCount" -ForegroundColor DarkGray }
    }
} finally { $sw.Close() }

# ─── 9. Certifications.csv ───────────────────────────────────────
# Access review decisions spread over the past 12 months. Each decision
# references a random (resource, user) pair — these do NOT need to match
# a real assignment; the schema allows loose references.
Write-Host "[9/9] Generating Certifications.csv ($CertificationCount rows)..." -ForegroundColor Cyan
$reviewWindowDays = 365
$nowTicks = [DateTime]::UtcNow.Ticks
$ticksPerDay = [TimeSpan]::TicksPerDay
$sw = New-Writer 'Certifications.csv'
try {
    $sw.WriteLine('ExternalId;ResourceExternalId;UserDisplayName;Decision;ReviewerDisplayName;ReviewedDateTime')
    for ($i = 1; $i -le $CertificationCount; $i++) {
        $resIdx = $rng.Next(1, $ResourceCount + 1)
        $usrIdx = $rng.Next(1, $UserCount + 1)
        $rvrIdx = $rng.Next(1, $UserCount + 1)
        $decision = $decisions[$rng.Next(0, $decisions.Count)]
        $daysBack = $rng.Next(0, $reviewWindowDays)
        $reviewed = [DateTime]::new($nowTicks - ($daysBack * $ticksPerDay)).ToString('o')
        $sw.WriteLine(("CERT{0};RES{1};User {2};{3};User {4};{5}" -f $i, $resIdx, $usrIdx, $decision, $rvrIdx, $reviewed))
        if ($i % 50000 -eq 0) { Write-Host "      $i / $CertificationCount" -ForegroundColor DarkGray }
    }
} finally { $sw.Close() }

# ─── Summary ─────────────────────────────────────────────────────
$swatch.Stop()
Write-Host ""
Write-Host "=== Done in $([Math]::Round($swatch.Elapsed.TotalSeconds, 1))s ===" -ForegroundColor Green
Write-Host ""
Write-Host "Generated files:" -ForegroundColor Cyan
Get-ChildItem $OutputFolder -Filter *.csv | Sort-Object Name | ForEach-Object {
    $sizeMb = [Math]::Round($_.Length / 1MB, 2)
    Write-Host ("  {0,-28} {1,10:N0} bytes  ({2} MB)" -f $_.Name, $_.Length, $sizeMb) -ForegroundColor Gray
}
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Start the Identity Atlas API" -ForegroundColor Gray
Write-Host "  2. Create a crawler API key via Admin -> Crawlers" -ForegroundColor Gray
Write-Host "  3. Run:" -ForegroundColor Gray
Write-Host "     tools\crawlers\csv\Start-CSVCrawler.ps1 ``" -ForegroundColor DarkGray
Write-Host "       -ApiBaseUrl http://localhost:3001/api ``" -ForegroundColor DarkGray
Write-Host "       -ApiKey fgc_... ``" -ForegroundColor DarkGray
Write-Host "       -CsvFolder $OutputFolder" -ForegroundColor DarkGray
Write-Host ""
