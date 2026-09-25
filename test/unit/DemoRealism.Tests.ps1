#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the demo dataset's opt-in realism slice.

.DESCRIPTION
    The realism slice exists to make questions answerable that the standard
    26-person dataset cannot express (see test/demo-dataset/parts/DemoRealism*.ps1
    and docs/reference/report-generator.md). Each test below therefore asserts a
    PROPERTY A QUESTION DEPENDS ON, not a row count for its own sake: if the
    property goes, the question silently becomes unanswerable again and a model
    that gets it wrong still scores a pass.

    The first test is the most important one: generating WITHOUT the switch must
    produce exactly the standard dataset, because the Capture-the-Flag answers,
    Verify-DemoDataset.ps1's exact counts and the E2E suite all pin it.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/DemoRealism.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:genScript = Join-Path $script:repoRoot 'test' 'demo-dataset' 'Generate-DemoDataset.ps1'
    $script:basePath = Join-Path ([System.IO.Path]::GetTempPath()) 'demo-realism-tests-base.json'
    $script:fullPath = Join-Path ([System.IO.Path]::GetTempPath()) 'demo-realism-tests-full.json'

    & $script:genScript -OutputPath $script:basePath | Out-Null
    & $script:genScript -OutputPath $script:fullPath -IncludeRealism | Out-Null
    $script:base = Get-Content $script:basePath -Raw | ConvertFrom-Json
    $script:data = Get-Content $script:fullPath -Raw | ConvertFrom-Json

    # ── Lookups every test below shares ──────────────────────────────────────
    $script:groups = @($script:data.resources | Where-Object { $_.resourceType -eq 'Group' })
    $script:resourceById = @{}
    foreach ($r in $script:data.resources) { $script:resourceById[$r.id] = $r }
    $script:principalById = @{}
    foreach ($p in $script:data.principals) { $script:principalById[$p.id] = $p }

    # Live memberships per resource and per principal.
    $script:membersOf = @{}
    $script:holdingsOf = @{}
    foreach ($a in $script:data.resourceAssignments) {
        if (-not $script:membersOf.ContainsKey($a.resourceId)) { $script:membersOf[$a.resourceId] = [System.Collections.Generic.List[object]]::new() }
        $script:membersOf[$a.resourceId].Add($a)
        if (-not $script:holdingsOf.ContainsKey($a.principalId)) { $script:holdingsOf[$a.principalId] = [System.Collections.Generic.List[object]]::new() }
        $script:holdingsOf[$a.principalId].Add($a)
    }

    # Sign-in rows, by principal, for the aggregate resource the reports read.
    $script:activityOf = @{}
    foreach ($act in $script:data.principalActivity) {
        if ($act.resourceId -eq '00000000-0000-0000-0000-000000000000' -and $act.activityType -eq 'SignIn') {
            $script:activityOf[$act.principalId] = $act
        }
    }

    function Script:GroupsNamed { param([string]$Like) return @($script:groups | Where-Object { $_.displayName -like $Like }) }
    function Script:LiveMembers { param([string]$ResourceId) return @($script:membersOf[$ResourceId]) }
}

Describe 'the realism slice is opt-in' {
    It 'leaves the standard dataset untouched when the switch is off' {
        # The numbers the Capture-the-Flag answers and Verify-DemoDataset.ps1 pin.
        $script:base.systems.Count | Should -Be 5
        $script:base.principals.Count | Should -Be 49
        $script:base.resources.Count | Should -Be 47
        $script:base.resourceAssignments.Count | Should -Be 180
        $script:base.identities.Count | Should -Be 27
        $script:base.certificationDecisions.Count | Should -Be 3
    }

    It 'adds to the standard dataset rather than replacing it, keeping every id' {
        $baseIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($p in $script:base.principals) { $null = $baseIds.Add($p.id) }
        $fullIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($p in $script:data.principals) { $null = $fullIds.Add($p.id) }
        $fullIds.IsSupersetOf($baseIds) | Should -BeTrue
        $script:data.principals.Count | Should -BeGreaterThan 1000
    }

    It 'is deterministic: the same generation twice produces the same file' {
        $again = Join-Path ([System.IO.Path]::GetTempPath()) 'demo-realism-tests-again.json'
        & $script:genScript -OutputPath $again -IncludeRealism | Out-Null
        # generatedAt is a timestamp by design; everything else must match.
        $first = (Get-Content $script:fullPath -Raw) -replace '"generatedAt": "[^"]+"', ''
        $second = (Get-Content $again -Raw) -replace '"generatedAt": "[^"]+"', ''
        # The sign-in dates are relative to the moment of generation, so compare
        # the sections that carry no clock: principals, resources, assignments.
        $a = ($first -split '"principalActivity"')[0]
        $b = ($second -split '"principalActivity"')[0]
        $a | Should -Be $b
    }
}

