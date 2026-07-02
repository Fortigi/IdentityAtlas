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
    # Get-FGServicePrincipalType (pure SDK classifier) — used by
    # ConvertTo-EntraServicePrincipalRecord inside the ServicePrincipals phase.
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'helpers' 'Get-FGServicePrincipalType.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Phases.ps1')

    # Script-scope state the phases + shared helpers read at call time.
    $script:ApiKey     = 'fgc_testkey'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0
    $Global:AccessToken = 'test-token'   # PIM passes this as the (Mandatory) -Token

    # Token-refresh helper the PIM phase probes via Get-Command; stub so the
    # refresh branch runs without the Graph SDK loaded.
    function Update-FGAccessTokenIfExpired { param([string]$DebugFlag) }

    # The Graph SDK functions the phases call. Defined as stubs so Pester can Mock
    # them; every test overrides with -ParameterFilter on the URI.
    function Invoke-FGGetRequest { param([string]$URI, [int]$MaxRetries, [int]$TimeoutSec) }
    function Invoke-FGGetRequestStream { param([string]$URI) }

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

# ─── Sync-EntraPim ──────────────────────────────────────────────────────────────
Describe 'Sync-EntraPim' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'uploads deduped Eligible EntraGroup assignments and skips dynamic groups' {
        # Invoke-FGGroupPimBatchParallel is the parallel-runspace boundary — mock
        # it to return raw eligibility rows (as the real one emits per group).
        Mock Invoke-FGGroupPimBatchParallel -MockWith {
            @(
                [pscustomobject]@{ resourceId = 'g1'; principalId = 'u1'; principalType = 'User'; assignmentType = 'Eligible'; state = 'Provisioned'; expirationDateTime = $null }
                # Duplicate (g1,u1) — must collapse.
                [pscustomobject]@{ resourceId = 'g1'; principalId = 'u1'; principalType = 'User'; assignmentType = 'Eligible'; state = 'Provisioned'; expirationDateTime = $null }
                [pscustomobject]@{ resourceId = 'g2'; principalId = 'u2'; principalType = 'User'; assignmentType = 'Eligible'; state = 'Provisioned'; expirationDateTime = $null }
            )
        }
        $groups = @(
            [pscustomobject]@{ id = 'g1'; displayName = 'Group One'; groupTypes = @() }
            [pscustomobject]@{ id = 'g2'; displayName = 'Group Two'; groupTypes = @() }
            [pscustomobject]@{ id = 'gDyn'; displayName = 'Dynamic'; groupTypes = @('DynamicMembership') }
        )

        $timings = [ordered]@{}
        Sync-EntraPim -SystemId 9 -Groups $groups -Timings $timings

        $sent = Get-Sent { $_.Scope.assignmentType -eq 'Eligible' -and $_.Scope.resourceType -eq 'EntraGroup' }
        $sent[0].Records.Count | Should -Be 2   # (g1,u1) deduped + (g2,u2)
        $sent[0].Records[0].resourceType | Should -Be 'EntraGroup'
        # The dynamic group must be filtered out before the parallel fetch.
        Should -Invoke Invoke-FGGroupPimBatchParallel -Times 1 -ParameterFilter { @($Batch).id -notcontains 'gDyn' }
        $timings.Contains('PIM') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'sends nothing when no group has eligibilities' {
        Mock Invoke-FGGroupPimBatchParallel -MockWith { @() }

        Sync-EntraPim -SystemId 1 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'G1'; groupTypes = @() }) -Timings ([ordered]@{})

        (Get-Sent { $_.Scope.assignmentType -eq 'Eligible' }).Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the parallel fetch throws' {
        Mock Invoke-FGGroupPimBatchParallel -MockWith { throw 'runspace boom' }

        Sync-EntraPim -SystemId 1 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'G1'; groupTypes = @() }) -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'PIM:*'
    }
}

