<#
.SYNOPSIS
    Fortigi Demo Corp — the realism slice: the group catalogue.

.DESCRIPTION
    Part of the opt-in realism slice (Generate-DemoDataset.ps1 -IncludeRealism).
    This file creates the GROUPS and who owns them; DemoRealismAccess.ps1 decides
    who is in them.

    A real tenant's group list is not a tidy list of security groups. It is
    families of them, grown over years by different people for different reasons,
    and the questions an analyst asks are mostly about the mess:

      * NAMING FAMILIES — 'License-*', 'SG-<dept>-*', 'PRJ-*', 'APP-*', 'DL-*',
        'TEAM-*'. "Groups whose name starts with License" is only a real question
        when a family exists, and it is only a DISCRIMINATING question when two
        groups mention licences in their DESCRIPTION but not their name (the
        model likes to filter on both and one group then differs).
      * KINDS — security groups, mail-enabled distribution lists, and Microsoft
        365 / Teams groups. Without the securityEnabled / mailEnabled flags,
        "mail enabled groups that are not security groups" returns nothing
        however right the pipeline is. The standard slice sets neither.
      * PROJECTS THAT ENDED. Ten of the 24 project groups are finished, years
        ago in some cases, and every member still holds them. That is the single
        most common finding in a real access review.
      * SIZES — from empty groups nobody cleaned up, through a handful of
        members, to one group with every employee in it.
      * OWNERS — about a quarter of the groups have one. "Groups without an
        owner that have more than five members" is a question with a long answer
        here, which is the point.
      * NESTING, the AD kind: a group inside a group. The data model has no
        group-to-group edge — a member is a Principal — so nesting is recorded
        the way the Entra crawler records it: every member of the child group
        also holds the parent, as an INDIRECT assignment (see
        reference_matrix_inheritance_materialized). DemoRealismAccess.ps1 writes
        those; this file records which group nests in which so the pattern is one
        decision in one place.

    DETERMINISTIC: every id comes from New-DemoGuid, every choice from
    Get-DemoIndex.
#>

Set-StrictMode -Version Latest

# Licences a company of this size really does track by group membership. The
# number is the rough share of staff who hold it (per cent), used by the access
# part; the whole family is what makes "starts with License" answerable.
$script:RealismLicenses = @(
    @{ Key = 'lic-m365-e3';    Name = 'License-M365-E3';        Share = 62; Desc = 'Microsoft 365 E3 licence assignment' }
    @{ Key = 'lic-m365-e5';    Name = 'License-M365-E5';        Share = 20; Desc = 'Microsoft 365 E5 licence assignment' }
    @{ Key = 'lic-visio';      Name = 'License-Visio';          Share = 10; Desc = '' }
    @{ Key = 'lic-project';    Name = 'License-Project';        Share = 8;  Desc = 'Project Online licence' }
    @{ Key = 'lic-powerbi';    Name = 'License-PowerBI-Pro';    Share = 15; Desc = 'Power BI Pro licence' }
    @{ Key = 'lic-adobe';      Name = 'License-Adobe-CC';       Share = 6;  Desc = 'Adobe Creative Cloud' }
    @{ Key = 'lic-autodesk';   Name = 'License-Autodesk';       Share = 3;  Desc = '' }
    @{ Key = 'lic-teamsphone'; Name = 'License-Teams-Phone';    Share = 25; Desc = 'Teams telefonie' }
)

# The two groups that mention a licence only in their DESCRIPTION. A definition
# that filters name AND description finds neither; one that filters the name
# finds the eight above. That one-group difference is what made this worth
# building — it is the held-out set's standing miss.
$script:RealismLicenseLookalikes = @(
    @{ Key = 'look-office';  Name = 'SG-Office-Toewijzing'; Desc = 'License assignment for Office, managed by IT Support' }
    @{ Key = 'look-devtool'; Name = 'SG-Dev-Tooling';       Desc = 'Developer tooling licenses (JetBrains, Docker)' }
)

