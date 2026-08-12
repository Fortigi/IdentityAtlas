<#
.SYNOPSIS
    Fortigi Demo Corp — role drift: people who hold FEWER and MORE permissions
    than their business role assigns.

.DESCRIPTION
    The rest of the demo shows access that matches its business role, plus
    ad-hoc access no role covers. What it did not show is the other direction:
    a person whose actual access falls SHORT of what their role assigns, and a
    person who is short on one resource of a role while over on another.

    The cast — BR-Service-Desk grants three resources to the Operations crew:

      * SG-Servicedesk-Tools  (Member)          — standing membership
      * SG-Servicedesk-KB     (Member)          — standing membership
      * SG-Servicedesk-Admin  (Eligible Member) — just-in-time elevation only

      Ursula Visser (E0014) — holds all three exactly as assigned. The control.
      Victor Wang   (E0029) — same. Two clean holders keep the deviations from
                              looking like the norm.
      Tom Bakker    (E0034) — holds the role but was only ever provisioned into
                              Tools: FEWER than the role assigns, on two of its
                              three resources.
      Wendy Xu      (E0030) — the both-directions case: never provisioned into
                              the KB (FEWER), and holds Admin as a permanent
                              membership where the role only makes her eligible
                              (MORE). One person, one role, both deviations.
      Lars Muller   (E0024) — holds Tools directly without holding the role at
                              all: access the role does not account for.

    A fourth resource — the Ticketing-Agent app role — is added to this role by
    DemoSharedGrants.ps1, which also gives it to BR-IT-Operations. It lives
    there because it belongs to that scenario (one resource, two roles), not
    because it is a fourth drift case. Tom is left out of it as well.

    WHY THE Indirect ROWS ARE EXPLICIT: same reason as DemoSalesScenario.ps1 —
    the matrix matview reads declared rows, so access a role confers has to be
    emitted as a real assignment. Leaving one out is exactly what makes it read
    as "fewer than the role assigns" rather than as access.
#>

Set-StrictMode -Version Latest

function Add-DemoRoleDrift {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $sysIga   = $State.SystemIds['iga']

    $drift = [ordered]@{
        BR    = New-DemoGuid 'res-br-service-desk'
        Tools = New-DemoGuid 'res-sg-servicedesk-tools'
        KB    = New-DemoGuid 'res-sg-servicedesk-kb'
        Admin = New-DemoGuid 'res-sg-servicedesk-admin'
    }
    $State['Drift'] = $drift

    foreach ($g in @(
        @{ Id = $drift.Tools; Name = 'SG-Servicedesk-Tools'
           Desc = 'Service desk tooling — ticketing, remote assistance and asset lookup.' }
        @{ Id = $drift.KB; Name = 'SG-Servicedesk-KB'
           Desc = 'Service desk knowledge base — runbooks and internal procedures.' }
        @{ Id = $drift.Admin; Name = 'SG-Servicedesk-Admin'
           Desc = 'Service desk administration — queue configuration and mailbox delegation. Elevate only when needed.' }
    )) {
        $null = Add-DemoResource $State -Id $g.Id -DisplayName $g.Name -ResourceType 'Group' `
            -SystemId $sysEntra -Description $g.Desc
    }

    $null = Add-DemoResource $State -Id $drift.BR -DisplayName 'BR-Service-Desk' -ResourceType 'BusinessRole' `
        -SystemId $sysIga -CatalogId (New-DemoGuid 'cat-employee-access') `
        -Description 'Service desk business role — grants the service desk tooling and knowledge base, and eligibility for service desk administration.'

    # What the role assigns. The Admin group is eligibility only, which is what
    # makes a standing membership on it MORE than the role assigns.
    foreach ($grant in @(
        @{ Child = $drift.Tools; Role = 'Member' }
        @{ Child = $drift.KB;    Role = 'Member' }
        @{ Child = $drift.Admin; Role = 'Eligible Member' }
    )) {
        Add-DemoRelationship $State -ParentResourceId $drift.BR -ChildResourceId $grant.Child `
            -RelationshipType 'Contains' -RoleName $grant.Role
    }

    Add-DemoRoleDriftGrants $State
}

function Add-DemoRoleDriftGrants {
    param([Parameter(Mandatory)]$State)

    $drift = $State.Drift

    # Per holder: which of the role's resources they actually ended up with.
    # A resource left out of a holder's list is the whole point of this part —
    # it is what the grid must show as "fewer than the role assigns".
    $holders = @(
        @{ Emp = 'E0014'; Tools = 'Indirect'; KB = 'Indirect'; Admin = 'Eligible' }
        @{ Emp = 'E0029'; Tools = 'Indirect'; KB = 'Indirect'; Admin = 'Eligible' }
        @{ Emp = 'E0034'; Tools = 'Indirect'; KB = $null;      Admin = $null }
        # Standing membership where the role only grants eligibility, and no KB
        # at all — both deviations on one person.
        @{ Emp = 'E0030'; Tools = 'Indirect'; KB = $null;      Admin = 'Direct' }
    )

    foreach ($h in $holders) {
        $p = Get-DemoPrincipalId $h.Emp
        Add-DemoAssignment $State -ResourceId $drift.BR -PrincipalId $p -AssignmentType 'Direct' -Governed
        foreach ($grant in @(
            @{ Res = $drift.Tools; Type = $h.Tools }
            @{ Res = $drift.KB;    Type = $h.KB }
            @{ Res = $drift.Admin; Type = $h.Admin }
        )) {
            if (-not $grant.Type) { continue }
            Add-DemoAssignment $State -ResourceId $grant.Res -PrincipalId $p -AssignmentType $grant.Type
        }
    }

    # Held without the role behind it — the access a folded role cannot account
    # for, from the other side.
    Add-DemoAssignment $State -ResourceId $drift.Tools -PrincipalId (Get-DemoPrincipalId 'E0024') -AssignmentType 'Direct'
}
