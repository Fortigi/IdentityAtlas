<#
.SYNOPSIS
    Fortigi Demo Corp — the Entra ID baseline: groups, directory roles, app
    roles, their grants, and group ownership.

.DESCRIPTION
    The "ordinary" access every demo needs, independent of the CTF: company-wide
    and departmental security groups, two directory roles, two app roles, and the
    v5 ownership model (a Direct assignment on a synthetic GroupOwnership
    resource, never the retired 'Owner' assignmentType).
#>

Set-StrictMode -Version Latest

function Add-DemoEntraBase {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']

    $res = [ordered]@{
        AllEmp      = New-DemoGuid 'res-sg-all-employees'
        Eng         = New-DemoGuid 'res-sg-engineering'
        Fin         = New-DemoGuid 'res-sg-finance'
        VPN         = New-DemoGuid 'res-sg-vpn-access'
        AdminTier0  = New-DemoGuid 'res-sg-admin-tier0'
        PAM         = New-DemoGuid 'res-sg-pam-users'
        GlobalAdmin = New-DemoGuid 'res-global-administrator'
        SPAdmin     = New-DemoGuid 'res-sharepoint-admin'
        AppFG       = New-DemoGuid 'res-app-fortigraph'
        AppSAP      = New-DemoGuid 'res-app-sap-finance'
    }
    $State['Res'] = $res

    # Each group carries the crawler-derived groupCategory the real Entra
    # transform stamps (Get-EntraGroupClassification), so the
    # entra-group-category-tree context plugin groups them exactly as it would
    # a live tenant's.
    $groups = @(
        @{ Id = $res.AllEmp;     Name = 'SG-AllEmployees'; Cat = 'DynamicSecurityGroup' }
        @{ Id = $res.Eng;        Name = 'SG-Engineering';  Cat = 'Microsoft365' }
        @{ Id = $res.Fin;        Name = 'SG-Finance';      Cat = 'SecurityGroup' }
        @{ Id = $res.VPN;        Name = 'SG-VPN-Access';   Cat = 'SecurityGroup' }
        @{ Id = $res.AdminTier0; Name = 'SG-Admin-Tier0';  Cat = 'SecurityGroup'; Desc = 'Tier 0 administrative access - critical' }
        @{ Id = $res.PAM;        Name = 'SG-PAM-Users';    Cat = 'SecurityGroup' }
    )
    foreach ($g in $groups) {
        $desc = if ($g.ContainsKey('Desc')) { $g.Desc } else { '' }
        $null = Add-DemoResource $State -Id $g.Id -DisplayName $g.Name -ResourceType 'Group' -SystemId $sysEntra -Description $desc `
            -Extended @{ groupCategory = $g.Cat }
    }

    foreach ($dr in @(
        @{ Id = $res.GlobalAdmin; Name = 'Global Administrator' }
        @{ Id = $res.SPAdmin;     Name = 'SharePoint Admin' }
    )) {
        $null = Add-DemoResource $State -Id $dr.Id -DisplayName $dr.Name -ResourceType 'EntraDirectoryRole' -SystemId $sysEntra
    }

    foreach ($ar in @(
        @{ Id = $res.AppFG;  Name = 'FortigiGraph-App' }
        @{ Id = $res.AppSAP; Name = 'SAP-Finance-Role' }
    )) {
        $null = Add-DemoResource $State -Id $ar.Id -DisplayName $ar.Name -ResourceType 'AppRole' -SystemId $sysEntra
    }

    Add-DemoEntraBaseGrants $State
    Add-DemoGroupOwnership  $State
}

function Add-DemoEntraBaseGrants {
    param([Parameter(Mandatory)]$State)

    $res = $State.Res

    # Every provisioned employee is in SG-AllEmployees. This is also the one
    # member of the Sales shared set that everyone holds *directly* rather than
    # through a role — the contrast flag 5 turns on.
    foreach ($emp in (Get-DemoProvisioned $State)) {
        Add-DemoAssignment $State -ResourceId $res.AllEmp -PrincipalId (Get-DemoPrincipalId $emp.id) -AssignmentType 'Direct'
    }

    foreach ($pair in @(
        @{ Res = $res.Eng; Dept = 'Engineering' }
        @{ Res = $res.Fin; Dept = 'Finance' }
    )) {
        foreach ($emp in (Get-DemoProvisioned $State -Department $pair.Dept)) {
            Add-DemoAssignment $State -ResourceId $pair.Res -PrincipalId (Get-DemoPrincipalId $emp.id) -AssignmentType 'Direct'
        }
    }

    # SysAdmins -> VPN
    foreach ($e in @('E0029', 'E0030')) {
        Add-DemoAssignment $State -ResourceId $res.VPN -PrincipalId (Get-DemoPrincipalId $e) -AssignmentType 'Direct'
    }

    # Admin Tier0: CTO + SysAdmin + the deploy service principal
    foreach ($p in @((Get-DemoPrincipalId 'E0002'), (Get-DemoPrincipalId 'E0029'), $State.EdgeCaseIds.SvcPrinc)) {
        Add-DemoAssignment $State -ResourceId $res.AdminTier0 -PrincipalId $p -AssignmentType 'Direct'
    }

    # CTO -> Global Admin directory role
    Add-DemoAssignment $State -ResourceId $res.GlobalAdmin -PrincipalId (Get-DemoPrincipalId 'E0002') -AssignmentType 'Direct'
}

# v5 ownership: a Direct assignment on a synthetic GroupOwnership resource
# (named after the owned group), linked to the group by a HasOwnership
# relationship — mirroring ConvertTo-EntraGroupOwnership in the Entra crawler.
function Add-DemoGroupOwnership {
    param([Parameter(Mandatory)]$State)

    $res = $State.Res
    $ownedGroups = @(
        @{ GroupId = $res.Eng;        Name = 'SG-Engineering'; Owners = @('E0010') }
        @{ GroupId = $res.Fin;        Name = 'SG-Finance';     Owners = @('E0012') }
        @{ GroupId = $res.AdminTier0; Name = 'SG-Admin-Tier0'; Owners = @('E0002', 'E0029') }
    )

    foreach ($og in $ownedGroups) {
        $ownId = New-DemoGuid "res-ownership-$($og.Name)"
        $null = Add-DemoResource $State -Id $ownId -DisplayName $og.Name -ResourceType 'GroupOwnership' `
            -SystemId $State.SystemIds['entra'] -ExternalId "entraid-ownership:$($og.GroupId)" `
            -Extended @{ ownedResourceId = $og.GroupId }
        Add-DemoRelationship $State -ParentResourceId $og.GroupId -ChildResourceId $ownId -RelationshipType 'HasOwnership'
        foreach ($ownerId in $og.Owners) {
            Add-DemoAssignment $State -ResourceId $ownId -PrincipalId (Get-DemoPrincipalId $ownerId) `
                -AssignmentType 'Direct' -ResourceType 'GroupOwnership'
        }
    }
}
