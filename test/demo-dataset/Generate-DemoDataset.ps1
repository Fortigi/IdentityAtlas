<#
.SYNOPSIS
    Generates the Fortigi Demo Corp synthetic dataset for E2E testing.

.DESCRIPTION
    Creates demo-company.json with deterministic GUIDs for all entities.
    The dataset exercises every feature: org hierarchy, multi-system identities,
    business roles, governed assignments, edge cases (contractors, disabled accounts,
    service principals, AI agents).

.EXAMPLE
    .\Generate-DemoDataset.ps1
    Generates _Test/DemoDataset/demo-company.json
#>

[CmdletBinding()]
Param()

$outputPath = Join-Path $PSScriptRoot 'demo-company.json'

# Deterministic GUID from a seed string (same input always produces same GUID)
function New-DemoGuid {
    param([string]$Seed)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("fortigi-demo:$Seed"))
    return [Guid]::new($bytes).ToString()
}

# ─── Systems ──────────────────────────────────────────────────────

$systems = @(
    @{ systemType = 'EntraID'; displayName = 'Fortigi Demo EntraID'; tenantId = 'demo-tenant-001'; enabled = $true; syncEnabled = $true }
    @{ systemType = 'HR';      displayName = 'Fortigi Demo HR';      tenantId = 'demo-hr-001';     enabled = $true; syncEnabled = $true }
    @{ systemType = 'Omada';   displayName = 'Fortigi Demo Omada';   tenantId = 'demo-omada-001';  enabled = $true; syncEnabled = $true }
)

# System IDs are auto-assigned by SQL; we'll use 1, 2, 3 in references
$sysEntraId = 1
$sysHR = 2
$sysOmada = 3

# ─── Contexts (Org Structure) ────────────────────────────────────

$ctxRoot      = New-DemoGuid 'ctx-root'
$ctxEng       = New-DemoGuid 'ctx-engineering'
$ctxFin       = New-DemoGuid 'ctx-finance'
$ctxSales     = New-DemoGuid 'ctx-sales'
$ctxOps       = New-DemoGuid 'ctx-operations'
$ctxPlatform  = New-DemoGuid 'ctx-platform-team'
$ctxSecurity  = New-DemoGuid 'ctx-security-team'
$ctxAUNL      = New-DemoGuid 'ctx-au-netherlands'

$contexts = @(
    @{ id = $ctxRoot;     displayName = 'Fortigi Demo Corp';  contextType = 'Department'; targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysHR }
    @{ id = $ctxEng;      displayName = 'Engineering';        contextType = 'Department'; targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysHR; parentContextId = $ctxRoot }
    @{ id = $ctxFin;      displayName = 'Finance';            contextType = 'Department'; targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysHR; parentContextId = $ctxRoot }
    @{ id = $ctxSales;    displayName = 'Sales';              contextType = 'Department'; targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysHR; parentContextId = $ctxRoot }
    @{ id = $ctxOps;      displayName = 'Operations';         contextType = 'Department'; targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysHR; parentContextId = $ctxRoot }
    @{ id = $ctxPlatform; displayName = 'Platform Team';      contextType = 'Team';       targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysHR; parentContextId = $ctxEng }
    @{ id = $ctxSecurity; displayName = 'Security Team';      contextType = 'Team';       targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysHR; parentContextId = $ctxEng }
    @{ id = $ctxAUNL;     displayName = 'AU-Netherlands';     contextType = 'AdministrativeUnit'; targetType = 'Principal'; variant = 'synced'; scopeSystemId = $sysEntraId }
)

# ─── Principals ───────────────────────────────────────────────────

