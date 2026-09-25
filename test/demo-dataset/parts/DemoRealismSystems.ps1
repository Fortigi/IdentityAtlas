<#
.SYNOPSIS
    Fortigi Demo Corp — the realism slice: the other systems, and the three kinds
    of inheritance.

.DESCRIPTION
    Part of the opt-in realism slice (Generate-DemoDataset.ps1 -IncludeRealism).
    Access does not live in one directory, and the ways it is inherited differ
    per system. This file builds all three, because a report that handles one and
    not the others looks right until somebody asks about the second:

      1. GROUP NESTING (Entra / AD): a group inside a group. Handled in
         DemoRealismAccess.ps1 — every member of the child also holds the parent,
         Indirect.
      2. SCOPE INHERITANCE (Azure): a role granted on a resource group applies to
         everything inside it. Recorded as a Contains tree over scope nodes, with
         the inherited grants materialised as Indirect assignments on the capability
         of each child scope — which is what the matrix reads.
      3. ROLE SYNCHRONISATION (governance): a business role hands out groups and
         application roles to whoever holds the role. Handled in
         DemoRealismGovernance.ps1, which needs the application roles this file
         creates.

    SYSTEMS WITH AND WITHOUT THEIR OWN ACCOUNTS. The on-premises AD and the CRM
    keep account objects of their own, which is why one person here holds several
    accounts (DemoRealismPeople.ps1 links them into one identity). Azure keeps
    none: it grants access to the Entra principals it trusts, and its resources
    are scopes, not accounts. Both cases have to exist or account correlation and
    cross-system questions cannot be tested.

    Every id is New-DemoGuid of a stable seed; every choice is Get-DemoIndex.
#>

Set-StrictMode -Version Latest

# Roles an application really exposes: who may use it, who administers it, who
# may see its reports. A business role hands these out (DemoRealismGovernance).
$script:RealismAppRoles = @('Gebruiker', 'Beheerder', 'Rapportage')

# The second Azure subscription: four resource groups, ten resources, and grants
# at every level so inheritance has something to inherit.
$script:RealismAzureSubId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb'
$script:RealismAzureGroups = @(
    @{ Key = 'rg-prod-nl';  Name = 'rg-prod-westeurope-02'; Location = 'westeurope' }
    @{ Key = 'rg-test-nl';  Name = 'rg-test-westeurope';    Location = 'westeurope' }
    @{ Key = 'rg-data';     Name = 'rg-data-northeurope';   Location = 'northeurope' }
    @{ Key = 'rg-shared';   Name = 'rg-shared-services';    Location = 'westeurope' }
)
$script:RealismAzureResources = @(
    @{ Key = 'st-prod';   Name = 'stprodnl02';        Rg = 'rg-prod-nl'; Type = 'Microsoft.Storage/storageAccounts' }
    @{ Key = 'kv-prod';   Name = 'kv-prod-nl';        Rg = 'rg-prod-nl'; Type = 'Microsoft.KeyVault/vaults' }
    @{ Key = 'sql-prod';  Name = 'sql-prod-nl';       Rg = 'rg-prod-nl'; Type = 'Microsoft.Sql/servers' }
    @{ Key = 'app-prod';  Name = 'app-prod-webshop';  Rg = 'rg-prod-nl'; Type = 'Microsoft.Web/sites' }
    @{ Key = 'st-test';   Name = 'sttestnl01';        Rg = 'rg-test-nl'; Type = 'Microsoft.Storage/storageAccounts' }
    @{ Key = 'app-test';  Name = 'app-test-webshop';  Rg = 'rg-test-nl'; Type = 'Microsoft.Web/sites' }
    @{ Key = 'dl-data';   Name = 'dldatane01';        Rg = 'rg-data';    Type = 'Microsoft.Storage/storageAccounts' }
    @{ Key = 'syn-data';  Name = 'syn-analytics';     Rg = 'rg-data';    Type = 'Microsoft.Synapse/workspaces' }
    @{ Key = 'kv-shared'; Name = 'kv-shared-01';      Rg = 'rg-shared';  Type = 'Microsoft.KeyVault/vaults' }
    @{ Key = 'acr-shared'; Name = 'acrshared01';      Rg = 'rg-shared';  Type = 'Microsoft.ContainerRegistry/registries' }
)

