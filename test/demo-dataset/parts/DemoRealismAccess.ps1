<#
.SYNOPSIS
    Fortigi Demo Corp — the realism slice: who holds which group, and why.

.DESCRIPTION
    Part of the opt-in realism slice (Generate-DemoDataset.ps1 -IncludeRealism).
    DemoRealismGroups.ps1 created the groups; this file fills them, and the shape
    of the filling is the whole point. Access in a real directory is not a
    function of the job title on someone's HR record:

      * TEAM BEATS TITLE. Everyone on a team holds the team's groups and most of
        its applications, whatever their title says. Two people with the same
        generic title ('Medewerker') on different teams therefore hold very
        different things — and two people with different titles on ONE team look
        almost identical. That is the signal role mining is supposed to find and
        the trap a report that trusts jobTitle falls into.
      * NOT QUITE CLEAN. One member of a team in five holds a few extra things
        nobody else on the team has: a project they were lent to, an application
        they administer. Perfect clusters would make role mining trivial.
      * CAREERS LEAVE RESIDUE. Everyone who changed department keeps one to three
        groups of the department they left. Their account says Finance and their
        access says Engineering, which is exactly the finding an access review is
        for — and it is invisible on a dataset where nobody ever moved.
      * PROJECTS OUTLIVE THEMSELVES. The ten finished projects keep every member
        they ever had.
      * LEAVERS. Half the disabled accounts still hold everything they held on
        their last day.
      * NESTING. Every member of a nested child group also holds the parent, as
        an Indirect assignment — the way the Entra crawler records a group inside
        a group (reference_matrix_inheritance_materialized).

    Nothing here is random: every choice is Get-DemoIndex of a stable seed.
#>

Set-StrictMode -Version Latest

# The three accounts that accumulate everything: an IT Support lead who never
# hands anything back, and two long-serving engineers. Every tenant has them, and
# "who is in more than fifty groups" is the question that finds them.
$script:RealismPowerUserCount = 3

function Add-DemoRealismAccess {
    param([Parameter(Mandatory)]$State)

    # Every (resource, principal) pair written so far, so nothing is granted
    # twice: the database keys memberships on exactly that pair.
    $State.Realism['Held'] = [System.Collections.Generic.HashSet[string]]::new()
    # groupKey -> the principals in it, needed to nest one group inside another.
    $State.Realism['GroupMembers'] = @{}

    Add-DemoRealismBaselineAccess   $State
    Add-DemoRealismDepartmentAccess $State
    Add-DemoRealismLicenseAccess    $State
    Add-DemoRealismAppAccess        $State
    Add-DemoRealismProjectAccess    $State
    Add-DemoRealismMailAccess       $State
    Add-DemoRealismLegacyAccess     $State
    Add-DemoRealismPowerUsers       $State
    Add-DemoRealismLeaverAccess     $State
    Add-DemoRealismGuestAccess      $State
    # Last: nesting reads the memberships every rule above produced.
    Add-DemoRealismNestedAccess     $State
}

<#
.SYNOPSIS
    One membership, deduplicated and recorded.
.DESCRIPTION
    Returns $true when it was written, $false when that person already held the
    group — which the nesting pass needs to know, so a direct member is not also
    given an indirect claim on the same group.
#>
function Add-DemoRealismMember {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$GroupKey,
        [Parameter(Mandatory)][string]$PrincipalId,
        [ValidateSet('Direct', 'Indirect', 'Eligible')][string]$AssignmentType = 'Direct'
    )
    $group = $State.Realism.Groups[$GroupKey]
    if (-not $group) { throw "Add-DemoRealismMember: no such group key '$GroupKey'" }
    if (-not $State.Realism.Held.Add("$($group.id)|$PrincipalId")) { return $false }

    Add-DemoAssignment $State -ResourceId $group.id -PrincipalId $PrincipalId -AssignmentType $AssignmentType
    if (-not $State.Realism.GroupMembers.ContainsKey($GroupKey)) {
        $State.Realism.GroupMembers[$GroupKey] = [System.Collections.Generic.List[string]]::new()
    }
    $State.Realism.GroupMembers[$GroupKey].Add($PrincipalId)
    return $true
}

# Convenience: the principal id of a roster person.
function Get-DemoRealismPrincipal {
    param([Parameter(Mandatory)]$Person)
    return (Get-DemoPrincipalId $Person.id)
}