$employees = @(
    # C-Level
    @{ id = 'E0001'; name = 'Anna Bakker';      title = 'CEO';                dept = 'Management';  manager = $null;   ctx = $ctxRoot }
    @{ id = 'E0002'; name = 'Bob Chen';          title = 'CTO';                dept = 'Engineering'; manager = 'E0001'; ctx = $ctxEng }
    @{ id = 'E0003'; name = 'Clara Dijkstra';    title = 'CFO';                dept = 'Finance';     manager = 'E0001'; ctx = $ctxFin }
    @{ id = 'E0004'; name = 'David El-Amin';     title = 'CSO';                dept = 'Sales';       manager = 'E0001'; ctx = $ctxSales }
    @{ id = 'E0005'; name = 'Eva Fischer';        title = 'COO';                dept = 'Operations';  manager = 'E0001'; ctx = $ctxOps }
    # Team Leads
    @{ id = 'E0010'; name = 'Fatih Gunay';       title = 'Team Lead Platform'; dept = 'Engineering'; manager = 'E0002'; ctx = $ctxPlatform }
    @{ id = 'E0011'; name = 'Grace Huang';       title = 'Team Lead Security'; dept = 'Engineering'; manager = 'E0002'; ctx = $ctxSecurity }
    @{ id = 'E0012'; name = 'Maria Novak';       title = 'Finance Manager';    dept = 'Finance';     manager = 'E0003'; ctx = $ctxFin }
    @{ id = 'E0013'; name = 'Paul Quinn';        title = 'Sales Manager';      dept = 'Sales';       manager = 'E0004'; ctx = $ctxSales }
    @{ id = 'E0014'; name = 'Ursula Visser';     title = 'Ops Manager';        dept = 'Operations';  manager = 'E0005'; ctx = $ctxOps }
    # Individual Contributors
    @{ id = 'E0020'; name = 'Hassan Ibrahim';    title = 'Developer';           dept = 'Engineering'; manager = 'E0010'; ctx = $ctxPlatform }
    @{ id = 'E0021'; name = 'Ingrid Jensen';     title = 'Developer';           dept = 'Engineering'; manager = 'E0010'; ctx = $ctxPlatform }
    @{ id = 'E0022'; name = 'Jun Kobayashi';     title = 'Developer';           dept = 'Engineering'; manager = 'E0010'; ctx = $ctxPlatform }
    @{ id = 'E0023'; name = 'Karen Lee';         title = 'Security Engineer';   dept = 'Engineering'; manager = 'E0011'; ctx = $ctxSecurity }
    @{ id = 'E0024'; name = 'Lars Muller';       title = 'SOC Analyst';         dept = 'Engineering'; manager = 'E0011'; ctx = $ctxSecurity }
    @{ id = 'E0025'; name = 'Niels Olsen';       title = 'Accountant';          dept = 'Finance';     manager = 'E0012'; ctx = $ctxFin }
    @{ id = 'E0026'; name = 'Olivia Park';       title = 'Accountant';          dept = 'Finance';     manager = 'E0012'; ctx = $ctxFin }
    @{ id = 'E0027'; name = 'Rachel Smith';      title = 'Account Executive';   dept = 'Sales';       manager = 'E0013'; ctx = $ctxSales }
    @{ id = 'E0028'; name = 'Stefan Tanaka';     title = 'Account Executive';   dept = 'Sales';       manager = 'E0013'; ctx = $ctxSales }
    @{ id = 'E0029'; name = 'Victor Wang';       title = 'SysAdmin';            dept = 'Operations';  manager = 'E0014'; ctx = $ctxOps }
    @{ id = 'E0030'; name = 'Wendy Xu';          title = 'SysAdmin';            dept = 'Operations';  manager = 'E0014'; ctx = $ctxOps }
    @{ id = 'E0031'; name = 'Zara Intern';       title = 'Intern';              dept = 'Engineering'; manager = 'E0010'; ctx = $ctxEng }
)