# On-premises AD groups, the oldest access in any company: a few of them named
# after things that no longer exist.
$script:RealismAdGroups = @(
    'G-Fileshare-Algemeen', 'G-Fileshare-Finance', 'G-Fileshare-Engineering',
    'G-Printers-Kantoor-Amsterdam', 'G-Printers-Kantoor-Zwolle', 'G-VPN-Toegang',
    'G-Applicatie-Boekhoud2012', 'G-Beheer-Werkplek', 'G-Netwerkschijf-Archief',
    'G-Terminalserver-Gebruikers', 'G-Oud-Fusie-Meridiaan', 'G-Directie-Schijf'
)

$script:RealismCrmRoles = @('CRM-Verkoper', 'CRM-Verkoopleider', 'CRM-Marketing', 'CRM-Alleen-Lezen', 'CRM-Beheerder')

<#
    Entra directory roles. `Holders` and `Eligible` are how many accounts hold the
    role now and how many may activate it (PIM) — and three roles have neither,
    because every tenant carries built-in roles nobody was ever given. That is
    what "which admin roles does nobody hold" is asked about, while "who can
    request the privileged role administrator" needs the eligible column to be
    more than the four rows the standard slice has.

    The two roles the standard slice already creates ('Global Administrator',
    'SharePoint Admin') are NOT repeated here; they are given more holders and
    eligible accounts instead, so a question about global admin has one answer
    rather than two identically named ones.
#>
$script:RealismDirectoryRoles = @(
    @{ Key = 'useradmin';  Name = 'User Administrator';            Holders = 3; Eligible = 4 }
    @{ Key = 'secadmin';   Name = 'Security Administrator';        Holders = 2; Eligible = 5 }
    @{ Key = 'exchadmin';  Name = 'Exchange Administrator';        Holders = 2; Eligible = 2 }
    @{ Key = 'teamsadmin'; Name = 'Teams Administrator';           Holders = 2; Eligible = 3 }
    @{ Key = 'intune';     Name = 'Intune Administrator';          Holders = 1; Eligible = 3 }
    @{ Key = 'privrole';   Name = 'Privileged Role Administrator'; Holders = 1; Eligible = 2 }
    @{ Key = 'appadmin';   Name = 'Application Administrator';     Holders = 2; Eligible = 4 }
    @{ Key = 'billing';    Name = 'Billing Administrator';         Holders = 2; Eligible = 0 }
    @{ Key = 'globalread'; Name = 'Global Reader';                 Holders = 6; Eligible = 3 }
    @{ Key = 'helpdesk';   Name = 'Helpdesk Administrator';        Holders = 5; Eligible = 6 }
    @{ Key = 'compliance'; Name = 'Compliance Administrator';      Holders = 0; Eligible = 0 }
    @{ Key = 'attackpay';  Name = 'Attack Payload Author';         Holders = 0; Eligible = 0 }
    @{ Key = 'printadmin'; Name = 'Printer Administrator';         Holders = 0; Eligible = 0 }
)

function Add-DemoRealismSystems {
    param([Parameter(Mandatory)]$State)

    $State.Realism['AppRoles'] = [ordered]@{}
    Add-DemoRealismApplications    $State
    Add-DemoRealismDirectoryRoles  $State
    Add-DemoRealismAzureEstate     $State
    Add-DemoRealismAdGroups        $State
    Add-DemoRealismCrmRoles        $State
}

<#
.SYNOPSIS
    Directory roles, who holds them, and who may activate them.
.DESCRIPTION
    Holders are drawn from IT Support and the admin accounts — because in a tenant
    that has been tidied up at all, privileged roles sit on the second account
    somebody uses for administration, not on the one they read their mail with.
    Eligible (PIM) assignments are drawn from people who do NOT hold the role, so
    "can this person activate it" and "does this person have it" have different
    answers for the same name.
