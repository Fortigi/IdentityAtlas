#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the extracted midPoint crawler sync phases
    (MidpointCrawler.Phases.ps1).

.DESCRIPTION
    The Start script's Main body is NOT run — only the dot-sourced sibling files
    are. The midPoint boundary (Invoke-MidpointSearch / Invoke-MidpointSearchStream),
    ingest boundary (Send-IngestBatch / Invoke-IngestAPI) and Invoke-RestMethod are
    mocked/stubbed, so no real HTTP is performed; the pure shapers in
    MidpointCrawler.Transform.ps1 and helpers in Invoke-MidpointApi.ps1 run for real.
    Phases read/write the same $Script:phaseErrors / $Script:fetchStats state they
    do when dot-sourced.

.USAGE
    Invoke-Pester -Path test/unit/MidpointCrawlerPhases.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:midpointDir = Join-Path $script:repoRoot 'tools\crawlers\midpoint'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:midpointDir 'Invoke-MidpointApi.ps1')      # Get-Midpoint* helpers + ConvertTo-MapRows
    . (Join-Path $script:midpointDir 'MidpointCrawler.Functions.ps1') # Send-IngestBatch, Add-PhaseError, Write-Step, streams
    . (Join-Path $script:midpointDir 'MidpointCrawler.Transform.ps1')
    . (Join-Path $script:midpointDir 'MidpointCrawler.Phases.ps1')

    $script:ApiKey     = 'fgc_test'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0

    # Get-MidpointShadowLabel (MidpointCrawler.Functions.ps1) reads cross-phase
    # script state; stub it so the account-shadow transform stays hermetic.
    function Get-MidpointShadowLabel { param($Shadow, $ShadowOid, $ResourceOid) "label:$ShadowOid" }

    function Reset-PhaseTestState {
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:fetchStats  = [ordered]@{}
        $script:ingestStats = [ordered]@{}
        $script:sent        = [System.Collections.Generic.List[object]]::new()
    }
    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; SystemId = $SystemId; Scope = $Scope; Records = @($Records) })
        return @{ inserted = @($Records).Count; updated = 0; deleted = 0 }
    }
    function Get-Sent {
        param([scriptblock]$Where)
        @($script:sent | Where-Object $Where)
    }
    function New-StrSet {
        param([string[]]$Values)
        $s = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($v in $Values) { $s.Add($v) | Out-Null }
        $s
    }
}

# ─── Sync-MidpointSystems ───────────────────────────────────────────────────────
Describe 'Sync-MidpointSystems' {
    BeforeEach { Reset-PhaseTestState }

    It 'registers midPoint + data-holding resources and resolves the system-id map' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'resources' } -MockWith {
            @([pscustomobject]@{ oid = 'res-1'; name = 'AD' }, [pscustomobject]@{ oid = 'res-2'; name = 'EmptyConn' })
        }
        # The shadow scan finds account/entitlement shadows only on res-1.
        Mock Invoke-MidpointSearchStream -MockWith {
            if ($OnPage) { & $OnPage @([pscustomobject]@{ kind = 'account'; oid = 'sh1'; resourceRef = @{ oid = 'res-1' } }) }
            return 1
        }
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith {
            @(
                [pscustomobject]@{ systemType = 'Midpoint'; tenantId = 'https://mp.example.com'; id = 10 }
                [pscustomobject]@{ systemType = 'Midpoint'; tenantId = 'res-1'; id = 11 }
            )
        }

        $r = Sync-MidpointSystems -RestRoot 'https://mp.example.com' -ApiBaseUrl 'https://x/api' -ApiKey 'k'

        $r.midpointSystemId | Should -Be 10
        $r.resourceSystemId['res-1'] | Should -Be 11
        $r.resourceOidToName['res-1'] | Should -Be 'AD'
        # res-2 held no shadows → registered set has only midPoint + res-1.
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Endpoint -eq 'ingest/systems' }
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'throws (critical phase) when the system id cannot be resolved' {
        Mock Invoke-MidpointSearch -MockWith { @() }
        Mock Invoke-MidpointSearchStream -MockWith { 0 }
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith { @() }   # no atlas systems -> id stays 0

        { Sync-MidpointSystems -RestRoot 'https://mp.example.com' -ApiBaseUrl 'https://x/api' -ApiKey 'k' } | Should -Throw
        $script:phaseErrors[0] | Should -BeLike 'Systems:*'
    }
}

