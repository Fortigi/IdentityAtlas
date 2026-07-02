#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the extracted Entra ID crawler sync phases
    (EntraIDCrawler.Phases.ps1).

.DESCRIPTION
    Covers the "leaf" sync phases moved verbatim out of Start-EntraIDCrawler.ps1's
    top-level body — the ones that consume no earlier-phase state and return
    nothing to a later phase:

        Sync-EntraOAuth2Grants, Sync-EntraAppRoles (+ its helpers
        Add-EntraAppRoleAssignment, Expand-EntraAppRoleGroupAssignments,
        Get-EntraAppRoleAssignmentData, Send-EntraAppRoleBatches),
        Sync-EntraDirectoryRoles.

    The Start script's body is NOT run — only the dot-sourced sibling files are.
    The Graph boundary (Invoke-FGGetRequest) and the ingest boundary
    (Send-IngestBatch) are mocked, so no real HTTP is performed; the pure record
    shapers in EntraIDCrawler.Transform.ps1 run for real. The phases read/write
    the same $script:phaseErrors / $script:phases state they do when dot-sourced
    into the Start script.

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerPhases.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    # Update-CrawlerProgress / ConvertTo-JsonArray / Invoke-IngestAPI live here.
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    # Send-IngestBatch, Write-Phase, New-AppRoleResourceId, New-OAuth2ScopeResourceId,
    # Format-FGDelegatedPermissionName, Resolve-DirectoryRolePrincipalType.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    # ConvertTo-*/New-* pure record shapers the phases call.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Transform.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Phases.ps1')

    # Script-scope state the phases + shared helpers read at call time.
    $script:ApiKey     = 'fgc_testkey'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0

    # The Graph SDK function the phases call. Defined as a stub so Pester can Mock
    # it; every test overrides it with -ParameterFilter on the URI.
    function Invoke-FGGetRequest { param([string]$URI, [int]$MaxRetries, [int]$TimeoutSec) }

    # Add-FGEntraCalculatedAttributes is a Graph SDK helper (own tests) that
    # ConvertTo-EntraGroupResourceRecord calls. Stub it so the group shaper stays
    # hermetic — same stub the Transform suite uses.
    function Add-FGEntraCalculatedAttributes {
        param($Object, $Ext, $Type)
        if ($Object.onPremisesDistinguishedName) { $Ext['_calc'] = $Type }
    }

    # Reset the shared per-phase accumulators (Pester forbids a root-level
    # BeforeEach, so each Describe calls this from its own BeforeEach).
    function Reset-PhaseTestState {
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:phases      = [System.Collections.Generic.List[object]]::new()
        $script:sent        = [System.Collections.Generic.List[object]]::new()
    }

    # MockWith body for Send-IngestBatch: captures every upload so tests can
    # assert what was sent (records + scope), without any real HTTP.
    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{
            Endpoint = $Endpoint
            SystemId = $SystemId
            SyncMode = $SyncMode
            Scope    = $Scope
            Records  = @($Records)
        })
        return @{ inserted = @($Records).Count; updated = 0; deleted = 0 }
    }

    # Small helper: the captured Send-IngestBatch call(s) whose scope matches a filter.
    function Get-Sent {
        param([scriptblock]$Where)
        @($script:sent | Where-Object $Where)
    }
}