Describe 'people — the questions about who somebody is' {
    It 'has one first name shared by many people, so a name needs disambiguating' {
        $byGiven = @($script:data.principals |
            Where-Object { $_.principalType -eq 'User' -and $_.PSObject.Properties.Name -contains 'givenName' -and $_.givenName } |
            Group-Object givenName | Sort-Object Count -Descending)
        $byGiven[0].Count | Should -BeGreaterThan 15 -Because 'a question naming only a first name must be genuinely ambiguous'
    }

    It 'has people with the same full name, in different teams' {
        $dupes = @($script:data.principals |
            Where-Object { $_.principalType -eq 'User' -and $_.systemId -eq 1 } |
            Group-Object displayName | Where-Object { $_.Count -gt 1 })
        $dupes.Count | Should -BeGreaterOrEqual 5 -Because 'pinning a name to one person is the flow this data has to exercise'
    }

    It 'has surnames with particles, which a name lookup trips over' {
        @($script:data.principals | Where-Object { $_.displayName -match ' (van|de|van den|van der) ' }).Count |
            Should -BeGreaterThan 20
    }

    It 'gives most people a manager and a few none at all' {
        # The person's PRIMARY account only: their AD, CRM and admin accounts carry
        # the same employeeId and no manager of their own.
        $staff = @($script:data.principals | Where-Object {
            $_.employeeId -like 'R*' -and $_.systemId -eq 1 -and $_.jobTitle -ne 'Administrative account' })
        $staff.Count | Should -BeGreaterThan 500
        $withManager = @($staff | Where-Object { $_.managerId })
        $withManager.Count | Should -BeGreaterThan ($staff.Count * 0.9)
        @($staff | Where-Object { -not $_.managerId }).Count | Should -BeGreaterOrEqual 4
    }

    It 'spreads sign-ins from today to over a year ago, with never-signed-in accounts among them' {
        $withDate = @($script:activityOf.Values | Where-Object { $_.lastSignInDateTime })
        $never = @($script:activityOf.Values | Where-Object { -not $_.lastSignInDateTime })
        $oldest = ($withDate | ForEach-Object { [datetime]$_.lastSignInDateTime } | Sort-Object)[0]
        ((Get-Date) - $oldest).TotalDays | Should -BeGreaterThan 360
        $never.Count | Should -BeGreaterThan 10 -Because '"never signed in" is a different fact from "signed in long ago"'
    }

    It 'has guests as User accounts with userType Guest, at several degrees of staleness' {
        # The partner companies are this slice's guests. (The standard slice's two
        # guests are principalType ExternalUser, which the report catalog's `user`
        # entity does NOT match — noted in DemoRealismPeople.ps1, left as it is so
        # the standard counts stay pinned.)
        $partners = @('Noordzee Logistiek', 'Van Dijk Advies', 'Meridian Consulting')
        $guests = @($script:data.principals |
            Where-Object { $_.extendedAttributes.userType -eq 'Guest' -and $partners -contains $_.companyName })
        $guests.Count | Should -BeGreaterThan 30
        @($guests | Where-Object { $_.principalType -ne 'User' }).Count | Should -Be 0 -Because 'the report catalog finds guests through the user entity'
        $stale = @($guests | Where-Object {
            $script:activityOf.ContainsKey($_.id) -and $script:activityOf[$_.id].lastSignInDateTime -and
            ([datetime]$script:activityOf[$_.id].lastSignInDateTime) -lt (Get-Date).AddDays(-90) })
        $stale.Count | Should -BeGreaterThan 5
        @($guests | Where-Object { $_.extendedAttributes.externalUserState -eq 'PendingAcceptance' }).Count | Should -BeGreaterThan 3
    }

    It 'has disabled accounts, half of which still hold access' {
        $disabled = @($script:data.principals | Where-Object { -not $_.accountEnabled -and $_.employeeId -like 'L*' })
        $disabled.Count | Should -BeGreaterOrEqual 30
        $stillHolding = @($disabled | Where-Object { $script:holdingsOf.ContainsKey($_.id) })
        $stillHolding.Count | Should -BeGreaterThan 10 -Because '"disabled accounts that still have access" is the first thing an auditor asks'
    }

    It 'links several accounts per person into one identity, across systems' {
        $perIdentity = @($script:data.identityMembers | Group-Object identityId)
        @($perIdentity | Where-Object { $_.Count -gt 1 }).Count | Should -BeGreaterThan 200
        $kinds = @($script:data.identityMembers | Group-Object accountType | ForEach-Object { $_.Name })
        $kinds | Should -Contain 'ActiveDirectory'
        $kinds | Should -Contain 'CRM'
    }

    It 'records who moved department, and leaves them access from the old one' {
        $movers = @($script:data.principals | Where-Object {
            $_.extendedAttributes.PSObject.Properties.Name -contains 'previousDepartment' -and $_.extendedAttributes.previousDepartment })
        $movers.Count | Should -BeGreaterThan 100
        # At least some of them hold a group named after the department they left.
        $withOldAccess = @($movers | Where-Object {
            $old = $_.extendedAttributes.previousDepartment -replace '\s+', '-'
            $holdings = if ($script:holdingsOf.ContainsKey($_.id)) { $script:holdingsOf[$_.id] } else { @() }
            @($holdings | Where-Object { $script:resourceById[$_.resourceId].displayName -like "SG-$old-*" }).Count -gt 0 })
        $withOldAccess.Count | Should -BeGreaterThan 20 -Because 'access that does not match the current department is the point'
    }
}

