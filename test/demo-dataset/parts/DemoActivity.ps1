<#
.SYNOPSIS
    Fortigi Demo Corp — sign-in activity, and the account states the standard
    governance audit reports are supposed to find.

.DESCRIPTION
    Everything the rest of the dataset models is STATE: who holds what. This
    part adds the other axis an auditor always asks about — is the account
    actually being used, and by whom — plus the handful of account states that
    each standard report is meant to surface, so no report is empty on the demo
    data and an empty one is therefore a real failure.

    ACTIVITY IS A SNAPSHOT WITH A MEASUREMENT MOMENT. PrincipalActivity rows
    carry the timestamps a crawler last read, and `updatedAt` says when it read
    them. The demo cannot hardcode an absolute date without going stale, so
    every timestamp is generated relative to the generation moment, and the
    measurement moment is "just now" — which is also what makes the reports'
    freshness warning quiet on a freshly loaded demo and noisy on a stale one.

    The cast this part adds, one per report that needs it:

      Stale accounts        — three employees whose last sign-in is 120 / 200 /
                              400 days back. They already hold access from the
                              other parts, which is the second half of the
                              finding.
      Never signed in       — Zara Intern (the existing zero-access new hire)
                              gets an activity row with no timestamps at all,
                              so "never" is a real row rather than a missing one.
      Guests                — one stale guest and one whose invitation was never
                              accepted.
      Disabled with access  — the existing leaver Alex Former is given the
                              access he was never stripped of, plus a disabled
                              shared admin account.
      Privileged accounts   — a second admin account correlated to the CTO's
                              identity (so one person holds two), and an
                              eligible (PIM) directory-role assignment.
      Empty groups          — one group nobody is in.

    Access outside roles and missing managers need nothing here: Lars Muller's
    ungoverned direct grant on SG-Servicedesk-Tools (DemoRoleDrift.ps1) is
    already the former, and the CEO has no manager, which is the latter.
#>

Set-StrictMode -Version Latest

# The aggregate-row sentinel from migration 017. Real activity rows use a target
# resource id; the per-principal summary uses this.
$script:DemoAggResourceId = '00000000-0000-0000-0000-000000000000'

# Employees whose accounts went quiet, and how many days ago. Chosen to straddle
# the reports' default thresholds: 120 and 200 are stale at 90 days, 400 is stale
# at any threshold, and 3 days is the control that must NOT be listed.
$script:DemoStaleSignIns = @(
    @{ Emp = 'E0021'; DaysAgo = 120 }   # Ingrid Larsen  — QA Engineer
    @{ Emp = 'E0026'; DaysAgo = 200 }   # Olivia Park    — Accountant
    @{ Emp = 'E0034'; DaysAgo = 400 }   # Tom Bakker     — transferred out, never cleaned up
)

# The control group: recently active, so the stale report has something to NOT
# list and the list column has something to sort above the stale ones.
$script:DemoRecentSignIns = @(
    @{ Emp = 'E0001'; DaysAgo = 0 }
    @{ Emp = 'E0002'; DaysAgo = 1 }
    @{ Emp = 'E0013'; DaysAgo = 2 }
    @{ Emp = 'E0032'; DaysAgo = 3 }
    @{ Emp = 'E0029'; DaysAgo = 5 }
    @{ Emp = 'E0030'; DaysAgo = 8 }
)

function New-DemoActivityRecord {
    <#
    .SYNOPSIS
        One PrincipalActivity record. A $null DaysAgo means "never signed in" —
        the row exists, every timestamp is absent, which is exactly the state
        the never-signed-in report looks for.
    #>
    param(
        [Parameter(Mandatory)][string]$PrincipalId,
        [Parameter(Mandatory)][datetime]$MeasuredAt,
        [object]$DaysAgo,
        [string]$ActivityType = 'SignIn',
        [string]$ResourceId = $script:DemoAggResourceId,
        [int]$NonInteractiveOffsetDays = 0,
        [object]$SignInCount,
        [hashtable]$Extended
    )
    $rec = @{
        principalId  = $PrincipalId
        resourceId   = $ResourceId
        activityType = $ActivityType
    }
    if ($null -ne $DaysAgo) {
        $last = $MeasuredAt.AddDays(-[int]$DaysAgo)
        $rec['lastSignInDateTime']           = $last.ToString('o')
        $rec['lastSuccessfulSignInDateTime'] = $last.ToString('o')
        $rec['lastNonInteractiveSignInDateTime'] =
            $last.AddDays(-$NonInteractiveOffsetDays).ToString('o')
    }
    if ($null -ne $SignInCount) { $rec['signInCount']        = [int]$SignInCount }
    if ($Extended)              { $rec['extendedAttributes'] = $Extended }
    return $rec
}