# ─── Sync-MidpointOrgs ──────────────────────────────────────────────────────────
Describe 'Sync-MidpointOrgs' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests org contexts and returns the synced-org id set + name map' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'orgs' } -MockWith {
            @(
                [pscustomobject]@{ oid = 'org-root'; name = 'Root' }
                [pscustomobject]@{ oid = 'org-1'; name = 'Sales'; parentOrgRef = @{ oid = 'org-root' } }
            )
        }
        $mapping = ConvertTo-MapRows $null @('orgSubtype', 'contextType')
        $r = Sync-MidpointOrgs -MidpointSystemId 10 -OrgContextMapping $mapping

        (Get-Sent { $_.Endpoint -eq 'ingest/contexts' })[0].Records.Count | Should -Be 2
        $r.syncedOrgIds.Contains('org-1') | Should -BeTrue
        $r.orgOidToName['org-1'] | Should -Be 'Sales'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase error when the org fetch throws' {
        Mock Invoke-MidpointSearch -MockWith { throw 'midPoint 500' }
        Sync-MidpointOrgs -MidpointSystemId 10 -OrgContextMapping (ConvertTo-MapRows $null @('orgSubtype','contextType'))
        $script:phaseErrors[0] | Should -BeLike 'Orgs:*'
    }
}

# ─── Sync-MidpointRefreshViews ──────────────────────────────────────────────────
Describe 'Sync-MidpointRefreshViews' {
    BeforeEach { Reset-PhaseTestState }

    It 'posts to the refresh-views endpoint' {
        Mock Invoke-RestMethod -MockWith { @{} }
        Sync-MidpointRefreshViews -ApiBaseUrl 'https://x/api' -ApiKey 'k'
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -match '/ingest/refresh-views' }
    }

    It 'soft-fails (no throw) when refresh-views errors' {
        Mock Invoke-RestMethod -MockWith { throw 'refresh 500' }
        { Sync-MidpointRefreshViews -ApiBaseUrl 'https://x/api' -ApiKey 'k' } | Should -Not -Throw
    }
}

# ─── Get-MidpointArchetypeLabels ────────────────────────────────────────────────
Describe 'Get-MidpointArchetypeLabels' {
    BeforeEach { Reset-PhaseTestState }

    It 'builds an oid -> labels map from the archetype catalog' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'archetypes' } -MockWith {
            @([pscustomobject]@{ oid = 'arch-1'; name = 'application-role'; displayName = 'Application Role' })
        }
        $labels = Get-MidpointArchetypeLabels
        @($labels['arch-1']) | Should -Contain 'application-role'
        @($labels['arch-1']) | Should -Contain 'Application Role'
    }

    It 'returns an empty map (soft-fail) when the catalog fetch throws' {
        Mock Invoke-MidpointSearch -MockWith { throw 'midPoint 500' }
        (Get-MidpointArchetypeLabels).Count | Should -Be 0
    }
}

# ─── Sync-MidpointResources ─────────────────────────────────────────────────────
Describe 'Sync-MidpointResources' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'buckets roles + services by resourceType and returns the synced-id state' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'roles' } -MockWith {
            @([pscustomobject]@{ oid = 'role-1'; name = 'admin'; displayName = 'Administrator' })
        }
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'services' } -MockWith {
            @([pscustomobject]@{ oid = 'svc-1'; name = 'email'; displayName = 'Email' })
        }
        $mapping = ConvertTo-MapRows $null @('archetype', 'subtype', 'resourceType')
        $r = Sync-MidpointResources -MidpointSystemId 10 -ArchetypeMapping $mapping

        (Get-Sent { $_.Scope.resourceType -eq 'BusinessRole' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.resourceType -eq 'Service' })[0].Records.Count | Should -Be 1
        @($r.allRoles).Count | Should -Be 1
        $r.syncedResourceIds.Contains('role-1') | Should -BeTrue
        $r.syncedResourceIds.Contains('svc-1') | Should -BeTrue
        $r.resourceOidToType['role-1'] | Should -Be 'BusinessRole'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a Roles phase error when the roles fetch throws (services still run)' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'roles' } -MockWith { throw 'roles 500' }
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'services' } -MockWith { @() }
        Sync-MidpointResources -MidpointSystemId 10 -ArchetypeMapping (ConvertTo-MapRows $null @('archetype','subtype','resourceType'))
        $script:phaseErrors | Where-Object { $_ -like 'Roles:*' } | Should -Not -BeNullOrEmpty
    }
}