# ─── Sync-EntraDirectoryRoles ───────────────────────────────────────────────────
Describe 'Sync-EntraDirectoryRoles' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }


    It 'uploads role resources + deduped active + eligible assignments' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleDefinitions' } -MockWith {
            @(
                [pscustomobject]@{ id = 'r1'; displayName = 'Global Admin'; isEnabled = $true
                    rolePermissions = @([pscustomobject]@{ allowedResourceActions = @('microsoft.directory/x') }) }
                [pscustomobject]@{ id = 'r2'; displayName = 'Reader'; isEnabled = $true }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleAssignments' } -MockWith {
            @(
                [pscustomobject]@{ id = 'ra1'; principalId = 'u1'; roleDefinitionId = 'r1'
                    principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' } }
                # Duplicate (u1,r1) at a different scope — must collapse to one row.
                [pscustomobject]@{ id = 'ra2'; principalId = 'u1'; roleDefinitionId = 'r1'
                    principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' } }
                [pscustomobject]@{ id = 'ra3'; principalId = 'u2'; roleDefinitionId = 'r2'
                    principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.group' } }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleEligibilityScheduleInstances' } -MockWith {
            @([pscustomobject]@{ id = 'e1'; principalId = 'u3'; roleDefinitionId = 'r1'; endDateTime = '2026-01-01T00:00:00Z'
                principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' } })
        }

        $timings = [ordered]@{}
        Sync-EntraDirectoryRoles -SystemId 7 -Timings $timings

        (Get-Sent { $_.Scope.resourceType -eq 'EntraRole' -and $_.Endpoint -eq 'ingest/resources' })[0].Records.Count | Should -Be 2
        $active = Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'EntraRole' }
        $active[0].Records.Count | Should -Be 2   # (u1,r1) deduped, plus (u2,r2)
        $eligible = Get-Sent { $_.Scope.assignmentType -eq 'Eligible' -and $_.Scope.resourceType -eq 'EntraRole' }
        $eligible[0].Records.Count | Should -Be 1

        $timings.Contains('DirectoryRoles') | Should -BeTrue
        ($script:phases | Where-Object { $_.name -eq 'DirectoryRoles' }).status | Should -Be 'ok'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'still uploads roles + active when PIM eligibility is unavailable (soft-fail)' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleDefinitions' } -MockWith {
            @([pscustomobject]@{ id = 'r1'; displayName = 'Global Admin'; isEnabled = $true })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleAssignments' } -MockWith {
            @([pscustomobject]@{ id = 'ra1'; principalId = 'u1'; roleDefinitionId = 'r1'
                principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' } })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleEligibilityScheduleInstances' } -MockWith { throw 'HTTP 403 (no P2)' }

        Sync-EntraDirectoryRoles -SystemId 1 -Timings ([ordered]@{})

        (Get-Sent { $_.Scope.resourceType -eq 'EntraRole' -and $_.Endpoint -eq 'ingest/resources' }).Count | Should -Be 1
        (Get-Sent { $_.Scope.assignmentType -eq 'Eligible' }).Count | Should -Be 0
        # Inner catch swallows PIM failure — the phase itself is not marked failed.
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the role catalog fetch throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'roleDefinitions' } -MockWith { throw 'Graph 500' }

        Sync-EntraDirectoryRoles -SystemId 1 -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'DirectoryRoles:*'
        ($script:phases | Where-Object { $_.name -eq 'DirectoryRoles' }).status | Should -Be 'failed'
    }
}

# ─── Sync-EntraOAuth2Grants ─────────────────────────────────────────────────────
Describe 'Sync-EntraOAuth2Grants' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }


    It 'ingests per-user consents as apps, scope resources, relationships and assignments' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith {
            @(
                [pscustomobject]@{ id = 'g1'; consentType = 'Principal'; principalId = 'u1'
                    clientId = 'cli'; resourceId = 'api'; scope = 'Mail.Read User.Read' }
                # Tenant-wide consent — must be skipped.
                [pscustomobject]@{ id = 'g2'; consentType = 'AllPrincipals'; principalId = $null
                    clientId = 'cli'; resourceId = 'api'; scope = 'Directory.Read.All' }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/cli' } -MockWith {
            [pscustomobject]@{ id = 'cli'; displayName = 'Client App'; appId = 'app-cli'; publisherName = 'Acme' }
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/api' } -MockWith {
            [pscustomobject]@{ id = 'api'; displayName = 'Graph API'; appId = 'app-api'; publisherName = 'MS' }
        }

        Sync-EntraOAuth2Grants -SystemId 3 -Timings ([ordered]@{})

        (Get-Sent { $_.Scope.resourceType -eq 'Application' })[0].Records.Count | Should -Be 1
        # Two scopes -> two DelegatedPermission resources + two assignments.
        (Get-Sent { $_.Scope.resourceType -eq 'DelegatedPermission' -and $_.Endpoint -eq 'ingest/resources' })[0].Records.Count | Should -Be 2
        (Get-Sent { $_.Scope.relationshipType -eq 'DelegatesScope' })[0].Records.Count | Should -Be 2
        $assigns = Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'DelegatedPermission' }
        $assigns[0].Records.Count | Should -Be 2
        $assigns[0].Records[0].principalId | Should -Be 'u1'
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'ingests nothing when there are no per-user consents' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith {
            @([pscustomobject]@{ id = 'g2'; consentType = 'AllPrincipals'; principalId = $null; clientId = 'c'; resourceId = 'a'; scope = 'X' })
        }

        Sync-EntraOAuth2Grants -SystemId 1 -Timings ([ordered]@{})

        (Get-Sent { $_.Scope.resourceType -eq 'DelegatedPermission' }).Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the grants fetch throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith { throw 'Graph 403' }

        Sync-EntraOAuth2Grants -SystemId 1 -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'OAuth2Grants:*'
    }
}

