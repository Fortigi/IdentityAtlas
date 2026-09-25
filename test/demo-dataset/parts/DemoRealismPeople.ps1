<#
.SYNOPSIS
    Fortigi Demo Corp — the optional realism slice: people, their accounts, their careers.

.DESCRIPTION
    Opt-in (Generate-DemoDataset.ps1 -IncludeRealism). Where the standard dataset
    is a 26-person company in which every record exists to tell one story, this
    slice adds a directory that behaves like a real one: ~600 staff across ten
    departments and ~55 teams, guests from three partner companies, leavers who
    kept their access, and one identity holding accounts in several systems.

    WHY IT EXISTS. The custom-report and chat pipelines are measured against
    questions an analyst really asks ("which guests have not signed in for 90
    days", "did you mean Jeroen Jansen or Jeroen Visser?", "which groups does
    someone still hold from their old department"). On the standard dataset most
    of those questions have zero or one possible answer, no first name occurs
    twice, and nobody has ever changed jobs — so a question can pass by accident
    and a name-disambiguation flow never triggers. See
    docs/reference/report-generator.md.

    WHAT MAKES IT FEEL REAL (each choice below is something the small dataset
    cannot express):

      * Job titles do not predict access. Half of them are deliberately generic
        ('Medewerker', 'Specialist', 'Consultant'), people on the same team share
        access whatever their title says, and two people with the SAME title in
        different teams hold very different things.
      * Careers. Tenure runs 0-18 years; roughly two in five long-timers moved
        department at some point, and the groups part leaves some of their old
        department's access in place. `previousDepartment` records the move.
      * Accounts, not people. An identity here can hold an Entra account, an
        on-premises AD account, a CRM account and a separate admin account —
        which is what account correlation exists for, and what makes "how many
        accounts does this person have" a real question.
      * Guests are `principalType = 'User'` with `userType = 'Guest'`, the way
        Entra models a B2B guest — and the way the report catalog's `user` entity
        finds them. (The standard slice uses `ExternalUser` for its two guests,
        so a guest question over that data comes back empty even when the
        pipeline is right.)

    DETERMINISTIC. Every id, name, date and bucket comes from Get-DemoIndex or
    New-DemoGuid, so the same dataset is produced on every machine and every run.

    NOT PART OF THE STANDARD DATASET. Verify-DemoDataset.ps1's exact row counts,
    the Capture-the-Flag answers and the E2E suite all pin the 26-person company;
    this slice is appended after them and changes every count.
#>

Set-StrictMode -Version Latest

# ── The name pool ─────────────────────────────────────────────────────────────
# Fictitious throughout: common Dutch given names and surnames, chosen so that
# repeats and near-misses happen on their own. Surnames keep their particles
# ("van den Berg") because a particle is exactly what a name lookup trips over —
# the pipeline once read the "van" in a surname as a person's name.
$script:RealismGivenNames = @(
    'Jeroen', 'Sanne', 'Bas', 'Lotte', 'Daan', 'Femke', 'Ruben', 'Maaike',
    'Joost', 'Nienke', 'Sander', 'Iris', 'Koen', 'Esther', 'Martijn', 'Anouk',
    'Stijn', 'Marloes', 'Gijs', 'Roos', 'Hidde', 'Janneke', 'Pieter', 'Elske'
)
$script:RealismSurnames = @(
    'Jansen', 'Janssen', 'de Vries', 'van Dijk', 'Visser', 'Smit', 'Meijer',
    'de Boer', 'Mulder', 'Bos', 'Vos', 'Peters', 'Hendriks', 'van Leeuwen',
    'Dekker', 'Brouwer', 'de Wit', 'Smits', 'van den Berg', 'Kuijpers',
    'Willems', 'Maas', 'Verhoeven', 'Koning', 'Prins', 'Blom', 'van der Meer', 'Groen'
)

# HOW NAMES ARE HANDED OUT, and why it is not random. A pool of 24 given names
# and 28 surnames has 672 combinations; drawing 600 of them at random collides so
# often that nearly every full name occurs twice, which would make every question
# about a person ambiguous and turn the benchmark into a disambiguation test. So
# the pool is walked WITHOUT repeats (given cycles fastest, surname every 24
# people), which still gives ~30 people per given name — the realistic part, the
# one that makes "welke groepen heeft Jeroen" need a "which Jeroen?" — and then a
# short, deliberate list of true duplicates is forced on top.
#
# Forced onto the first entries of the roster, so the hard lookups are always
# present rather than left to chance:
#   * six people called Jeroen — "welke groepen heeft Jeroen" must ask which one
#   * two people with the SAME full name, in different teams
#   * Jansen beside Janssen, same given name — one letter apart
#   * three surnames with particles
$script:RealismNameCast = @(
    @{ Given = 'Jeroen'; Surname = 'Jansen' },      @{ Given = 'Jeroen'; Surname = 'Visser' }
    @{ Given = 'Jeroen'; Surname = 'de Vries' },    @{ Given = 'Jeroen'; Surname = 'van den Berg' }
    @{ Given = 'Jeroen'; Surname = 'Smit' },        @{ Given = 'Jeroen'; Surname = 'Kuijpers' }
    @{ Given = 'Sanne';  Surname = 'Visser' },      @{ Given = 'Sanne';  Surname = 'Visser' }
    @{ Given = 'Koen';   Surname = 'Jansen' },      @{ Given = 'Koen';   Surname = 'Janssen' }
    @{ Given = 'Iris';   Surname = 'van der Meer' }, @{ Given = 'Bas';   Surname = 'van Leeuwen' }
)

# "The person at position N has the same full name as the person at position M."
# Seven more exact duplicates, spread over departments — about what a 600-person
# company really has, and enough that a name lookup has to ask more than once.
$script:RealismDuplicateOf = @{ 100 = 3; 180 = 17; 260 = 44; 340 = 61; 420 = 130; 500 = 210; 560 = 333 }

<#
.SYNOPSIS
    The given name and surname of roster position $Seq (1-based).
.DESCRIPTION
    A pure function of the position, so the duplicate list above can point one
    person at another's name without either of them existing yet.
#>
function Get-DemoRealismName {
    param([Parameter(Mandatory)][int]$Seq)

    if ($Seq -le $script:RealismNameCast.Count) {
        return @{ Given = $script:RealismNameCast[$Seq - 1].Given; Surname = $script:RealismNameCast[$Seq - 1].Surname }
    }
    if ($script:RealismDuplicateOf.ContainsKey($Seq)) {
        return (Get-DemoRealismName -Seq $script:RealismDuplicateOf[$Seq])
    }
    $k = $Seq - 1
    return @{
        Given   = $script:RealismGivenNames[$k % $script:RealismGivenNames.Count]
        Surname = $script:RealismSurnames[[int][Math]::Floor($k / $script:RealismGivenNames.Count) % $script:RealismSurnames.Count]
    }
}

# ── Departments ───────────────────────────────────────────────────────────────
# Five reuse the standard dataset's department names (so their contexts and the
# matrix keep working); five are new. Titles are HALF generic on purpose: a
# report that assumes "jobTitle tells you what someone does" must fail here, the
# way it fails on a real tenant.
$script:RealismDepartments = @(
    @{ Name = 'Engineering';      Count = 120; New = $false
       Titles = @('Software Engineer', 'Medewerker', 'Specialist', 'DevOps Engineer', 'Consultant', 'Analist') }
    @{ Name = 'Operations';       Count = 90;  New = $false
       Titles = @('Operations Medewerker', 'Medewerker', 'Coördinator', 'Specialist', 'Planner') }
    @{ Name = 'Sales';            Count = 80;  New = $false
       Titles = @('Account Executive', 'Medewerker', 'Consultant', 'Sales Support', 'Specialist') }
    @{ Name = 'Customer Service'; Count = 70;  New = $true
       Titles = @('Servicedesk Medewerker', 'Medewerker', 'Specialist', 'Coördinator') }
    @{ Name = 'Finance';          Count = 55;  New = $false
       Titles = @('Financieel Medewerker', 'Analist', 'Medewerker', 'Controller', 'Specialist') }
    @{ Name = 'Marketing';        Count = 45;  New = $false
       Titles = @('Marketing Specialist', 'Medewerker', 'Content Specialist', 'Analist') }
    @{ Name = 'IT Support';       Count = 45;  New = $true
       Titles = @('IT Support Medewerker', 'Systeembeheerder', 'Medewerker', 'Specialist', 'Consultant') }
    @{ Name = 'HR';               Count = 35;  New = $true
       Titles = @('HR Adviseur', 'Medewerker', 'Recruiter', 'Specialist') }
    @{ Name = 'Legal';            Count = 30;  New = $true
       Titles = @('Juridisch Adviseur', 'Medewerker', 'Contractmanager', 'Specialist') }
    @{ Name = 'Facilities';       Count = 30;  New = $true
       Titles = @('Facilitair Medewerker', 'Medewerker', 'Coördinator') }
)

# A title carries no information about access when it is one of these.
$script:RealismGenericTitles = @('Medewerker', 'Specialist', 'Consultant', 'Analist', 'Coördinator')

# Partner companies the guests come from, and where staff sit.
$script:RealismPartners = @('Noordzee Logistiek', 'Van Dijk Advies', 'Meridian Consulting')
$script:RealismLocations = @('NL', 'NL', 'NL', 'NL', 'NL', 'NL', 'NL', 'BE', 'BE', 'DE')

# Staff with no manager at all — a real directory always has a few, and
# "accounts without a manager" is a question people ask.
$script:RealismNoManager = @('R0123', 'R0247', 'R0388', 'R0512')

# One measurement moment for every sign-in row this slice writes.
$script:RealismAggResourceId = '00000000-0000-0000-0000-000000000000'

<#
.SYNOPSIS
    The roster: one record per member of staff, before anything is written.
.DESCRIPTION
    A pure function of nothing but the tables above, so the Pester tests can
    assert its shape (name collisions, manager chains, career moves) without
    generating the whole dataset.
#>
function New-DemoRealismRoster {
    $roster = [System.Collections.Generic.List[object]]::new()
    $usedEmails = [System.Collections.Generic.HashSet[string]]::new()
    $seq = 0

    foreach ($dept in $script:RealismDepartments) {
        # One head, then a lead per ~14 people (2-6), then staff spread over the
        # leads' teams. Everyone on a team shares most of their access later,
        # whatever their title says.
        $leadCount = [Math]::Min(6, [Math]::Max(2, [int][Math]::Ceiling(($dept.Count - 1) / 14.0)))
        $deptPeople = [System.Collections.Generic.List[object]]::new()

        for ($i = 0; $i -lt $dept.Count; $i++) {
            $seq++
            $id = 'R{0:D4}' -f $seq

            $drawn = Get-DemoRealismName -Seq $seq
            $given = $drawn.Given
            $surname = $drawn.Surname

            $level = if ($i -eq 0) { 'head' } elseif ($i -le $leadCount) { 'lead' } else { 'staff' }
            $team = if ($level -eq 'staff') { ($i - $leadCount - 1) % $leadCount } else { $i - 1 }
            $title = switch ($level) {
                'head' { "Head of $($dept.Name)" }
                'lead' { "Team Lead $($dept.Name)" }
                default { $dept.Titles[(Get-DemoIndex -Seed "title-$id" -Modulo $dept.Titles.Count)] }
            }

            # Tenure drives the career: long-timers moved department, and the
            # groups part leaves some of the old department's access behind.
            $tenure = Get-DemoIndex -Seed "tenure-$id" -Modulo 19
            $prevDept = $null
            if ($tenure -ge 7 -and (Get-DemoIndex -Seed "moved-$id" -Modulo 10) -lt 4) {
                $others = @($script:RealismDepartments | Where-Object { $_.Name -ne $dept.Name })
                $prevDept = $others[(Get-DemoIndex -Seed "prevdept-$id" -Modulo $others.Count)].Name
            }

            $teamName = if ($level -eq 'head') { "$($dept.Name) - Lead" } else { "$($dept.Name) - Team $($team + 1)" }

            $record = [ordered]@{
                id           = $id
                name         = "$given $surname"
                given        = $given
                surname      = $surname
                email        = (Get-DemoRealismEmail -Given $given -Surname $surname -Used $usedEmails)
                dept         = $dept.Name
                title        = $title
                generic      = ($script:RealismGenericTitles -contains $title)
                level        = $level
                team         = $teamName
                teamIndex    = $team
                manager      = $null        # filled in below, once the leads are known
                tenureYears  = $tenure
                prevDept     = $prevDept
                employeeType = $script:RealismEmployeeTypes[(Get-DemoIndex -Seed "emptype-$id" -Modulo $script:RealismEmployeeTypes.Count)]
                location     = $script:RealismLocations[(Get-DemoIndex -Seed "loc-$id" -Modulo $script:RealismLocations.Count)]
                signInBucket = (Get-DemoIndex -Seed "signin-$id" -Modulo 100)
                extraAccount = (Get-DemoIndex -Seed "accounts-$id" -Modulo 100)
            }
            $roster.Add($record)
            $deptPeople.Add($record)
        }

        # Manager chain: head reports to the CEO of the standard dataset, leads to
        # the head, staff to the lead whose team they are on.
        $head = $deptPeople[0]
        $head.manager = 'E0001'
        $leads = @($deptPeople | Where-Object { $_.level -eq 'lead' })
        foreach ($lead in $leads) { $lead.manager = $head.id }
        foreach ($person in @($deptPeople | Where-Object { $_.level -eq 'staff' })) {
            $person.manager = $leads[$person.teamIndex % $leads.Count].id
        }
    }

    foreach ($person in $roster) {
        if ($script:RealismNoManager -contains $person.id) { $person.manager = $null }
    }
    return $roster
}

$script:RealismEmployeeTypes = @('Employee', 'Employee', 'Employee', 'Employee', 'Employee',
                                'Employee', 'Employee', 'Employee', 'Contractor', 'Intern')

# "Jeroen van den Berg" -> jeroen.vandenberg@fortigidemo.com, with a number
# appended when two people would otherwise share an address (they do: the roster
# has two people with the same full name).
function Get-DemoRealismEmail {
    param(
        [Parameter(Mandatory)][string]$Given,
        [Parameter(Mandatory)][string]$Surname,
        # Not Mandatory: the set is empty on the first call, and PowerShell
        # refuses to bind an empty collection to a mandatory parameter.
        [AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$Used
    )
    $local = "$($Given.ToLower()).$(($Surname -replace '[^\p{L}]', '').ToLower())"
    $candidate = $local
    $n = 1
    while (-not $Used.Add($candidate)) { $n++; $candidate = "$local$n" }
    return "$candidate@fortigidemo.com"
}

function Add-DemoRealismPeople {
    param([Parameter(Mandatory)]$State)

    # Two more systems that keep their OWN accounts, so one person can hold
    # several. AzureRM (standard slice) is the counter-example: it grants access
    # to Entra principals and has no account objects of its own.
    $sysAd = Add-DemoSystem $State -Key 'ad'  -SystemType 'ActiveDirectory' -DisplayName 'Fortigi Demo AD'  -TenantId 'demo-ad-001'
    $sysCrm = Add-DemoSystem $State -Key 'crm' -SystemType 'CSV'             -DisplayName 'Fortigi Demo CRM' -TenantId 'demo-crm-001'

    $roster = New-DemoRealismRoster
    $measuredAt = if ($State.Contains('ActivityMeasuredAt')) { $State['ActivityMeasuredAt'] } else { [datetime]::UtcNow }

    $State['Realism'] = [ordered]@{
        People     = $roster
        ByDept     = @{}
        ByTeam     = @{}
        Guests     = [System.Collections.Generic.List[object]]::new()
        Leavers    = [System.Collections.Generic.List[object]]::new()
        NonHuman   = [ordered]@{}
        Systems    = @{ ad = $sysAd; crm = $sysCrm }
        MeasuredAt = $measuredAt
    }
    foreach ($person in $roster) {
        if (-not $State.Realism.ByDept.ContainsKey($person.dept)) { $State.Realism.ByDept[$person.dept] = [System.Collections.Generic.List[object]]::new() }
        $State.Realism.ByDept[$person.dept].Add($person)
        if (-not $State.Realism.ByTeam.ContainsKey($person.team)) { $State.Realism.ByTeam[$person.team] = [System.Collections.Generic.List[object]]::new() }
        $State.Realism.ByTeam[$person.team].Add($person)
    }

    Add-DemoRealismContexts $State
    Add-DemoRealismStaff    $State
    Add-DemoRealismGuests   $State
    Add-DemoRealismLeavers  $State
    Add-DemoRealismNonHuman $State
}

# Department contexts for the five new departments, plus a Team context per team
# so the matrix can be scoped the way an organisation is actually run.
function Add-DemoRealismContexts {
    param([Parameter(Mandatory)]$State)

    $sysHr = $State.SystemIds['hr']
    foreach ($dept in $script:RealismDepartments) {
        if ($dept.New) {
            $id = New-DemoGuid "ctx-realism-dept-$($dept.Name)"
            Add-DemoContext $State -Id $id -DisplayName $dept.Name -ContextType 'Department' `
                -ScopeSystemId $sysHr -ParentContextId $State.Ctx.Root
            $State.DeptCtx[$dept.Name] = $id
        }
    }
    foreach ($team in $State.Realism.ByTeam.Keys) {
        Add-DemoContext $State -Id (New-DemoGuid "ctx-realism-team-$team") -DisplayName $team `
            -ContextType 'Team' -ScopeSystemId $sysHr -ParentContextId $State.DeptCtx[$State.Realism.ByTeam[$team][0].dept]
    }
}

function Add-DemoRealismStaff {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $measuredAt = $State.Realism.MeasuredAt

    foreach ($person in $State.Realism.People) {
        $pGuid = Get-DemoPrincipalId $person.id
        $idGuid = Get-DemoIdentityId $person.id
        $mgrGuid = if ($person.manager) { Get-DemoPrincipalId $person.manager } else { $null }
        $created = $measuredAt.AddDays(-1 * (365 * $person.tenureYears + (Get-DemoIndex -Seed "created-$($person.id)" -Modulo 365)))

        $ext = [ordered]@{
            userType             = 'Member'
            employeeType         = $person.employeeType
            usageLocation        = $person.location
            passwordNeverExpires = $false
        }
        if ($person.prevDept) { $ext['previousDepartment'] = $person.prevDept }

        $null = Add-DemoPrincipal $State -Record @{
            id                 = $pGuid
            displayName        = $person.name
            email              = $person.email
            accountEnabled     = $true
            principalType      = 'User'
            employeeId         = $person.id
            givenName          = $person.given
            surname            = $person.surname
            department         = $person.dept
            jobTitle           = $person.title
            companyName        = 'Fortigi Demo Corp'
            managerId          = $mgrGuid
            createdDateTime    = $created.ToString('o')
            systemId           = $sysEntra
            extendedAttributes = $ext
        }
        $null = Add-DemoIdentity $State -Record @{
            id          = $idGuid
            displayName = $person.name
            email       = $person.email
            department  = $person.dept
            jobTitle    = $person.title
            employeeId  = $person.id
            givenName   = $person.given
            surname     = $person.surname
            companyName = 'Fortigi Demo Corp'
        }
        Add-DemoIdentityMember $State -IdentityId $idGuid -PrincipalId $pGuid `
            -DisplayName $person.name -AccountType 'EntraID' -IsPrimary $true

        foreach ($cid in @($State.DeptCtx[$person.dept], (New-DemoGuid "ctx-realism-team-$($person.team)"))) {
            Add-DemoContextMember $State -ContextId $cid -MemberId $pGuid
        }

        Add-DemoRealismLinkedAccounts $State -Person $person
        Add-DemoRealismSignIn $State -PrincipalId $pGuid -Bucket $person.signInBucket -Seed $person.id
    }
}

<#
.SYNOPSIS
    The other accounts one person holds — the reason account correlation exists.
.DESCRIPTION
    Roughly half the staff have an on-premises AD account, a fifth a CRM account,
    and a handful a SEPARATE admin account in Entra. All of them hang off the same
    identity, so "how many accounts does this person have" and "which admin
    accounts belong to somebody who already has a normal account" are real
    questions over this data.
#>
function Add-DemoRealismLinkedAccounts {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Person
    )
    $idGuid = Get-DemoIdentityId $Person.id
    $bucket = $Person.extraAccount

    if ($bucket -lt 55) {
        $sam = "$($Person.given.Substring(0,1))$(($Person.surname -replace '[^\p{L}]', ''))".ToLower()
        $adId = New-DemoGuid "principal-$($Person.id)-ad"
        $null = Add-DemoPrincipal $State -Record @{
            id                 = $adId
            displayName        = $sam
            principalType      = 'User'
            accountEnabled     = $true
            employeeId         = $Person.id
            department         = $Person.dept
            companyName        = 'Fortigi Demo Corp'
            systemId           = $State.Realism.Systems.ad
            extendedAttributes = @{ userType = 'Member'; onPremisesSamAccountName = $sam }
        }
        Add-DemoIdentityMember $State -IdentityId $idGuid -PrincipalId $adId `
            -DisplayName $sam -AccountType 'ActiveDirectory'
    }
    if ($bucket -ge 55 -and $bucket -lt 75) {
        $crmId = New-DemoGuid "principal-$($Person.id)-crm"
        $null = Add-DemoPrincipal $State -Record @{
            id                 = $crmId
            displayName        = "$($Person.name) (CRM)"
            email              = $Person.email
            principalType      = 'User'
            accountEnabled     = $true
            employeeId         = $Person.id
            department         = $Person.dept
            systemId           = $State.Realism.Systems.crm
            extendedAttributes = @{ userType = 'Member' }
        }
        Add-DemoIdentityMember $State -IdentityId $idGuid -PrincipalId $crmId `
            -DisplayName "$($Person.name) (CRM)" -AccountType 'CRM'
    }
    # The shadow admin account: same person, second Entra account, privileged
    # access on it rather than on the account they read their mail with.
    if ($bucket -ge 96) {
        $admId = New-DemoGuid "principal-$($Person.id)-adm"
        $null = Add-DemoPrincipal $State -Record @{
            id                 = $admId
            displayName        = "$($Person.name) (admin)"
            email              = "adm-$($Person.email)"
            principalType      = 'User'
            accountEnabled     = $true
            employeeId         = $Person.id
            department         = $Person.dept
            jobTitle           = 'Administrative account'
            companyName        = 'Fortigi Demo Corp'
            systemId           = $State.SystemIds['entra']
            extendedAttributes = @{ userType = 'Member'; passwordNeverExpires = $true }
        }
        Add-DemoIdentityMember $State -IdentityId $idGuid -PrincipalId $admId `
            -DisplayName "$($Person.name) (admin)" -AccountType 'EntraID'
    }
}