$principals = @()
foreach ($emp in $employees) {
    $guid = New-DemoGuid "principal-$($emp.id)"
    $mgrGuid = if ($emp.manager) { New-DemoGuid "principal-$($emp.manager)" } else { $null }
    $nameParts = $emp.name -split ' ', 2
    $principals += @{
        id              = $guid
        displayName     = $emp.name
        email           = "$($nameParts[0].ToLower()).$($nameParts[1].ToLower())@fortigidemo.com"
        accountEnabled  = $true
        principalType   = 'User'
        employeeId      = $emp.id
        givenName       = $nameParts[0]
        surname         = $nameParts[1]
        department      = $emp.dept
        jobTitle        = $emp.title
        companyName     = 'Fortigi Demo Corp'
        managerId       = $mgrGuid
    }
}

# Edge cases
$guidContractor = New-DemoGuid 'principal-E0040'
$guidDisabled   = New-DemoGuid 'principal-E0041'
$guidSvcPrinc   = New-DemoGuid 'principal-SVC-001'
$guidAIAgent    = New-DemoGuid 'principal-AI-001'
$guidMailbox    = New-DemoGuid 'principal-SM-001'

$principals += @(
    @{ id = $guidContractor; displayName = 'Yuki Zhao'; email = 'yuki.zhao@external.com'; accountEnabled = $true;  principalType = 'ExternalUser'; employeeId = 'E0040'; department = 'Engineering'; jobTitle = 'Contractor'; companyName = 'External Inc' }
    @{ id = $guidDisabled;   displayName = 'Alex Former'; email = 'alex.former@fortigidemo.com'; accountEnabled = $false; principalType = 'User'; employeeId = 'E0041'; department = 'Sales'; jobTitle = 'Former Employee' }
    @{ id = $guidSvcPrinc;   displayName = 'Deploy Pipeline'; principalType = 'ServicePrincipal'; accountEnabled = $true }
    @{ id = $guidAIAgent;    displayName = 'Copilot Assistant'; principalType = 'AIAgent'; accountEnabled = $true }
    @{ id = $guidMailbox;    displayName = 'info@fortigidemo.com'; principalType = 'SharedMailbox'; email = 'info@fortigidemo.com'; accountEnabled = $true }
)

# ─── Resources ────────────────────────────────────────────────────

$resAllEmp     = New-DemoGuid 'res-sg-all-employees'
$resEng        = New-DemoGuid 'res-sg-engineering'
$resFin        = New-DemoGuid 'res-sg-finance'
$resVPN        = New-DemoGuid 'res-sg-vpn-access'
$resAdminTier0 = New-DemoGuid 'res-sg-admin-tier0'
$resPAM        = New-DemoGuid 'res-sg-pam-users'
$resGlobalAdmin = New-DemoGuid 'res-global-administrator'
$resSPAdmin    = New-DemoGuid 'res-sharepoint-admin'
$resAppFG      = New-DemoGuid 'res-app-fortigraph'
$resAppSAP     = New-DemoGuid 'res-app-sap-finance'
$resBRBase     = New-DemoGuid 'res-br-employee-base'
$resBREng      = New-DemoGuid 'res-br-engineering-tools'
$resBRFin      = New-DemoGuid 'res-br-finance-systems'
$resBRAdmin    = New-DemoGuid 'res-br-admin-privileged'

$catEmployee   = New-DemoGuid 'cat-employee-access'
$catPrivileged = New-DemoGuid 'cat-privileged-access'