# Everyone, in the one group that really does hold everyone.
function Add-DemoRealismBaselineAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($person in $State.Realism.People) {
        $null = Add-DemoRealismMember $State -GroupKey 'all-staff' -PrincipalId (Get-DemoRealismPrincipal $person)
        $null = Add-DemoRealismMember $State -GroupKey 'dl-Alle-Medewerkers' -PrincipalId (Get-DemoRealismPrincipal $person)
    }
}

# Department, managers, and the team working folder: the access that does follow
# the org chart.
function Add-DemoRealismDepartmentAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($person in $State.Realism.People) {
        $principal = Get-DemoRealismPrincipal $person
        $deptKey = "dept-$($person.dept -replace '\s+', '-')"
        $teamKey = "team-$($person.team -replace '[^\p{L}\p{N}]+', '-')"
        $null = Add-DemoRealismMember $State -GroupKey $deptKey -PrincipalId $principal
        $null = Add-DemoRealismMember $State -GroupKey $teamKey -PrincipalId $principal
        if ($person.level -in @('head', 'lead')) {
            $null = Add-DemoRealismMember $State -GroupKey "deptmgr-$($person.dept -replace '\s+', '-')" -PrincipalId $principal
            $null = Add-DemoRealismMember $State -GroupKey 'dl-Managers' -PrincipalId $principal
        }
    }
}

# Licences by share of staff, plus the two look-alike groups whose names say
# nothing about licences.
function Add-DemoRealismLicenseAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($lic in $script:RealismLicenses) {
        foreach ($person in $State.Realism.People) {
            if ((Get-DemoIndex -Seed "$($lic.Key)-$($person.id)" -Modulo 100) -lt $lic.Share) {
                $null = Add-DemoRealismMember $State -GroupKey $lic.Key -PrincipalId (Get-DemoRealismPrincipal $person)
            }
        }
    }
    foreach ($look in $script:RealismLicenseLookalikes) {
        foreach ($person in $State.Realism.People) {
            if ((Get-DemoIndex -Seed "$($look.Key)-$($person.id)" -Modulo 100) -lt 12) {
                $null = Add-DemoRealismMember $State -GroupKey $look.Key -PrincipalId (Get-DemoRealismPrincipal $person)
            }
        }
    }
}

<#
.SYNOPSIS
    Application access: mostly the owning department, partly not.
.DESCRIPTION
    Users: four in five of the application's own department, plus roughly one in
    eight of everybody else — the colleagues who needed it once and kept it.
    Administrators: a handful, mostly IT Support, plus one or two from the
    department that owns the application. Neither set can be derived from a job
    title, which is the reason to build it this way.
#>
function Add-DemoRealismAppAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($app in $script:RealismApps) {
        foreach ($person in $State.Realism.People) {
            $own = ($person.dept -eq $app.Dept)
            $threshold = if ($own) { 80 } else { 12 }
            if ((Get-DemoIndex -Seed "app-$($app.Key)-$($person.id)" -Modulo 100) -lt $threshold) {
                $null = Add-DemoRealismMember $State -GroupKey "app-$($app.Key)-users" -PrincipalId (Get-DemoRealismPrincipal $person)
            }
        }
        $itPeople = @($State.Realism.ByDept['IT Support'])
        $ownPeople = @($State.Realism.ByDept[$app.Dept])
        $admins = @(
            $itPeople[(Get-DemoIndex -Seed "admin1-$($app.Key)" -Modulo $itPeople.Count)]
            $itPeople[(Get-DemoIndex -Seed "admin2-$($app.Key)" -Modulo $itPeople.Count)]
            $ownPeople[(Get-DemoIndex -Seed "admin3-$($app.Key)" -Modulo $ownPeople.Count)]
        )
        foreach ($admin in $admins) {
            $null = Add-DemoRealismMember $State -GroupKey "app-$($app.Key)-admins" -PrincipalId (Get-DemoRealismPrincipal $admin)
            # An administrator is nearly always a user of the thing as well.
            $null = Add-DemoRealismMember $State -GroupKey "app-$($app.Key)-users" -PrincipalId (Get-DemoRealismPrincipal $admin)
        }
    }
}

<#
.SYNOPSIS
    Project groups, including the ten that ended.
.DESCRIPTION
    Four to fourteen members: mostly the project's own department, a couple from
    elsewhere — the way a project team is really staffed. Finished projects are
    filled exactly the same way and never emptied, so "who still has access to a
    project that ended two years ago" has an answer.