# Applications the company runs. Each gets a user and an administrator group —
# the commonest access pattern there is, and the reason "who administers X" is
# asked far more often than "who uses X".
$script:RealismApps = @(
    @{ Key = 'crm';    Name = 'CRM';             Dept = 'Sales' }
    @{ Key = 'erp';    Name = 'ERP';             Dept = 'Finance' }
    @{ Key = 'salaris'; Name = 'Salarisadministratie'; Dept = 'HR' }
    @{ Key = 'tijd';   Name = 'Tijdregistratie'; Dept = 'Operations' }
    @{ Key = 'docs';   Name = 'Documentbeheer';  Dept = 'Legal' }
    @{ Key = 'sd';     Name = 'Servicedesk';     Dept = 'Customer Service' }
    @{ Key = 'bi';     Name = 'BI-Platform';     Dept = 'Finance' }
    @{ Key = 'webshop'; Name = 'Webshop';        Dept = 'Marketing' }
    @{ Key = 'plan';   Name = 'Planning';        Dept = 'Operations' }
    @{ Key = 'fact';   Name = 'Facturatie';      Dept = 'Finance' }
    @{ Key = 'intra';  Name = 'Intranet';        Dept = 'Marketing' }
    @{ Key = 'mon';    Name = 'Monitoring';      Dept = 'IT Support' }
)

# Projects, ten of them finished. `Ended` is how many days ago the project
# closed; the access part leaves every member in place regardless.
$script:RealismProjects = @(
    @{ Key = 'zonnedak';   Name = 'Zonnedak';       Dept = 'Operations';       Ended = $null }
    @{ Key = 'kustlijn';   Name = 'Kustlijn';       Dept = 'Engineering';      Ended = $null }
    @{ Key = 'meridiaan';  Name = 'Meridiaan';      Dept = 'Sales';            Ended = $null }
    @{ Key = 'hoogtij';    Name = 'Hoogtij';        Dept = 'Finance';          Ended = $null }
    @{ Key = 'nachtwacht'; Name = 'Nachtwacht';     Dept = 'IT Support';       Ended = $null }
    @{ Key = 'zandloper';  Name = 'Zandloper';      Dept = 'Customer Service'; Ended = $null }
    @{ Key = 'windkracht'; Name = 'Windkracht';     Dept = 'Engineering';      Ended = $null }
    @{ Key = 'vuurtoren';  Name = 'Vuurtoren';      Dept = 'Marketing';        Ended = $null }
    @{ Key = 'polder';     Name = 'Polder';         Dept = 'Legal';            Ended = $null }
    @{ Key = 'zeewind';    Name = 'Zeewind';        Dept = 'HR';               Ended = $null }
    @{ Key = 'brugpijler'; Name = 'Brugpijler';     Dept = 'Engineering';      Ended = $null }
    @{ Key = 'schutsluis'; Name = 'Schutsluis';     Dept = 'Operations';       Ended = $null }
    @{ Key = 'ijsvogel';   Name = 'IJsvogel';       Dept = 'Engineering';      Ended = 420 }
    @{ Key = 'roodborst';  Name = 'Roodborst';      Dept = 'Sales';            Ended = 700 }
    @{ Key = 'notenkraker'; Name = 'Notenkraker';   Dept = 'Finance';          Ended = 300 }
    @{ Key = 'zilvermeeuw'; Name = 'Zilvermeeuw';   Dept = 'Operations';       Ended = 900 }
    @{ Key = 'steenuil';   Name = 'Steenuil';       Dept = 'IT Support';       Ended = 260 }
    @{ Key = 'lijsterbes'; Name = 'Lijsterbes';     Dept = 'Marketing';        Ended = 1100 }
    @{ Key = 'esdoorn';    Name = 'Esdoorn';        Dept = 'Legal';            Ended = 520 }
    @{ Key = 'hazelaar';   Name = 'Hazelaar';       Dept = 'HR';               Ended = 380 }
    @{ Key = 'wilgentak';  Name = 'Wilgentak';      Dept = 'Customer Service'; Ended = 640 }
    @{ Key = 'berkenbos';  Name = 'Berkenbos';      Dept = 'Facilities';       Ended = 480 }
    @{ Key = 'duinroos';   Name = 'Duinroos';       Dept = 'Sales';            Ended = $null }
    @{ Key = 'zeearend';   Name = 'Zeearend';       Dept = 'Engineering';      Ended = $null }
)