Describe 'groups — the questions about what access looks like' {
    It 'has a License-* family, and look-alikes that only mention licences in the description' {
        (Script:GroupsNamed 'License-*').Count | Should -BeGreaterOrEqual 8
        $descOnly = @($script:groups | Where-Object { $_.displayName -notlike 'License-*' -and $_.description -match 'licen' })
        $descOnly.Count | Should -BeGreaterOrEqual 2 -Because 'name AND description must give a different answer from name alone'
    }

    It 'has mail-enabled groups that are not security groups, and the other way round' {
        @($script:groups | Where-Object { $_.extendedAttributes.mailEnabled -and -not $_.extendedAttributes.securityEnabled }).Count |
            Should -BeGreaterThan 10
        @($script:groups | Where-Object { $_.extendedAttributes.securityEnabled -and -not $_.extendedAttributes.mailEnabled }).Count |
            Should -BeGreaterThan 100
    }

    It 'has empty groups, small groups and one group holding the whole company' {
        @($script:groups | Where-Object { -not $script:membersOf.ContainsKey($_.id) }).Count | Should -BeGreaterOrEqual 5
        $biggest = ($script:groups | ForEach-Object { (Script:LiveMembers $_.id).Count } | Sort-Object)[-1]
        $biggest | Should -BeGreaterThan 500
    }

    It 'leaves most groups without an owner, and gives some two' {
        $owned = @{}
        foreach ($rel in @($script:data.resourceRelationships | Where-Object { $_.relationshipType -eq 'HasOwnership' })) {
            $owned[$rel.parentResourceId] = $rel.childResourceId
        }
        $noOwnerBusy = @($script:groups | Where-Object { -not $owned.ContainsKey($_.id) -and (Script:LiveMembers $_.id).Count -gt 5 })
        $noOwnerBusy.Count | Should -BeGreaterThan 20 -Because '"groups without an owner that have members" needs a long answer'
        $ownerCounts = @($owned.Values | ForEach-Object { (Script:LiveMembers $_).Count })
        @($ownerCounts | Where-Object { $_ -gt 1 }).Count | Should -BeGreaterThan 3
    }

    It 'has finished projects whose members were never removed' {
        $finished = @($script:groups | Where-Object { $_.extendedAttributes.projectStatus -eq 'Afgerond' })
        $finished.Count | Should -BeGreaterOrEqual 8
        $held = 0
        foreach ($g in $finished) { $held += (Script:LiveMembers $g.id).Count }
        $held | Should -BeGreaterThan 50
    }

    It 'nests groups, recorded as indirect memberships' {
        @($script:data.resourceAssignments | Where-Object { $_.assignmentType -eq 'Indirect' }).Count |
            Should -BeGreaterThan 300 -Because 'a group inside a group is stored as an indirect membership'
    }

    It 'spreads how much access one person has, with a few holding far too much' {
        $counts = @($script:data.principals | Where-Object { $_.employeeId -like 'R*' } | ForEach-Object {
            if ($script:holdingsOf.ContainsKey($_.id)) { $script:holdingsOf[$_.id].Count } else { 0 } })
        $sorted = @($counts | Sort-Object)
        $sorted[[int]($sorted.Count / 2)] | Should -BeGreaterThan 4
        @($counts | Where-Object { $_ -gt 50 }).Count | Should -BeGreaterOrEqual 3 -Because '"who is in more than fifty groups" must find somebody'
    }

    It 'makes a team look like a team, and a job title mean little' {
        # Two people on one team share more than two people with the same title
        # in different departments do. Compared on the sets of groups they hold.
        $staff = @($script:data.principals | Where-Object { $_.employeeId -like 'R*' -and $_.department -eq 'Sales' })
        $withTitle = @($staff | Where-Object { $_.jobTitle -eq 'Medewerker' })
        $withTitle.Count | Should -BeGreaterThan 3 -Because 'generic titles have to be common for the trap to exist'
    }
}

