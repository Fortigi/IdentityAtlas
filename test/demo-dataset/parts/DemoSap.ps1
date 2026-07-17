<#
.SYNOPSIS
    Fortigi Demo Corp — the SAP ERP system (CTF Track 2, flag 8).

.DESCRIPTION
    A second account source with its own namespace and its own roles.

    THE POINT OF THIS PART: SAP accounts deliberately carry NO `department`
    attribute and NO recognisable display name — just an SAP user id like
    'CDIJKSTRA'. That is what real ERP account lists look like, and it is what
    makes flag 8 ("which department has the most users in SAP ERP?") genuinely
    hard from a raw export: the export has no department column, so you would
    have to map every SAP account to a person and then to an HR department by
    hand.

    In Identity Atlas the same question is a join that is already done —
    IdentityMembers correlates each SAP account to its identity, and the identity
    carries the department. Because these accounts have no department of their
    own, they never join a department context directly; the answer is only
    reachable through the identity, which is exactly the lesson.

    Distribution is Finance 4 > Sales 3 > Operations 2 > Engineering 1, so the
    answer is Finance but the runner-up is close enough to require counting.
#>

Set-StrictMode -Version Latest

# Who has an SAP account, and which SAP role they hold. Skewed to Finance —
# an ERP's heaviest users are the finance back office.
$script:SapAccounts = @(
    @{ Emp = 'E0003'; Role = 'FI' }   # Clara Dijkstra  — CFO
    @{ Emp = 'E0012'; Role = 'FI' }   # Maria Novak     — Finance Manager
    @{ Emp = 'E0025'; Role = 'FI' }   # Niels Olsen     — Accountant
    @{ Emp = 'E0026'; Role = 'FI' }   # Olivia Park     — Accountant
    @{ Emp = 'E0013'; Role = 'SD' }   # Paul Quinn      — Sales Manager
    @{ Emp = 'E0027'; Role = 'SD' }   # Rachel Smith    — Account Executive
    @{ Emp = 'E0032'; Role = 'SD' }   # Piet Jansen     — Account Executive
    @{ Emp = 'E0014'; Role = 'MM' }   # Ursula Visser   — Ops Manager
    @{ Emp = 'E0029'; Role = 'BASIS' }# Victor Wang     — SysAdmin
    @{ Emp = 'E0020'; Role = 'MM' }   # Hassan Ibrahim  — Developer
)

function Add-DemoSap {
    param([Parameter(Mandatory)]$State)

    $sysSap = $State.SystemIds['sap']

    $roles = @(
        @{ Key = 'FI';    Name = 'SAP_FI_ACCOUNTANT'; Desc = 'Financial Accounting — post journal entries, close periods.' }
        @{ Key = 'SD';    Name = 'SAP_SD_SALES';      Desc = 'Sales & Distribution — quotations, orders, billing.' }
        @{ Key = 'MM';    Name = 'SAP_MM_VIEWER';     Desc = 'Materials Management — read-only stock and purchasing.' }
        @{ Key = 'BASIS'; Name = 'SAP_BASIS_ADMIN';   Desc = 'SAP Basis administration — transports, users, system config.' }
    )

    $roleIds = @{}
    foreach ($r in $roles) {
        $rid = New-DemoGuid "res-sap-role-$($r.Key)"
        $roleIds[$r.Key] = $rid
        $null = Add-DemoResource $State -Id $rid -DisplayName $r.Name -ResourceType 'SAPRole' `
            -SystemId $sysSap -Description $r.Desc
    }

    foreach ($acct in $script:SapAccounts) {
        Add-DemoSapAccount $State -EmployeeId $acct.Emp -RoleId $roleIds[$acct.Role]
    }
}

# One SAP account: a bare principal in the SAP namespace, correlated to the
# person's identity. No department, no email, no friendly name — the correlation
# is the only route from this account back to a department.
function Add-DemoSapAccount {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$EmployeeId,
        [Parameter(Mandatory)][string]$RoleId
    )

    $emp   = $State.EmployeesById[$EmployeeId]
    $parts = $emp.name -split ' ', 2
    # SAP user id convention: first initial + surname, uppercased.
    $sapUser = "$($parts[0].Substring(0,1))$($parts[1])".ToUpper() -replace '[^A-Z0-9]', ''
    # NB: not $pId — PowerShell variable names are case-insensitive and $PID is
    # a read-only automatic variable.
    $sapPrincipalId = New-DemoGuid "principal-$EmployeeId-sap"

    $null = Add-DemoPrincipal $State -Record @{
        id             = $sapPrincipalId
        displayName    = $sapUser
        principalType  = 'User'
        accountEnabled = $true
        employeeId     = $EmployeeId
        systemId       = $State.SystemIds['sap']
        extendedAttributes = @{ sapUserName = $sapUser; sapClient = '100' }
    }

    Add-DemoIdentityMember $State -IdentityId (Get-DemoIdentityId $EmployeeId) -PrincipalId $sapPrincipalId `
        -DisplayName $sapUser -AccountType 'SAP'

    Add-DemoAssignment $State -ResourceId $RoleId -PrincipalId $sapPrincipalId -AssignmentType 'Direct'
}
