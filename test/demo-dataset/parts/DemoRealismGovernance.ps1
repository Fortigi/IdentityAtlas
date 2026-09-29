<#
.SYNOPSIS
    Fortigi Demo Corp — the realism slice: business roles, eligibility, and an
    attestation campaign.

.DESCRIPTION
    Part of the opt-in realism slice (Generate-DemoDataset.ps1 -IncludeRealism).
    Runs after the groups, the memberships and the other systems, because a
    business role hands out exactly those things.

    WHAT A BUSINESS ROLE IS HERE. A resource with resourceType 'BusinessRole'
    (an access package, a role, an access profile — the vendor's word differs, the
    concept does not), linked by `Contains` to everything it grants: security
    groups AND application roles. Whoever holds the role holds those, and the
    membership it confers is materialised as an Indirect assignment — the role is
    the intent, the assignment is the fact, and the two can disagree:

      * PROVISIONING GAP — one holder in twelve is missing one of the things the
        role grants. Somebody's sync failed and nobody noticed.
      * DRIFT THE OTHER WAY — plenty of people hold groups the role does not
        grant, because DemoRealismAccess.ps1 gave them access directly as well.
        Telling "has it through the role" from "has it anyway" is the whole
        reason the governed flag exists.

    ELIGIBILITY. Three roles are things you may REQUEST rather than things you
    hold: an Eligible assignment, no membership. That is what "who can request
    the finance controller role" and "can Jeroen activate it" are asked about, and
    a dataset with four eligible assignments in it cannot answer either.

    ATTESTATION. Two review campaigns over the governed assignments: one closed
    two months ago, one still running. Each decision carries the reviewer (the
    holder's own manager), the recommendation the system made, the decision the
    reviewer took and why — the shape Entra's access reviews produce, which is
    what makes "what was approved in the last campaign" answerable.
#>

Set-StrictMode -Version Latest

# Department roles: everybody's baseline access, handed out per department.
# `Apps` names the application groups the role also grants.
$script:RealismDeptRoles = @(
    @{ Dept = 'Engineering';      Share = 85; Apps = @('mon') }
    @{ Dept = 'Operations';       Share = 80; Apps = @('tijd', 'plan') }
    @{ Dept = 'Sales';            Share = 85; Apps = @('crm') }
    @{ Dept = 'Customer Service'; Share = 90; Apps = @('sd') }
    @{ Dept = 'Finance';          Share = 85; Apps = @('erp', 'fact') }
    @{ Dept = 'Marketing';        Share = 75; Apps = @('webshop', 'intra') }
    @{ Dept = 'IT Support';       Share = 90; Apps = @('sd', 'mon') }
    @{ Dept = 'HR';               Share = 85; Apps = @('salaris') }
    @{ Dept = 'Legal';            Share = 80; Apps = @('docs') }
    @{ Dept = 'Facilities';       Share = 70; Apps = @() }
)

# Function roles: the ones an organisation writes because a job needs a set of
# things, across applications. These are the roles that grant application ROLES,
# not just groups.
$script:RealismFunctionRoles = @(
    @{ Key = 'servicedesk';  Name = 'BR-Servicedesk';            Cat = 'app'
       Groups = @('app-sd-users', 'app-mon-users'); AppRoles = @('sd-Gebruiker', 'mon-Gebruiker'); Dept = 'Customer Service'; Share = 60 }
    @{ Key = 'appbeheer';    Name = 'BR-Applicatiebeheer';       Cat = 'priv'
       Groups = @('app-sd-admins', 'app-crm-admins', 'app-erp-admins'); AppRoles = @('sd-Beheerder', 'crm-Beheerder', 'erp-Beheerder'); Dept = 'IT Support'; Share = 20; Eligible = 14 }
    @{ Key = 'controller';   Name = 'BR-Finance-Controller';     Cat = 'priv'
       Groups = @('app-erp-users', 'app-bi-users', 'app-fact-users'); AppRoles = @('erp-Rapportage', 'bi-Rapportage'); Dept = 'Finance'; Share = 25; Eligible = 9 }
    @{ Key = 'accountmgr';   Name = 'BR-Sales-Accountmanager';   Cat = 'app'
       Groups = @('app-crm-users', 'lic-m365-e5'); AppRoles = @('crm-Gebruiker', 'crm-Rapportage'); Dept = 'Sales'; Share = 45 }
    @{ Key = 'platform';     Name = 'BR-Engineering-Platform';   Cat = 'priv'
       Groups = @('app-mon-users', 'lic-m365-e5'); AppRoles = @('mon-Beheerder'); Dept = 'Engineering'; Share = 15; Eligible = 11 }
    @{ Key = 'partner';      Name = 'BR-Externe-Partner';        Cat = 'ext'
       Groups = @('m365-Team-Partners-Noordzee', 'm365-Team-Partners-Meridian'); AppRoles = @(); Dept = $null; Share = 0 }
)

# One holder in twelve is missing something the role grants: the provisioning gap
# every governance report is built to surface.
$script:RealismGapRate = 12

function Add-DemoRealismGovernance {
    param([Parameter(Mandatory)]$State)

    $sysIga = $State.SystemIds['iga']
    $State.Realism['Roles'] = [ordered]@{}
    $State.Realism['RoleHolders'] = @{}

    $catalogs = [ordered]@{
        app     = @{ Id = (New-DemoGuid 'cat-realism-app');     Name = 'Applicatietoegang' }
        priv    = @{ Id = (New-DemoGuid 'cat-realism-priv');    Name = 'Beheertoegang' }
        ext     = @{ Id = (New-DemoGuid 'cat-realism-ext');     Name = 'Externe toegang' }
        general = @{ Id = (New-DemoGuid 'cat-realism-general'); Name = 'Basistoegang per afdeling' }
    }
    foreach ($key in $catalogs.Keys) {
        $State.Catalogs.Add(@{
            id = $catalogs[$key].Id; displayName = $catalogs[$key].Name; catalogType = 'userManaged'
            enabled = $true; systemId = $sysIga
        })
    }

    Add-DemoRealismDeptRoles     $State -CatalogId $catalogs.general.Id
    Add-DemoRealismFunctionRoles $State -Catalogs $catalogs
    Add-DemoRealismAttestation   $State
}

<#
.SYNOPSIS
    One business role, its contents, and the assignments that follow from it.
.DESCRIPTION
    Contains-edges for every group and application role it grants, a governed
    Direct assignment for each holder, and — for each thing the role grants that
    the holder does not already hold directly — an Indirect assignment, minus the
    one in twelve left out as a provisioning gap.
#>
function Add-DemoRealismRole {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$CatalogId,
        [string]$Description = '',
        [string[]]$GroupKeys = @(),
        [string[]]$AppRoleKeys = @(),
        [object[]]$Holders = @(),
        [object[]]$EligibleHolders = @()
    )
    $roleId = Add-DemoResource $State -Id (New-DemoGuid "res-realism-br-$Key") `
        -DisplayName $Name -ResourceType 'BusinessRole' -SystemId $State.SystemIds['iga'] `
        -Description $Description -CatalogId $CatalogId
    $State.Realism.Roles[$Key] = @{ id = $roleId; name = $Name }

    # What the role grants.
    $grants = [System.Collections.Generic.List[object]]::new()
    foreach ($groupKey in $GroupKeys) {
        $group = $State.Realism.Groups[$groupKey]
        if (-not $group) { continue }
        Add-DemoRelationship $State -ParentResourceId $roleId -ChildResourceId $group.id -RelationshipType 'Contains' -RoleName 'Member'
        $grants.Add($group.id)
    }
    foreach ($appRoleKey in $AppRoleKeys) {
        if (-not $State.Realism.AppRoles.Contains($appRoleKey)) { continue }
        $appRole = $State.Realism.AppRoles[$appRoleKey]
        Add-DemoRelationship $State -ParentResourceId $roleId -ChildResourceId $appRole.id -RelationshipType 'Contains' -RoleName 'Member'
        $grants.Add($appRole.id)
    }

    # Who holds it, and what that gets them.
    $holderIds = [System.Collections.Generic.List[string]]::new()
    foreach ($principalId in $Holders) {
        Add-DemoAssignment $State -ResourceId $roleId -PrincipalId $principalId -AssignmentType 'Direct' -Governed
        $holderIds.Add($principalId)

        $gapAt = Get-DemoIndex -Seed "gap-$Key-$principalId" -Modulo $script:RealismGapRate
        $n = 0
        foreach ($grantId in $grants) {
            # The gap: one holder in twelve does not get one of the things.
            if ($n -eq $gapAt) { $n++; continue }
            $n++
            if ($State.Realism.Held.Add("$grantId|$principalId")) {
                Add-DemoAssignment $State -ResourceId $grantId -PrincipalId $principalId -AssignmentType 'Indirect'
            }
        }
    }
    foreach ($principalId in $EligibleHolders) {
        Add-DemoAssignment $State -ResourceId $roleId -PrincipalId $principalId -AssignmentType 'Eligible'
    }
    $State.Realism.RoleHolders[$Key] = $holderIds
    return $roleId
}