# Mail-enabled, NOT security-enabled: the distribution lists every organisation
# has and nobody governs.
$script:RealismDistributionLists = @(
    'Alle-Medewerkers', 'Nieuws', 'Directie', 'Managers', 'Sociaal-Comite',
    'BHV', 'Ondernemingsraad', 'Stagiairs'
)

# Microsoft 365 / Teams groups: mail-enabled, unified, and the place external
# guests are actually invited.
$script:RealismTeamGroups = @(
    'Team-Klantcontact', 'Team-Productontwikkeling', 'Team-Tenderbureau',
    'Team-Onboarding', 'Team-Security', 'Team-Datakwaliteit',
    'Team-Partners-Noordzee', 'Team-Partners-Meridian', 'Team-Jaarafsluiting', 'Team-Innovatie'
)

# Groups with nothing in them. Empty because the project ended, the team was
# renamed, or somebody made them twice — never because a generator needed a case.
$script:RealismEmptyGroups = @(
    @{ Name = 'SG-Oud-Projectbeheer';  Desc = 'Voormalig projectbeheer, leeg sinds reorganisatie' }
    @{ Name = 'SG-Tijdelijk-Migratie'; Desc = 'Tijdelijke groep migratie 2023' }
    @{ Name = 'SG-Test-Groep';         Desc = '' }
    @{ Name = 'SG-Finance-Oud';        Desc = 'Vervangen door SG-Finance-Alle' }
    @{ Name = 'SG-Reserve';            Desc = '' }
    @{ Name = 'SG-Archief-2022';       Desc = 'Archief, niet verwijderen' }
)

# ── The catalogue ─────────────────────────────────────────────────────────────

function Add-DemoRealismGroups {
    param([Parameter(Mandatory)]$State)

    $State.Realism['Groups'] = [ordered]@{}
    $State.Realism['Nesting'] = [System.Collections.Generic.List[object]]::new()

    Add-DemoRealismSecurityGroups     $State
    Add-DemoRealismLicenseGroups      $State
    Add-DemoRealismApplicationGroups  $State
    Add-DemoRealismProjectGroups      $State
    Add-DemoRealismMailGroups         $State
    Add-DemoRealismNesting            $State
    Add-DemoRealismGroupOwners        $State
}

<#
.SYNOPSIS
    One group, registered so the access part can find it by key.
.PARAMETER Family
    What kind of group this is ('license', 'dept', 'team', 'app', 'project',
    'dl', 'm365', 'empty', 'baseline'). The access part keys its membership
    rules off this, and the tests assert per family.