# ─── Add-EntraAppRoleAssignment ─────────────────────────────────────────────────
Describe 'Add-EntraAppRoleAssignment' {

    BeforeEach {
        Reset-PhaseTestState
        $script:sp = [pscustomobject]@{ id = 'sp1'; displayName = 'App One' }
        $script:rolesByGuid = @{ 'role-a' = [pscustomobject]@{ id = 'role-a'; displayName = 'Admin'; value = 'admin' } }
        $script:appRoleMap = @{}
        $script:relMap     = @{}
        $script:directAssns = [System.Collections.Generic.List[object]]::new()
        $script:groupAssns  = @{}
    }

    It 'adds a User assignment plus the AppRole resource and HasAppRole relationship' {
        $a = [pscustomobject]@{ id = 'aa1'; appRoleId = 'role-a'; principalId = 'u1'; principalType = 'User' }
        Add-EntraAppRoleAssignment -Assignment $a -ServicePrincipal $script:sp -RolesByGuid $script:rolesByGuid `
            -DefaultRoleId '00000000-0000-0000-0000-000000000000' -AppRoleMap $script:appRoleMap `
            -RelMap $script:relMap -DirectAssns $script:directAssns -GroupAssns $script:groupAssns

        $script:directAssns.Count | Should -Be 1
        $script:directAssns[0].principalType | Should -Be 'User'
        $script:appRoleMap.Count | Should -Be 1
        $script:relMap.Count | Should -Be 1
        $script:groupAssns.Count | Should -Be 0
    }

    It 'buckets a Group assignment and also emits the group->AppRole edge' {
        $a = [pscustomobject]@{ id = 'aa2'; appRoleId = 'role-a'; principalId = 'grp1'; principalType = 'Group' }
        Add-EntraAppRoleAssignment -Assignment $a -ServicePrincipal $script:sp -RolesByGuid $script:rolesByGuid `
            -DefaultRoleId '00000000-0000-0000-0000-000000000000' -AppRoleMap $script:appRoleMap `
            -RelMap $script:relMap -DirectAssns $script:directAssns -GroupAssns $script:groupAssns

        $script:groupAssns.ContainsKey('grp1') | Should -BeTrue
        $script:groupAssns['grp1'].Count | Should -Be 1
        $script:directAssns[0].principalType | Should -Be 'Group'
    }

    It 'synthesizes a placeholder role for an appRoleId absent from the catalog' {
        $a = [pscustomobject]@{ id = 'aa3'; appRoleId = 'unknown-role'; principalId = 'u2'; principalType = 'User' }
        Add-EntraAppRoleAssignment -Assignment $a -ServicePrincipal $script:sp -RolesByGuid $script:rolesByGuid `
            -DefaultRoleId '00000000-0000-0000-0000-000000000000' -AppRoleMap $script:appRoleMap `
            -RelMap $script:relMap -DirectAssns $script:directAssns -GroupAssns $script:groupAssns

        $script:rolesByGuid.ContainsKey('unknown-role') | Should -BeTrue
        $script:directAssns.Count | Should -Be 1
    }

    It 'skips a ServicePrincipal-typed assignment (no direct row) but still catalogs the role' {
        $a = [pscustomobject]@{ id = 'aa4'; appRoleId = 'role-a'; principalId = 'sp2'; principalType = 'ServicePrincipal' }
        Add-EntraAppRoleAssignment -Assignment $a -ServicePrincipal $script:sp -RolesByGuid $script:rolesByGuid `
            -DefaultRoleId '00000000-0000-0000-0000-000000000000' -AppRoleMap $script:appRoleMap `
            -RelMap $script:relMap -DirectAssns $script:directAssns -GroupAssns $script:groupAssns

        $script:directAssns.Count | Should -Be 0
        $script:appRoleMap.Count | Should -Be 1
    }
}