Describe 'roles, eligibility and attestation' {
    It 'has directory roles that somebody holds and three that nobody holds' {
        $roles = @($script:data.resources | Where-Object { $_.resourceType -eq 'EntraDirectoryRole' })
        $roles.Count | Should -BeGreaterOrEqual 12
        $held = @($roles | Where-Object { @((Script:LiveMembers $_.id) | Where-Object { $_.assignmentType -eq 'Direct' }).Count -gt 0 })
        @($roles).Count - @($held).Count | Should -BeGreaterOrEqual 3 -Because '"roles nobody holds" is a real question'
    }

    It 'has eligible (PIM) assignments on roles, separate from who holds them' {
        $eligible = @($script:data.resourceAssignments | Where-Object { $_.assignmentType -eq 'Eligible' })
        $eligible.Count | Should -BeGreaterThan 30 -Because '"who can request this role" needs a population'
        # Nobody is both a holder and eligible for the same thing.
        $pairs = @{}
        foreach ($a in $script:data.resourceAssignments) {
            $key = "$($a.resourceId)|$($a.principalId)"
            if (-not $pairs.ContainsKey($key)) { $pairs[$key] = [System.Collections.Generic.List[string]]::new() }
            $pairs[$key].Add($a.assignmentType)
        }
        @($pairs.Values | Where-Object { $_.Contains('Eligible') -and ($_.Contains('Direct') -or $_.Contains('Indirect')) }).Count |
            Should -Be 0
    }

    It 'has business roles that grant groups AND application roles' {
        $roles = @($script:data.resources | Where-Object { $_.resourceType -eq 'BusinessRole' })
        $roles.Count | Should -BeGreaterOrEqual 20
        $contains = @($script:data.resourceRelationships | Where-Object { $_.relationshipType -eq 'Contains' })
        $grantedTypes = @($contains | ForEach-Object { $script:resourceById[$_.childResourceId].resourceType } | Sort-Object -Unique)
        $grantedTypes | Should -Contain 'Group'
        $grantedTypes | Should -Contain 'AppRole'
    }

    It 'marks role-driven access as governed, and leaves a provisioning gap' {
        @($script:data.resourceAssignments | Where-Object { $_.governed }).Count | Should -BeGreaterThan 300

        # At least some holders of a business role are missing one thing it grants.
        $roleId = @($script:data.resources | Where-Object { $_.displayName -eq 'BR-Sales-Basis' })[0].id
        $grants = @(@($script:data.resourceRelationships |
            Where-Object { $_.parentResourceId -eq $roleId -and $_.relationshipType -eq 'Contains' }) |
            ForEach-Object { $_.childResourceId })
        $holders = @((Script:LiveMembers $roleId) | Where-Object { $_.governed } | ForEach-Object { $_.principalId })
        $holders.Count | Should -BeGreaterThan 20
        $gaps = @($holders | Where-Object {
            $principal = $_
            @($grants | Where-Object { -not ($script:membersOf.ContainsKey($_) -and @($script:membersOf[$_] | Where-Object { $_.principalId -eq $principal }).Count) }).Count -gt 0 })
        $gaps.Count | Should -BeGreaterThan 0 -Because 'a governance report exists to show what the role did not deliver'
    }

    It 'has two attestation campaigns, one finished and one still running' {
        $certs = @($script:data.certificationDecisions | Where-Object { $_.reviewInstanceStatus })
        $certs.Count | Should -BeGreaterThan 100
        $statuses = @($certs | Group-Object reviewInstanceStatus | ForEach-Object { $_.Name })
        $statuses | Should -Contain 'Completed'
        $statuses | Should -Contain 'InProgress'
        @($certs | Where-Object { $_.decision -eq 'Deny' }).Count | Should -BeGreaterThan 5
        @($certs | Where-Object { $_.decision -eq 'NotReviewed' }).Count | Should -BeGreaterThan 5 -Because 'an unfinished review has rows nobody decided'
    }
}