# ─── Send-EntraServicePrincipalBatches ──────────────────────────────────────────
Describe 'Send-EntraServicePrincipalBatches' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'buckets by principalType and rides delta tombstones on the first non-empty bucket only' {
        $sps = @(
            [pscustomobject]@{ id = 'sp1'; appId = 'a1'; displayName = 'App One'; servicePrincipalType = 'Application'; accountEnabled = $true }
            [pscustomobject]@{ id = 'mi1'; appId = 'a2'; displayName = 'Managed'; servicePrincipalType = 'ManagedIdentity'; accountEnabled = $true }
        )
        Send-EntraServicePrincipalBatches -SystemId 3 -Sps $sps -RemovedSpIds @('gone1') -SpDeltaHit $true

        $spCall = Get-Sent { $_.Scope.principalType -eq 'ServicePrincipal' }
        $miCall = Get-Sent { $_.Scope.principalType -eq 'ManagedIdentity' }
        $spCall[0].Records.Count | Should -Be 1
        $miCall[0].Records.Count | Should -Be 1
        # syncMode is 'delta' in a delta-hit run.
        $spCall[0].SyncMode | Should -Be 'delta'
        # Only ONE bucket carries the deleted ids (id-scoped delete runs once).
        @($script:sent | Where-Object { $_.Records }).Count | Should -BeGreaterThan 0
        Should -Invoke Send-IngestBatch -Times 1 -ParameterFilter { @($DeletedIds).Count -gt 0 }
    }

    It 'uses full syncMode and sends no deletes on a non-delta run' {
        $sps = @([pscustomobject]@{ id = 'sp1'; appId = 'a1'; displayName = 'App One'; servicePrincipalType = 'Application'; accountEnabled = $true })
        Send-EntraServicePrincipalBatches -SystemId 1 -Sps $sps -RemovedSpIds @() -SpDeltaHit $false

        (Get-Sent { $_.Scope.principalType -eq 'ServicePrincipal' })[0].SyncMode | Should -Be 'full'
        Should -Invoke Send-IngestBatch -Times 0 -ParameterFilter { @($DeletedIds).Count -gt 0 }
    }
}

# ─── Sync-EntraServicePrincipals (integration over the sub-helpers) ─────────────
Describe 'Sync-EntraServicePrincipals' {
    BeforeEach {
        Reset-PhaseTestState
        Mock Send-IngestBatch -MockWith $script:SendMock
        # Delta-token persistence boundary (would hit Invoke-RestMethod) — stub out.
        Mock Get-FGDeltaToken -MockWith { $null }
        Mock Remove-FGDeltaToken -MockWith { }
        Mock Set-FGDeltaToken -MockWith { }
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = 'primed-tok' } }
    }

    It 'full mode: fetches, classifies, uploads, primes the delta token and returns the SPs' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?\$select' } -MockWith {
            @(
                [pscustomobject]@{ id = 'sp1'; appId = 'a1'; displayName = 'App One'; servicePrincipalType = 'Application'; accountEnabled = $true }
                [pscustomobject]@{ id = 'mi1'; appId = 'a2'; displayName = 'Managed'; servicePrincipalType = 'ManagedIdentity'; accountEnabled = $true }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipalSignInActivities' } -MockWith { @() }

        $timings = [ordered]@{}
        $returned = Sync-EntraServicePrincipals -SystemId 5 -SyncMode 'full' -AINamePatterns @() -AggregateResourceId '00000000-0000-0000-0000-000000000000' -Timings $timings

        (Get-Sent { $_.Scope.principalType -eq 'ServicePrincipal' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.principalType -eq 'ManagedIdentity' })[0].Records.Count | Should -Be 1
        # Returns ONLY the SPs (not the ingest results).
        @($returned).Count | Should -Be 2
        @($returned).id | Should -Contain 'sp1'
        Should -Invoke Set-FGDeltaToken -Times 1 -ParameterFilter { $Token -eq 'primed-tok' }
        $timings.Contains('ServicePrincipals') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'uploads SP sign-in activity joined by appId' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?\$select' } -MockWith {
            @([pscustomobject]@{ id = 'sp1'; appId = 'a1'; displayName = 'App One'; servicePrincipalType = 'Application'; accountEnabled = $true })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipalSignInActivities' } -MockWith {
            @([pscustomobject]@{ appId = 'a1'; lastSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-06-01T00:00:00Z' } })
        }

        Sync-EntraServicePrincipals -SystemId 1 -SyncMode 'full' -AggregateResourceId '00000000-0000-0000-0000-000000000000' -Timings ([ordered]@{})

        (Get-Sent { $_.Endpoint -eq 'ingest/principal-activity' }).Count | Should -BeGreaterThan 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'soft-fails SP activity (WARN) without failing the whole phase' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?\$select' } -MockWith {
            @([pscustomobject]@{ id = 'sp1'; appId = 'a1'; displayName = 'App One'; servicePrincipalType = 'Application'; accountEnabled = $true })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipalSignInActivities' } -MockWith { throw 'HTTP 403' }

        Sync-EntraServicePrincipals -SystemId 1 -SyncMode 'full' -AggregateResourceId 'x' -Timings ([ordered]@{})

        # SP records still landed; the activity 403 is swallowed, not a phase error.
        (Get-Sent { $_.Scope.principalType -eq 'ServicePrincipal' }).Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure and returns empty when the SP fetch throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?\$select' } -MockWith { throw 'Graph 500' }

        $returned = Sync-EntraServicePrincipals -SystemId 1 -SyncMode 'full' -AggregateResourceId 'x' -Timings ([ordered]@{})

        @($returned).Count | Should -Be 0
        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'ServicePrincipals:*'
    }
}