# ─── Expand-EntraAppRoleGroupAssignments ────────────────────────────────────────
Describe 'Expand-EntraAppRoleGroupAssignments' {
    BeforeEach { Reset-PhaseTestState }

    It 'fans a group role assignment out to one row per transitive user member' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'transitiveMembers' } -MockWith {
            @(
                [pscustomobject]@{ id = 'u1'; '@odata.type' = '#microsoft.graph.user' }
                [pscustomobject]@{ id = 'u2'; '@odata.type' = '#microsoft.graph.user' }
                [pscustomobject]@{ id = 'nestedGrp'; '@odata.type' = '#microsoft.graph.group' }  # filtered out
            )
        }
        $groupAssns = @{ 'grp1' = [System.Collections.Generic.List[object]]::new() }
        $groupAssns['grp1'].Add(@{ roleResId = 'rr1'; roleId = 'role-a'; sourceAssignmentId = 'aa1'; appName = 'App One' })

        $out = Expand-EntraAppRoleGroupAssignments -GroupAssns $groupAssns

        @($out).Count | Should -Be 2
        @($out)[0].assignmentType | Should -Be 'Indirect'
        @($out).principalId | Should -Contain 'u1'
        @($out).principalId | Should -Contain 'u2'
    }

    It 'skips a group whose transitiveMembers call fails' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'transitiveMembers' } -MockWith { throw 'Graph 404' }
        $groupAssns = @{ 'grp1' = [System.Collections.Generic.List[object]]::new() }
        $groupAssns['grp1'].Add(@{ roleResId = 'rr1'; roleId = 'role-a'; sourceAssignmentId = 'aa1'; appName = 'App One' })

        $out = Expand-EntraAppRoleGroupAssignments -GroupAssns $groupAssns
        @($out).Count | Should -Be 0
    }
}

# ─── Send-EntraAppRoleBatches ───────────────────────────────────────────────────
Describe 'Send-EntraAppRoleBatches' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }


    It 'sends one batch per non-empty record set and skips the empty ones' {
        Send-EntraAppRoleBatches -SystemId 1 `
            -AppRecords @(@{ id = 'a' }) -RoleRecords @() -RelRecords @(@{ id = 'r' }) `
            -DirectRecords @() -IndirectRecords @(@{ id = 'i' })

        $script:sent.Count | Should -Be 3
        (Get-Sent { $_.Scope.resourceType -eq 'Application' }).Count | Should -Be 1
        (Get-Sent { $_.Scope.relationshipType -eq 'HasAppRole' }).Count | Should -Be 1
        (Get-Sent { $_.Scope.assignmentType -eq 'Indirect' -and $_.Scope.resourceType -eq 'AppRole' }).Count | Should -Be 1
    }

    It 'sends nothing when every set is empty' {
        Send-EntraAppRoleBatches -SystemId 1 -AppRecords @() -RoleRecords @() -RelRecords @() -DirectRecords @() -IndirectRecords @()
        $script:sent.Count | Should -Be 0
    }
}

# ─── Sync-EntraAppRoles (integration over the helpers) ──────────────────────────
Describe 'Sync-EntraAppRoles' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }


    It 'discovers an enterprise app and uploads its app, role, relationship and direct assignment' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith {
            @([pscustomobject]@{
                id = 'sp1'; displayName = 'App One'; appId = 'app1'; appRoleAssignmentRequired = $true
                appRoles = @([pscustomobject]@{ id = 'role-a'; displayName = 'Admin'; value = 'admin' })
            })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'appRoleAssignedTo' } -MockWith {
            @([pscustomobject]@{ id = 'aa1'; appRoleId = 'role-a'; principalId = 'u1'; principalType = 'User'; createdDateTime = '2026-01-01T00:00:00Z' })
        }

        $timings = [ordered]@{}
        Sync-EntraAppRoles -SystemId 5 -Timings $timings

        (Get-Sent { $_.Scope.resourceType -eq 'Application' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.resourceType -eq 'AppRole' -and $_.Endpoint -eq 'ingest/resources' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.relationshipType -eq 'HasAppRole' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'AppRole' })[0].Records.Count | Should -Be 1
        $timings.Contains('AppRoles') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the SP enumeration throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith { throw 'Graph 403' }

        Sync-EntraAppRoles -SystemId 1 -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'AppRoles:*'
    }
}

