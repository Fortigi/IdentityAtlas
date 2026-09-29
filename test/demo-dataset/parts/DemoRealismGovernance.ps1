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
# Everything a role grants, as Contains edges: the groups and the application
# roles. Returns the resource ids, which is what a holder's memberships are
# materialised from. A key that names nothing is skipped rather than fatal, so a
# role can mention a group a later slice adds.
function Add-DemoRealismRoleGrants {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$RoleId,
        [AllowEmptyCollection()][string[]]$GroupKeys,
        [AllowEmptyCollection()][string[]]$AppRoleKeys
    )
    $grants = [System.Collections.Generic.List[object]]::new()
    foreach ($groupKey in $GroupKeys) {
        $group = $State.Realism.Groups[$groupKey]
        if (-not $group) { continue }
        Add-DemoRelationship $State -ParentResourceId $RoleId -ChildResourceId $group.id -RelationshipType 'Contains' -RoleName 'Member'
        $grants.Add($group.id)
    }
    foreach ($appRoleKey in $AppRoleKeys) {
        if (-not $State.Realism.AppRoles.Contains($appRoleKey)) { continue }
        Add-DemoRelationship $State -ParentResourceId $RoleId -ChildResourceId $State.Realism.AppRoles[$appRoleKey].id `
            -RelationshipType 'Contains' -RoleName 'Member'
        $grants.Add($State.Realism.AppRoles[$appRoleKey].id)
    }
    # As above: the comma keeps a one-item list from arriving as a bare value.
    return , $grants.ToArray()
}

<#
.SYNOPSIS
    What holding the role actually got one person.
.DESCRIPTION
    The role assignment is the intent; the memberships it confers are the fact, and
    the two are allowed to disagree. One holder in twelve is missing one of the
    things the role grants — a sync that failed and nobody noticed, which is the
    finding a governance report exists to surface. A membership the person already
    holds directly is left alone: that is drift the other way, and the governed flag
    is what tells the two apart.
#>
function Add-DemoRealismRoleGrantsToHolder {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$PrincipalId,
        [AllowEmptyCollection()][object[]]$Grants = @()
    )
    $gapAt = Get-DemoIndex -Seed "gap-$Key-$PrincipalId" -Modulo $script:RealismGapRate
    $n = 0
    foreach ($grantId in $Grants) {
        $skip = ($n -eq $gapAt)
        $n++
        if ($skip) { continue }
        if ($State.Realism.Held.Add("$grantId|$PrincipalId")) {
            Add-DemoAssignment $State -ResourceId $grantId -PrincipalId $PrincipalId -AssignmentType 'Indirect'
        }
    }
}

<#
.SYNOPSIS
    One business role, its contents, and the assignments that follow from it.
.DESCRIPTION
    Contains-edges for every group and application role it grants, a governed Direct
    assignment per holder, the memberships those confer (minus the deliberate gap),
    and an Eligible assignment for everyone who may only request it.
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

    # No @() around the call: the helper already returns the array whole (see the
    # unary comma in it), and wrapping it again would nest one array inside another.
    $grants = Add-DemoRealismRoleGrants $State -RoleId $roleId -GroupKeys $GroupKeys -AppRoleKeys $AppRoleKeys

    $holderIds = [System.Collections.Generic.List[string]]::new()
    foreach ($principalId in $Holders) {
        Add-DemoAssignment $State -ResourceId $roleId -PrincipalId $principalId -AssignmentType 'Direct' -Governed
        $holderIds.Add($principalId)
        Add-DemoRealismRoleGrantsToHolder $State -Key $Key -PrincipalId $principalId -Grants $grants
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
# Who holds a function role. A role with a department is held by a share of that
# department; the partner role has none, and is held by the guests who accepted
# their invitation — which is what an access package for externals looks like.
function Get-DemoRealismRoleHolders {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Role
    )
    $holders = [System.Collections.Generic.List[string]]::new()
    if (-not $Role.Dept) {
        foreach ($guest in $State.Realism.Guests) {
            if (-not $guest.pending) { $holders.Add($guest.principalId) }
        }
        # The unary comma keeps the array whole: PowerShell unrolls a returned
        # collection, so one holder would come back as a bare string and none as
        # $null. Same trap as New-DemoState's lists.
        return , $holders.ToArray()
    }
    foreach ($person in $State.Realism.ByDept[$Role.Dept]) {
        if ((Get-DemoIndex -Seed "funcrole-$($Role.Key)-$($person.id)" -Modulo 100) -lt $Role.Share) {
            $holders.Add((Get-DemoPrincipalId $person.id))
        }
    }
    return , $holders.ToArray()
}

# Who may REQUEST it. Drawn from outside the holders on purpose: "can this person
# activate it" and "does this person have it" must have different answers for the
# same name, or the eligible column proves nothing.
function Get-DemoRealismEligibleHolders {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Role,
        [AllowEmptyCollection()][string[]]$Holders = @()
    )
    $eligible = [System.Collections.Generic.List[string]]::new()
    if (-not $Role.ContainsKey('Eligible')) { return , $eligible.ToArray() }

    $candidates = @($State.Realism.People | Where-Object { $Holders -notcontains (Get-DemoPrincipalId $_.id) })
    for ($n = 0; $n -lt $Role.Eligible; $n++) {
        $principalId = Get-DemoPrincipalId $candidates[(Get-DemoIndex -Seed "elig-$($Role.Key)-$n" -Modulo $candidates.Count)].id
        if (-not $eligible.Contains($principalId)) { $eligible.Add($principalId) }
    }
    return , $eligible.ToArray()
}

function Add-DemoRealismFunctionRoles {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Catalogs
    )
    foreach ($role in $script:RealismFunctionRoles) {
        $holders = Get-DemoRealismRoleHolders -State $State -Role $role
        $eligible = Get-DemoRealismEligibleHolders -State $State -Role $role -Holders $holders
        $null = Add-DemoRealismRole $State -Key $role.Key -Name $role.Name -CatalogId $Catalogs[$role.Cat].Id `
            -Description "Functierol $($role.Name)" -GroupKeys $role.Groups -AppRoleKeys $role.AppRoles `
            -Holders $holders -EligibleHolders $eligible
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
# The two campaigns: one closed two months ago, one still running.
$script:RealismCampaigns = @(
    @{ Key = 'q2'; Name = 'Toegangsreview Q2'; Status = 'Completed';  Start = 150; End = 60
       Roles = @('appbeheer', 'controller', 'platform'); Limit = 90 }
    @{ Key = 'q3'; Name = 'Toegangsreview Q3'; Status = 'InProgress'; Start = 20;  End = -10
       Roles = @('servicedesk', 'accountmgr', 'dept-Finance', 'dept-IT-Support'); Limit = 120 }
)

<#
.SYNOPSIS
    What one reviewer did with one holder's access.
.DESCRIPTION
    One deterministic roll decides all three answers together, because they are
    correlated in life: the system recommends removing access it has not seen used,
    the reviewer usually agrees, and sometimes approves it anyway. An unfinished
    campaign also has undecided rows — which is exactly what a manager who ignored
    three reminders leaves behind, and what an attestation report has to show.
#>
function Get-DemoRealismVerdict {
    param(
        [Parameter(Mandatory)][string]$Seed,
        [Parameter(Mandatory)][string]$Status
    )
    $roll = Get-DemoIndex -Seed $Seed -Modulo 100
    $decision = if ($Status -eq 'InProgress' -and $roll -lt 35) { 'NotReviewed' }
                elseif ($roll -lt 78) { 'Approve' }
                else { 'Deny' }
    $recommendation = if ($roll -ge 78) { 'Deny' } elseif ($roll -lt 60) { 'Approve' } else { 'NoInfoAvailable' }
    $why = switch ($decision) {
        'Approve' { 'Nodig voor de huidige functie' }
        'Deny'    { 'Niet meer nodig — medewerker werkt niet meer met deze applicatie' }
        default   { '' }
    }
    return @{ Decision = $decision; Recommendation = $recommendation; Why = $why }
}

# Who reviews a holder's access: their own manager, which is how these are routed.
# The chief executive of the standard dataset catches whatever has nobody above it.
function Get-DemoRealismReviewer {
    param(
        [Parameter(Mandatory)]$State,
        $Person
    )
    if ($Person -and $Person.Manager) {
        $name = if ($State.EmployeesById.Contains($Person.Manager)) { $State.EmployeesById[$Person.Manager].name }
                else { (Get-DemoRealismPersonName -State $State -EmployeeId $Person.Manager) }
        return @{ Id = (Get-DemoPrincipalId $Person.Manager); Name = $name }
    }
    return @{ Id = (Get-DemoPrincipalId 'E0001'); Name = 'Anna Bakker' }
}

# The display name of a realism employee id, for the reviewer line.
function Get-DemoRealismPersonName {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$EmployeeId
    )
    $match = @($State.Realism.People | Where-Object { $_.id -eq $EmployeeId })
    if ($match.Count) { return $match[0].name }
    return ''
}

# One decision row, in the shape Entra's access reviews produce.
function New-DemoRealismDecision {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Campaign,
        [Parameter(Mandatory)]$Role,
        [Parameter(Mandatory)][string]$HolderId,
        [Parameter(Mandatory)]$Holder,
        [Parameter(Mandatory)][string]$RoleKey
    )
    $verdict = Get-DemoRealismVerdict -Seed "cert-$($Campaign.Key)-$RoleKey-$HolderId" -Status $Campaign.Status
    $reviewer = Get-DemoRealismReviewer -State $State -Person $Holder
    $measuredAt = $State.Realism.MeasuredAt

    $record = @{
        id                          = (New-DemoGuid "cert-realism-$($Campaign.Key)-$RoleKey-$HolderId")
        resourceId                  = $Role.id
        principalId                 = $HolderId
        principalDisplayName        = if ($Holder) { $Holder.Name } else { '' }
        reviewedResourceId          = $Role.id
        reviewedResourceDisplayName = $Role.name
        decision                    = $verdict.Decision
        recommendation              = $verdict.Recommendation
        justification               = $verdict.Why
        reviewedBy                  = $reviewer.Id
        reviewedByDisplayName       = $reviewer.Name
        reviewDefinitionId          = (New-DemoGuid "review-def-$($Campaign.Key)")
        reviewInstanceId            = (New-DemoGuid "review-inst-$($Campaign.Key)")
        reviewInstanceStatus        = $Campaign.Status
        reviewInstanceStartDateTime = $measuredAt.AddDays(-1 * $Campaign.Start).ToString('o')
        reviewInstanceEndDateTime   = $measuredAt.AddDays(-1 * $Campaign.End).ToString('o')
        systemId                    = $State.SystemIds['iga']
        extendedAttributes          = @{ campaign = $Campaign.Name }
    }
    # An undecided row has no decision date, which is what makes it findable.
    if ($verdict.Decision -ne 'NotReviewed') {
        $record['reviewedDateTime'] = $measuredAt.AddDays(
            -1 * ($Campaign.End + (Get-DemoIndex -Seed "certwhen-$($Campaign.Key)-$HolderId" -Modulo 20))).ToString('o')
    }
    return $record
}

function Add-DemoRealismAttestation {
    param([Parameter(Mandatory)]$State)

    # holder principal id -> the person, so a reviewer can be found without
    # searching the roster for every row.
    $holders = @{}
    foreach ($person in $State.Realism.People) {
        $holders[(Get-DemoPrincipalId $person.id)] = @{ Manager = $person.manager; Name = $person.name }
    }

    foreach ($campaign in $script:RealismCampaigns) {
        $written = 0
        foreach ($roleKey in $campaign.Roles) {
            if (-not $State.Realism.RoleHolders.ContainsKey($roleKey)) { continue }
            $role = $State.Realism.Roles[$roleKey]
            foreach ($holderId in $State.Realism.RoleHolders[$roleKey]) {
                if ($written -ge $campaign.Limit) { break }
                $written++
                $decisionArgs = @{ State = $State; Campaign = $campaign; Role = $role; HolderId = $holderId; Holder = $holders[$holderId]; RoleKey = $roleKey }
                $State.Certifications.Add((New-DemoRealismDecision @decisionArgs))
            }
        }
    }
}