# ─── Sync-MidpointUsers ─────────────────────────────────────────────────────────
Describe 'Sync-MidpointUsers' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'ingests identities/principals/members and returns the user + shadow-owner maps' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'users' } -MockWith {
            @([pscustomobject]@{ oid = 'u-1'; name = 'alice'; fullName = 'Alice Smith'; linkRef = @(@{ oid = 'sh-1' }) })
        }
        $mapping = ConvertTo-MapRows $null @('userType', 'principalType')
        $r = Sync-MidpointUsers -MidpointSystemId 10 -OrgOidToName @{} -IdentityTypeMapping $mapping

        (Get-Sent { $_.Endpoint -eq 'ingest/identities' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/principals' -and $_.Scope.principalType -eq 'User' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/identity-members' })[0].Records.Count | Should -Be 1
        @($r.allUsers).Count | Should -Be 1
        $r.userOidToName['u-1'] | Should -Be 'Alice Smith'
        $r.shadowOidToUserOid['sh-1'] | Should -Be 'u-1'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a Users phase error when the users fetch throws' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'users' } -MockWith { throw 'users 500' }
        Sync-MidpointUsers -MidpointSystemId 10 -OrgOidToName @{} -IdentityTypeMapping (ConvertTo-MapRows $null @('userType','principalType'))
        $script:phaseErrors[0] | Should -BeLike 'Users:*'
    }
}

# ─── Get-MidpointShadowEntitlementOids (pure) ───────────────────────────────────
Describe 'Get-MidpointShadowEntitlementOids' {
    It 'collects entitlement OIDs from both association[] and referenceAttributes' {
        $shadow = [pscustomobject]@{
            association = @([pscustomobject]@{ shadowRef = @{ oid = 'ent-a' } })
            referenceAttributes = [pscustomobject]@{ group = @([pscustomobject]@{ oid = 'ent-b' }) }
        }
        $oids = Get-MidpointShadowEntitlementOids -Shadow $shadow
        @($oids) | Should -Contain 'ent-a'
        @($oids) | Should -Contain 'ent-b'
    }
    It 'returns empty for a shadow with no entitlement refs' {
        @(Get-MidpointShadowEntitlementOids -Shadow ([pscustomobject]@{})).Count | Should -Be 0
    }
}

# ─── Add-MidpointShadowPage (pass A, pure-ish) ──────────────────────────────────
Describe 'Add-MidpointShadowPage' {
    It 'buckets accounts/entitlements, indexes by DN, and skips un-synced/generic' {
        $resSys   = @{ 'res-1' = 11 }
        $ownerMap = @{ 'acc-sh' = 'u-1' }
        $acct = @{}; $ent = @{}; $members = [System.Collections.Generic.List[object]]::new()
        $skipped = @{ generic = 0; other = 0 }
        $syncedRes = [System.Collections.Generic.HashSet[string]]::new()
        $byDn = @{}
        $page = @(
            [pscustomobject]@{ kind = 'account'; oid = 'acc-sh'; resourceRef = @{ oid = 'res-1' }; name = 'CN=alice' }
            [pscustomobject]@{ kind = 'entitlement'; oid = 'ent-sh'; resourceRef = @{ oid = 'res-1' }; name = 'CN=Admins' }
            [pscustomobject]@{ kind = 'generic'; oid = 'gen'; resourceRef = @{ oid = 'res-1' } }
            [pscustomobject]@{ kind = 'account'; oid = 'x'; resourceRef = @{ oid = 'res-unsynced' } }
        )
        Add-MidpointShadowPage -Page $page -ResourceSystemId $resSys -ShadowOidToUserOid $ownerMap `
            -AcctBySystem $acct -EntBySystem $ent -ShadowMembers $members -Skipped $skipped `
            -SyncedResourceIds $syncedRes -EntitlementByDn $byDn

        $acct[11].Count | Should -Be 1              # only the synced account
        $ent[11].Count | Should -Be 1
        $members.Count | Should -Be 1               # acc-sh owner is known
        $syncedRes.Contains('ent-sh') | Should -BeTrue
        $skipped.generic | Should -Be 1
        ($byDn.Values) | Should -Contain 'ent-sh'
    }
}