# A base role per department: the department's own group, a licence, and the
# applications that department lives in.
function Add-DemoRealismDeptRoles {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$CatalogId
    )
    foreach ($role in $script:RealismDeptRoles) {
        $slug = ($role.Dept -replace '\s+', '-')
        $groups = @("dept-$slug", 'lic-m365-e3')
        foreach ($app in $role.Apps) { $groups += "app-$app-users" }

        $holders = [System.Collections.Generic.List[string]]::new()
        foreach ($person in $State.Realism.ByDept[$role.Dept]) {
            if ((Get-DemoIndex -Seed "deptrole-$slug-$($person.id)" -Modulo 100) -lt $role.Share) {
                $holders.Add((Get-DemoPrincipalId $person.id))
            }
        }
        $null = Add-DemoRealismRole $State -Key "dept-$slug" -Name "BR-$slug-Basis" -CatalogId $CatalogId `
            -Description "Basistoegang voor medewerkers van $($role.Dept)" `
            -GroupKeys $groups -Holders $holders.ToArray()
    }
}

# The roles that cross applications — including the three you can only request.
function Add-DemoRealismFunctionRoles {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Catalogs
    )
    foreach ($role in $script:RealismFunctionRoles) {
        $holders = [System.Collections.Generic.List[string]]::new()
        $eligible = [System.Collections.Generic.List[string]]::new()

        if ($role.Dept) {
            foreach ($person in $State.Realism.ByDept[$role.Dept]) {
                if ((Get-DemoIndex -Seed "funcrole-$($role.Key)-$($person.id)" -Modulo 100) -lt $role.Share) {
                    $holders.Add((Get-DemoPrincipalId $person.id))
                }
            }
        }
        else {
            # The partner role is held by guests, which is what an access package
            # for externals really looks like.
            foreach ($guest in $State.Realism.Guests) {
                if (-not $guest.pending) { $holders.Add($guest.principalId) }
            }
        }

        # Eligibility is drawn from OUTSIDE the holders: the population that could
        # ask for the role but does not have it.
        if ($role.ContainsKey('Eligible')) {
            $candidates = @($State.Realism.People | Where-Object { -not $holders.Contains((Get-DemoPrincipalId $_.id)) })
            for ($n = 0; $n -lt $role.Eligible; $n++) {
                $person = $candidates[(Get-DemoIndex -Seed "elig-$($role.Key)-$n" -Modulo $candidates.Count)]
                $principalId = Get-DemoPrincipalId $person.id
                if (-not $eligible.Contains($principalId)) { $eligible.Add($principalId) }
            }
        }

        $null = Add-DemoRealismRole $State -Key $role.Key -Name $role.Name -CatalogId $Catalogs[$role.Cat].Id `
            -Description "Functierol $($role.Name)" -GroupKeys $role.Groups -AppRoleKeys $role.AppRoles `
            -Holders $holders.ToArray() -EligibleHolders $eligible.ToArray()
    }
}