#>
function Add-DemoRealismGroup {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Family,
        [string]$Description = '',
        [string]$Dept,
        [string]$Team,
        [switch]$MailEnabled,
        [switch]$Unified,
        [hashtable]$Extra
    )
    $ext = [ordered]@{
        securityEnabled = (-not $MailEnabled)
        mailEnabled     = [bool]$MailEnabled
    }
    if ($Unified) { $ext['groupTypes'] = 'Unified' }
    if ($Extra) { foreach ($k in $Extra.Keys) { $ext[$k] = $Extra[$k] } }

    $id = Add-DemoResource $State `
        -Id (New-DemoGuid "res-realism-group-$Key") `
        -DisplayName $Name -ResourceType 'Group' -SystemId $State.SystemIds['entra'] `
        -Description $Description -Extended $ext

    $State.Realism.Groups[$Key] = [ordered]@{
        id = $id; name = $Name; family = $Family; dept = $Dept; team = $Team
    }
    return $id
}

# Everyone, the departments, the teams. The team groups are the role-mining
# signal: people on one team hold the same things whatever their job title says.
function Add-DemoRealismSecurityGroups {
    param([Parameter(Mandatory)]$State)

    $null = Add-DemoRealismGroup $State -Key 'all-staff' -Name 'SG-Alle-Medewerkers' -Family 'baseline' `
        -Description 'Iedere medewerker, automatisch gevuld vanuit HR'

    foreach ($dept in $script:RealismDepartments) {
        $slug = ($dept.Name -replace '\s+', '-')
        $null = Add-DemoRealismGroup $State -Key "dept-$slug" -Name "SG-$slug-Alle" -Family 'dept' `
            -Description "Alle medewerkers van $($dept.Name)" -Dept $dept.Name
        $null = Add-DemoRealismGroup $State -Key "deptmgr-$slug" -Name "SG-$slug-Managers" -Family 'dept' `
            -Description "Leidinggevenden $($dept.Name)" -Dept $dept.Name
    }
    foreach ($team in $State.Realism.ByTeam.Keys) {
        $slug = ($team -replace '[^\p{L}\p{N}]+', '-')
        $null = Add-DemoRealismGroup $State -Key "team-$slug" -Name "SG-$slug-Werkmap" -Family 'team' `
            -Description "Gedeelde werkmap $team" -Dept $State.Realism.ByTeam[$team][0].dept -Team $team
    }
    foreach ($empty in $script:RealismEmptyGroups) {
        $null = Add-DemoRealismGroup $State -Key "empty-$($empty.Name)" -Name $empty.Name -Family 'empty' `
            -Description $empty.Desc
    }
}

function Add-DemoRealismLicenseGroups {
    param([Parameter(Mandatory)]$State)

    foreach ($lic in $script:RealismLicenses) {
        $null = Add-DemoRealismGroup $State -Key $lic.Key -Name $lic.Name -Family 'license' `
            -Description $lic.Desc -Extra @{ licenseShare = $lic.Share }
    }
    foreach ($look in $script:RealismLicenseLookalikes) {
        $null = Add-DemoRealismGroup $State -Key $look.Key -Name $look.Name -Family 'lookalike' `
            -Description $look.Desc
    }
}

function Add-DemoRealismApplicationGroups {
    param([Parameter(Mandatory)]$State)

    foreach ($app in $script:RealismApps) {
        $null = Add-DemoRealismGroup $State -Key "app-$($app.Key)-users" -Name "APP-$($app.Name)-Gebruikers" `
            -Family 'app' -Description "Gebruikers van $($app.Name)" -Dept $app.Dept
        $null = Add-DemoRealismGroup $State -Key "app-$($app.Key)-admins" -Name "APP-$($app.Name)-Beheerders" `
            -Family 'app-admin' -Description "Functioneel beheer $($app.Name)" -Dept $app.Dept
    }
}