#>
function Add-DemoRealismDirectoryRoles {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    # ContainsKey, not a property test: most principal records have no jobTitle at
    # all, and StrictMode makes reading a missing key an error rather than $null.
    $adminAccounts = @($State.Principals |
        Where-Object { $_.ContainsKey('jobTitle') -and $_.jobTitle -eq 'Administrative account' } |
        ForEach-Object { $_.id })
    $itPeople = @($State.Realism.ByDept['IT Support'] | ForEach-Object { Get-DemoPrincipalId $_.id })
    $everyone = @($State.Realism.People | ForEach-Object { Get-DemoPrincipalId $_.id })
    $privileged = @($adminAccounts + $itPeople)

    foreach ($role in $script:RealismDirectoryRoles) {
        $roleId = Add-DemoResource $State -Id (New-DemoGuid "res-realism-dirrole-$($role.Key)") `
            -DisplayName $role.Name -ResourceType 'EntraDirectoryRole' -SystemId $sysEntra `
            -Description "Entra directory role $($role.Name)" `
            -Extended @{ isBuiltIn = $true; roleTemplateId = (New-DemoGuid "roletemplate-$($role.Key)") }
        Add-DemoRealismRoleHolders $State -RoleId $roleId -Key $role.Key `
            -Holders $role.Holders -Eligible $role.Eligible -Privileged $privileged -Everyone $everyone
    }

    # The two roles the standard slice created get a realistic population too, so
    # the commonest question of all ("who is global admin, and who can become
    # one") has an answer with more than one row in it.
    Add-DemoRealismRoleHolders $State -RoleId (New-DemoGuid 'res-global-administrator') -Key 'globaladmin-extra' `
        -Holders 2 -Eligible 4 -Privileged $privileged -Everyone $everyone
    Add-DemoRealismRoleHolders $State -RoleId (New-DemoGuid 'res-sharepoint-admin') -Key 'spadmin-extra' `
        -Holders 1 -Eligible 3 -Privileged $privileged -Everyone $everyone
}

# Deterministic holders and eligible accounts for one role, never the same
# account twice and never eligible for something it already holds.
function Add-DemoRealismRoleHolders {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$RoleId,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][int]$Holders,
        [Parameter(Mandatory)][int]$Eligible,
        [Parameter(Mandatory)][string[]]$Privileged,
        [Parameter(Mandatory)][string[]]$Everyone
    )
    $held = [System.Collections.Generic.HashSet[string]]::new()
    for ($n = 0; $n -lt $Holders; $n++) {
        $candidate = $Privileged[(Get-DemoIndex -Seed "dirhold-$Key-$n" -Modulo $Privileged.Count)]
        if ($held.Add($candidate)) {
            Add-DemoAssignment $State -ResourceId $RoleId -PrincipalId $candidate -AssignmentType 'Direct'
        }
    }
    for ($n = 0; $n -lt $Eligible; $n++) {
        $candidate = $Everyone[(Get-DemoIndex -Seed "direlig-$Key-$n" -Modulo $Everyone.Count)]
        if ($held.Add($candidate)) {
            Add-DemoAssignment $State -ResourceId $RoleId -PrincipalId $candidate -AssignmentType 'Eligible'
        }
    }
}

<#
.SYNOPSIS
    One enterprise application per business application, with its roles and its
    owner.
.DESCRIPTION
    The application itself grants nothing — it is the parent of the app roles,
    exactly as the Entra crawler models it. Ownership is the interesting part:
    six applications are owned by a person, three by a service principal (which
    is what makes "service principals that own an application" a real question),
    and three have no owner at all.