<#
.SYNOPSIS
    Two access-review campaigns over the governed assignments.
.DESCRIPTION
    One closed 60 days ago, one running now. Every decision names the reviewer
    (the holder's own manager, which is how these are routed), the recommendation
    the system made from sign-in activity, and the decision the reviewer took —
    including the ones who approved access their own report had not used in half a
    year, which is the finding that makes an attestation report worth reading.
#>
function Add-DemoRealismAttestation {
    param([Parameter(Mandatory)]$State)

    $sysIga = $State.SystemIds['iga']
    $measuredAt = $State.Realism.MeasuredAt
    $managerOf = @{}
    foreach ($person in $State.Realism.People) {
        $managerOf[(Get-DemoPrincipalId $person.id)] = @{
            Manager = $person.manager; Name = $person.name
        }
    }

    $campaigns = @(
        @{ Key = 'q2'; Name = 'Toegangsreview Q2'; Status = 'Completed';  Start = 150; End = 60;  Roles = @('appbeheer', 'controller', 'platform'); Limit = 90 }
        @{ Key = 'q3'; Name = 'Toegangsreview Q3'; Status = 'InProgress'; Start = 20;  End = -10; Roles = @('servicedesk', 'accountmgr', 'dept-Finance', 'dept-IT-Support'); Limit = 120 }
    )

    foreach ($campaign in $campaigns) {
        $definitionId = New-DemoGuid "review-def-$($campaign.Key)"
        $instanceId = New-DemoGuid "review-inst-$($campaign.Key)"
        $written = 0

        foreach ($roleKey in $campaign.Roles) {
            if (-not $State.Realism.RoleHolders.ContainsKey($roleKey)) { continue }
            $role = $State.Realism.Roles[$roleKey]
            foreach ($holderId in $State.Realism.RoleHolders[$roleKey]) {
                if ($written -ge $campaign.Limit) { break }
                $written++

                # An unfinished campaign has undecided rows in it; a finished one
                # does not. "NotReviewed" is exactly what a manager who ignored
                # three reminders leaves behind.
                $roll = Get-DemoIndex -Seed "cert-$($campaign.Key)-$roleKey-$holderId" -Modulo 100
                $decision = if ($campaign.Status -eq 'InProgress' -and $roll -lt 35) { 'NotReviewed' }
                            elseif ($roll -lt 78) { 'Approve' } else { 'Deny' }
                $recommendation = if ($roll -ge 78) { 'Deny' } elseif ($roll -lt 60) { 'Approve' } else { 'NoInfoAvailable' }
                $why = switch ($decision) {
                    'Approve'     { 'Nodig voor de huidige functie' }
                    'Deny'        { 'Niet meer nodig — medewerker werkt niet meer met deze applicatie' }
                    default       { '' }
                }

                $manager = $managerOf[$holderId]
                $reviewerId = if ($manager -and $manager.Manager) { Get-DemoPrincipalId $manager.Manager } else { Get-DemoPrincipalId 'E0001' }
                $reviewerName = if ($manager -and $manager.Manager -and $State.EmployeesById.Contains($manager.Manager)) {
                    $State.EmployeesById[$manager.Manager].name
                } else { 'Anna Bakker' }

                $record = @{
                    id                          = (New-DemoGuid "cert-realism-$($campaign.Key)-$roleKey-$holderId")
                    resourceId                  = $role.id
                    principalId                 = $holderId
                    principalDisplayName        = if ($manager) { $manager.Name } else { '' }
                    reviewedResourceId          = $role.id
                    reviewedResourceDisplayName = $role.name
                    decision                    = $decision
                    recommendation              = $recommendation
                    justification               = $why
                    reviewedBy                  = $reviewerId
                    reviewedByDisplayName        = $reviewerName
                    reviewDefinitionId           = $definitionId
                    reviewInstanceId             = $instanceId
                    reviewInstanceStatus         = $campaign.Status
                    reviewInstanceStartDateTime  = $measuredAt.AddDays(-1 * $campaign.Start).ToString('o')
                    reviewInstanceEndDateTime    = $measuredAt.AddDays(-1 * $campaign.End).ToString('o')
                    systemId                     = $sysIga
                    extendedAttributes           = @{ campaign = $campaign.Name }
                }
                if ($decision -ne 'NotReviewed') {
                    $record['reviewedDateTime'] = $measuredAt.AddDays(-1 * ($campaign.End + (Get-DemoIndex -Seed "certwhen-$($campaign.Key)-$holderId" -Modulo 20))).ToString('o')
                }
                $State.Certifications.Add($record)
            }
        }
    }
}