# ─── Get-EntraSpAppIdIndex ──────────────────────────────────────────────────────
Describe 'Get-EntraSpAppIdIndex' {

    It 'builds the appId -> spId map from provided SPs without a Graph call' {
        Mock Invoke-FGGetRequest -MockWith { throw 'should not be called' }
        $sps = @(
            [pscustomobject]@{ id = 'sp1'; appId = 'a1' }
            [pscustomobject]@{ id = 'sp2'; appId = 'a2' }
            [pscustomobject]@{ id = 'sp3'; appId = $null }   # no appId -> skipped
        )
        $idx = Get-EntraSpAppIdIndex -Sps $sps
        $idx['a1'] | Should -Be 'sp1'
        $idx['a2'] | Should -Be 'sp2'
        $idx.Count | Should -Be 2
    }

    It 'falls back to a Graph fetch when no SPs are supplied' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals' } -MockWith {
            @([pscustomobject]@{ id = 'spX'; appId = 'aX' })
        }
        $idx = Get-EntraSpAppIdIndex -Sps @()
        $idx['aX'] | Should -Be 'spX'
        Should -Invoke Invoke-FGGetRequest -Times 1
    }
}

# ─── Sync-EntraSignInLogs ───────────────────────────────────────────────────────
Describe 'Sync-EntraSignInLogs' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'aggregates streamed events into per-(user, app) activity rows' {
        Mock Invoke-FGGetRequestStream -MockWith {
            @(
                [pscustomobject]@{ userId = 'u1'; appId = 'a1'; createdDateTime = '2026-06-01T10:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } }
                [pscustomobject]@{ userId = 'u1'; appId = 'a1'; createdDateTime = '2026-06-02T10:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } }
                [pscustomobject]@{ userId = 'u2'; appId = 'a1'; createdDateTime = '2026-06-02T11:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } }
            )
        }
        $sps = @([pscustomobject]@{ id = 'sp1'; appId = 'a1' })
        $timings = [ordered]@{}
        Sync-EntraSignInLogs -SystemId 6 -Sps $sps -SignInLogsDays 1 -Timings $timings

        $act = Get-Sent { $_.Endpoint -eq 'ingest/principal-activity' }
        $act[0].Records.Count | Should -Be 2   # (u1,sp1) collapsed from 2 events + (u2,sp1)
        ($act[0].Records | Where-Object { $_.principalId -eq 'u1' }).signInCount | Should -Be 2
        $timings.Contains('SignInLogs') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'skips events whose appId is not in the index (no activity uploaded)' {
        Mock Invoke-FGGetRequestStream -MockWith {
            @([pscustomobject]@{ userId = 'u1'; appId = 'unknown'; createdDateTime = '2026-06-01T10:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } })
        }
        Sync-EntraSignInLogs -SystemId 1 -Sps @([pscustomobject]@{ id = 'sp1'; appId = 'a1' }) -SignInLogsDays 1 -Timings ([ordered]@{})

        (Get-Sent { $_.Endpoint -eq 'ingest/principal-activity' }).Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when every day slice fails' {
        Mock Invoke-FGGetRequestStream -MockWith { throw 'Graph 400 skiptoken expired' }
        Sync-EntraSignInLogs -SystemId 1 -Sps @([pscustomobject]@{ id = 'sp1'; appId = 'a1' }) -SignInLogsDays 2 -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'SignInLogs:*'
    }
}

# ─── Resolve-EntraAccessReviewApId (pure) ───────────────────────────────────────
Describe 'Resolve-EntraAccessReviewApId' {
    BeforeAll { $uuid = '11111111-1111-1111-1111-111111111111' }

    It 'returns noscope when the definition has no query' {
        $r = Resolve-EntraAccessReviewApId -Definition ([pscustomobject]@{ id = 'rd1' })
        $r.reason | Should -Be 'noscope'
        $r.apId | Should -BeNullOrEmpty
    }

    It 'matches a path-style accessPackages/<uuid> in resourceScope.query' {
        $def = [pscustomobject]@{ id = 'rd1'; resourceScope = [pscustomobject]@{ query = "/identityGovernance/.../accessPackages/$uuid/resourceRoleScopes" } }
        (Resolve-EntraAccessReviewApId -Definition $def).apId | Should -Be $uuid
    }

    It "matches a filter-style accessPackage/id eq '<uuid>' in scope.query" {
        $def = [pscustomobject]@{ id = 'rd1'; scope = [pscustomobject]@{ query = "accessPackage/id eq '$uuid'" } }
        (Resolve-EntraAccessReviewApId -Definition $def).apId | Should -Be $uuid
    }

    It 'returns nomatch when a query exists but carries no access-package id' {
        $def = [pscustomobject]@{ id = 'rd1'; scope = [pscustomobject]@{ query = '/users' } }
        $r = Resolve-EntraAccessReviewApId -Definition $def
        $r.reason | Should -Be 'nomatch'
        $r.queryStrings | Should -Contain '/users'
    }
}

# ─── Governance sub-phases ──────────────────────────────────────────────────────
Describe 'Governance phases' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'Sync-EntraGovernanceCatalogs uploads catalogs + BusinessRole resources and returns the access packages' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessPackageCatalogs' } -MockWith {
            @([pscustomobject]@{ id = 'c1'; displayName = 'Cat'; isPublished = $true })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'entitlementManagement/accessPackages\?' } -MockWith {
            @([pscustomobject]@{ id = 'ap1'; displayName = 'AP1'; catalogId = 'c1' })
        }

        $aps = Sync-EntraGovernanceCatalogs -SystemId 2

        (Get-Sent { $_.Endpoint -eq 'ingest/governance/catalogs' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Scope.resourceType -eq 'BusinessRole' -and $_.Endpoint -eq 'ingest/resources' })[0].Records.Count | Should -Be 1
        # Returns only the access packages, not the ingest results.
        @($aps).Count | Should -Be 1
        @($aps).id | Should -Contain 'ap1'
    }

    It 'Sync-EntraGovernanceResourceScopes uploads deduped Contains relationships' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessPackages/ap1' } -MockWith {
            [pscustomobject]@{ accessPackageResourceRoleScopes = @(
                [pscustomobject]@{ accessPackageResourceScope = [pscustomobject]@{ originId = 'grp1' }; accessPackageResourceRole = [pscustomobject]@{ displayName = 'Member'; originSystem = 'AadGroup' } }
                # Duplicate (ap1 -> grp1) — must collapse.
                [pscustomobject]@{ accessPackageResourceScope = [pscustomobject]@{ originId = 'grp1' }; accessPackageResourceRole = [pscustomobject]@{ displayName = 'Owner'; originSystem = 'AadGroup' } }
            ) }
        }
        $aps = @([pscustomobject]@{ id = 'ap1'; displayName = 'AP1' })
        Sync-EntraGovernanceResourceScopes -SystemId 1 -AccessPackages $aps

        (Get-Sent { $_.Scope.relationshipType -eq 'Contains' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'Sync-EntraGovernanceAssignments streams + dedups active AP assignments' {
        Mock Invoke-FGGetRequestStream -ParameterFilter { $URI -match 'accessPackageAssignments' } -MockWith {
            @(
                [pscustomobject]@{ accessPackage = [pscustomobject]@{ id = 'ap1' }; target = [pscustomobject]@{ objectId = 'u1' }; assignmentState = 'Delivered' }
                [pscustomobject]@{ accessPackage = [pscustomobject]@{ id = 'ap1' }; target = [pscustomobject]@{ objectId = 'u1' }; assignmentState = 'Delivered' }   # dup
                [pscustomobject]@{ accessPackage = [pscustomobject]@{ id = 'ap1' }; target = [pscustomobject]@{ objectId = 'u2' }; assignmentState = 'Expired' }     # skipped
            )
        }
        Sync-EntraGovernanceAssignments -SystemId 1

        (Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'BusinessRole' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'Sync-EntraGovernancePolicies uploads assignment policies' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'assignmentPolicies' } -MockWith {
            @([pscustomobject]@{ id = 'pol1'; accessPackage = [pscustomobject]@{ id = 'ap1' }; displayName = 'P' })
        }
        Sync-EntraGovernancePolicies -SystemId 1

        (Get-Sent { $_.Endpoint -eq 'ingest/governance/policies' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'Get-EntraAccessReviewCertRecords builds decision records and skips failed instances' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'definitions/rd1/instances\?' } -MockWith {
            @([pscustomobject]@{ id = 'inst1'; status = 'Applied' })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'instances/inst1/decisions' } -MockWith {
            @([pscustomobject]@{ id = 'dec1'; principal = [pscustomobject]@{ id = 'u1'; displayName = 'U' }; decision = 'Approve' })
        }
        $def = [pscustomobject]@{ id = 'rd1' }
        $recs = Get-EntraAccessReviewCertRecords -Definition $def -ApId 'ap1'

        @($recs).Count | Should -Be 1
        @($recs)[0].resourceId | Should -Be 'ap1'
        @($recs)[0].principalId | Should -Be 'u1'
    }

    It 'Sync-EntraGovernanceReviews uploads certification decisions for AP-scoped reviews' {
        $uuid = '11111111-1111-1111-1111-111111111111'
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessReviews/definitions\?' } -MockWith {
            @(
                [pscustomobject]@{ id = 'rd1'; resourceScope = [pscustomobject]@{ query = "/accessPackages/$uuid/x" } }
                [pscustomobject]@{ id = 'rd2' }   # no scope -> skipped
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'definitions/rd1/instances\?' } -MockWith { @([pscustomobject]@{ id = 'inst1'; status = 'Applied' }) }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'instances/inst1/decisions' } -MockWith {
            @([pscustomobject]@{ id = 'dec1'; principal = [pscustomobject]@{ id = 'u1' }; decision = 'Approve' })
        }
        Sync-EntraGovernanceReviews -SystemId 1

        (Get-Sent { $_.Endpoint -eq 'ingest/governance/certifications' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'Sync-EntraGovernance runs all sub-phases and records the phase timing' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessPackageCatalogs' } -MockWith { @() }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'entitlementManagement/accessPackages\?' } -MockWith { @() }
        Mock Invoke-FGGetRequestStream -MockWith { @() }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'assignmentPolicies' } -MockWith { @() }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessReviews/definitions\?' } -MockWith { @() }

        $timings = [ordered]@{}
        Sync-EntraGovernance -SystemId 1 -Timings $timings

        $timings.Contains('Governance') | Should -BeTrue
        # Sub-phases report individually; no top-level 'Governance' Write-Phase.
        @($script:phases.name) | Should -Not -Contain 'Governance'
        @($script:phases.name) | Should -Contain 'Governance/ResourceScopes'
        @($script:phases.name) | Should -Contain 'Governance/AccessReviews'
    }

    It 'Sync-EntraGovernance swallows a missing-Entitlement-Management tenant (outer catch)' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessPackageCatalogs' } -MockWith { throw 'HTTP 400 not enabled' }

        $timings = [ordered]@{}
        Sync-EntraGovernance -SystemId 1 -Timings $timings

        # Outer catch is silent (no phase error), still records the timing.
        $script:phaseErrors.Count | Should -Be 0
        $timings.Contains('Governance') | Should -BeTrue
    }
}

# ─── Get-EntraUserSelect (pure) ─────────────────────────────────────────────────
Describe 'Get-EntraUserSelect' {

    It 'includes the core attributes and a plain custom attribute' {
        $sel = Get-EntraUserSelect -CustomUserAttributes @('costCenter')
        $sel | Should -Match 'signInActivity'
        $sel | Should -Match 'costCenter'
        $sel | Should -Not -Match 'onPremisesExtensionAttributes'
    }

    It 'adds onPremisesExtensionAttributes when a custom attribute is extensionAttributeN' {
        (Get-EntraUserSelect -CustomUserAttributes @('extensionAttribute5')) | Should -Match 'onPremisesExtensionAttributes'
    }

    It 'adds onPremisesExtensionAttributes when the identity filter targets an extensionAttributeN' {
        (Get-EntraUserSelect -IdentityFilter @{ attribute = 'extensionAttribute3' }) | Should -Match 'onPremisesExtensionAttributes'
    }
}

# ─── Select-EntraIdentityUsers (pure filter) ────────────────────────────────────
Describe 'Select-EntraIdentityUsers' {
    BeforeAll {
        $users = @(
            [pscustomobject]@{ id = 'u1'; department = 'Sales'; employeeId = '100' }
            [pscustomobject]@{ id = 'u2'; department = 'Eng';   employeeId = $null }
            [pscustomobject]@{ id = 'u3'; department = 'Sales'; employeeId = '300' }
        )
    }

    It "matches 'equals'" {
        $m = Select-EntraIdentityUsers -Users $users -IdentityFilter @{ attribute = 'department'; condition = 'equals'; value = 'Sales' }
        @($m).id | Should -Be @('u1','u3')
    }

    It "matches 'isNotNull'" {
        $m = Select-EntraIdentityUsers -Users $users -IdentityFilter @{ attribute = 'employeeId'; condition = 'isNotNull' }
        @($m).id | Should -Be @('u1','u3')
    }

    It "matches 'inValues'" {
        $m = Select-EntraIdentityUsers -Users $users -IdentityFilter @{ attribute = 'department'; condition = 'inValues'; values = @('Eng') }
        @($m).id | Should -Be @('u2')
    }
}

# ─── ConvertTo-EntraIdentityRecord (pure) ───────────────────────────────────────
Describe 'ConvertTo-EntraIdentityRecord' {

    It 'maps core fields and falls back to UPN for email' {
        $u = [pscustomobject]@{ id = 'u1'; displayName = 'Alice'; mail = $null; userPrincipalName = 'alice@x'; department = 'Sales' }
        $rec = ConvertTo-EntraIdentityRecord -User $u
        $rec.id | Should -Be 'u1'
        $rec.email | Should -Be 'alice@x'
        $rec.ContainsKey('extendedAttributes') | Should -BeFalse
    }

    It 'carries non-empty custom attributes into extendedAttributes' {
        $u = [pscustomobject]@{ id = 'u1'; displayName = 'Alice'; mail = 'a@x'; costCenter = 'CC1'; empty = '' }
        $rec = ConvertTo-EntraIdentityRecord -User $u -CustomUserAttributes @('costCenter','empty')
        $rec.extendedAttributes['costCenter'] | Should -Be 'CC1'
        $rec.extendedAttributes.ContainsKey('empty') | Should -BeFalse
    }
}

# ─── Get-EntraUserData ──────────────────────────────────────────────────────────
Describe 'Get-EntraUserData' {
    BeforeEach {
        Reset-PhaseTestState
        Mock Get-FGDeltaToken -MockWith { $null }
        Mock Remove-FGDeltaToken -MockWith { }
        Mock Set-FGDeltaToken -MockWith { }
    }

    It 'full mode fetches with manager expand and primes a fresh delta token' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith {
            @([pscustomobject]@{ id = 'u1'; displayName = 'Alice' })
        }
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = 'primed' } }

        $data = Get-EntraUserData -SystemId 1 -SyncMode 'full' -UserSelect 'id,displayName'
        $data.deltaHit | Should -BeFalse
        @($data.users).Count | Should -Be 1
        $data.newUsersToken | Should -Be 'primed'
    }

    It 'delta mode returns changed users and @removed tombstones' {
        Mock Get-FGDeltaToken -MockWith { 'stored-token' }
        Mock Invoke-FGGetDeltaRequest -MockWith {
            @{ value = @(
                [pscustomobject]@{ id = 'u1'; displayName = 'Alice' }
                [pscustomobject]@{ id = 'gone'; '@removed' = [pscustomobject]@{ reason = 'deleted' } }
              ); deltaToken = 'next-token' }
        }

        $data = Get-EntraUserData -SystemId 1 -SyncMode 'delta' -UserSelect 'id'
        $data.deltaHit | Should -BeTrue
        @($data.users).id | Should -Be @('u1')
        @($data.removedUserIds) | Should -Contain 'gone'
    }

    It 'falls back to full when the stored delta token is rejected' {
        Mock Get-FGDeltaToken -MockWith { 'bad-token' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'deltatoken=' } -MockWith { throw [System.InvalidOperationException]::new('token rejected') }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith { @([pscustomobject]@{ id = 'u1' }) }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'select=id' } -MockWith { @{ value = @(); deltaToken = 'primed' } }

        $data = Get-EntraUserData -SystemId 1 -SyncMode 'delta' -UserSelect 'id'
        $data.deltaHit | Should -BeFalse
        @($data.users).Count | Should -Be 1
        Should -Invoke Remove-FGDeltaToken -Times 1
    }
}