#>
function Add-DemoRealismApplications {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $people = @($State.Realism.People)
    $serviceAccounts = @($State.Realism.NonHuman.Keys | Where-Object { $_ -like 'RSVC-*' })

    $n = 0
    foreach ($app in $script:RealismApps) {
        $n++
        $appId = Add-DemoResource $State -Id (New-DemoGuid "res-realism-app-$($app.Key)") `
            -DisplayName "$($app.Name) (applicatie)" -ResourceType 'Application' -SystemId $sysEntra `
            -Description "Enterprise application voor $($app.Name)"

        foreach ($role in $script:RealismAppRoles) {
            $roleKey = "$($app.Key)-$role"
            $roleId = Add-DemoResource $State -Id (New-DemoGuid "res-realism-approle-$roleKey") `
                -DisplayName "$($app.Name) - $role" -ResourceType 'AppRole' -SystemId $sysEntra `
                -Description "Applicatierol $role in $($app.Name)"
            Add-DemoRelationship $State -ParentResourceId $appId -ChildResourceId $roleId -RelationshipType 'HasAppRole'
            $State.Realism.AppRoles[$roleKey] = @{ id = $roleId; app = $app.Key; role = $role }

            # Who holds the role: the members of the matching group, so the app
            # role and the group access tell the same story — the way a real
            # tenant ends up, having done it twice.
            $groupKey = if ($role -eq 'Beheerder') { "app-$($app.Key)-admins" } else { "app-$($app.Key)-users" }
            $share = switch ($role) { 'Beheerder' { 100 } 'Rapportage' { 25 } default { 60 } }
            if ($State.Realism.GroupMembers.ContainsKey($groupKey)) {
                $i = 0
                foreach ($principal in $State.Realism.GroupMembers[$groupKey]) {
                    $i++
                    if ((Get-DemoIndex -Seed "approle-$roleKey-$i" -Modulo 100) -lt $share) {
                        Add-DemoAssignment $State -ResourceId $roleId -PrincipalId $principal -AssignmentType 'Direct'
                    }
                }
            }
        }

        # Ownership: people, then service principals, then three with nobody.
        if ($n -le 6) {
            $owner = $people[(Get-DemoIndex -Seed "appowner-$($app.Key)" -Modulo $people.Count)]
            Add-DemoRealismOwnership $State -AppId $appId -AppName $app.Name -Key $app.Key `
                -PrincipalId (Get-DemoPrincipalId $owner.id) -Kind 'ApplicationOwnership'
        }
        elseif ($n -le 9) {
            $svcKey = $serviceAccounts[(Get-DemoIndex -Seed "appownersvc-$($app.Key)" -Modulo $serviceAccounts.Count)]
            Add-DemoRealismOwnership $State -AppId $appId -AppName $app.Name -Key $app.Key `
                -PrincipalId $State.Realism.NonHuman[$svcKey] -Kind 'ServicePrincipalOwnership'
        }
    }
}

# Ownership of an application is a Direct assignment on a synthetic ownership
# resource linked to the app — the same shape as group ownership.
function Add-DemoRealismOwnership {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$AppName,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$PrincipalId,
        [Parameter(Mandatory)][ValidateSet('ApplicationOwnership', 'ServicePrincipalOwnership')][string]$Kind
    )
    $ownId = Add-DemoResource $State -Id (New-DemoGuid "res-realism-appown-$Key") `
        -DisplayName $AppName -ResourceType $Kind -SystemId $State.SystemIds['entra'] `
        -Extended @{ ownedResourceId = $AppId }
    Add-DemoRelationship $State -ParentResourceId $AppId -ChildResourceId $ownId -RelationshipType 'HasAppOwnership'
    Add-DemoAssignment $State -ResourceId $ownId -PrincipalId $PrincipalId -AssignmentType 'Direct' -ResourceType $Kind
}

<#
.SYNOPSIS
    A second Azure subscription, and the inheritance that comes with it.
.DESCRIPTION
    Scope tree: subscription -> four resource groups -> ten resources, linked by
    Contains. A role is granted on ONE scope and applies to everything below it,
    so a grant on a resource group is written as a Direct assignment on that
    scope's capability and an INDIRECT assignment on the capability of every
    resource inside it. Without those indirect rows, "who can write to this
    storage account" answers "nobody" while four people can.
#>
function Add-DemoRealismAzureEstate {
    param([Parameter(Mandatory)]$State)

    $sysAz = $State.SystemIds['azurerm']
    $sub = $script:RealismAzureSubId
    $subPath = "/subscriptions/$sub"
    $scopeIds = @{}
    $childrenOf = @{}

    $subId = Add-DemoResource $State -Id (New-DemoGuid 'res-realism-az-sub') `
        -DisplayName 'Fortigi Demo Productie' -ResourceType 'AzureScope' -SystemId $sysAz -ExternalId $subPath `
        -Extended @{ armPath = $subPath; scopeKind = 'Subscription'; scopeTypeLabel = 'Sub' }
    $scopeIds['sub'] = $subId
    $childrenOf['sub'] = [System.Collections.Generic.List[string]]::new()

    foreach ($rg in $script:RealismAzureGroups) {
        $armPath = "$subPath/resourceGroups/$($rg.Name)"
        $id = Add-DemoResource $State -Id (New-DemoGuid "res-realism-az-$($rg.Key)") `
            -DisplayName $rg.Name -ResourceType 'AzureResourceGroup' -SystemId $sysAz -ExternalId $armPath `
            -Extended @{ armPath = $armPath; scopeKind = 'ResourceGroup'; scopeTypeLabel = 'RG'; azureLocation = $rg.Location }
        Add-DemoRelationship $State -ParentResourceId $subId -ChildResourceId $id -RelationshipType 'Contains'
        $scopeIds[$rg.Key] = $id
        $childrenOf[$rg.Key] = [System.Collections.Generic.List[string]]::new()
        $childrenOf['sub'].Add($rg.Key)
    }
    foreach ($res in $script:RealismAzureResources) {
        $rgName = ($script:RealismAzureGroups | Where-Object { $_.Key -eq $res.Rg }).Name
        $location = ($script:RealismAzureGroups | Where-Object { $_.Key -eq $res.Rg }).Location
        $armPath = "$subPath/resourceGroups/$rgName/providers/$($res.Type)/$($res.Name)"
        $id = Add-DemoResource $State -Id (New-DemoGuid "res-realism-az-$($res.Key)") `
            -DisplayName $res.Name -ResourceType 'AzureResource' -SystemId $sysAz -ExternalId $armPath `
            -Extended @{ armPath = $armPath; scopeKind = 'Resource'; scopeTypeLabel = 'Res'
                         azureResourceType = $res.Type; azureLocation = $location }
        Add-DemoRelationship $State -ParentResourceId $scopeIds[$res.Rg] -ChildResourceId $id -RelationshipType 'Contains'
        $scopeIds[$res.Key] = $id
        $childrenOf[$res.Rg].Add($res.Key)
    }

    Add-DemoRealismAzureGrants $State -ScopeIds $scopeIds -ChildrenOf $childrenOf
}