# ─── Sync-MidpointShadows (integration) ─────────────────────────────────────────
Describe 'Sync-MidpointShadows' {
    BeforeEach {
        Reset-PhaseTestState
        Mock Send-IngestBatch -MockWith $script:SendMock
        # Stream helpers (pass B) — stub so no real ingest is attempted.
        Mock New-IngestStream -MockWith { [pscustomobject]@{ Records = 0; Inserted = 0; Updated = 0; Deleted = 0 } }
        Mock Add-IngestStreamRecord -MockWith { }
        Mock Complete-IngestStream -MockWith { }
    }

    It 'runs both passes: ingests entitlements/accounts/members and returns the DN index' {
        Mock Invoke-MidpointSearchStream -MockWith {
            if ($OnPage) {
                & $OnPage @(
                    [pscustomobject]@{ kind = 'entitlement'; oid = 'ent-sh'; resourceRef = @{ oid = 'res-1' }; name = 'CN=Admins' }
                    [pscustomobject]@{ kind = 'account'; oid = 'acc-sh'; resourceRef = @{ oid = 'res-1' }; name = 'CN=alice'
                                       association = @([pscustomobject]@{ shadowRef = @{ oid = 'ent-sh' } }) }
                )
            }
            return 2
        }
        $syncedRes = [System.Collections.Generic.HashSet[string]]::new()
        $r = Sync-MidpointShadows -MidpointSystemId 10 -ResourceSystemId @{ 'res-1' = 11 } `
            -ShadowOidToUserOid @{ 'acc-sh' = 'u-1' } -SyncedResourceIds $syncedRes

        (Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'Entitlement' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/principals' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/identity-members' }).Count | Should -BeGreaterThan 0
        ($r.entitlementByDn.Values) | Should -Contain 'ent-sh'
        # Pass B emitted an entitlement assignment via the stream.
        Should -Invoke Add-IngestStreamRecord -Exactly 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase error when the shadow stream throws' {
        Mock Invoke-MidpointSearchStream -MockWith { throw 'shadows 500' }
        Sync-MidpointShadows -MidpointSystemId 10 -ResourceSystemId @{} -ShadowOidToUserOid @{} `
            -SyncedResourceIds ([System.Collections.Generic.HashSet[string]]::new())
        $script:phaseErrors[0] | Should -BeLike 'Shadows:*'
    }
}

# ─── Sync-MidpointOrgMembership ─────────────────────────────────────────────────
Describe 'Sync-MidpointOrgMembership' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'emits context members for synced orgs only, deduped' {
        $users = @(
            [pscustomobject]@{ oid = 'u-1'; parentOrgRef = @([pscustomobject]@{ oid = 'org-1' }, [pscustomobject]@{ oid = 'org-unsynced' }) }
            [pscustomobject]@{ oid = 'u-2'; parentOrgRef = @([pscustomobject]@{ oid = 'org-1' }) }
        )
        $synced = New-StrSet 'org-1'
        Sync-MidpointOrgMembership -MidpointSystemId 10 -AllUsers $users -SyncedOrgIds $synced

        $sent = (Get-Sent { $_.Endpoint -eq 'ingest/context-members' })[0]
        $sent.Records.Count | Should -Be 2   # (org-1,u-1) + (org-1,u-2); org-unsynced skipped
        $script:phaseErrors.Count | Should -Be 0
    }
}