function Add-DemoRealismProjectGroups {
    param([Parameter(Mandatory)]$State)

    foreach ($prj in $script:RealismProjects) {
        $extra = [ordered]@{}
        $desc = "Projectgroep $($prj.Name)"
        if ($prj.Ended) {
            $extra['projectStatus'] = 'Afgerond'
            $extra['projectEndDate'] = $State.Realism.MeasuredAt.AddDays(-1 * $prj.Ended).ToString('yyyy-MM-dd')
            $desc = "Projectgroep $($prj.Name) — afgerond, toegang nooit opgeruimd"
        }
        else { $extra['projectStatus'] = 'Actief' }

        $null = Add-DemoRealismGroup $State -Key "prj-$($prj.Key)" -Name "PRJ-$($prj.Name)" -Family 'project' `
            -Description $desc -Dept $prj.Dept -Extra $extra
    }
}

function Add-DemoRealismMailGroups {
    param([Parameter(Mandatory)]$State)

    foreach ($dl in $script:RealismDistributionLists) {
        $null = Add-DemoRealismGroup $State -Key "dl-$dl" -Name "DL-$dl" -Family 'dl' `
            -Description "Verzendlijst $dl" -MailEnabled
    }
    foreach ($team in $script:RealismTeamGroups) {
        $null = Add-DemoRealismGroup $State -Key "m365-$team" -Name $team -Family 'm365' `
            -Description "Microsoft 365 groep $team" -MailEnabled -Unified
    }
}

<#
.SYNOPSIS
    Which group sits inside which — the AD kind of nesting.
.DESCRIPTION
    Two shapes, both of which a real tenant has:
      * each department group contains its team groups (so a department group has
        members it was never directly given), and
      * two umbrella groups contain licence groups, which is how "everyone with
        any Microsoft 365 licence" gets built by hand.
    Recorded here, materialised as Indirect assignments by the access part.
#>
function Add-DemoRealismNesting {
    param([Parameter(Mandatory)]$State)

    foreach ($team in $State.Realism.ByTeam.Keys) {
        $dept = $State.Realism.ByTeam[$team][0].dept
        $parentKey = "dept-$($dept -replace '\s+', '-')"
        $childKey = "team-$($team -replace '[^\p{L}\p{N}]+', '-')"
        $State.Realism.Nesting.Add(@{ Parent = $parentKey; Child = $childKey })
    }

    $null = Add-DemoRealismGroup $State -Key 'umbrella-m365' -Name 'SG-Alle-M365-Licenties' -Family 'umbrella' `
        -Description 'Verzamelgroep: alle Microsoft 365 licenties (genest)'
    $null = Add-DemoRealismGroup $State -Key 'umbrella-design' -Name 'SG-Alle-Ontwerplicenties' -Family 'umbrella' `
        -Description 'Verzamelgroep: Visio, Adobe, Autodesk (genest)'
    foreach ($child in @('lic-m365-e3', 'lic-m365-e5')) {
        $State.Realism.Nesting.Add(@{ Parent = 'umbrella-m365'; Child = $child })
    }
    foreach ($child in @('lic-visio', 'lic-adobe', 'lic-autodesk')) {
        $State.Realism.Nesting.Add(@{ Parent = 'umbrella-design'; Child = $child })
    }
}

<#
.SYNOPSIS
    Owners for about a quarter of the groups.
.DESCRIPTION
    v5 models ownership as a Direct assignment on a synthetic GroupOwnership
    resource linked to the group by HasOwnership — never an 'Owner' assignment
    type (see DemoEntraBase.ps1 and the guard test on assignment types).

    Who owns what is deliberately uneven: application and project groups usually
    have an owner, licence and department groups usually do not, and the biggest
    group in the company has none at all. That is what makes "groups without an
    owner that have more than five members" worth asking.
#>
function Add-DemoRealismGroupOwners {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $people = @($State.Realism.People)

    foreach ($key in @($State.Realism.Groups.Keys)) {
        $group = $State.Realism.Groups[$key]
        # Application, project and Microsoft 365 groups mostly have an owner;
        # everything else rarely does.
        $likelihood = switch ($group.family) {
            'app' { 70 } 'app-admin' { 85 } 'project' { 60 } 'm365' { 80 }
            'team' { 25 } 'dept' { 15 } 'license' { 10 } default { 5 }
        }
        if ((Get-DemoIndex -Seed "owner-$key" -Modulo 100) -ge $likelihood) { continue }

        $ownId = New-DemoGuid "res-realism-ownership-$key"
        $null = Add-DemoResource $State -Id $ownId -DisplayName $group.name -ResourceType 'GroupOwnership' `
            -SystemId $sysEntra -Extended @{ ownedResourceId = $group.id }
        Add-DemoRelationship $State -ParentResourceId $group.id -ChildResourceId $ownId -RelationshipType 'HasOwnership'

        # One owner, and a second for one group in four — co-ownership is normal
        # and it makes the owner count something other than always one.
        $ownerCount = if ((Get-DemoIndex -Seed "coowner-$key" -Modulo 4) -eq 0) { 2 } else { 1 }
        for ($n = 0; $n -lt $ownerCount; $n++) {
            $candidate = $people[(Get-DemoIndex -Seed "ownerwho-$key-$n" -Modulo $people.Count)]
            Add-DemoAssignment $State -ResourceId $ownId -PrincipalId (Get-DemoPrincipalId $candidate.id) `
                -AssignmentType 'Direct' -ResourceType 'GroupOwnership'
        }
    }
}