# ─── Sync-EntraPrincipals (integration) ─────────────────────────────────────────
Describe 'Sync-EntraPrincipals' {
    BeforeEach {
        Reset-PhaseTestState
        Mock Send-IngestBatch -MockWith $script:SendMock
        Mock Get-FGDeltaToken -MockWith { $null }
        Mock Remove-FGDeltaToken -MockWith { }
        Mock Set-FGDeltaToken -MockWith { }
        Mock Invoke-FGGetDeltaRequest -MockWith { @{ value = @(); deltaToken = 'primed' } }
    }

    It 'full mode uploads User principals with tombstones and primes the token' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith {
            @(
                [pscustomobject]@{ id = 'u1'; displayName = 'Alice'; userPrincipalName = 'a@x'; accountEnabled = $true }
                [pscustomobject]@{ id = 'u2'; displayName = 'Bob';   userPrincipalName = 'b@x'; accountEnabled = $true }
            )
        }
        $timings = [ordered]@{}
        Sync-EntraPrincipals -SystemId 5 -SyncMode 'full' -Timings $timings

        $p = Get-Sent { $_.Scope.principalType -eq 'User' }
        $p[0].Records.Count | Should -Be 2
        $p[0].SyncMode | Should -Be 'full'
        Should -Invoke Set-FGDeltaToken -Times 1 -ParameterFilter { $Token -eq 'primed' }
        $timings.Contains('Principals') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'runs the identity sub-sync when an identity filter is configured' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith {
            @(
                [pscustomobject]@{ id = 'u1'; displayName = 'Alice'; userPrincipalName = 'a@x'; department = 'Sales'; accountEnabled = $true }
                [pscustomobject]@{ id = 'u2'; displayName = 'Bob';   userPrincipalName = 'b@x'; department = 'Eng';   accountEnabled = $true }
            )
        }
        Sync-EntraPrincipals -SystemId 1 -SyncMode 'full' -IdentityFilter @{ attribute = 'department'; condition = 'equals'; value = 'Sales' } -Timings ([ordered]@{})

        (Get-Sent { $_.Endpoint -eq 'ingest/identities' })[0].Records.Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/identity-members' })[0].Records.Count | Should -Be 1
    }

    It 'records a phase failure when the user fetch throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith { throw 'Graph 500' }

        Sync-EntraPrincipals -SystemId 1 -SyncMode 'full' -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'Principals:*'
    }
}