function Add-DemoActivity {
    param([Parameter(Mandatory)]$State)

    # One measurement moment for the whole dataset — it was all "collected" by
    # the same synthetic crawl.
    $measuredAt = [datetime]::UtcNow
    $State['ActivityMeasuredAt'] = $measuredAt

    foreach ($entry in ($script:DemoRecentSignIns + $script:DemoStaleSignIns)) {
        $State.PrincipalActivity.Add((New-DemoActivityRecord `
            -PrincipalId (Get-DemoPrincipalId $entry.Emp) -MeasuredAt $measuredAt `
            -DaysAgo $entry.DaysAgo -NonInteractiveOffsetDays 0 -SignInCount (40 - $entry.DaysAgo % 37)))
    }

    # The new hire who was provisioned and never logged in: a row with no
    # timestamps, which is a different fact from having no row at all.
    $State.PrincipalActivity.Add((New-DemoActivityRecord `
        -PrincipalId (Get-DemoPrincipalId 'E0031') -MeasuredAt $measuredAt -DaysAgo $null))

    Add-DemoServicePrincipalActivity $State $measuredAt
    Add-DemoPerAppActivity           $State $measuredAt
    Add-DemoAuditCast                $State $measuredAt
}

# The service-principal aggregate: the report behind it reports four flavours,
# two of which have no column of their own and ride in extendedAttributes. The
# detail page renders whatever it finds there, so this is what proves it.
function Add-DemoServicePrincipalActivity {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][datetime]$MeasuredAt)

    $State.PrincipalActivity.Add((New-DemoActivityRecord `
        -PrincipalId $State.EdgeCaseIds.SvcPrinc -MeasuredAt $MeasuredAt -DaysAgo 1 `
        -ActivityType 'ServicePrincipalSignIn' -SignInCount 4210 -Extended @{
            lastSignInDateTime_applicationAuthentication = $MeasuredAt.AddDays(-1).ToString('o')
            lastSignInDateTime_delegatedClient           = $MeasuredAt.AddDays(-9).ToString('o')
        }))

    # The AI agent is the quiet one — a non-human account nobody notices going
    # unused, which is the whole reason activity is worth showing for them.
    $State.PrincipalActivity.Add((New-DemoActivityRecord `
        -PrincipalId $State.EdgeCaseIds.AIAgent -MeasuredAt $MeasuredAt -DaysAgo 150 `
        -ActivityType 'ServicePrincipalSignIn' -SignInCount 12 -Extended @{
            lastSignInDateTime_applicationAuthentication = $MeasuredAt.AddDays(-150).ToString('o')
        }))
}

# "Last used per app" — only collected when the optional sign-in-logs phase runs,
# so the demo carries a few so the detail page's per-app table is exercised.
function Add-DemoPerAppActivity {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][datetime]$MeasuredAt)

    foreach ($use in @(
        @{ Emp = 'E0032'; App = $State.EdgeCaseIds.SvcPrinc; DaysAgo = 3;   Count = 88 }
        @{ Emp = 'E0032'; App = $State.EdgeCaseIds.AIAgent;  DaysAgo = 21;  Count = 4 }
        @{ Emp = 'E0002'; App = $State.EdgeCaseIds.SvcPrinc; DaysAgo = 1;   Count = 310 }
    )) {
        $State.PrincipalActivity.Add((New-DemoActivityRecord `
            -PrincipalId (Get-DemoPrincipalId $use.Emp) -MeasuredAt $MeasuredAt `
            -DaysAgo $use.DaysAgo -ActivityType 'SignInPerApp' -ResourceId $use.App `
            -SignInCount $use.Count))
    }
}

