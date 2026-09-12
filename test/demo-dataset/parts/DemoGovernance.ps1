<#
.SYNOPSIS
    Fortigi Demo Corp — the IGA layer: catalogs, business roles, policies,
    certifications.

.DESCRIPTION
    Vendor-neutral by design (issue #705, Rob's review): a business role is the
    same concept whether it comes from Omada, midPoint or SailPoint, so the
    source system is 'IGA' and nothing here names a vendor.

    MODEL NOTE — how role-derived access actually works:
      * A business role is a Resource (resourceType='BusinessRole'), which ingest
        auto-flags governanceResource=true.
      * Holding it is a Direct assignment with governed=true.
      * `Contains` links the role to what it grants.
      * The matrix matview (migration 049) DERIVES "managed by this role" from
        Contains + holding the role — but only for cells that actually exist.
        A Contains child with no effective assignment renders as a provisioning
        GAP, not as access. So anything a role really grants must ALSO be emitted
        as an explicit Indirect assignment (see DemoSalesScenario.ps1).

    BR-Employee-Base deliberately Contains FortigiGraph-App without anyone
    holding an effective assignment on it — that is the demo's provisioning-gap
    example, visible under the matrix's Gaps toggle. Do not "fix" it.

    SG-VPN-Access is the mirror image and equally deliberate: BR-Engineering-
    Tools grants it, every engineer holds it through the role (Indirect), and
    the two SysAdmins hold it *directly* without holding the role at all — a
    membership no business role accounts for, which the matrix marks in red on
    those two cells. Keep both halves: drop the Indirect rows and the engineers
    turn into eight bogus provisioning gaps; give the SysAdmins the role and the
    "held outside the role" example disappears.
#>

Set-StrictMode -Version Latest

function Add-DemoGovernance {
    param([Parameter(Mandatory)]$State)

    $sysIga = $State.SystemIds['iga']
    $res    = $State.Res

    $catEmployee   = New-DemoGuid 'cat-employee-access'
    $catPrivileged = New-DemoGuid 'cat-privileged-access'

    $br = [ordered]@{
        Base  = New-DemoGuid 'res-br-employee-base'
        Eng   = New-DemoGuid 'res-br-engineering-tools'
        Fin   = New-DemoGuid 'res-br-finance-systems'
        Admin = New-DemoGuid 'res-br-admin-privileged'
    }
    $State['BR'] = $br

    foreach ($cat in @(
        @{ Id = $catEmployee;   Name = 'Employee Access' }
        @{ Id = $catPrivileged; Name = 'Privileged Access' }
    )) {
        $State.Catalogs.Add(@{
            id = $cat.Id; displayName = $cat.Name; catalogType = 'userManaged'
            enabled = $true; systemId = $sysIga
        })
    }

    $roles = @(
        @{ Id = $br.Base;  Name = 'BR-Employee-Base';     Cat = $catEmployee }
        @{ Id = $br.Eng;   Name = 'BR-Engineering-Tools'; Cat = $catEmployee }
        @{ Id = $br.Fin;   Name = 'BR-Finance-Systems';   Cat = $catEmployee }
        @{ Id = $br.Admin; Name = 'BR-Admin-Privileged';  Cat = $catPrivileged }
    )
    foreach ($r in $roles) {
        $null = Add-DemoResource $State -Id $r.Id -DisplayName $r.Name -ResourceType 'BusinessRole' `
            -SystemId $sysIga -CatalogId $r.Cat
    }

    # BR-Engineering-Tools grants the VPN group's *Owner* role, not plain
    # membership — the real-tenant shape that broke the matrix Excel export
    # (#942). It is ordinary access: the matrix badges it 'D' on screen and the
    # export must write the same letter, so keep a role-scoped Contains here.
    foreach ($rel in @(
        @{ P = $br.Base;  C = $res.AllEmp }
        @{ P = $br.Base;  C = $res.AppFG }
        @{ P = $br.Eng;   C = $res.Eng }
        @{ P = $br.Eng;   C = $res.VPN;  Role = 'Owner' }
        @{ P = $br.Fin;   C = $res.Fin }
        @{ P = $br.Fin;   C = $res.AppSAP }
        @{ P = $br.Admin; C = $res.AdminTier0 }
        @{ P = $br.Admin; C = $res.PAM }
    )) {
        $roleName = if ($rel.ContainsKey('Role')) { $rel.Role } else { $null }
        Add-DemoRelationship $State -ParentResourceId $rel.P -ChildResourceId $rel.C `
            -RelationshipType 'Contains' -RoleName $roleName
    }
    Add-DemoRelationship $State -ParentResourceId $res.Eng -ChildResourceId $res.AllEmp -RelationshipType 'GrantsAccessTo'

    # Governed role memberships.
    foreach ($emp in (Get-DemoProvisioned $State)) {
        Add-DemoAssignment $State -ResourceId $br.Base -PrincipalId (Get-DemoPrincipalId $emp.id) -AssignmentType 'Direct' -Governed
    }
    foreach ($emp in (Get-DemoProvisioned $State -Department 'Engineering')) {
        $p = Get-DemoPrincipalId $emp.id
        Add-DemoAssignment $State -ResourceId $br.Eng -PrincipalId $p -AssignmentType 'Direct' -Governed
        # BR-Engineering-Tools really grants the VPN group, so the membership it
        # confers has to exist as an assignment — see the model note above. Its
        # other child, SG-Engineering, is already held directly by every
        # engineer, so only this one needs materialising. Leaving it out made
        # every engineer read as a provisioning gap on a group the role does
        # hand them (requestor feedback on #370), which also buried the demo's
        # two deliberate gaps under eight accidental ones.
        Add-DemoAssignment $State -ResourceId $res.VPN -PrincipalId $p -AssignmentType 'Indirect'
    }

    # SysAdmin is eligible for privileged admin rather than holding it.
    Add-DemoAssignment $State -ResourceId $br.Admin -PrincipalId (Get-DemoPrincipalId 'E0029') -AssignmentType 'Eligible'

    Add-DemoGovernancePolicies $State
}

function Add-DemoGovernancePolicies {
    param([Parameter(Mandatory)]$State)

    $sysIga = $State.SystemIds['iga']
    $br     = $State.BR

    # Derived, not read from state: every demo GUID is a pure function of its
    # seed, so referencing another part's resource needs no ordering contract.
    $salesBR    = New-DemoGuid 'res-br-sales'
    $finReports = New-DemoGuid 'res-sg-finance-reports'

    foreach ($pol in @(
        @{ Seed = 'pol-auto-base';  Res = $br.Base;  Name = 'Auto-assign all employees';          Scope = 'allMemberUsers' }
        @{ Seed = 'pol-mgr-eng';    Res = $br.Eng;   Name = 'Manager approval required';          Scope = 'specificDirectoryUsers' }
        @{ Seed = 'pol-dual-admin'; Res = $br.Admin; Name = 'Dual approval (mgr + security)';     Scope = 'specificDirectoryUsers' }
        @{ Seed = 'pol-sales';      Res = $salesBR;  Name = 'Sales role — manager approval';      Scope = 'specificDirectoryUsers' }
    )) {
        $State.Policies.Add(@{
            id = (New-DemoGuid $pol.Seed); resourceId = $pol.Res; displayName = $pol.Name
            allowedTargetScope = $pol.Scope; systemId = $sysIga
        })
    }

    foreach ($cert in @(
        @{ Seed = 'cert-001'; Res = $br.Admin; Principal = (Get-DemoPrincipalId 'E0029'); Decision = 'Approve'
           By = (Get-DemoPrincipalId 'E0011'); ByName = 'Grace Huang'
           Why = 'Required for infrastructure maintenance' }
        @{ Seed = 'cert-002'; Res = $br.Base; Principal = $State.EdgeCaseIds.Disabled; Decision = 'Deny'
           By = (Get-DemoPrincipalId 'E0013'); ByName = 'Paul Quinn'
           Why = 'Employee has left the organization' }
        # The over-privileged trap was reviewed and approved for the Sales
        # Manager only — the evidence a participant needs for flag 7's "why".
        @{ Seed = 'cert-003'; Res = $finReports; Principal = (Get-DemoPrincipalId 'E0013'); Decision = 'Approve'
           By = (Get-DemoPrincipalId 'E0012'); ByName = 'Maria Novak'
           Why = 'Sales Manager needs pipeline revenue reporting; approved for this role only' }
    )) {
        $State.Certifications.Add(@{
            id = (New-DemoGuid $cert.Seed); resourceId = $cert.Res; principalId = $cert.Principal
            decision = $cert.Decision; reviewedBy = $cert.By; reviewedByDisplayName = $cert.ByName
            justification = $cert.Why; systemId = $sysIga
        })
    }
}