#>
function Add-DemoRealismProjectAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($prj in $script:RealismProjects) {
        $homeDept = @($State.Realism.ByDept[$prj.Dept])
        $all = @($State.Realism.People)
        $size = 4 + (Get-DemoIndex -Seed "prjsize-$($prj.Key)" -Modulo 11)

        for ($n = 0; $n -lt $size; $n++) {
            $fromHome = ((Get-DemoIndex -Seed "prjfrom-$($prj.Key)-$n" -Modulo 100) -lt 75)
            $pool = if ($fromHome) { $homeDept } else { $all }
            $person = $pool[(Get-DemoIndex -Seed "prjwho-$($prj.Key)-$n" -Modulo $pool.Count)]
            $null = Add-DemoRealismMember $State -GroupKey "prj-$($prj.Key)" -PrincipalId (Get-DemoRealismPrincipal $person)
        }
    }
}

# Distribution lists and Microsoft 365 groups. The lists follow the organisation;
# the Microsoft 365 groups are cross-department by nature, which is why they are
# where guests end up (Add-DemoRealismGuestAccess).
function Add-DemoRealismMailAccess {
    param([Parameter(Mandatory)]$State)

    $people = @($State.Realism.People)
    foreach ($dl in $script:RealismDistributionLists) {
        if ($dl -in @('Alle-Medewerkers', 'Managers')) { continue }   # filled elsewhere
        $size = 8 + (Get-DemoIndex -Seed "dlsize-$dl" -Modulo 40)
        for ($n = 0; $n -lt $size; $n++) {
            $person = $people[(Get-DemoIndex -Seed "dlwho-$dl-$n" -Modulo $people.Count)]
            $null = Add-DemoRealismMember $State -GroupKey "dl-$dl" -PrincipalId (Get-DemoRealismPrincipal $person)
        }
    }
    foreach ($team in $script:RealismTeamGroups) {
        $size = 6 + (Get-DemoIndex -Seed "m365size-$team" -Modulo 20)
        for ($n = 0; $n -lt $size; $n++) {
            $person = $people[(Get-DemoIndex -Seed "m365who-$team-$n" -Modulo $people.Count)]
            $null = Add-DemoRealismMember $State -GroupKey "m365-$team" -PrincipalId (Get-DemoRealismPrincipal $person)
        }
    }
}

<#
.SYNOPSIS
    The access people keep from a department they left, and the odd extra thing
    one person on a team has and their colleagues do not.
.DESCRIPTION
    Two kinds of untidiness, both deliberate:
      * everyone with a `previousDepartment` keeps one to three of that
        department's groups — the account says one thing, the access says another;
      * one member of a team in five holds one or two applications or projects
        nobody else on their team holds, so the clusters are not perfect.
#>
function Add-DemoRealismLegacyAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($person in $State.Realism.People) {
        $principal = Get-DemoRealismPrincipal $person

        if ($person.prevDept) {
            $slug = ($person.prevDept -replace '\s+', '-')
            $keep = 1 + (Get-DemoIndex -Seed "keep-$($person.id)" -Modulo 3)
            $candidates = @("dept-$slug")
            $candidates += @($script:RealismApps | Where-Object { $_.Dept -eq $person.prevDept } | ForEach-Object { "app-$($_.Key)-users" })
            $candidates += @($script:RealismProjects | Where-Object { $_.Dept -eq $person.prevDept } | ForEach-Object { "prj-$($_.Key)" })
            for ($n = 0; $n -lt [Math]::Min($keep, $candidates.Count); $n++) {
                $null = Add-DemoRealismMember $State -GroupKey $candidates[(Get-DemoIndex -Seed "keepwhich-$($person.id)-$n" -Modulo $candidates.Count)] -PrincipalId $principal
            }
        }

        if ((Get-DemoIndex -Seed "odd-$($person.id)" -Modulo 100) -lt 20) {
            $extra = 1 + (Get-DemoIndex -Seed "oddcount-$($person.id)" -Modulo 2)
            for ($n = 0; $n -lt $extra; $n++) {
                $app = $script:RealismApps[(Get-DemoIndex -Seed "oddapp-$($person.id)-$n" -Modulo $script:RealismApps.Count)]
                $null = Add-DemoRealismMember $State -GroupKey "app-$($app.Key)-users" -PrincipalId $principal
            }
        }
    }
}

<#
.SYNOPSIS
    The three accounts that hold far too much.
.DESCRIPTION
    Every application administrator group, every licence, and most projects.
    They are picked from IT Support and Engineering because that is where they
    really are, and they are the answer to "who is in more than fifty groups".