# The grants themselves, and the inherited rows they imply.
function Add-DemoRealismAzureGrants {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][hashtable]$ScopeIds,
        [Parameter(Mandatory)][hashtable]$ChildrenOf
    )
    $sysAz = $State.SystemIds['azurerm']
    $engineers = @($State.Realism.ByDept['Engineering'])
    $itPeople = @($State.Realism.ByDept['IT Support'])

    # Who gets what, where. Managed identities and pipelines hold Azure access
    # too — usually more of it than the people do.
    $grants = @(
        @{ Key = 'own-sub';    Role = 'Owner';        Scope = 'sub';        People = 1; Svc = @('RSVC-5') }
        @{ Key = 'read-sub';   Role = 'Reader';       Scope = 'sub';        People = 6; Svc = @('RSVC-4') }
        @{ Key = 'con-prod';   Role = 'Contributor';  Scope = 'rg-prod-nl'; People = 3; Svc = @('RSVC-5', 'RMI-1') }
        @{ Key = 'con-test';   Role = 'Contributor';  Scope = 'rg-test-nl'; People = 8; Svc = @() }
        @{ Key = 'blob-data';  Role = 'Storage Blob Data Contributor'; Scope = 'rg-data'; People = 2; Svc = @('RMI-2') }
        @{ Key = 'kv-shared';  Role = 'Key Vault Secrets User';        Scope = 'rg-shared'; People = 2; Svc = @('RSVC-1', 'RSVC-6') }
        @{ Key = 'con-sqlprod'; Role = 'Contributor'; Scope = 'sql-prod';   People = 1; Svc = @() }
    )

    foreach ($grant in $grants) {
        $capId = Add-DemoResource $State -Id (New-DemoGuid "res-realism-az-cap-$($grant.Key)") `
            -DisplayName "$($grant.Role) @ $($grant.Scope)" -ResourceType 'AzureRoleAssignment' -SystemId $sysAz `
            -Extended @{ roleName = $grant.Role; targetNodeId = $ScopeIds[$grant.Scope]; isCustom = $false; plane = 'control' }
        Add-DemoRelationship $State -ParentResourceId $ScopeIds[$grant.Scope] -ChildResourceId $capId -RelationshipType 'GrantsAccessTo'

        $holders = [System.Collections.Generic.List[string]]::new()
        $pool = if ($grant.Role -eq 'Contributor') { $engineers } else { $itPeople }
        for ($n = 0; $n -lt $grant.People; $n++) {
            $person = $pool[(Get-DemoIndex -Seed "azwho-$($grant.Key)-$n" -Modulo $pool.Count)]
            $holders.Add((Get-DemoPrincipalId $person.id))
        }
        foreach ($svc in $grant.Svc) { $holders.Add($State.Realism.NonHuman[$svc]) }

        foreach ($holder in ($holders | Sort-Object -Unique)) {
            Add-DemoAssignment $State -ResourceId $capId -PrincipalId $holder -AssignmentType 'Direct'
        }

        # Inheritance: the same people hold the role on everything under the
        # scope it was granted on, and that is an Indirect assignment.
        foreach ($childKey in (Get-DemoRealismDescendants -ChildrenOf $ChildrenOf -Key $grant.Scope)) {
            $childCap = Add-DemoResource $State -Id (New-DemoGuid "res-realism-az-cap-$($grant.Key)-$childKey") `
                -DisplayName "$($grant.Role) @ $childKey" -ResourceType 'AzureRoleAssignment' -SystemId $sysAz `
                -Extended @{ roleName = $grant.Role; targetNodeId = $ScopeIds[$childKey]; isCustom = $false
                             plane = 'control'; inheritedFrom = $grant.Scope }
            Add-DemoRelationship $State -ParentResourceId $ScopeIds[$childKey] -ChildResourceId $childCap -RelationshipType 'GrantsAccessTo'
            foreach ($holder in ($holders | Sort-Object -Unique)) {
                Add-DemoAssignment $State -ResourceId $childCap -PrincipalId $holder -AssignmentType 'Indirect'
            }
        }
    }
}