# The account states each remaining report is meant to find.
function Add-DemoAuditCast {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][datetime]$MeasuredAt)

    $sysEntra = $State.SystemIds['entra']
    $res      = $State.Res

    # ── Guests ───────────────────────────────────────────────────────────────
    # userType/externalUserState are where the crawler puts them, so the reports
    # read them from extendedAttributes rather than from a column.
    $guestStale   = New-DemoGuid 'principal-GUEST-001'
    $guestPending = New-DemoGuid 'principal-GUEST-002'

    $null = Add-DemoPrincipal $State -Record @{
        id = $guestStale; displayName = 'Marta Ferreira (Guest)'
        email = 'marta.ferreira@partner-agency.com'; principalType = 'ExternalUser'
        accountEnabled = $true; systemId = $sysEntra
        extendedAttributes = @{ userType = 'Guest'; externalUserState = 'Accepted' }
    }
    $null = Add-DemoPrincipal $State -Record @{
        id = $guestPending; displayName = 'Ronan Byrne (Guest)'
        email = 'ronan.byrne@consultancy.example'; principalType = 'ExternalUser'
        accountEnabled = $true; systemId = $sysEntra
        extendedAttributes = @{ userType = 'Guest'; externalUserState = 'PendingAcceptance' }
    }

    # The stale guest signed in once, long ago, and still holds a group. The
    # pending one never signed in at all — no activity row, because an
    # invitation that was never accepted never produced one.
    $State.PrincipalActivity.Add((New-DemoActivityRecord `
        -PrincipalId $guestStale -MeasuredAt $MeasuredAt -DaysAgo 240 -SignInCount 3))
    Add-DemoAssignment $State -ResourceId $res.AllEmp -PrincipalId $guestStale -AssignmentType 'Direct'

    # ── Disabled, but still entitled ─────────────────────────────────────────
    # The leaver kept his access: disabling blocked his sign-in and stripped
    # nothing, which is the finding.
    Add-DemoAssignment $State -ResourceId $res.AllEmp -PrincipalId $State.EdgeCaseIds.Disabled -AssignmentType 'Direct'
    Add-DemoAssignment $State -ResourceId $res.VPN    -PrincipalId $State.EdgeCaseIds.Disabled -AssignmentType 'Direct'

    $disabledAdmin = New-DemoGuid 'principal-ADM-002'
    $null = Add-DemoPrincipal $State -Record @{
        id = $disabledAdmin; displayName = 'svc-legacy-admin'
        principalType = 'User'; accountEnabled = $false; systemId = $sysEntra
        extendedAttributes = @{ userType = 'Member' }
    }
    Add-DemoAssignment $State -ResourceId $res.AdminTier0 -PrincipalId $disabledAdmin -AssignmentType 'Direct'

    Add-DemoPrivilegedCast $State $MeasuredAt

    # ── An empty group ───────────────────────────────────────────────────────
    # Created for a project that never started: it grants nobody anything, and
    # will silently grant whoever is added to it next.
    $null = Add-DemoResource $State -Id (New-DemoGuid 'res-sg-project-atlas') `
        -DisplayName 'SG-Project-Atlas' -ResourceType 'Group' -SystemId $sysEntra `
        -Description 'Project Atlas collaboration group — created during planning, never populated.'
}

# The CTO's second admin account: one person, two privileged accounts, which is
# the cross-check the privileged report exists to make visible. The eligible
# (PIM) assignment on it is the other half — standing versus just-in-time
# privilege have to be told apart.
function Add-DemoPrivilegedCast {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][datetime]$MeasuredAt)

    $adminAlt = New-DemoGuid 'principal-E0002-admin'
    $null = Add-DemoPrincipal $State -Record @{
        id = $adminAlt; displayName = 'Bob Chen (Admin)'
        email = 'adm.bob.chen@fortigidemo.com'; principalType = 'User'
        accountEnabled = $true; employeeId = 'E0002'; systemId = $State.SystemIds['entra']
        extendedAttributes = @{ userType = 'Member' }
    }
    Add-DemoIdentityMember $State -IdentityId (Get-DemoIdentityId 'E0002') -PrincipalId $adminAlt `
        -DisplayName 'Bob Chen (Admin)' -AccountType 'EntraID-Admin'

    Add-DemoAssignment $State -ResourceId $State.Res.SPAdmin -PrincipalId $adminAlt -AssignmentType 'Eligible'

    $State.PrincipalActivity.Add((New-DemoActivityRecord `
        -PrincipalId $adminAlt -MeasuredAt $MeasuredAt -DaysAgo 95 -SignInCount 6))
}
