<#
.SYNOPSIS
    Fortigi Demo Corp — one resource, two business roles: the overlap between
    BR-Service-Desk and BR-IT-Operations.

.DESCRIPTION
    Real IGA catalogues overlap: the same group or application role is handed
    out by more than one business role. Until this part, every resource in the
    demo belonged to exactly one role, so nothing on screen showed what the
    matrix does when two roles grant the same row (requestor feedback on #370).

    The overlap — BR-IT-Operations grants three resources, two of which
    BR-Service-Desk grants as well:

      * SG-Servicedesk-Tools  (Group)    — also granted by BR-Service-Desk
      * Ticketing-Agent       (AppRole)  — also granted by BR-Service-Desk
      * SG-Monitoring-Tools   (Group)    — granted by BR-IT-Operations alone

    The third one matters: folding one of the two roles must still take a row
    away, or "does folding do anything here?" has no visible answer.

    The cast:
      Victor Wang (E0029), Wendy Xu (E0030) — the two SysAdmins, who hold BOTH
        roles. Their membership of the shared resources is ONE assignment
        covered by TWO roles — which is the whole point: the overlap is in the
        coverage, not in the access.
      Fatih Gunay (E0010) — Team Lead Platform, holds BR-IT-Operations only. He
        is why the shared rows cannot be attributed to the service desk alone.

    Tom Bakker (E0034) deliberately does NOT get the ticketing role: he is the
    under-provisioned service desk holder from DemoRoleDrift.ps1, and the shared
    app role is one more thing his role assigns that he never received.

    WHY THE Indirect ROWS ARE EXPLICIT: same as DemoSalesScenario.ps1 — the
    matrix matview reads declared rows, so access a role confers is emitted as a
    real assignment. Memberships the drift part already emitted are NOT repeated
    here; a second role covering them adds coverage, not a second assignment.
#>

Set-StrictMode -Version Latest

# Holders of BR-IT-Operations. The two SysAdmins hold the service desk role too;
# the platform lead holds this one only.
$script:ItOpsHolders = @('E0010', 'E0029', 'E0030')

# Who ends up with the shared ticketing app role: the IT operations holders plus
# the service desk holders — except Tom Bakker, whose gap is the point.
$script:TicketingHolders = @('E0010', 'E0014', 'E0029', 'E0030')

# SG-Servicedesk-Tools memberships DemoRoleDrift.ps1 already emitted. Re-emitting
# them would duplicate the assignment rather than add the second role's coverage.
$script:AlreadyHoldsTools = @('E0014', 'E0029', 'E0030', 'E0034')

function Add-DemoSharedGrants {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $sysIga   = $State.SystemIds['iga']

    # Derived, not read from state: every demo GUID is a pure function of its
    # seed, so referencing the drift part's resources needs no ordering contract.
    $shared = [ordered]@{
        BR         = New-DemoGuid 'res-br-it-operations'
        Ticketing  = New-DemoGuid 'res-app-ticketing-agent'
        Monitoring = New-DemoGuid 'res-sg-monitoring-tools'
        Tools      = New-DemoGuid 'res-sg-servicedesk-tools'
        ServicesBR = New-DemoGuid 'res-br-service-desk'
    }
    $State['Shared'] = $shared

    $null = Add-DemoResource $State -Id $shared.Ticketing -DisplayName 'Ticketing-Agent' -ResourceType 'AppRole' `
        -SystemId $sysEntra `
        -Description 'Ticketing platform agent role — work, assign and close tickets on behalf of the service desk.'

    $null = Add-DemoResource $State -Id $shared.Monitoring -DisplayName 'SG-Monitoring-Tools' -ResourceType 'Group' `
        -SystemId $sysEntra `
        -Description 'Infrastructure monitoring — dashboards, alert routing and on-call schedules.'

    $null = Add-DemoResource $State -Id $shared.BR -DisplayName 'BR-IT-Operations' -ResourceType 'BusinessRole' `
        -SystemId $sysIga -CatalogId (New-DemoGuid 'cat-employee-access') `
        -Description 'IT operations business role — grants the monitoring tools, and shares the service desk tooling and ticketing role with BR-Service-Desk.'

    # The overlap itself. Two roles, one Contains edge each, on the same child.
    foreach ($grant in @(
        @{ Parent = $shared.BR;         Child = $shared.Tools }
        @{ Parent = $shared.BR;         Child = $shared.Ticketing }
        @{ Parent = $shared.BR;         Child = $shared.Monitoring }
        @{ Parent = $shared.ServicesBR; Child = $shared.Ticketing }
    )) {
        Add-DemoRelationship $State -ParentResourceId $grant.Parent -ChildResourceId $grant.Child `
            -RelationshipType 'Contains' -RoleName 'Member'
    }

    Add-DemoSharedGrantAssignments $State
}

function Add-DemoSharedGrantAssignments {
    param([Parameter(Mandatory)]$State)

    $shared = $State.Shared

    foreach ($e in $script:ItOpsHolders) {
        $p = Get-DemoPrincipalId $e
        Add-DemoAssignment $State -ResourceId $shared.BR -PrincipalId $p -AssignmentType 'Direct' -Governed
        Add-DemoAssignment $State -ResourceId $shared.Monitoring -PrincipalId $p -AssignmentType 'Indirect'
        # Only for a holder who does not already have the membership through the
        # service desk role — one membership, covered by both roles.
        if ($script:AlreadyHoldsTools -notcontains $e) {
            Add-DemoAssignment $State -ResourceId $shared.Tools -PrincipalId $p -AssignmentType 'Indirect'
        }
    }

    foreach ($e in $script:TicketingHolders) {
        Add-DemoAssignment $State -ResourceId $shared.Ticketing -PrincipalId (Get-DemoPrincipalId $e) -AssignmentType 'Indirect'
    }
}
