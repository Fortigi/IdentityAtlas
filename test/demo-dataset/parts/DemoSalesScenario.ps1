<#
.SYNOPSIS
    Fortigi Demo Corp — the Sales role-mining scenario (CTF Track 1, flags 1-7).

.DESCRIPTION
    One department, engineered so that every flag in Track 1 has exactly one
    defensible answer and at least one plausible wrong one.

    The cast:
      * BR-Sales           — the business role. Contains SG-Sales + SG-CRM-Users.
      * SG-Sales-SharePoint — the ROLE CANDIDATE (flag 6): held directly by 5 of
        the 6 Sales members, not in the role. A clean mining candidate.
      * SG-Finance-Reports  — the TRAP (flag 7): held directly by 4 of 6 Sales, so
        it *looks* like the same pattern — but it is sensitive cross-department
        finance access that only the Sales Manager legitimately needs
        (CertificationDecisions cert-003 is the evidence). Folding it into
        BR-Sales would over-grant every rep.
      * Tom Bakker + Nadia Haddad — the two out-of-department holders of the whole
        shared set (flag 3), via a BR-Sales assignment that was never revoked.

    WHY THE Indirect ROWS ARE EXPLICIT: the matrix matview reads declared rows.
    Holding BR-Sales does not by itself put SG-CRM-Users in anyone's access — it
    only makes the matview mark that cell "managed by" the role IF the cell
    exists. So role-derived access is emitted as real Indirect assignments; the
    Contains edge then supplies the "why". Without both, Piet's CRM access would
    render as a provisioning gap instead of as access, and flag 4 would have no
    answer. See migration 049 + docs/architecture/matrix.md.
#>

Set-StrictMode -Version Latest

# Sales members who hold BR-Sales but do not work in Sales (flag 3). Tom
# transferred to Operations and kept the role; Nadia holds it for a joint
# campaign. Both are the realistic "role assignment nobody cleaned up" case.
$script:SalesOutsiders = @('E0034', 'E0035')

# The one Sales member without the ad-hoc SharePoint grant — the newest hire.
# Keeping her out is what makes SG-Sales-SharePoint a *candidate* (held by most)
# rather than part of the shared-by-all set.
$script:SharePointExcluded = @('E0033')

# Sales reps who picked up the finance-reports group ad hoc, plus the manager who
# legitimately needs it. Deliberately a majority-but-not-all pattern, so it
# mimics a mining candidate.
$script:FinanceReportsSales = @('E0013', 'E0027', 'E0028', 'E0032')

function Add-DemoSalesScenario {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $sysIga   = $State.SystemIds['iga']

    $sales = [ordered]@{
        BR         = New-DemoGuid 'res-br-sales'
        Group      = New-DemoGuid 'res-sg-sales'
        Crm        = New-DemoGuid 'res-sg-crm-users'
        SharePoint = New-DemoGuid 'res-sg-sales-sharepoint'
        FinReports = New-DemoGuid 'res-sg-finance-reports'
    }
    $State['Sales'] = $sales

    # groupCategory mirrors what the Entra crawler transform stamps, feeding the
    # entra-group-category-tree context plugin (same as DemoEntraBase groups).
    $groups = @(
        @{ Id = $sales.Group; Name = 'SG-Sales'; Cat = 'SecurityGroup'
           Desc = 'Sales department security group — shared drives, distribution list.' }
        @{ Id = $sales.Crm; Name = 'SG-CRM-Users'; Cat = 'SecurityGroup'
           Desc = 'CRM access — customer accounts, opportunities and pipeline.' }
        @{ Id = $sales.SharePoint; Name = 'SG-Sales-SharePoint'; Cat = 'Microsoft365'
           Desc = 'Sales team SharePoint site — proposals, battlecards and templates.' }
        # The description is the signal that separates the trap from the
        # candidate: sensitive, cross-department, manager-only.
        @{ Id = $sales.FinReports; Name = 'SG-Finance-Reports'; Cat = 'MailEnabledSecurity'
           Desc = 'Sensitive financial reporting — quarterly revenue, margin and forecast data. Restricted to department managers and Finance.' }
    )
    foreach ($g in $groups) {
        $null = Add-DemoResource $State -Id $g.Id -DisplayName $g.Name -ResourceType 'Group' `
            -SystemId $sysEntra -Description $g.Desc -Extended @{ groupCategory = $g.Cat }
    }

    $null = Add-DemoResource $State -Id $sales.BR -DisplayName 'BR-Sales' -ResourceType 'BusinessRole' `
        -SystemId $sysIga -CatalogId (New-DemoGuid 'cat-employee-access') `
        -Description 'Sales business role — grants the Sales group and CRM access.'

    # What the role grants. These two edges are what turn "Piet has CRM" into
    # "Piet has CRM *because of BR-Sales*" (flag 4).
    foreach ($child in @($sales.Group, $sales.Crm)) {
        Add-DemoRelationship $State -ParentResourceId $sales.BR -ChildResourceId $child -RelationshipType 'Contains'
    }

    Add-DemoSalesGrants $State
}

function Add-DemoSalesGrants {
    param([Parameter(Mandatory)]$State)

    $sales = $State.Sales

    $salesMembers = @(Get-DemoProvisioned $State -Department 'Sales' | ForEach-Object { $_.id })
    $State['SalesMemberIds'] = $salesMembers

    # Everyone who holds the role: the department, plus the two outsiders.
    $roleHolders = @($salesMembers) + @($script:SalesOutsiders)

    foreach ($e in $roleHolders) {
        $p = Get-DemoPrincipalId $e
        # The role membership itself — governed, because an IGA drives it.
        Add-DemoAssignment $State -ResourceId $sales.BR -PrincipalId $p -AssignmentType 'Direct' -Governed
        # ...and the access it actually confers, materialised so the matrix has
        # cells to mark as role-managed.
        foreach ($child in @($sales.Group, $sales.Crm)) {
            Add-DemoAssignment $State -ResourceId $child -PrincipalId $p -AssignmentType 'Indirect'
        }
    }

    # Flag 6 — the role candidate: ad-hoc direct grants that never made it into
    # BR-Sales. Sales only; the outsiders don't have it.
    foreach ($e in ($salesMembers | Where-Object { $script:SharePointExcluded -notcontains $_ })) {
        Add-DemoAssignment $State -ResourceId $sales.SharePoint -PrincipalId (Get-DemoPrincipalId $e) -AssignmentType 'Direct'
    }

    # Flag 7 — the trap: same "most of Sales holds it directly" shape, but it
    # crosses into Finance and only the manager (E0013) is certified for it.
    foreach ($e in $script:FinanceReportsSales) {
        Add-DemoAssignment $State -ResourceId $sales.FinReports -PrincipalId (Get-DemoPrincipalId $e) -AssignmentType 'Direct'
    }
    # Finance holds it legitimately — this is what makes it cross-department
    # rather than a Sales-shaped pattern.
    foreach ($emp in (Get-DemoProvisioned $State -Department 'Finance')) {
        Add-DemoAssignment $State -ResourceId $sales.FinReports -PrincipalId (Get-DemoPrincipalId $emp.id) -AssignmentType 'Direct'
    }
}