# ─── Assignment passes (pure) + Sync-MidpointAssignments ────────────────────────
Describe 'Sync-MidpointAssignments' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'emits direct + inherited assignments, direct winning ties, bucketed by resourceType' {
        $users = @([pscustomobject]@{
            oid = 'u-1'
            assignment       = @([pscustomobject]@{ targetRef = [pscustomobject]@{ oid = 'role-1'; type = 'c:RoleType' } })
            roleMembershipRef = @(
                [pscustomobject]@{ oid = 'role-1'; type = 'c:RoleType'; relation = 'org:default' }   # dup of direct -> skipped
                [pscustomobject]@{ oid = 'role-2'; type = 'c:RoleType'; relation = 'org:default' }    # inherited
            )
        })
        $synced = New-StrSet @('role-1','role-2')
        $types  = @{ 'role-1' = 'BusinessRole'; 'role-2' = 'BusinessRole' }
        Sync-MidpointAssignments -MidpointSystemId 10 -AllUsers $users -SyncedResourceIds $synced -ResourceOidToType $types

        $sent = (Get-Sent { $_.Scope.resourceType -eq 'BusinessRole' -and $_.Scope.assignmentType -eq 'Direct' })[0]
        $sent.Records.Count | Should -Be 2   # role-1 (direct) + role-2 (inherited); role-1 not double-counted
        (@($sent.Records | Where-Object { $_.resourceId -eq 'role-1' }).extendedAttributes.grant) | Should -Be 'direct'
        (@($sent.Records | Where-Object { $_.resourceId -eq 'role-2' }).extendedAttributes.grant) | Should -Be 'inherited'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase error when the ingest throws' {
        Mock Send-IngestBatch -MockWith { throw 'ingest 500' }
        $users = @([pscustomobject]@{ oid = 'u'; assignment = @([pscustomobject]@{ targetRef = [pscustomobject]@{ oid = 'r'; type = 'c:RoleType' } }) })
        Sync-MidpointAssignments -MidpointSystemId 10 -AllUsers $users -SyncedResourceIds (New-StrSet 'r') -ResourceOidToType @{ 'r' = 'BusinessRole' }
        $script:phaseErrors[0] | Should -BeLike 'Assignments:*'
    }
}

