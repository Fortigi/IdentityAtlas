<#
.SYNOPSIS
    Fortigi Demo Corp — the realism slice: sign-in activity, guests, leavers and
    the accounts that are not people.

.DESCRIPTION
    Part of the opt-in realism slice (Generate-DemoDataset.ps1 -IncludeRealism),
    split out of DemoRealismPeople.ps1, which builds the staff. Everything here is
    a population an access question is really about:

      * SIGN-IN ACTIVITY, spread from today to well over a year ago, including
        accounts with a row and no timestamp ("never signed in") and accounts with
        no row at all ("this system does not report sign-ins"). Those are different
        facts and the report catalog tells them apart.
      * GUESTS from three partner companies, modelled the way Entra models a B2B
        guest — principalType 'User' with userType 'Guest' — which is also how the
        report catalog's `user` entity finds one.
      * LEAVERS: disabled accounts, half of which still hold everything they held
        on their last day.
      * NON-HUMAN ACCOUNTS: the pipelines, managed identities, agents and shared
        mailboxes every tenant accumulates.

    Called from Add-DemoRealismPeople; the parts share one dot-sourced scope, so
    the helpers and the $script: tables in DemoRealismPeople.ps1 are in reach.
#>

Set-StrictMode -Version Latest

<#
.SYNOPSIS
    One sign-in row, from the bucket the roster drew.
.DESCRIPTION
    The spread is the point: 40% signed in this week, and the tail runs out past
    a year, with some accounts that have a row but never signed in and some with
    no row at all. Those last two are different facts — "never signed in" versus
    "we do not collect sign-ins for that system" — and the report catalog tells
    them apart, so the data has to as well.
#>
function Add-DemoRealismSignIn {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$PrincipalId,
        [Parameter(Mandatory)][int]$Bucket,
        [Parameter(Mandatory)][string]$Seed
    )
    $measuredAt = $State.Realism.MeasuredAt
    $daysAgo = switch ($Bucket) {
        { $_ -lt 40 } { Get-DemoIndex -Seed "d-$Seed" -Modulo 8; break }
        { $_ -lt 60 } { 8 + (Get-DemoIndex -Seed "d-$Seed" -Modulo 23); break }
        { $_ -lt 75 } { 31 + (Get-DemoIndex -Seed "d-$Seed" -Modulo 59); break }
        { $_ -lt 85 } { 90 + (Get-DemoIndex -Seed "d-$Seed" -Modulo 90); break }
        { $_ -lt 93 } { 180 + (Get-DemoIndex -Seed "d-$Seed" -Modulo 220); break }
        { $_ -lt 97 } { $null; break }              # a row, no timestamps: never signed in
        default { 'none' }                           # no row at all
    }
    if ($daysAgo -is [string] -and $daysAgo -eq 'none') { return }

    # An account that never signed in has no count either; the rest get a plausible one.
    $count = if ($null -eq $daysAgo) { 0 } else { 1 + (Get-DemoIndex -Seed "cnt-$Seed" -Modulo 900) }
    $State.PrincipalActivity.Add((New-DemoActivityRecord `
        -PrincipalId $PrincipalId -MeasuredAt $measuredAt -DaysAgo $daysAgo `
        -ResourceId $script:RealismAggResourceId -SignInCount $count))
}

<#
.SYNOPSIS
    Guests from three partner companies.
.DESCRIPTION
    `principalType = 'User'` with `userType = 'Guest'`, which is how Entra models
    a B2B guest and how the report catalog finds one. Their staleness is spread
    deliberately: some active, some quiet for months, some that never accepted
    the invitation and never signed in — the population "which guests have not
    signed in for 90 days" is asked about.
#>
function Add-DemoRealismGuests {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    for ($i = 1; $i -le 40; $i++) {
        $gid = 'G{0:D4}' -f $i
        $given = $script:RealismGivenNames[(Get-DemoIndex -Seed "guest-given-$gid" -Modulo $script:RealismGivenNames.Count)]
        $surname = $script:RealismSurnames[(Get-DemoIndex -Seed "guest-surname-$gid" -Modulo $script:RealismSurnames.Count)]
        $partner = $script:RealismPartners[$i % $script:RealismPartners.Count]
        $domain = ($partner -replace '[^\p{L}]', '').ToLower() + '.example'
        $pending = ($i % 4 -eq 0)

        $pGuid = Get-DemoPrincipalId $gid
        $null = Add-DemoPrincipal $State -Record @{
            id                 = $pGuid
            displayName        = "$given $surname"
            email              = "$($given.ToLower()).$(($surname -replace '[^\p{L}]', '').ToLower())@$domain"
            accountEnabled     = $true
            principalType      = 'User'
            givenName          = $given
            surname            = $surname
            companyName        = $partner
            systemId           = $sysEntra
            createdDateTime    = $State.Realism.MeasuredAt.AddDays(-1 * (30 + (Get-DemoIndex -Seed "gcreated-$gid" -Modulo 900))).ToString('o')
            extendedAttributes = @{
                userType          = 'Guest'
                externalUserState = if ($pending) { 'PendingAcceptance' } else { 'Accepted' }
                usageLocation     = 'NL'
            }
        }
        $State.Realism.Guests.Add(@{ id = $gid; principalId = $pGuid; partner = $partner; pending = $pending })

        # A guest who never accepted has never signed in; the rest run from
        # yesterday to well over a year ago.
        $bucket = if ($pending) { 95 } else { 20 + (Get-DemoIndex -Seed "gsignin-$gid" -Modulo 75) }
        Add-DemoRealismSignIn $State -PrincipalId $pGuid -Bucket $bucket -Seed $gid
    }
}