$resources = @(
    @{ id = $resAllEmp;      displayName = 'SG-AllEmployees';       resourceType = 'EntraGroup';        systemId = $sysEntraId; enabled = $true }
    @{ id = $resEng;         displayName = 'SG-Engineering';        resourceType = 'EntraGroup';        systemId = $sysEntraId; enabled = $true }
    @{ id = $resFin;         displayName = 'SG-Finance';            resourceType = 'EntraGroup';        systemId = $sysEntraId; enabled = $true }
    @{ id = $resVPN;         displayName = 'SG-VPN-Access';         resourceType = 'EntraGroup';        systemId = $sysEntraId; enabled = $true }
    @{ id = $resAdminTier0;  displayName = 'SG-Admin-Tier0';        resourceType = 'EntraGroup';        systemId = $sysEntraId; enabled = $true; description = 'Tier 0 administrative access - critical' }
    @{ id = $resPAM;         displayName = 'SG-PAM-Users';          resourceType = 'EntraGroup';        systemId = $sysEntraId; enabled = $true }
    @{ id = $resGlobalAdmin; displayName = 'Global Administrator';  resourceType = 'EntraDirectoryRole'; systemId = $sysEntraId; enabled = $true }
    @{ id = $resSPAdmin;     displayName = 'SharePoint Admin';      resourceType = 'EntraDirectoryRole'; systemId = $sysEntraId; enabled = $true }
    @{ id = $resAppFG;       displayName = 'FortigiGraph-App';      resourceType = 'EntraAppRole';      systemId = $sysEntraId; enabled = $true }
    @{ id = $resAppSAP;      displayName = 'SAP-Finance-Role';      resourceType = 'EntraAppRole';      systemId = $sysEntraId; enabled = $true }
    @{ id = $resBRBase;      displayName = 'BR-Employee-Base';      resourceType = 'BusinessRole';      systemId = $sysOmada;   enabled = $true; catalogId = $catEmployee }
    @{ id = $resBREng;       displayName = 'BR-Engineering-Tools';  resourceType = 'BusinessRole';      systemId = $sysOmada;   enabled = $true; catalogId = $catEmployee }
    @{ id = $resBRFin;       displayName = 'BR-Finance-Systems';    resourceType = 'BusinessRole';      systemId = $sysOmada;   enabled = $true; catalogId = $catEmployee }
    @{ id = $resBRAdmin;     displayName = 'BR-Admin-Privileged';   resourceType = 'BusinessRole';      systemId = $sysOmada;   enabled = $true; catalogId = $catPrivileged }
)

# ─── Resource Assignments ─────────────────────────────────────────

$assignments = @()

# All employees -> SG-AllEmployees (Direct)
foreach ($emp in $employees) {
    $pGuid = New-DemoGuid "principal-$($emp.id)"
    $assignments += @{ resourceId = $resAllEmp; principalId = $pGuid; assignmentType = 'Direct' }
}

# Engineering employees -> SG-Engineering
foreach ($emp in ($employees | Where-Object { $_.dept -eq 'Engineering' })) {
    $pGuid = New-DemoGuid "principal-$($emp.id)"
    $assignments += @{ resourceId = $resEng; principalId = $pGuid; assignmentType = 'Direct' }
}

# Finance employees -> SG-Finance
foreach ($emp in ($employees | Where-Object { $_.dept -eq 'Finance' })) {
    $pGuid = New-DemoGuid "principal-$($emp.id)"
    $assignments += @{ resourceId = $resFin; principalId = $pGuid; assignmentType = 'Direct' }
}

# SysAdmins -> VPN
$assignments += @{ resourceId = $resVPN; principalId = (New-DemoGuid 'principal-E0029'); assignmentType = 'Direct' }
$assignments += @{ resourceId = $resVPN; principalId = (New-DemoGuid 'principal-E0030'); assignmentType = 'Direct' }

# Admin Tier0: CTO as owner, SysAdmin + SP as members
$assignments += @{ resourceId = $resAdminTier0; principalId = (New-DemoGuid 'principal-E0002'); assignmentType = 'Owner' }
$assignments += @{ resourceId = $resAdminTier0; principalId = (New-DemoGuid 'principal-E0029'); assignmentType = 'Direct' }
$assignments += @{ resourceId = $resAdminTier0; principalId = $guidSvcPrinc; assignmentType = 'Direct' }

# CTO -> Global Admin directory role
$assignments += @{ resourceId = $resGlobalAdmin; principalId = (New-DemoGuid 'principal-E0002'); assignmentType = 'Direct' }