Describe 'systems — access that lives somewhere else' {
    It 'has systems that keep their own accounts and one that keeps none' {
        $accountsPerSystem = @($script:data.principals | Group-Object systemId | ForEach-Object { $_.Name })
        $azure = @($script:data.systems | Where-Object { $_.systemType -eq 'AzureRM' })
        $azure.Count | Should -Be 1
        # Azure holds resources but no accounts of its own: its grants point at
        # Entra principals.
        $azureIndex = [array]::IndexOf(@($script:data.systems | ForEach-Object { $_.displayName }), $azure[0].displayName) + 1
        $accountsPerSystem | Should -Not -Contain "$azureIndex"
        @($script:data.systems).Count | Should -BeGreaterOrEqual 7
    }

    It 'inherits Azure access down the scope tree as indirect assignments' {
        $caps = @($script:data.resources | Where-Object { $_.resourceType -eq 'AzureRoleAssignment' })
        $inherited = @($caps | Where-Object { $_.extendedAttributes.PSObject.Properties.Name -contains 'inheritedFrom' })
        $inherited.Count | Should -BeGreaterThan 10 -Because 'a role on a resource group applies to what is inside it'
        $indirect = 0
        foreach ($cap in $inherited) { $indirect += @((Script:LiveMembers $cap.id) | Where-Object { $_.assignmentType -eq 'Indirect' }).Count }
        $indirect | Should -BeGreaterThan 10
    }

    It 'has applications owned by people and by service principals' {
        @($script:data.resources | Where-Object { $_.resourceType -eq 'ApplicationOwnership' }).Count | Should -BeGreaterOrEqual 5
        $spOwned = @($script:data.resources | Where-Object { $_.resourceType -eq 'ServicePrincipalOwnership' })
        $spOwned.Count | Should -BeGreaterOrEqual 3
        $owners = @($spOwned | ForEach-Object { (Script:LiveMembers $_.id) } | ForEach-Object { $script:principalById[$_.principalId].principalType })
        $owners | Should -Contain 'ServicePrincipal'
    }

    It 'holds on-premises AD access on the AD account, not the Entra one' {
        $adSystemIndex = ([array]::IndexOf(@($script:data.systems | ForEach-Object { $_.systemType }), 'ActiveDirectory')) + 1
        $adGroups = @($script:data.resources | Where-Object { $_.systemId -eq $adSystemIndex -and $_.resourceType -eq 'Group' })
        $adGroups.Count | Should -BeGreaterOrEqual 10
        $holders = @($adGroups | ForEach-Object { (Script:LiveMembers $_.id) } | ForEach-Object { $script:principalById[$_.principalId] })
        @($holders | Where-Object { $_.systemId -ne $adSystemIndex }).Count | Should -Be 0 -Because 'only AD accounts hold AD groups; adding up the person needs their identity'
    }
}