<#
.SYNOPSIS
    Leavers — disabled accounts, half of which kept their access.
.DESCRIPTION
    Disabling an account blocks the sign-in and leaves every membership exactly
    where it was. That is why "disabled accounts that still hold access" is the
    first thing an auditor asks for, and it cannot be asked of a dataset with one
    disabled account in it.
#>
function Add-DemoRealismLeavers {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $depts = @($script:RealismDepartments.Name)
    for ($i = 1; $i -le 30; $i++) {
        $lid = 'L{0:D4}' -f $i
        $given = $script:RealismGivenNames[(Get-DemoIndex -Seed "leaver-given-$lid" -Modulo $script:RealismGivenNames.Count)]
        $surname = $script:RealismSurnames[(Get-DemoIndex -Seed "leaver-surname-$lid" -Modulo $script:RealismSurnames.Count)]
        $dept = $depts[(Get-DemoIndex -Seed "leaver-dept-$lid" -Modulo $depts.Count)]
        $pGuid = Get-DemoPrincipalId $lid
        $idGuid = Get-DemoIdentityId $lid
        $left = 30 + (Get-DemoIndex -Seed "leaver-left-$lid" -Modulo 500)

        $null = Add-DemoPrincipal $State -Record @{
            id                 = $pGuid
            displayName        = "$given $surname"
            email              = "$($given.ToLower()).$(($surname -replace '[^\p{L}]', '').ToLower())@fortigidemo.com"
            accountEnabled     = $false
            principalType      = 'User'
            employeeId         = $lid
            givenName          = $given
            surname            = $surname
            department         = $dept
            jobTitle           = 'Medewerker'
            companyName        = 'Fortigi Demo Corp'
            systemId           = $sysEntra
            createdDateTime    = $State.Realism.MeasuredAt.AddDays(-1 * ($left + 400)).ToString('o')
            extendedAttributes = @{ userType = 'Member'; usageLocation = 'NL'; leftDaysAgo = $left }
        }
        $null = Add-DemoIdentity $State -Record @{
            id = $idGuid; displayName = "$given $surname"; department = $dept; employeeId = $lid
        }
        Add-DemoIdentityMember $State -IdentityId $idGuid -PrincipalId $pGuid `
            -DisplayName "$given $surname" -AccountType 'EntraID' -IsPrimary $true -AccountEnabled $false
        Add-DemoContextMember $State -ContextId $State.DeptCtx[$dept] -MemberId $pGuid

        # keepsAccess: the groups part leaves their memberships in place.
        $State.Realism.Leavers.Add(@{ id = $lid; principalId = $pGuid; dept = $dept; keepsAccess = ($i % 2 -eq 1) })
        $State.PrincipalActivity.Add((New-DemoActivityRecord `
            -PrincipalId $pGuid -MeasuredAt $State.Realism.MeasuredAt -DaysAgo $left `
            -ResourceId $script:RealismAggResourceId -SignInCount (Get-DemoIndex -Seed "leaver-cnt-$lid" -Modulo 500)))
    }
}

# Non-human accounts: the pipelines, the agents and the mailboxes every tenant
# accumulates. Their access is granted in the systems part.
function Add-DemoRealismNonHuman {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']
    $accounts = @(
        @{ Key = 'RSVC-1'; Name = 'svc-backup-runner';   Type = 'ServicePrincipal' }
        @{ Key = 'RSVC-2'; Name = 'svc-invoice-import';  Type = 'ServicePrincipal' }
        @{ Key = 'RSVC-3'; Name = 'svc-crm-sync';        Type = 'ServicePrincipal' }
        @{ Key = 'RSVC-4'; Name = 'svc-monitoring';      Type = 'ServicePrincipal' }
        @{ Key = 'RSVC-5'; Name = 'svc-terraform';       Type = 'ServicePrincipal' }
        @{ Key = 'RSVC-6'; Name = 'svc-reporting';       Type = 'ServicePrincipal' }
        @{ Key = 'RMI-1';  Name = 'mi-webapp-prod';      Type = 'ManagedIdentity' }
        @{ Key = 'RMI-2';  Name = 'mi-functions-batch';  Type = 'ManagedIdentity' }
        @{ Key = 'RAI-1';  Name = 'agent-servicedesk';   Type = 'AIAgent' }
        @{ Key = 'RAI-2';  Name = 'agent-sales-copilot'; Type = 'AIAgent' }
        @{ Key = 'RSM-1';  Name = 'facturen@fortigidemo.com';  Type = 'SharedMailbox' }
        @{ Key = 'RSM-2';  Name = 'servicedesk@fortigidemo.com'; Type = 'SharedMailbox' }
    )
    foreach ($acct in $accounts) {
        $pGuid = Get-DemoPrincipalId $acct.Key
        $null = Add-DemoPrincipal $State -Record @{
            id                 = $pGuid
            displayName        = $acct.Name
            principalType      = $acct.Type
            accountEnabled     = $true
            systemId           = $sysEntra
            extendedAttributes = @{ passwordNeverExpires = ($acct.Type -eq 'ServicePrincipal') }
        }
        $State.Realism.NonHuman[$acct.Key] = $pGuid
        $State.PrincipalActivity.Add((New-DemoActivityRecord `
            -PrincipalId $pGuid -MeasuredAt $State.Realism.MeasuredAt `
            -DaysAgo (Get-DemoIndex -Seed "nh-signin-$($acct.Key)" -Modulo 300) `
            -ActivityType 'ServicePrincipalSignIn' -ResourceId $script:RealismAggResourceId `
            -SignInCount (Get-DemoIndex -Seed "nh-cnt-$($acct.Key)" -Modulo 5000)))
    }
}