# ─── Get-MidpointRoleNestingEdges (pure) + Sync-MidpointRoleNesting ──────────────
Describe 'Role nesting' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'Get-MidpointRoleNestingEdges emits targetRef + construction Contains edges' {
        $role = [pscustomobject]@{
            oid = 'parent'
            inducement = @(
                [pscustomobject]@{ targetRef = [pscustomobject]@{ oid = 'child'; type = 'c:RoleType' } }
                [pscustomobject]@{ construction = [pscustomobject]@{ association = [pscustomobject]@{ shadowRef = [pscustomobject]@{ oid = 'ent-1' } } } }
            )
        }
        $stats = @{ targetRef = 0; construction = 0; unresolved = 0 }
        $edges = Get-MidpointRoleNestingEdges -Role $role -SyncedResourceIds (New-StrSet @('child','ent-1')) `
            -EntitlementByDn @{} -Seen ([System.Collections.Generic.HashSet[string]]::new()) -Stats $stats
        @($edges).Count | Should -Be 2
        $stats.targetRef | Should -Be 1
        $stats.construction | Should -Be 1
    }

    It 'Sync-MidpointRoleNesting ingests the Contains relationships' {
        $roles = @([pscustomobject]@{ oid = 'parent'; inducement = @([pscustomobject]@{ targetRef = [pscustomobject]@{ oid = 'child'; type = 'c:RoleType' } }) })
        Sync-MidpointRoleNesting -MidpointSystemId 10 -AllRoles $roles -SyncedResourceIds (New-StrSet @('child')) -EntitlementByDn @{}
        (Get-Sent { $_.Scope.relationshipType -eq 'Contains' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'Sync-MidpointRoleNesting sends nothing when there are no roles (no reconcile → no deletes)' {
        Sync-MidpointRoleNesting -MidpointSystemId 10 -AllRoles $null -SyncedResourceIds (New-StrSet @()) -EntitlementByDn @{}
        @(Get-Sent { $_.Scope.relationshipType -eq 'Contains' }).Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }
}

# ─── Sync-MidpointReviews ───────────────────────────────────────────────────────
Describe 'Sync-MidpointReviews' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'maps role/service campaign cases on synced resources to certification decisions' {
        Mock Invoke-MidpointSearch -ParameterFilter { $Type -eq 'accessCertificationCampaigns' } -MockWith {
            @([pscustomobject]@{ oid = 'camp-1'; name = 'Q1 review'; state = 'closed'
                case = @(
                    [pscustomobject]@{ '@id' = '1'; objectRef = @{ oid = 'u-1' }; targetRef = [pscustomobject]@{ oid = 'role-1'; type = 'c:RoleType' }; outcome = 'accept' }
                    [pscustomobject]@{ '@id' = '2'; objectRef = @{ oid = 'u-1' }; targetRef = [pscustomobject]@{ oid = 'org-x'; type = 'c:OrgType' }; outcome = 'accept' }   # org -> skipped
                ) })
        }
        Sync-MidpointReviews -MidpointSystemId 10 -SyncedResourceIds (New-StrSet 'role-1') -UserOidToName @{ 'u-1' = 'Alice' }

        (Get-Sent { $_.Endpoint -eq 'ingest/governance/certifications' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase error when the campaign fetch throws' {
        Mock Invoke-MidpointSearch -MockWith { throw 'campaigns 500' }
        Sync-MidpointReviews -MidpointSystemId 10 -SyncedResourceIds (New-StrSet 'x') -UserOidToName @{}
        $script:phaseErrors[0] | Should -BeLike 'Reviews:*'
    }
}

# ─── Resolve-MidpointConfig ─────────────────────────────────────────────────────
Describe 'Resolve-MidpointConfig' {
    It 'defaults every phase toggle on and fills sensible defaults' {
        $p = Join-Path $TestDrive 'cfg-defaults.json'
        '{ "baseUrl": "https://mp.example.com", "authMethod": "BasicAuth" }' | Set-Content -Path $p
        $r = Resolve-MidpointConfig -ConfigPath $p
        $r.cfg.baseUrl | Should -Be 'https://mp.example.com'
        $r.syncMode    | Should -Be 'full'
        $r.pageSize    | Should -Be 100
        foreach ($k in @('systems','orgs','roles','services','users','shadows','orgMembership','assignments','roleNesting','reviews')) {
            $r.sync[$k] | Should -BeTrue
        }
        $r.crossSystemEntities | Should -Contain 'context-members'
    }

    It 'honours selectedObjects toggles, syncShadows, _syncMode and pageSize' {
        $p = Join-Path $TestDrive 'cfg-toggles.json'
        @'
{
  "baseUrl": "https://mp.example.com",
  "authMethod": "ApiToken",
  "pageSize": 250,
  "syncShadows": false,
  "_syncMode": "delta",
  "selectedObjects": { "reviews": false, "roles": false }
}
'@ | Set-Content -Path $p
        $r = Resolve-MidpointConfig -ConfigPath $p
        $r.pageSize        | Should -Be 250
        $r.syncMode        | Should -Be 'delta'
        $r.sync.shadows    | Should -BeFalse
        $r.sync.reviews    | Should -BeFalse
        $r.sync.roles      | Should -BeFalse
        $r.sync.users      | Should -BeTrue
    }

    It 'falls back to full sync mode for an unknown _syncMode value' {
        $p = Join-Path $TestDrive 'cfg-badmode.json'
        '{ "baseUrl": "u", "authMethod": "BasicAuth", "_syncMode": "bogus" }' | Set-Content -Path $p
        (Resolve-MidpointConfig -ConfigPath $p).syncMode | Should -Be 'full'
    }

    It 'throws when the config file does not exist' {
        { Resolve-MidpointConfig -ConfigPath (Join-Path $TestDrive 'missing.json') } | Should -Throw '*not found*'
    }
}

# ─── Connect-MidpointSession ────────────────────────────────────────────────────
Describe 'Connect-MidpointSession' {
    It 'passes only the credential fields that are present to Connect-MidpointAPI' {
        Mock Connect-MidpointAPI -MockWith { }
        $cfg = [pscustomobject]@{ baseUrl = 'https://mp'; authMethod = 'BasicAuth'; username = 'admin'; password = 'pw' }
        Connect-MidpointSession -Cfg $cfg
        Should -Invoke Connect-MidpointAPI -Exactly 1 -ParameterFilter {
            $BaseUrl -eq 'https://mp' -and $AuthMethod -eq 'BasicAuth' -and $Username -eq 'admin' -and $Password -eq 'pw'
        }
    }

    It 'forwards OAuth2 client-credential fields when configured' {
        Mock Connect-MidpointAPI -MockWith { }
        $cfg = [pscustomobject]@{ baseUrl = 'https://mp'; authMethod = 'OAuth2CC'; clientId = 'cid'; clientSecret = 'sec'; tokenEndpoint = 'https://t' }
        Connect-MidpointSession -Cfg $cfg
        Should -Invoke Connect-MidpointAPI -Exactly 1 -ParameterFilter {
            $ClientId -eq 'cid' -and $ClientSecret -eq 'sec' -and $TokenEndpoint -eq 'https://t'
        }
    }
}

# ─── Write-MidpointPerfSummary ──────────────────────────────────────────────────
Describe 'Write-MidpointPerfSummary' {
    # This is the operator's only view of where a midPoint run spent its time, and
    # it was asserted only for "does not throw" -- so every figure in it, and both
    # section guards, could have been wrong. The numbers ARE the behaviour here.
    # Decimal separators are culture-dependent ({N1} formatting), hence [.,].
    BeforeEach {
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        $script:swMaster = [System.Diagnostics.Stopwatch]::StartNew()
    }

    It 'stops the master stopwatch and prints both sections with their figures' {
        $script:fetchStats  = [ordered]@{ users = @{ seconds = 1.2; count = 3 } }
        $script:ingestStats = [ordered]@{ 'ingest/users' = @{ seconds = 0.5; calls = 2; records = 10 } }

        Write-MidpointPerfSummary

        $script:swMaster.IsRunning | Should -BeFalse
        $out = $script:said -join "`n"
        $out | Should -Match 'midPoint reads:'
        $out | Should -Match 'users\s+1[.,]2s\s+\(3 objects\)'
        # 10 records in 0.5s is 20/s -- the one figure here that is computed rather
        # than echoed, so it is the one that can silently be nonsense.
        $out | Should -Match 'ingest/users\s+0[.,]5s /\s*2 /\s*10 .+ 20 rec/s'
        $out | Should -Match 'ingest TOTAL\s+0[.,]5s total'
    }

    It 'reports 0 rec/s for an endpoint that took no measurable time' {
        # The -gt 0 guard is what stops a divide-by-zero. Every existing fixture had
        # a non-zero duration, so the guard could be removed without complaint; a
        # zero-second entry is what makes it divide.
        $script:fetchStats  = [ordered]@{}
        $script:ingestStats = [ordered]@{ 'ingest/fast' = @{ seconds = 0; calls = 1; records = 5 } }

        { Write-MidpointPerfSummary } | Should -Not -Throw

        ($script:said -join "`n") | Should -Match 'ingest/fast\s+0[.,]0s / \s*1 /\s*5 .+ 0 rec/s'
    }

    It 'prints neither section when nothing was recorded' {
        $script:fetchStats  = [ordered]@{}
        $script:ingestStats = [ordered]@{}

        Write-MidpointPerfSummary

        $out = $script:said -join "`n"
        $out | Should -Match 'Total wall-clock'
        $out | Should -Not -Match 'midPoint reads:'
        $out | Should -Not -Match 'Ingest API'
    }
}

# ─── Complete-MidpointRun ───────────────────────────────────────────────────────
Describe 'Complete-MidpointRun' {
    BeforeEach { Reset-PhaseTestState; Mock Update-CrawlerProgress -MockWith { } }

    It 'marks progress complete and does not throw when there are no phase errors' {
        { Complete-MidpointRun } | Should -Not -Throw
        Should -Invoke Update-CrawlerProgress -Exactly 1 -ParameterFilter { $Step -eq 'Complete' -and $Pct -eq 100 }
    }

    It 'fails the run on a SINGLE phase error' {
        # The other failure test records two errors, so it cannot tell `Count -gt 0`
        # from `-gt 1`. Read as -gt 1, a run in which exactly one phase failed
        # finishes silently and the worker marks the job successful -- the one
        # failure mode this function exists to prevent.
        $script:phaseErrors.Add('Users: boom')
        { Complete-MidpointRun } | Should -Throw '*completed with errors: Users: boom*'
    }

    It 'throws a summary error when phases recorded failures' {
        $script:phaseErrors.Add('Users: boom')
        $script:phaseErrors.Add('Shadows: kaboom')
        { Complete-MidpointRun } | Should -Throw '*completed with errors: Users: boom; Shadows: kaboom*'
    }
}