# Governed assignments (business roles)
foreach ($emp in $employees) {
    $pGuid = New-DemoGuid "principal-$($emp.id)"
    $assignments += @{ resourceId = $resBRBase; principalId = $pGuid; assignmentType = 'Governed' }
}
foreach ($emp in ($employees | Where-Object { $_.dept -eq 'Engineering' })) {
    $pGuid = New-DemoGuid "principal-$($emp.id)"
    $assignments += @{ resourceId = $resBREng; principalId = $pGuid; assignmentType = 'Governed' }
}

# SysAdmin eligible for privileged admin
$assignments += @{ resourceId = $resBRAdmin; principalId = (New-DemoGuid 'principal-E0029'); assignmentType = 'Eligible' }

# ─── Resource Relationships ───────────────────────────────────────

$relationships = @(
    @{ parentResourceId = $resBRBase;  childResourceId = $resAllEmp;  relationshipType = 'Contains' }
    @{ parentResourceId = $resBRBase;  childResourceId = $resAppFG;   relationshipType = 'Contains' }
    @{ parentResourceId = $resBREng;   childResourceId = $resEng;     relationshipType = 'Contains' }
    @{ parentResourceId = $resBREng;   childResourceId = $resVPN;     relationshipType = 'Contains' }
    @{ parentResourceId = $resBRFin;   childResourceId = $resFin;     relationshipType = 'Contains' }
    @{ parentResourceId = $resBRFin;   childResourceId = $resAppSAP;  relationshipType = 'Contains' }
    @{ parentResourceId = $resBRAdmin; childResourceId = $resAdminTier0; relationshipType = 'Contains' }
    @{ parentResourceId = $resBRAdmin; childResourceId = $resPAM;     relationshipType = 'Contains' }
    @{ parentResourceId = $resEng;     childResourceId = $resAllEmp;  relationshipType = 'GrantsAccessTo' }
)

# ─── Identities & IdentityMembers ────────────────────────────────

$identities = @()
$identityMembers = @()

foreach ($emp in $employees) {
    $idGuid = New-DemoGuid "identity-$($emp.id)"
    $pGuid  = New-DemoGuid "principal-$($emp.id)"
    $nameParts = $emp.name -split ' ', 2

    $identities += @{
        id          = $idGuid
        displayName = $emp.name
        email       = "$($nameParts[0].ToLower()).$($nameParts[1].ToLower())@fortigidemo.com"
        department  = $emp.dept
        jobTitle    = $emp.title
        employeeId  = $emp.id
        givenName   = $nameParts[0]
        surname     = $nameParts[1]
        companyName = 'Fortigi Demo Corp'
    }

    # Primary principal link
    $identityMembers += @{
        identityId  = $idGuid
        principalId = $pGuid
        displayName = $emp.name
        accountType = 'EntraID'
        isPrimary   = $true
        accountEnabled = $true
    }
}

# Disabled employee identity
$idDisabled = New-DemoGuid 'identity-E0041'
$identities += @{ id = $idDisabled; displayName = 'Alex Former'; email = 'alex.former@fortigidemo.com'; department = 'Sales'; employeeId = 'E0041' }
$identityMembers += @{ identityId = $idDisabled; principalId = $guidDisabled; displayName = 'Alex Former'; accountType = 'EntraID'; isPrimary = $true; accountEnabled = $false }

# Multi-system: Hassan Ibrahim has Omada account too
$pOmadaHassan = New-DemoGuid 'principal-E0020-omada'
$principals += @{ id = $pOmadaHassan; displayName = 'Hassan Ibrahim (Omada)'; principalType = 'User'; employeeId = 'E0020'; accountEnabled = $true; companyName = 'Fortigi Demo Corp'; department = 'Engineering' }
$identityMembers += @{
    identityId  = (New-DemoGuid 'identity-E0020')
    principalId = $pOmadaHassan
    displayName = 'Hassan Ibrahim (Omada)'
    accountType = 'Omada'
    isPrimary   = $false
    accountEnabled = $true
}

# ─── Governance ───────────────────────────────────────────────────