# ─── Sync-EntraResources ────────────────────────────────────────────────────────
Describe 'Sync-EntraResources' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'uploads EntraGroup resources and returns the raw groups (only the groups)' {
        $fixtureGroups = @(
            [pscustomobject]@{ id = 'g1'; displayName = 'Group One'; securityEnabled = $true }
            [pscustomobject]@{ id = 'g2'; displayName = 'Group Two'; securityEnabled = $true }
        )
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/groups\?' } -MockWith { $fixtureGroups }

        $timings = [ordered]@{}
        $returned = Sync-EntraResources -SystemId 2 -CustomGroupAttributes @() -Timings $timings

        (Get-Sent { $_.Scope.resourceType -eq 'EntraGroup' })[0].Records.Count | Should -Be 2
        # The function must return ONLY the groups — not the Send-IngestBatch result.
        @($returned).Count | Should -Be 2
        @($returned).id | Should -Contain 'g1'
        @($returned).id | Should -Contain 'g2'
        $timings.Contains('Resources') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure and returns empty when the group fetch throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/groups\?' } -MockWith { throw 'Graph 500' }

        $returned = Sync-EntraResources -SystemId 1 -Timings ([ordered]@{})

        @($returned).Count | Should -Be 0
        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'Resources:*'
    }
}

# ─── Sync-EntraAssignments ──────────────────────────────────────────────────────
Describe 'Sync-EntraAssignments' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'uploads memberships plus ownership resources, relationships and owner assignments' {
        # Get-FGGroupChildrenParallel is the parallel-fetch boundary — mock it per
        # child path so the phase's orchestration (not the runspaces) is exercised.
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'members' } -MockWith {
            @{ records = @(
                @{ resourceId = 'g1'; principalId = 'u1'; assignmentType = 'Direct'; resourceType = 'EntraGroup'; principalType = 'User' }
                @{ resourceId = 'g1'; principalId = 'u2'; assignmentType = 'Direct'; resourceType = 'EntraGroup'; principalType = 'User' }
              ); errorCount = 0 }
        }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'owners' } -MockWith {
            @{ records = @(@{ groupId = 'g1'; principalId = 'o1' }); errorCount = 0 }
        }

        $groups = @([pscustomobject]@{ id = 'g1'; displayName = 'Group One' })
        $timings = [ordered]@{}
        Sync-EntraAssignments -SystemId 4 -Groups $groups -Timings $timings

        (Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'EntraGroup' })[0].Records.Count | Should -Be 2
        (Get-Sent { $_.Scope.resourceType -eq 'GroupOwnership' -and $_.Endpoint -eq 'ingest/resources' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.relationshipType -eq 'HasOwnership' })[0].Records.Count | Should -Be 1
        $ownerAssns = Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'GroupOwnership' }
        $ownerAssns[0].Records.Count | Should -Be 1
        $ownerAssns[0].Records[0].principalId | Should -Be 'o1'
        $timings.Contains('Assignments') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'sends ownership batches even when there are no owners (full-sync reconcile)' {
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'members' } -MockWith { @{ records = @(); errorCount = 0 } }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'owners' } -MockWith { @{ records = @(); errorCount = 0 } }

        Sync-EntraAssignments -SystemId 1 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'G1' }) -Timings ([ordered]@{})

        # Ownership resource/relationship/assignment batches are still sent (empty)
        # so the reconcile clears rows for groups that lost owners.
        (Get-Sent { $_.Scope.resourceType -eq 'GroupOwnership' -and $_.Endpoint -eq 'ingest/resources' }).Count | Should -Be 1
        (Get-Sent { $_.Scope.relationshipType -eq 'HasOwnership' }).Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the member fetch throws' {
        Mock Get-FGGroupChildrenParallel -MockWith { throw 'runspace boom' }

        Sync-EntraAssignments -SystemId 1 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'G1' }) -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'Assignments:*'
    }
}