# Every scope below this one, breadth-first.
function Get-DemoRealismDescendants {
    param(
        [Parameter(Mandatory)][hashtable]$ChildrenOf,
        [Parameter(Mandatory)][string]$Key
    )
    $out = [System.Collections.Generic.List[string]]::new()
    $queue = [System.Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($Key)
    while ($queue.Count) {
        $current = $queue.Dequeue()
        if (-not $ChildrenOf.ContainsKey($current)) { continue }
        foreach ($child in $ChildrenOf[$current]) { $out.Add($child); $queue.Enqueue($child) }
    }
    return $out
}

<#
.SYNOPSIS
    The on-premises AD groups, held by the AD accounts.
.DESCRIPTION
    Held by the AD ACCOUNT, not the Entra one — which is the point of account
    correlation: "what does this person have" has to add up two accounts in two
    systems. A few of these groups are named after a merger and an application
    that were retired years ago, and people still hold them.
#>
function Add-DemoRealismAdGroups {
    param([Parameter(Mandatory)]$State)

    $sysAd = $State.Realism.Systems.ad
    $adAccounts = @($State.Principals | Where-Object { $_.systemId -eq $sysAd })
    if ($adAccounts.Count -eq 0) { return }

    foreach ($name in $script:RealismAdGroups) {
        $id = Add-DemoResource $State -Id (New-DemoGuid "res-realism-ad-$name") `
            -DisplayName $name -ResourceType 'Group' -SystemId $sysAd `
            -Description "On-premises AD groep $name" `
            -Extended @{ securityEnabled = $true; mailEnabled = $false; onPremisesGroup = $true }

        $share = if ($name -like '*Algemeen*') { 90 } elseif ($name -like 'G-Oud-*' -or $name -like '*2012*') { 20 } else { 35 }
        foreach ($account in $adAccounts) {
            if ((Get-DemoIndex -Seed "ad-$name-$($account.id)" -Modulo 100) -lt $share) {
                Add-DemoAssignment $State -ResourceId $id -PrincipalId $account.id -AssignmentType 'Direct'
            }
        }
    }
}

# CRM roles, held by the CRM accounts. Same story, smaller system: access that a
# question about a person only finds by way of their second account.
function Add-DemoRealismCrmRoles {
    param([Parameter(Mandatory)]$State)

    $sysCrm = $State.Realism.Systems.crm
    $crmAccounts = @($State.Principals | Where-Object { $_.systemId -eq $sysCrm })
    if ($crmAccounts.Count -eq 0) { return }

    foreach ($role in $script:RealismCrmRoles) {
        $id = Add-DemoResource $State -Id (New-DemoGuid "res-realism-crm-$role") `
            -DisplayName $role -ResourceType 'CRMRole' -SystemId $sysCrm -Description "Rol in het CRM: $role"
        $share = if ($role -eq 'CRM-Beheerder') { 8 } elseif ($role -eq 'CRM-Alleen-Lezen') { 40 } else { 30 }
        foreach ($account in $crmAccounts) {
            if ((Get-DemoIndex -Seed "crm-$role-$($account.id)" -Modulo 100) -lt $share) {
                Add-DemoAssignment $State -ResourceId $id -PrincipalId $account.id -AssignmentType 'Direct'
            }
        }
    }
}