$catalogs = @(
    @{ id = $catEmployee;   displayName = 'Employee Access';   catalogType = 'userManaged'; enabled = $true; systemId = $sysOmada }
    @{ id = $catPrivileged; displayName = 'Privileged Access'; catalogType = 'userManaged'; enabled = $true; systemId = $sysOmada }
)

$policies = @(
    @{ id = (New-DemoGuid 'pol-auto-base');     resourceId = $resBRBase;  displayName = 'Auto-assign all employees';    allowedTargetScope = 'allMemberUsers'; systemId = $sysOmada }
    @{ id = (New-DemoGuid 'pol-mgr-eng');       resourceId = $resBREng;   displayName = 'Manager approval required';    allowedTargetScope = 'specificDirectoryUsers'; systemId = $sysOmada }
    @{ id = (New-DemoGuid 'pol-dual-admin');     resourceId = $resBRAdmin; displayName = 'Dual approval (mgr + security)'; allowedTargetScope = 'specificDirectoryUsers'; systemId = $sysOmada }
)

$certifications = @(
    @{ id = (New-DemoGuid 'cert-001'); resourceId = $resBRAdmin; principalId = (New-DemoGuid 'principal-E0029'); decision = 'Approve'; reviewedBy = (New-DemoGuid 'principal-E0011'); reviewedByDisplayName = 'Grace Huang'; justification = 'Required for infrastructure maintenance'; systemId = $sysOmada }
    @{ id = (New-DemoGuid 'cert-002'); resourceId = $resBRBase;  principalId = $guidDisabled; decision = 'Deny'; reviewedBy = (New-DemoGuid 'principal-E0013'); reviewedByDisplayName = 'Paul Quinn'; justification = 'Employee has left the organization'; systemId = $sysOmada }
)

# ─── Assemble & Write ────────────────────────────────────────────

$dataset = @{
    metadata = @{
        company     = 'Fortigi Demo Corp'
        version     = '1.0'
        generatedAt = (Get-Date).ToString('o')
        description = 'Synthetic dataset for E2E testing — 50 employees, 3 systems, 14 resources, 4 business roles'
        entityCounts = @{
            systems                = $systems.Count
            principals             = $principals.Count
            resources              = $resources.Count
            resourceAssignments    = $assignments.Count
            resourceRelationships  = $relationships.Count
            identities             = $identities.Count
            identityMembers        = $identityMembers.Count
            contexts               = $contexts.Count
            governanceCatalogs     = $catalogs.Count
            assignmentPolicies     = $policies.Count
            certificationDecisions = $certifications.Count
        }
    }
    systems                = $systems
    contexts               = $contexts
    principals             = $principals
    resources              = $resources
    resourceAssignments    = $assignments
    resourceRelationships  = $relationships
    identities             = $identities
    identityMembers        = $identityMembers
    governanceCatalogs     = $catalogs
    assignmentPolicies     = $policies
    certificationDecisions = $certifications
}

$dataset | ConvertTo-Json -Depth 10 | Out-File -FilePath $outputPath -Encoding UTF8

$counts = $dataset.metadata.entityCounts
Write-Host "Demo dataset generated: $outputPath" -ForegroundColor Green
Write-Host "  Systems:              $($counts.systems)"
Write-Host "  Principals:           $($counts.principals)"
Write-Host "  Resources:            $($counts.resources)"
Write-Host "  Assignments:          $($counts.resourceAssignments)"
Write-Host "  Relationships:        $($counts.resourceRelationships)"
Write-Host "  Identities:           $($counts.identities)"
Write-Host "  Identity Members:     $($counts.identityMembers)"
Write-Host "  Contexts:             $($counts.contexts)"
Write-Host "  Governance Catalogs:  $($counts.governanceCatalogs)"
Write-Host "  Assignment Policies:  $($counts.assignmentPolicies)"
Write-Host "  Certifications:       $($counts.certificationDecisions)"
