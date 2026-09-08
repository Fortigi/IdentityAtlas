<#
.SYNOPSIS
    Fortigi Demo Corp — systems, org contexts, people, identities.

.DESCRIPTION
    The backbone every other part hangs off: the five connected systems, the
    department/team context tree, the employee roster, and the Identities /
    IdentityMembers that correlate accounts across systems.

    VENDOR-NEUTRAL IGA: the governance system is 'IGA', not 'Omada'. A business
    role is the same concept whether it comes from Omada, midPoint or SailPoint,
    so the demo must not imply one vendor. (The real Omada crawler under
    tools/crawlers/omada/ is untouched — this is demo data only.)
#>

Set-StrictMode -Version Latest

function Add-DemoOrg {
    param([Parameter(Mandatory)]$State)

    # ─── Systems ──────────────────────────────────────────────────────────────
    # Placeholder ids only — Ingest-DemoDataset.ps1 remaps them to the real
    # SERIAL ids the API returns. See DemoState.ps1.
    $sysEntra = Add-DemoSystem $State -Key 'entra'   -SystemType 'EntraID' -DisplayName 'Fortigi Demo EntraID' -TenantId 'demo-tenant-001'
    $sysHR    = Add-DemoSystem $State -Key 'hr'      -SystemType 'HR'      -DisplayName 'Fortigi Demo HR'      -TenantId 'demo-hr-001'
    $sysIga   = Add-DemoSystem $State -Key 'iga'     -SystemType 'IGA'     -DisplayName 'Fortigi Demo IGA'     -TenantId 'demo-iga-001'
    $null     = Add-DemoSystem $State -Key 'sap'     -SystemType 'SAP'     -DisplayName 'Fortigi Demo SAP ERP' -TenantId 'demo-sap-001'
    $null     = Add-DemoSystem $State -Key 'azurerm' -SystemType 'AzureRM' -DisplayName 'Fortigi Demo Azure'   -TenantId 'demo-azure-001'

    # ─── Contexts (org structure) ─────────────────────────────────────────────
    $ctx = [ordered]@{
        Root      = New-DemoGuid 'ctx-root'
        Eng       = New-DemoGuid 'ctx-engineering'
        Fin       = New-DemoGuid 'ctx-finance'
        Sales     = New-DemoGuid 'ctx-sales'
        Ops       = New-DemoGuid 'ctx-operations'
        Marketing = New-DemoGuid 'ctx-marketing'
        Platform  = New-DemoGuid 'ctx-platform-team'
        Security  = New-DemoGuid 'ctx-security-team'
        AUNL      = New-DemoGuid 'ctx-au-netherlands'
    }
    $State['Ctx'] = $ctx

    # Department attribute -> context id. The context keys are short handles,
    # the `dept` attribute carries the display name, so the two need mapping.
    $State['DeptCtx'] = @{
        'Management'  = $ctx.Root
        'Engineering' = $ctx.Eng
        'Finance'     = $ctx.Fin
        'Sales'       = $ctx.Sales
        'Operations'  = $ctx.Ops
        'Marketing'   = $ctx.Marketing
    }

    Add-DemoContext $State -Id $ctx.Root      -DisplayName 'Fortigi Demo Corp' -ContextType 'Department' -ScopeSystemId $sysHR
    foreach ($dept in @(
        @{ Id = $ctx.Eng;       Name = 'Engineering' }
        @{ Id = $ctx.Fin;       Name = 'Finance' }
        @{ Id = $ctx.Sales;     Name = 'Sales' }
        @{ Id = $ctx.Ops;       Name = 'Operations' }
        @{ Id = $ctx.Marketing; Name = 'Marketing' }
    )) {
        Add-DemoContext $State -Id $dept.Id -DisplayName $dept.Name -ContextType 'Department' -ScopeSystemId $sysHR -ParentContextId $ctx.Root
    }
    foreach ($team in @(
        @{ Id = $ctx.Platform; Name = 'Platform Team' }
        @{ Id = $ctx.Security; Name = 'Security Team' }
    )) {
        Add-DemoContext $State -Id $team.Id -DisplayName $team.Name -ContextType 'Team' -ScopeSystemId $sysHR -ParentContextId $ctx.Eng
    }
    Add-DemoContext $State -Id $ctx.AUNL -DisplayName 'AU-Netherlands' -ContextType 'AdministrativeUnit' -ScopeSystemId $sysEntra

    # ─── Employees ────────────────────────────────────────────────────────────
    # Surnames are deliberately single-word: the email local part is built as
    # "<given>.<surname>" and a two-word surname ("de Vries") would put a space
    # in the address.
    $employees = @(
        # C-Level
        @{ id = 'E0001'; name = 'Anna Bakker';    title = 'CEO';                  dept = 'Management';  manager = $null;   ctx = $ctx.Root }
        @{ id = 'E0002'; name = 'Bob Chen';       title = 'CTO';                  dept = 'Engineering'; manager = 'E0001'; ctx = $ctx.Eng }
        @{ id = 'E0003'; name = 'Clara Dijkstra'; title = 'CFO';                  dept = 'Finance';     manager = 'E0001'; ctx = $ctx.Fin }
        @{ id = 'E0004'; name = 'David El-Amin';  title = 'CSO';                  dept = 'Sales';       manager = 'E0001'; ctx = $ctx.Sales }
        @{ id = 'E0005'; name = 'Eva Fischer';    title = 'COO';                  dept = 'Operations';  manager = 'E0001'; ctx = $ctx.Ops }
        # Team Leads
        @{ id = 'E0010'; name = 'Fatih Gunay';    title = 'Team Lead Platform';   dept = 'Engineering'; manager = 'E0002'; ctx = $ctx.Platform }
        @{ id = 'E0011'; name = 'Grace Huang';    title = 'Team Lead Security';   dept = 'Engineering'; manager = 'E0002'; ctx = $ctx.Security }
        @{ id = 'E0012'; name = 'Maria Novak';    title = 'Finance Manager';      dept = 'Finance';     manager = 'E0003'; ctx = $ctx.Fin }
        @{ id = 'E0013'; name = 'Paul Quinn';     title = 'Sales Manager';        dept = 'Sales';       manager = 'E0004'; ctx = $ctx.Sales }
        @{ id = 'E0014'; name = 'Ursula Visser';  title = 'Ops Manager';          dept = 'Operations';  manager = 'E0005'; ctx = $ctx.Ops }
        # Individual Contributors
        @{ id = 'E0020'; name = 'Hassan Ibrahim'; title = 'Developer';            dept = 'Engineering'; manager = 'E0010'; ctx = $ctx.Platform }
        @{ id = 'E0021'; name = 'Ingrid Jensen';  title = 'Developer';            dept = 'Engineering'; manager = 'E0010'; ctx = $ctx.Platform }
        @{ id = 'E0022'; name = 'Jun Kobayashi';  title = 'Developer';            dept = 'Engineering'; manager = 'E0010'; ctx = $ctx.Platform }
        @{ id = 'E0023'; name = 'Karen Lee';      title = 'Security Engineer';    dept = 'Engineering'; manager = 'E0011'; ctx = $ctx.Security }
        @{ id = 'E0024'; name = 'Lars Muller';    title = 'SOC Analyst';          dept = 'Engineering'; manager = 'E0011'; ctx = $ctx.Security }
        @{ id = 'E0025'; name = 'Niels Olsen';    title = 'Accountant';           dept = 'Finance';     manager = 'E0012'; ctx = $ctx.Fin }
        @{ id = 'E0026'; name = 'Olivia Park';    title = 'Accountant';           dept = 'Finance';     manager = 'E0012'; ctx = $ctx.Fin }
        @{ id = 'E0027'; name = 'Rachel Smith';   title = 'Account Executive';    dept = 'Sales';       manager = 'E0013'; ctx = $ctx.Sales }
        @{ id = 'E0028'; name = 'Stefan Tanaka';  title = 'Account Executive';    dept = 'Sales';       manager = 'E0013'; ctx = $ctx.Sales }
        @{ id = 'E0029'; name = 'Victor Wang';    title = 'SysAdmin';             dept = 'Operations';  manager = 'E0014'; ctx = $ctx.Ops }
        @{ id = 'E0030'; name = 'Wendy Xu';       title = 'SysAdmin';             dept = 'Operations';  manager = 'E0014'; ctx = $ctx.Ops }
        # Zara Intern is the deliberate "principal with zero resource assignments"
        # edge case (a new hire not yet provisioned): noAccess excludes her from
        # every grant loop, while she still exists as a principal and appears in
        # her department context. See docs/architecture/demo-dataset.md.
        @{ id = 'E0031'; name = 'Zara Intern';    title = 'Intern';               dept = 'Engineering'; manager = 'E0010'; ctx = $ctx.Eng; noAccess = $true }
        # ── CTF cast (issue #705) ────────────────────────────────────────────
        # Piet Jansen is the recurring worst-case identity: role-inherited CRM
        # access (flag 4), a never-expiring password (flag 9), and consent to a
        # risky app (flags 11-12).
        @{ id = 'E0032'; name = 'Piet Jansen';    title = 'Account Executive';    dept = 'Sales';       manager = 'E0013'; ctx = $ctx.Sales }
        # Newest rep — the one Sales member WITHOUT the ad-hoc SharePoint grant,
        # which is what makes that grant a role *candidate* (flag 6) rather than
        # part of the shared-by-all set (flag 2).
        @{ id = 'E0033'; name = 'Sanne Vermeer';  title = 'Sales Development Rep'; dept = 'Sales';      manager = 'E0013'; ctx = $ctx.Sales }
        # Transferred out of Sales into Operations; his BR-Sales role assignment
        # was never revoked. One of the two flag-3 outsiders.
        @{ id = 'E0034'; name = 'Tom Bakker';     title = 'Logistics Coordinator'; dept = 'Operations'; manager = 'E0014'; ctx = $ctx.Ops }
        # Marketing, holds BR-Sales for a joint campaign. The other flag-3 outsider.
        @{ id = 'E0035'; name = 'Nadia Haddad';   title = 'Marketing Specialist';  dept = 'Marketing';  manager = 'E0001'; ctx = $ctx.Marketing }
    )

    foreach ($emp in $employees) {
        if (-not $emp.ContainsKey('noAccess')) { $emp['noAccess'] = $false }
        $State.EmployeesById[$emp.id] = $emp
    }

    # ─── Principals, Identities, IdentityMembers ──────────────────────────────
    foreach ($emp in $employees) {
        $pGuid   = Get-DemoPrincipalId $emp.id
        $idGuid  = Get-DemoIdentityId  $emp.id
        $parts   = $emp.name -split ' ', 2
        $email   = "$($parts[0].ToLower()).$($parts[1].ToLower())@fortigidemo.com"
        $mgrGuid = if ($emp.manager) { Get-DemoPrincipalId $emp.manager } else { $null }

        $null = Add-DemoPrincipal $State -Record @{
            id                 = $pGuid
            displayName        = $emp.name
            email              = $email
            accountEnabled     = $true
            principalType      = 'User'
            employeeId         = $emp.id
            givenName          = $parts[0]
            surname            = $parts[1]
            department         = $emp.dept
            jobTitle           = $emp.title
            companyName        = 'Fortigi Demo Corp'
            managerId          = $mgrGuid
            systemId           = $State.SystemIds['entra']
            extendedAttributes = @{
                passwordNeverExpires        = (Test-DemoNeverExpires $emp.id)
                $script:DemoSamAccountKey   = (Get-DemoSamAccountName $emp.name)
            }
        }

        $null = Add-DemoIdentity $State -Record @{
            id          = $idGuid
            displayName = $emp.name
            email       = $email
            department  = $emp.dept
            jobTitle    = $emp.title
            employeeId  = $emp.id
            givenName   = $parts[0]
            surname     = $parts[1]
            companyName = 'Fortigi Demo Corp'
        }
        Add-DemoIdentityMember $State -IdentityId $idGuid -PrincipalId $pGuid `
            -DisplayName $emp.name -AccountType 'EntraID' -IsPrimary $true

        # Department context, plus the team context for those who have one.
        foreach ($cid in @($State.DeptCtx[$emp.dept], $emp.ctx)) {
            if ($cid) { Add-DemoContextMember $State -ContextId $cid -MemberId $pGuid }
        }
    }

    Add-DemoOrgEdgeCases $State
}

# ─── The Entra directory-extension attribute ──────────────────────────────────
# Every tenant that syncs from on-prem AD ends up with attributes like this one:
# Entra writes them under their wire name, `extension_<32-hex appId>_<name>`,
# where the middle segment is the appId of the application the extension was
# defined for. The demo carries one so the dataset exercises the display-name
# rule (issue #872) — the GUI shows `sAMAccountName`, while the stored key stays
# the full wire name so filters and sorts keep addressing the real attribute.
#
# The appId is a well-formed 32-hex value that belongs to no real tenant. It has
# to be exactly 32 hex characters: `extension_notahexguid_foo` is deliberately
# NOT treated as an extension key and would be left alone.
$script:DemoExtensionAppId = '8ce8d3db3b314def88d829e15494e83f'
$script:DemoSamAccountKey  = "extension_$($script:DemoExtensionAppId)_sAMAccountName"

# The on-prem logon name for a demo employee: "anna.bakker" from "Anna Bakker".
# Single-word display names (the non-human accounts) simply lower-case whole.
function Get-DemoSamAccountName {
    param([Parameter(Mandatory)][string]$DisplayName)
    return ($DisplayName -replace '\s+', '.').ToLower() -replace '[^a-z0-9.@_-]', ''
}

# The accounts whose password never expires (flag 9): two non-human (a service
# principal and a shared mailbox — the plausible, defensible ones) and three
# humans. Both SysAdmins qualify, which is realistic and gives flag 12 its trap:
# Victor Wang has a never-expiring password AND has consented to an app — but a
# clean one, so he is NOT part of flag 12's answer. Piet and Wendy are.
$script:NeverExpireAccounts = @('SVC-001', 'SM-001', 'E0029', 'E0030', 'E0032')

function Test-DemoNeverExpires {
    param([Parameter(Mandatory)][string]$AccountKey)
    return $script:NeverExpireAccounts -contains $AccountKey
}

# Non-employee principals: the contractor, the disabled leaver, and the
# non-human accounts. These exist to exercise principalType variety and to act
# as distractors — Alex Former is the disabled Sales account that makes flag 1
# ("how many identities does Sales have?") non-trivial.
function Add-DemoOrgEdgeCases {
    param([Parameter(Mandatory)]$State)

    $ctx      = $State.Ctx
    $sysEntra = $State.SystemIds['entra']

    $guidContractor = Get-DemoPrincipalId 'E0040'
    $guidDisabled   = Get-DemoPrincipalId 'E0041'
    $guidSvcPrinc   = Get-DemoPrincipalId 'SVC-001'
    $guidAIAgent    = Get-DemoPrincipalId 'AI-001'
    $guidMailbox    = Get-DemoPrincipalId 'SM-001'

    $State['EdgeCaseIds'] = [ordered]@{
        Contractor = $guidContractor
        Disabled   = $guidDisabled
        SvcPrinc   = $guidSvcPrinc
        AIAgent    = $guidAIAgent
        Mailbox    = $guidMailbox
    }

    $edgeCases = @(
        @{ id = $guidContractor; displayName = 'Yuki Zhao'; email = 'yuki.zhao@external.com'; accountEnabled = $true
           principalType = 'ExternalUser'; employeeId = 'E0040'; department = 'Engineering'; jobTitle = 'Contractor'
           companyName = 'External Inc'; neverExpires = $false }
        @{ id = $guidDisabled; displayName = 'Alex Former'; email = 'alex.former@fortigidemo.com'; accountEnabled = $false
           principalType = 'User'; employeeId = 'E0041'; department = 'Sales'; jobTitle = 'Former Employee'
           neverExpires = $false }
        @{ id = $guidSvcPrinc; displayName = 'Deploy Pipeline'; principalType = 'ServicePrincipal'; accountEnabled = $true
           neverExpires = (Test-DemoNeverExpires 'SVC-001') }
        @{ id = $guidAIAgent; displayName = 'Copilot Assistant'; principalType = 'AIAgent'; accountEnabled = $true
           neverExpires = $false }
        @{ id = $guidMailbox; displayName = 'info@fortigidemo.com'; email = 'info@fortigidemo.com'
           principalType = 'SharedMailbox'; accountEnabled = $true; neverExpires = (Test-DemoNeverExpires 'SM-001') }
    )

    foreach ($ec in $edgeCases) {
        $rec = @{
            id                 = $ec.id
            displayName        = $ec.displayName
            principalType      = $ec.principalType
            accountEnabled     = $ec.accountEnabled
            systemId           = $sysEntra
            extendedAttributes = @{ passwordNeverExpires = $ec.neverExpires }
        }
        foreach ($opt in @('email', 'employeeId', 'department', 'jobTitle', 'companyName')) {
            if ($ec.ContainsKey($opt)) { $rec[$opt] = $ec[$opt] }
        }
        $null = Add-DemoPrincipal $State -Record $rec
    }

    # The leaver keeps an identity of his own so he shows up in the Sales
    # department alongside the six active members (flag 1's distractor).
    $idDisabled = New-DemoGuid 'identity-E0041'
    $null = Add-DemoIdentity $State -Record @{
        id = $idDisabled; displayName = 'Alex Former'; email = 'alex.former@fortigidemo.com'
        department = 'Sales'; employeeId = 'E0041'
    }
    Add-DemoIdentityMember $State -IdentityId $idDisabled -PrincipalId $guidDisabled `
        -DisplayName 'Alex Former' -AccountType 'EntraID' -IsPrimary $true -AccountEnabled $false

    Add-DemoContextMember $State -ContextId $ctx.Eng   -MemberId $guidContractor
    Add-DemoContextMember $State -ContextId $ctx.Sales -MemberId $guidDisabled

    # Multi-system: Hassan Ibrahim also has an account in the IGA system.
    $pIgaHassan = New-DemoGuid 'principal-E0020-iga'
    $null = Add-DemoPrincipal $State -Record @{
        id             = $pIgaHassan
        displayName    = 'Hassan Ibrahim (IGA)'
        principalType  = 'User'
        employeeId     = 'E0020'
        accountEnabled = $true
        companyName    = 'Fortigi Demo Corp'
        department     = 'Engineering'
        systemId       = $State.SystemIds['iga']
    }
    Add-DemoIdentityMember $State -IdentityId (Get-DemoIdentityId 'E0020') -PrincipalId $pIgaHassan `
        -DisplayName 'Hassan Ibrahim (IGA)' -AccountType 'IGA'
}