#>
function Add-DemoRealismPowerUsers {
    param([Parameter(Mandatory)]$State)

    $candidates = @($State.Realism.ByDept['IT Support'][0], $State.Realism.ByDept['IT Support'][1], $State.Realism.ByDept['Engineering'][1])
    $State.Realism['PowerUsers'] = [System.Collections.Generic.List[object]]::new()

    foreach ($person in $candidates[0..($script:RealismPowerUserCount - 1)]) {
        $principal = Get-DemoRealismPrincipal $person
        $State.Realism.PowerUsers.Add($person)
        foreach ($app in $script:RealismApps) {
            $null = Add-DemoRealismMember $State -GroupKey "app-$($app.Key)-admins" -PrincipalId $principal
            $null = Add-DemoRealismMember $State -GroupKey "app-$($app.Key)-users" -PrincipalId $principal
        }
        foreach ($lic in $script:RealismLicenses) {
            $null = Add-DemoRealismMember $State -GroupKey $lic.Key -PrincipalId $principal
        }
        foreach ($prj in $script:RealismProjects) {
            if ((Get-DemoIndex -Seed "power-$($person.id)-$($prj.Key)" -Modulo 100) -lt 70) {
                $null = Add-DemoRealismMember $State -GroupKey "prj-$($prj.Key)" -PrincipalId $principal
            }
        }
    }
}

# The leavers who kept their access: their old department, a licence or two, and
# whatever projects they were on. Disabling the account changed none of it.
function Add-DemoRealismLeaverAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($leaver in $State.Realism.Leavers) {
        if (-not $leaver.keepsAccess) { continue }
        $slug = ($leaver.dept -replace '\s+', '-')
        $null = Add-DemoRealismMember $State -GroupKey 'all-staff' -PrincipalId $leaver.principalId
        $null = Add-DemoRealismMember $State -GroupKey "dept-$slug" -PrincipalId $leaver.principalId
        $null = Add-DemoRealismMember $State -GroupKey 'lic-m365-e3' -PrincipalId $leaver.principalId

        $prjs = @($script:RealismProjects | Where-Object { $_.Dept -eq $leaver.dept })
        if ($prjs.Count) {
            $prj = $prjs[(Get-DemoIndex -Seed "leaverprj-$($leaver.id)" -Modulo $prjs.Count)]
            $null = Add-DemoRealismMember $State -GroupKey "prj-$($prj.Key)" -PrincipalId $leaver.principalId
        }
    }
}

# Guests hold Microsoft 365 groups and the occasional project group — the two
# places external collaboration actually happens. Most guests hold nothing.
function Add-DemoRealismGuestAccess {
    param([Parameter(Mandatory)]$State)

    $partnerGroups = @{
        'Noordzee Logistiek'   = 'm365-Team-Partners-Noordzee'
        'Meridian Consulting'  = 'm365-Team-Partners-Meridian'
        'Van Dijk Advies'      = 'm365-Team-Tenderbureau'
    }
    foreach ($guest in $State.Realism.Guests) {
        if ((Get-DemoIndex -Seed "guestaccess-$($guest.id)" -Modulo 100) -ge 40) { continue }
        $null = Add-DemoRealismMember $State -GroupKey $partnerGroups[$guest.partner] -PrincipalId $guest.principalId
        if ((Get-DemoIndex -Seed "guestprj-$($guest.id)" -Modulo 100) -lt 35) {
            $prj = $script:RealismProjects[(Get-DemoIndex -Seed "guestprjwhich-$($guest.id)" -Modulo $script:RealismProjects.Count)]
            $null = Add-DemoRealismMember $State -GroupKey "prj-$($prj.Key)" -PrincipalId $guest.principalId
        }
    }
}

<#
.SYNOPSIS
    Nesting, materialised.
.DESCRIPTION
    For every "child group sits inside parent group" pair the groups part
    recorded, each member of the child also holds the parent — as an Indirect
    assignment, which is how the Entra crawler records a nested membership and
    what the matrix reads. Somebody who already holds the parent directly keeps
    the direct row; the pair is written once either way.
#>
function Add-DemoRealismNestedAccess {
    param([Parameter(Mandatory)]$State)

    foreach ($pair in $State.Realism.Nesting) {
        if (-not $State.Realism.GroupMembers.ContainsKey($pair.Child)) { continue }
        foreach ($principal in $State.Realism.GroupMembers[$pair.Child]) {
            $null = Add-DemoRealismMember $State -GroupKey $pair.Parent -PrincipalId $principal -AssignmentType 'Indirect'
        }
    }
}
