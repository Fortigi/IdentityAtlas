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
    # App-role record shapers live in their own file (extracted for the ratchets).
    . (Join-Path $script:entraDir 'EntraIDCrawler.AppRoles.ps1')
    # Get-FGServicePrincipalType (pure SDK classifier) — used by
    # ConvertTo-EntraServicePrincipalRecord inside the ServicePrincipals phase.
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'helpers' 'Get-FGServicePrincipalType.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Phases.ps1')
    # Sync-EntraAppOwners + its helpers live in their own file (extracted for the ratchets).
    . (Join-Path $script:entraDir 'EntraIDCrawler.AppOwners.ps1')
    # Sync-EntraAppPermissions + its helpers live in their own file too.
    . (Join-Path $script:entraDir 'EntraIDCrawler.AppPermissions.ps1')
    # Sync-EntraPrincipalRelationships (agent owners / guest sponsors) — its own file.
    . (Join-Path $script:entraDir 'EntraIDCrawler.PrincipalRelationships.ps1')
    # Invoke-EntraApplicationPhases — dispatch for the application + principal-relationship phases.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Orchestration.ps1')

    # Script-scope state the phases + shared helpers read at call time.
    $script:ApiKey     = 'fgc_testkey'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0
    $Global:AccessToken = 'test-token'   # PIM passes this as the (Mandatory) -Token

    # Token-refresh helper the PIM phase probes via Get-Command; stub so the
    # refresh branch runs without the Graph SDK loaded.
    function Update-FGAccessTokenIfExpired { param([string]$DebugFlag) }

    # Graph auth stub for the run-init phase + tenant id for system registration.
    function Get-FGAccessToken { param($ConfigFile) }
    $Global:TenantId = 'tenant-123'

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

# ─── Sync-EntraAppOwners ────────────────────────────────────────────────────────
Describe 'Sync-EntraAppOwners' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'models SP + app-registration owners as ownership resources hanging off the Application' {
        # One service principal (Payroll), appId app-guid-1.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith {
            @([pscustomobject]@{ id = 'sp1'; appId = 'app-guid-1'; displayName = 'Payroll'; servicePrincipalType = 'Application' })
        }
        # One app registration, same appId → resolves to sp1.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'applications\?' } -MockWith {
            @([pscustomobject]@{ id = 'app1obj'; appId = 'app-guid-1'; displayName = 'Payroll' })
        }
        # Owner fetches — the mock bypasses the RecordBuilder, so return final-shape records.
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $EntityType -eq 'servicePrincipals' } -MockWith {
            @{ records = @(@{ appResourceId = 'sp1'; principalId = 'u1' }, @{ appResourceId = 'sp1'; principalId = 'u2' }); errorCount = 0 }
        }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $EntityType -eq 'applications' } -MockWith {
            @{ records = @(@{ appObjectId = 'app1obj'; principalId = 'u3' }); errorCount = 0 }
        }

        Sync-EntraAppOwners -SystemId 7 -Timings ([ordered]@{})
        $script:phaseErrors.Count | Should -Be 0

        # Parent Application upserted WITHOUT reconcile (SyncMode 'delta').
        $appUpsert = Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'Application' }
        $appUpsert.Count            | Should -Be 1
        $appUpsert[0].SyncMode      | Should -Be 'delta'
        $appUpsert[0].Records.Count | Should -Be 1
        $appUpsert[0].Records[0].id | Should -Be 'sp1'

        # ServicePrincipalOwnership: one resource (full-sync), two Direct assignments.
        $spRes = Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'ServicePrincipalOwnership' }
        $spRes.Count                     | Should -Be 1
        $spRes[0].SyncMode               | Should -Be 'full'
        $spRes[0].Records.Count          | Should -Be 1
        $spRes[0].Records[0].displayName | Should -Be 'Payroll'
        $spAssn = Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' -and $_.Scope.resourceType -eq 'ServicePrincipalOwnership' }
        $spAssn[0].Records.Count         | Should -Be 2
        $spAssn[0].Scope.assignmentType  | Should -Be 'Direct'

        # ApplicationOwnership: one resource, one Direct assignment (u3, via appId match).
        (Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'ApplicationOwnership' })[0].Records.Count | Should -Be 1
        $appAssn = Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' -and $_.Scope.resourceType -eq 'ApplicationOwnership' }
        $appAssn[0].Records.Count       | Should -Be 1
        $appAssn[0].Records[0].principalId | Should -Be 'u3'

        # One HasAppOwnership batch, two relationships (both parent = sp1).
        $rels = Get-Sent { $_.Scope.relationshipType -eq 'HasAppOwnership' }
        $rels.Count              | Should -Be 1
        $rels[0].Records.Count   | Should -Be 2
        $rels[0].Records | ForEach-Object { $_.parentResourceId | Should -Be 'sp1' }
    }

    It 'skips app-registration owners whose appId has no matching service principal' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith { @() }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'applications\?' } -MockWith {
            @([pscustomobject]@{ id = 'orphanObj'; appId = 'no-sp-guid'; displayName = 'Orphan' })
        }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $EntityType -eq 'servicePrincipals' } -MockWith { @{ records = @(); errorCount = 0 } }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $EntityType -eq 'applications' } -MockWith {
            @{ records = @(@{ appObjectId = 'orphanObj'; principalId = 'u9' }); errorCount = 0 }
        }

        Sync-EntraAppOwners -SystemId 7 -Timings ([ordered]@{})
        $script:phaseErrors.Count | Should -Be 0

        # Orphan app owner has no SP → no ApplicationOwnership assignment, no owned app.
        (Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' -and $_.Scope.resourceType -eq 'ApplicationOwnership' })[0].Records.Count | Should -Be 0
        (Get-Sent { $_.Scope.resourceType -eq 'Application' }).Count | Should -Be 0
    }
}

# ─── Sync-EntraAppPermissions ───────────────────────────────────────────────────
Describe 'Sync-EntraAppPermissions' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'models each SP''s app-only permissions as ApplicationPermission resources off the client app, resolving the permission name from the target API catalog' {
        # Microsoft Graph is just an SP whose appRoles catalog names role-mailread → Mail.Read.
        # payrollSp (Application) and kvMi (ManagedIdentity) each hold that role on Graph.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith {
            @(
                [pscustomobject]@{ id = 'graphSp'; displayName = 'Microsoft Graph'; appId = 'graph-app'; servicePrincipalType = 'Application'
                    appRoles = @([pscustomobject]@{ id = 'role-mailread'; value = 'Mail.Read'; displayName = 'Read mail' }) }
                [pscustomobject]@{ id = 'payrollSp'; displayName = 'Payroll App'; appId = 'payroll-app'; servicePrincipalType = 'Application' }
                [pscustomobject]@{ id = 'kvMi'; displayName = 'kv-reader-mi'; appId = 'kv-app'; servicePrincipalType = 'ManagedIdentity' }
            )
        }
        # The parallel per-SP appRoleAssignments fetch — mock bypasses the RecordBuilder,
        # so return the final-shape (raw) rows the builder would have emitted.
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $EntityType -eq 'servicePrincipals' -and $ChildPath -eq 'appRoleAssignments' } -MockWith {
            @{ records = @(
                @{ id = 'ara1'; principalId = 'payrollSp'; resourceId = 'graphSp'; resourceDisplayName = 'Microsoft Graph'; appRoleId = 'role-mailread' }
                @{ id = 'ara2'; principalId = 'kvMi';      resourceId = 'graphSp'; resourceDisplayName = 'Microsoft Graph'; appRoleId = 'role-mailread' }
              ); errorCount = 0 }
        }

        $timings = [ordered]@{}
        Sync-EntraAppPermissions -SystemId 8 -Timings $timings
        $script:phaseErrors.Count | Should -Be 0

        # Two ApplicationPermission resources (distinct client SPs), full-synced for reconcile.
        $permRes = Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'ApplicationPermission' }
        $permRes.Count            | Should -Be 1
        $permRes[0].SyncMode      | Should -Be 'full'
        $permRes[0].Records.Count | Should -Be 2
        $permRes[0].Records.displayName | Should -Contain 'Mail.Read on Microsoft Graph (via Payroll App)'

        # HasApplicationPermission relationships hang off the client SP (full-sync).
        $rels = Get-Sent { $_.Scope.relationshipType -eq 'HasApplicationPermission' }
        $rels[0].Records.Count | Should -Be 2
        $rels[0].Records | ForEach-Object { $_.relationshipType | Should -Be 'HasApplicationPermission' }

        # Direct assignments whose principal is the holding SP itself — the managed
        # identity keeps its classified principalType, not a flat ServicePrincipal.
        $assns = Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' -and $_.Scope.resourceType -eq 'ApplicationPermission' }
        $assns[0].SyncMode              | Should -Be 'full'
        $assns[0].Scope.assignmentType  | Should -Be 'Direct'
        $assns[0].Records.Count         | Should -Be 2
        ($assns[0].Records | Where-Object { $_.principalId -eq 'kvMi' }).principalType | Should -Be 'ManagedIdentity'

        # Holder Application resources are ensured-exists via a non-reconciling delta
        # upsert (payrollSp + kvMi hold a permission; graphSp is only a target, so it
        # is NOT upserted here).
        $appUpsert = Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'Application' }
        $appUpsert.Count            | Should -Be 1
        $appUpsert[0].SyncMode      | Should -Be 'delta'
        $appUpsert[0].Records.Count | Should -Be 2
        $appUpsert[0].Records.id    | Should -Not -Contain 'graphSp'

        $timings.Contains('AppPermissions') | Should -BeTrue
        ($script:phases | Where-Object { $_.name -eq 'AppPermissions' }).status | Should -Be 'ok'
    }

    It 'runs the raw-child RecordBuilder and warns (non-fatally) on SPs that failed the appRoleAssignments fetch' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith {
            @([pscustomobject]@{ id = 'spX'; displayName = 'App X'; appId = 'ax'; servicePrincipalType = 'Application' })
        }
        # Exercise the { param($o) $o.raw } builder the phase passes, and report a
        # non-zero errorCount to hit the soft-warning branch.
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'appRoleAssignments' } -MockWith {
            $rec = & $RecordBuilder ([pscustomobject]@{ raw = @{ id = 'ara9'; principalId = 'spX'; resourceId = 'apiY'; appRoleId = 'role-z' } })
            @{ records = @($rec); errorCount = 1 }
        }

        Sync-EntraAppPermissions -SystemId 2 -Timings ([ordered]@{})

        # The raw row shaped into one ApplicationPermission grant (falls back to the
        # appRoleId as the permission name — apiY had no catalog entry).
        $assns = Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' -and $_.Scope.resourceType -eq 'ApplicationPermission' }
        $assns[0].Records.Count            | Should -Be 1
        $assns[0].Records[0].principalId   | Should -Be 'spX'
        # A per-SP fetch failure is a warning, not a phase failure.
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'still sends the full-sync batches when no SP holds a permission (reconcile clears revoked grants) and upserts no holder apps' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith { @() }

        Sync-EntraAppPermissions -SystemId 1 -Timings ([ordered]@{})

        # Resource / relationship / assignment batches are still sent (empty) so a
        # reconcile clears any grant that was revoked since the last run.
        (Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'ApplicationPermission' })[0].Records.Count | Should -Be 0
        (Get-Sent { $_.Scope.relationshipType -eq 'HasApplicationPermission' }).Count | Should -Be 1
        (Get-Sent { $_.Endpoint -eq 'ingest/resource-assignments' -and $_.Scope.resourceType -eq 'ApplicationPermission' }).Count | Should -Be 1
        # No holder held a permission → no Application delta upsert at all.
        (Get-Sent { $_.Endpoint -eq 'ingest/resources' -and $_.Scope.resourceType -eq 'Application' }).Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a phase failure when the service-principal fetch throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith { throw 'Graph 403' }

        Sync-EntraAppPermissions -SystemId 1 -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'AppPermissions:*'
        ($script:phases | Where-Object { $_.name -eq 'AppPermissions' }).status | Should -Be 'failed'
    }
}

# ─── Invoke-EntraApplicationPhases (dispatch) ───────────────────────────────────
Describe 'Invoke-EntraApplicationPhases' {
    BeforeEach {
        Reset-PhaseTestState
        # Mock the four phases the dispatcher fans out to — each has its own tests
        # above; here we assert only that the toggles gate them and shared args flow.
        Mock Sync-EntraOAuth2Grants   -MockWith { }
        Mock Sync-EntraAppRoles       -MockWith { }
        Mock Sync-EntraAppOwners      -MockWith { }
        Mock Sync-EntraAppPermissions -MockWith { }
        Mock Sync-EntraPrincipalRelationships -MockWith { }
    }

    It 'runs every phase when all toggles are on, forwarding AINamePatterns to app permissions + principal relationships' {
        Invoke-EntraApplicationPhases -SystemId 7 -AINamePatterns @('*copilot*') -Timings ([ordered]@{}) `
            -SyncOAuth2Grants $true -SyncAppRoles $true -SyncAppOwners $true -SyncAppPermissions $true -SyncPrincipalRelationships $true

        Should -Invoke Sync-EntraOAuth2Grants   -Exactly 1 -ParameterFilter { $SystemId -eq 7 }
        Should -Invoke Sync-EntraAppRoles       -Exactly 1 -ParameterFilter { $SystemId -eq 7 }
        Should -Invoke Sync-EntraAppOwners      -Exactly 1 -ParameterFilter { $SystemId -eq 7 }
        Should -Invoke Sync-EntraAppPermissions -Exactly 1 -ParameterFilter { $SystemId -eq 7 -and @($AINamePatterns) -contains '*copilot*' }
        Should -Invoke Sync-EntraPrincipalRelationships -Exactly 1 -ParameterFilter { $SystemId -eq 7 -and @($AINamePatterns) -contains '*copilot*' }
    }

    It 'runs nothing when every toggle is off (all default to false)' {
        Invoke-EntraApplicationPhases -SystemId 1 -Timings ([ordered]@{})
        Should -Invoke Sync-EntraOAuth2Grants   -Exactly 0
        Should -Invoke Sync-EntraAppRoles       -Exactly 0
        Should -Invoke Sync-EntraAppOwners      -Exactly 0
        Should -Invoke Sync-EntraAppPermissions -Exactly 0
        Should -Invoke Sync-EntraPrincipalRelationships -Exactly 0
    }

    It 'runs only the phases whose toggle is on' {
        Invoke-EntraApplicationPhases -SystemId 2 -Timings ([ordered]@{}) -SyncAppPermissions $true
        Should -Invoke Sync-EntraAppPermissions -Exactly 1
        Should -Invoke Sync-EntraOAuth2Grants   -Exactly 0
        Should -Invoke Sync-EntraAppRoles       -Exactly 0
        Should -Invoke Sync-EntraAppOwners      -Exactly 0
    }

    It 'treats an empty-string toggle (the shape the resolved config yields for an unset object) as OFF, not a binding error' {
        # Regression: [bool]-typed toggle params rejected '' with "Cannot convert value ''
        # to type System.Boolean" and crashed the entire crawl before any phase ran. The
        # replaced inline `if ($SyncX)` guards used truthiness, where '' is falsy. This is
        # exactly what the resolved config passes for an object the user did not select.
        { Invoke-EntraApplicationPhases -SystemId 1 -Timings ([ordered]@{}) `
            -SyncOAuth2Grants '' -SyncAppRoles '' -SyncAppOwners '' -SyncAppPermissions '' } | Should -Not -Throw
        Should -Invoke Sync-EntraOAuth2Grants   -Exactly 0
        Should -Invoke Sync-EntraAppRoles       -Exactly 0
        Should -Invoke Sync-EntraAppOwners      -Exactly 0
        Should -Invoke Sync-EntraAppPermissions -Exactly 0
    }

    It 'preserves the inline guards'' truthiness for every config shape ('''' / $null skip; "true" / $true run)' {
        Invoke-EntraApplicationPhases -SystemId 1 -Timings ([ordered]@{}) `
            -SyncOAuth2Grants '' -SyncAppRoles $null -SyncAppOwners 'true' -SyncAppPermissions $true
        Should -Invoke Sync-EntraOAuth2Grants   -Exactly 0   # '' → skip
        Should -Invoke Sync-EntraAppRoles       -Exactly 0   # $null → skip
        Should -Invoke Sync-EntraAppOwners      -Exactly 1   # 'true' → run
        Should -Invoke Sync-EntraAppPermissions -Exactly 1   # $true → run
    }
}

# ─── Invoke-EntraApplicationPhases — shared-scope transparency ───────────────────
# Guards the refactor that moved these four phase guards behind a dispatcher: a REAL
# phase (not mocked) invoked THROUGH Invoke-EntraApplicationPhases must still read/write
# the same $script:phaseErrors / $script:phases the entry-point owns. If the extra call
# layer changed $script: resolution, the phase's catch would write to the wrong (or a
# null) accumulator — which the mocked dispatch tests above can't catch. This is the
# path the live crawler actually runs.
Describe 'Invoke-EntraApplicationPhases (real phase through the dispatcher)' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'a real phase error raised via the dispatcher lands in the shared $script:phaseErrors + $script:phases' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith { throw 'Graph 403' }

        Invoke-EntraApplicationPhases -SystemId 3 -Timings ([ordered]@{}) -SyncOAuth2Grants $true

        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'OAuth2Grants:*'
        ($script:phases | Where-Object { $_.name -eq 'OAuth2Grants' }).status | Should -Be 'failed'
    }

    It 'a real successful phase via the dispatcher records its timing + an ok phase' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith {
            @([pscustomobject]@{ id = 'g1'; consentType = 'Principal'; principalId = 'u1'; clientId = 'cli'; resourceId = 'api'; scope = 'Mail.Read' })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/' } -MockWith { [pscustomobject]@{ id = 'x'; displayName = 'X'; appId = 'ax'; publisherName = 'p' } }

        $timings = [ordered]@{}
        Invoke-EntraApplicationPhases -SystemId 3 -Timings $timings -SyncOAuth2Grants $true

        $timings.Contains('OAuth2Grants') | Should -BeTrue
        ($script:phases | Where-Object { $_.name -eq 'OAuth2Grants' }).status | Should -Be 'ok'
        $script:phaseErrors.Count | Should -Be 0
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

        (Get-Sent { $_.Scope.resourceType -eq 'EntraDirectoryRole' -and $_.Endpoint -eq 'ingest/resources' })[0].Records.Count | Should -Be 2
        $active = Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'EntraDirectoryRole' }
        $active[0].Records.Count | Should -Be 2   # (u1,r1) deduped, plus (u2,r2)
        $eligible = Get-Sent { $_.Scope.assignmentType -eq 'Eligible' -and $_.Scope.resourceType -eq 'EntraDirectoryRole' }
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

        (Get-Sent { $_.Scope.resourceType -eq 'EntraDirectoryRole' -and $_.Endpoint -eq 'ingest/resources' }).Count | Should -Be 1
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


    It 'keeps only consents that are per-user AND name the user' {
        # The existing fixture pairs Principal+principalId against AllPrincipals+null, so
        # both halves of the filter agree on every row and -and reads exactly like -or.
        # These two rows disagree: a tenant-wide consent that happens to carry a principal
        # id, and a per-user consent with none. As -or, the first is ingested as though a
        # user had personally authorised it -- which is the distinction this phase exists
        # to make -- and the second produces an assignment held by nobody.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith {
            @(
                [pscustomobject]@{ id = 'g1'; consentType = 'AllPrincipals'; principalId = 'u9'
                    clientId = 'cli'; resourceId = 'api'; scope = 'Directory.Read.All' }
                [pscustomobject]@{ id = 'g2'; consentType = 'Principal'; principalId = $null
                    clientId = 'cli'; resourceId = 'api'; scope = 'Mail.Read' }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/' } -MockWith {
            [pscustomobject]@{ id = 'cli'; displayName = 'Client App'; appId = 'app-cli' }
        }

        Sync-EntraOAuth2Grants -SystemId 3 -Timings ([ordered]@{})

        # Neither row qualifies, so nothing is ingested at all.
        (Get-Sent { $_.Scope.resourceType -eq 'DelegatedPermission' }) | Should -HaveCount 0
        $script:phaseErrors.Count | Should -Be 0
    }

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

    It 'falls back to the raw id when a service-principal lookup fails (still ingests the grant)' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith {
            @([pscustomobject]@{ id = 'g1'; consentType = 'Principal'; principalId = 'u1'; clientId = 'cli'; resourceId = 'api'; scope = 'Mail.Read' })
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/' } -MockWith { throw 'SP deleted' }

        Sync-EntraOAuth2Grants -SystemId 3 -Timings ([ordered]@{})

        (Get-Sent { $_.Scope.resourceType -eq 'Application' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'dedupes grant assignments that collide on (resource, principal)' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'oauth2PermissionGrants' } -MockWith {
            @(
                [pscustomobject]@{ id = 'g1'; consentType = 'Principal'; principalId = 'u1'; clientId = 'cli'; resourceId = 'api'; scope = 'Mail.Read' }
                [pscustomobject]@{ id = 'g3'; consentType = 'Principal'; principalId = 'u1'; clientId = 'cli'; resourceId = 'api'; scope = 'Mail.Read Calendar.Read' }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/' } -MockWith { [pscustomobject]@{ id = 'x'; displayName = 'X'; appId = 'ax'; publisherName = 'p' } }

        Sync-EntraOAuth2Grants -SystemId 3 -Timings ([ordered]@{})

        # Raw: Mail.Read(u1) from both grants + Calendar.Read(u1) = 3; deduped to 2 unique.
        $assigns = Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'DelegatedPermission' }
        $assigns[0].Records.Count | Should -Be 2
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

    It 'announces the expansion when there is at least one group, and stays quiet otherwise' {
        # `groupCount -gt 0` guards the only line telling an operator that a /transitiveMembers
        # fan-out is starting -- the slowest part of the phase. Read as -gt 1, a run expanding
        # exactly ONE group looks like it stalled with no explanation; read as always, an
        # empty run claims to be expanding nothing.
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Update-CrawlerProgress -MockWith { }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'transitiveMembers' } -MockWith {
            @([pscustomobject]@{ id = 'u1'; '@odata.type' = '#microsoft.graph.user' })
        }

        $one = @{ 'grp1' = [System.Collections.Generic.List[object]]::new() }
        $one['grp1'].Add(@{ roleResId = 'rr1'; roleId = 'role-a'; sourceAssignmentId = 'aa1'; appName = 'App One' })
        Expand-EntraAppRoleGroupAssignments -GroupAssns $one | Out-Null
        ($script:said -join "`n") | Should -Match 'Expanding 1 group'

        $script:said.Clear()
        Expand-EntraAppRoleGroupAssignments -GroupAssns @{} | Out-Null
        ($script:said -join "`n") | Should -Not -Match 'Expanding'
    }

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


    It 'picks up an app that has roles OR requires assignment, and skips one with neither' {
        # The candidate filter is "has at least one app role OR requires assignment".
        # The other test's SP satisfies BOTH, so it cannot tell that from AND -- and
        # read as AND, every app that only requires assignment, and every app that
        # merely publishes roles, silently drops out of the whole phase. Three SPs,
        # one per case, and the role-bearing one has exactly ONE role so the
        # "at least one" boundary is exercised too.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith {
            @(
                [pscustomobject]@{ id = 'sp-roles';    displayName = 'Has Roles';  appId = 'a1'; appRoleAssignmentRequired = $false
                                   appRoles = @([pscustomobject]@{ id = 'role-a'; displayName = 'Admin'; value = 'admin' }) }
                [pscustomobject]@{ id = 'sp-required'; displayName = 'Needs Assn'; appId = 'a2'; appRoleAssignmentRequired = $true
                                   appRoles = @() }
                [pscustomobject]@{ id = 'sp-neither';  displayName = 'Plain';      appId = 'a3'; appRoleAssignmentRequired = $false
                                   appRoles = @() }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'appRoleAssignedTo' } -MockWith { @() }

        Sync-EntraAppRoles -SystemId 5 -Timings ([ordered]@{})

        # Being a candidate means the phase goes and fetches that app's role
        # assignments. Two of the three qualify; as AND neither does, and with the
        # "at least one role" boundary read as "more than one" only sp-required is
        # left. Asserting on the resources uploaded would not work here: an app
        # that merely REQUIRES assignment publishes no roles, so it contributes no
        # Application record even though it was correctly inspected.
        Should -Invoke Invoke-FGGetRequest -Exactly 2 -ParameterFilter { $URI -match 'appRoleAssignedTo' }
        Should -Invoke Invoke-FGGetRequest -Exactly 1 -ParameterFilter { $URI -match 'sp-roles/appRoleAssignedTo' }
        Should -Invoke Invoke-FGGetRequest -Exactly 1 -ParameterFilter { $URI -match 'sp-required/appRoleAssignedTo' }
        Should -Invoke Invoke-FGGetRequest -Exactly 0 -ParameterFilter { $URI -match 'sp-neither/appRoleAssignedTo' }
    }

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

    It 'skips a single app whose appRoleAssignedTo fetch fails, without failing the phase' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals\?' } -MockWith {
            @(
                [pscustomobject]@{ id = 'spBad'; displayName = 'Bad'; appId = 'aB'; appRoleAssignmentRequired = $true; appRoles = @() }
                [pscustomobject]@{ id = 'spGood'; displayName = 'Good'; appId = 'aG'; appRoleAssignmentRequired = $true
                    appRoles = @([pscustomobject]@{ id = 'role-a'; displayName = 'Admin'; value = 'admin' }) }
            )
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/spBad/appRoleAssignedTo' } -MockWith { throw 'Graph 500' }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'servicePrincipals/spGood/appRoleAssignedTo' } -MockWith {
            @([pscustomobject]@{ id = 'aa1'; appRoleId = 'role-a'; principalId = 'u1'; principalType = 'User'; createdDateTime = '2026-01-01T00:00:00Z' })
        }

        Sync-EntraAppRoles -SystemId 5 -Timings ([ordered]@{})

        # Only the good app emitted an Application resource; the bad one was skipped, not fatal.
        (Get-Sent { $_.Scope.resourceType -eq 'Application' })[0].Records.Count | Should -Be 1
        $script:phaseErrors.Count | Should -Be 0
    }
}

# ─── Sync-EntraResources ────────────────────────────────────────────────────────
Describe 'Sync-EntraResources' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'uploads Group resources and returns the raw groups (only the groups)' {
        $fixtureGroups = @(
            [pscustomobject]@{ id = 'g1'; displayName = 'Group One'; securityEnabled = $true }
            [pscustomobject]@{ id = 'g2'; displayName = 'Group Two'; securityEnabled = $true }
        )
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/groups\?' } -MockWith { $fixtureGroups }

        $timings = [ordered]@{}
        $returned = Sync-EntraResources -SystemId 2 -CustomGroupAttributes @() -Timings $timings

        (Get-Sent { $_.Scope.resourceType -eq 'Group' })[0].Records.Count | Should -Be 2
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

    It 'warns about groups that failed after retries, separately for members and owners' {
        # Every fixture here uses errorCount = 0, so the two warnings could never
        # fire and nothing noticed. They matter: a partial fetch still uploads as a
        # FULL sync, so anything missed is reconciled away as deleted. The warning
        # is the only signal that the run was incomplete, and the counts have to
        # come from the right fetch -- one failure on members, two on owners.
        # One failure on each fetch, in SEPARATE runs. A single test using 1 and 2
        # proves the counts come from the right fetch but leaves "more than one"
        # alive on whichever side got the 2 -- so each side needs its own run where
        # its count is exactly one, and the other side is clean.
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'members' } -MockWith {
            @{ records = @(@{ resourceId = 'g1'; principalId = 'u1'; assignmentType = 'Direct'; resourceType = 'Group'; principalType = 'User' }); errorCount = 1 }
        }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'owners' } -MockWith {
            @{ records = @(@{ groupId = 'g1'; principalId = 'o1' }); errorCount = 0 }
        }

        Sync-EntraAssignments -SystemId 1 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'Group One' }) -Timings ([ordered]@{})

        $out = $script:said -join "`n"
        $out | Should -Match 'WARNING: 1 groups failed after retries'
        $out | Should -Not -Match 'owner fetch'          # the clean fetch stays quiet
        # ...and the records that did come back are still uploaded.
        (Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'Group' })[0].Records.Count | Should -Be 1
    }

    It 'warns about a single group that failed during the OWNER fetch' {
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'members' } -MockWith {
            @{ records = @(@{ resourceId = 'g1'; principalId = 'u1'; assignmentType = 'Direct'; resourceType = 'Group'; principalType = 'User' }); errorCount = 0 }
        }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'owners' } -MockWith {
            @{ records = @(@{ groupId = 'g1'; principalId = 'o1' }); errorCount = 1 }
        }

        Sync-EntraAssignments -SystemId 1 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'Group One' }) -Timings ([ordered]@{})

        $out = $script:said -join "`n"
        $out | Should -Match 'WARNING: 1 groups failed during owner fetch'
        $out | Should -Not -Match 'failed after retries'
    }

    It 'uploads memberships plus ownership resources, relationships and owner assignments' {
        # Get-FGGroupChildrenParallel is the parallel-fetch boundary — mock it per
        # child path so the phase's orchestration (not the runspaces) is exercised.
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'members' } -MockWith {
            @{ records = @(
                @{ resourceId = 'g1'; principalId = 'u1'; assignmentType = 'Direct'; resourceType = 'Group'; principalType = 'User' }
                @{ resourceId = 'g1'; principalId = 'u2'; assignmentType = 'Direct'; resourceType = 'Group'; principalType = 'User' }
              ); errorCount = 0 }
        }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'owners' } -MockWith {
            @{ records = @(@{ groupId = 'g1'; principalId = 'o1' }); errorCount = 0 }
        }

        $groups = @([pscustomobject]@{ id = 'g1'; displayName = 'Group One' })
        $timings = [ordered]@{}
        Sync-EntraAssignments -SystemId 4 -Groups $groups -Timings $timings

        (Get-Sent { $_.Scope.assignmentType -eq 'Direct' -and $_.Scope.resourceType -eq 'Group' })[0].Records.Count | Should -Be 2
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

    It 'runs the member/owner record-builders and warns on groups that failed after retries' {
        # Invoke the passed -RecordBuilder so the shaping scriptblocks are exercised,
        # and report a non-zero errorCount to hit the WARNING branches.
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'members' } -MockWith {
            $rec = & $RecordBuilder ([pscustomobject]@{ resourceId = 'g1'; principalId = 'grp2'; childType = '#microsoft.graph.group' })
            @{ records = @($rec); errorCount = 1 }
        }
        Mock Get-FGGroupChildrenParallel -ParameterFilter { $ChildPath -eq 'owners' } -MockWith {
            $rec = & $RecordBuilder ([pscustomobject]@{ resourceId = 'g1'; principalId = 'o1' })
            @{ records = @($rec); errorCount = 2 }
        }

        Sync-EntraAssignments -SystemId 4 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'G1' }) -Timings ([ordered]@{})

        # The member builder classifies a nested group child as principalType 'Group'.
        (Get-Sent { $_.Scope.resourceType -eq 'Group' -and $_.Scope.assignmentType -eq 'Direct' })[0].Records[0].principalType | Should -Be 'Group'
        # The owner builder produced a raw owner row that became one owner assignment.
        (Get-Sent { $_.Scope.resourceType -eq 'GroupOwnership' -and $_.Endpoint -eq 'ingest/resource-assignments' })[0].Records[0].principalId | Should -Be 'o1'
        $script:phaseErrors.Count | Should -Be 0
    }
}

# ─── Sync-EntraPim ──────────────────────────────────────────────────────────────
Describe 'Sync-EntraPim' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'uploads deduped Eligible Group assignments and skips dynamic groups' {
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

        $sent = Get-Sent { $_.Scope.assignmentType -eq 'Eligible' -and $_.Scope.resourceType -eq 'Group' }
        $sent[0].Records.Count | Should -Be 2   # (g1,u1) deduped + (g2,u2)
        $sent[0].Records[0].resourceType | Should -Be 'Group'
        # The dynamic group must be filtered out before the parallel fetch.
        Should -Invoke Invoke-FGGroupPimBatchParallel -Exactly 1 -ParameterFilter { @($Batch).id -notcontains 'gDyn' }
        $timings.Contains('PIM') | Should -BeTrue
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'splits more groups than one batch holds into exact, non-overlapping batches' {
        # Every other fixture here has 3 groups against a batch size of 200, so the
        # loop runs once and the window arithmetic cannot be wrong in any way that
        # shows. One group past the batch size is what exercises it, and the two
        # failure modes are both silent: an off-by-one on the window end re-sends
        # the boundary group (duplicate eligibilities) or reads past the end of the
        # list (nulls into the batch); a wrong batch size collapses it back to a
        # single request, which is the OOM the batching exists to prevent.
        $groups = 1..201 | ForEach-Object { [pscustomobject]@{ id = "g$_"; displayName = "G$_"; groupTypes = @() } }
        $script:pimBatches = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-FGGroupPimBatchParallel -MockWith {
            $script:pimBatches.Add(@($Batch))
            @()
        }

        Sync-EntraPim -SystemId 1 -Groups $groups -Timings ([ordered]@{})

        $script:pimBatches.Count      | Should -Be 2
        @($script:pimBatches[0]).Count | Should -Be 200
        @($script:pimBatches[1]).Count | Should -Be 1

        $seen = @($script:pimBatches | ForEach-Object { $_ } | ForEach-Object { $_.id })
        $seen | Should -Not -Contain $null           # never reads past the end
        $seen.Count | Should -Be 201                 # nothing sent twice
        @($seen | Sort-Object -Unique).Count | Should -Be 201   # nothing missed
    }

    It 'uploads a lone eligibility — one is not the same as none' {
        # The tests either side of this one use 2 records and 0 records, and the
        # guard is `Count -gt 0`. Neither value can tell that from `-gt 1`, which
        # would drop a tenant with exactly one PIM eligibility on the floor: no
        # ingest call, no error, nothing to notice.
        Mock Invoke-FGGroupPimBatchParallel -MockWith {
            @([pscustomobject]@{ resourceId = 'g1'; principalId = 'u1'; principalType = 'User'; assignmentType = 'Eligible'; state = 'Provisioned'; expirationDateTime = $null })
        }

        Sync-EntraPim -SystemId 3 -Groups @([pscustomobject]@{ id = 'g1'; displayName = 'G1'; groupTypes = @() }) -Timings ([ordered]@{})

        $sent = Get-Sent { $_.Scope.assignmentType -eq 'Eligible' -and $_.Scope.resourceType -eq 'Group' }
        $sent | Should -HaveCount 1
        $sent[0].Records.Count | Should -Be 1
        $sent[0].Records[0].resourceId  | Should -Be 'g1'
        $sent[0].Records[0].principalId | Should -Be 'u1'
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
        Should -Invoke Send-IngestBatch -Exactly 1 -ParameterFilter { @($DeletedIds).Count -gt 0 }
    }

    It 'still delivers tombstones when the first bucket is empty, and sends no empty batch after it' {
        # The guard reads "skip an empty bucket UNLESS it is the first one and there
        # are removals to attach". Both existing tests have a non-empty first
        # bucket, so the exception it exists for never ran. Here the delta found
        # only a managed identity plus a deletion, which is an ordinary delta:
        #
        #   ServicePrincipal - empty, but must still go out to carry the deletes
        #   ManagedIdentity  - one record, no deletes (they have already gone)
        #   AIAgent          - empty and not first, so no call at all
        #
        # Getting this wrong is silent either way: the deletion is never applied,
        # or an empty full-sync batch reconciles a whole principalType away.
        $sps = @([pscustomobject]@{ id = 'mi1'; appId = 'a2'; displayName = 'Managed'; servicePrincipalType = 'ManagedIdentity'; accountEnabled = $true })

        Send-EntraServicePrincipalBatches -SystemId 3 -Sps $sps -RemovedSpIds @('gone1') -SpDeltaHit $true

        @($script:sent).Count | Should -Be 2                     # no AIAgent call
        $spCall = Get-Sent { $_.Scope.principalType -eq 'ServicePrincipal' }
        $miCall = Get-Sent { $_.Scope.principalType -eq 'ManagedIdentity' }
        $spCall | Should -HaveCount 1
        @($spCall[0].Records).Count | Should -Be 0
        $miCall[0].Records.Count | Should -Be 1
        # The id-scoped delete runs once, on the first bucket only.
        Should -Invoke Send-IngestBatch -Exactly 1 -ParameterFilter { @($DeletedIds).Count -gt 0 }
    }

    It 'uses full syncMode and sends no deletes on a non-delta run' {
        $sps = @([pscustomobject]@{ id = 'sp1'; appId = 'a1'; displayName = 'App One'; servicePrincipalType = 'Application'; accountEnabled = $true })
        Send-EntraServicePrincipalBatches -SystemId 1 -Sps $sps -RemovedSpIds @() -SpDeltaHit $false

        (Get-Sent { $_.Scope.principalType -eq 'ServicePrincipal' })[0].SyncMode | Should -Be 'full'
        Should -Invoke Send-IngestBatch -Exactly 0 -ParameterFilter { @($DeletedIds).Count -gt 0 }
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
        Should -Invoke Set-FGDeltaToken -Exactly 1 -ParameterFilter { $Token -eq 'primed-tok' }
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

# ─── Get-EntraServicePrincipalData (delta paths) ────────────────────────────────
Describe 'Get-EntraServicePrincipalData' {
    BeforeEach {
        Reset-PhaseTestState
        Mock Remove-FGDeltaToken -MockWith { }
    }

    It 'delta mode with a stored token fetches only changed SPs and collects @removed tombstones' {
        Mock Get-FGDeltaToken -MockWith { 'stored-tok' }
        Mock Invoke-FGGetDeltaRequest -MockWith {
            @{ value = @(
                [pscustomobject]@{ id = 'sp1'; displayName = 'Changed' }
                [pscustomobject]@{ id = 'sp3'; displayName = 'Also changed' }
                [pscustomobject]@{ id = 'sp2'; '@removed' = [pscustomobject]@{ reason = 'deleted' } }
            ); deltaToken = 'next-tok' }
        }
        $r = Get-EntraServicePrincipalData -SystemId 5 -SyncMode 'delta'
        $r.spDeltaHit       | Should -BeTrue
        # Assert WHICH service principals came back, not just how many. With one live and
        # one removed the counts are symmetric, so dropping the negation swaps the two
        # lists and every assertion still reads 1 -- the crawler would then upsert the
        # deleted SP and tombstone the live ones.
        @($r.sps).Count     | Should -Be 2
        @($r.sps.id)        | Should -Be @('sp1', 'sp3')
        @($r.removedSpIds)  | Should -Be @('sp2')
        $r.newSpsToken      | Should -Be 'next-tok'
    }

    It 'falls back to a full fetch when the delta token is rejected (InvalidOperationException)' {
        Mock Get-FGDeltaToken -MockWith { 'bad-tok' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'deltatoken=' } -MockWith { throw [System.InvalidOperationException]::new('token rejected') }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'select=id' } -MockWith { @{ deltaToken = 'primed' } }
        Mock Invoke-FGGetRequest -MockWith { @([pscustomobject]@{ id = 'sp1'; displayName = 'Full' }) }
        $r = Get-EntraServicePrincipalData -SystemId 5 -SyncMode 'delta'
        $r.spDeltaHit   | Should -BeFalse
        @($r.sps).Count | Should -Be 1
        Should -Invoke Remove-FGDeltaToken -Exactly 1
    }

    It 'falls back to a full fetch on a generic delta failure' {
        Mock Get-FGDeltaToken -MockWith { 'tok' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'deltatoken=' } -MockWith { throw 'network glitch' }
        Mock Invoke-FGGetDeltaRequest -ParameterFilter { $URI -match 'select=id' } -MockWith { @{ deltaToken = 'primed' } }
        Mock Invoke-FGGetRequest -MockWith { @([pscustomobject]@{ id = 'sp1' }) }
        (Get-EntraServicePrincipalData -SystemId 5 -SyncMode 'delta').spDeltaHit | Should -BeFalse
    }

    It 'swallows a delta-token priming failure on the full path' {
        Mock Get-FGDeltaToken -MockWith { $null }
        Mock Invoke-FGGetRequest -MockWith { @([pscustomobject]@{ id = 'sp1' }) }
        Mock Invoke-FGGetDeltaRequest -MockWith { throw 'prime failed' }
        { Get-EntraServicePrincipalData -SystemId 5 -SyncMode 'full' } | Should -Not -Throw
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
        Should -Invoke Invoke-FGGetRequest -Exactly 1
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

    It 'queries one calendar day per slice, labelled and counted' {
        # Nothing asserted the day windows, so the loop arithmetic was free: the
        # slice could span the wrong day, be labelled with the wrong number, or
        # report the wrong event count, and every test still passed. The progress
        # line carries all three unescaped, so pinning it pins the query.
        Mock Get-Date -MockWith { [datetime]::SpecifyKind([datetime]'2026-01-10T00:00:00', 'Utc') }
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Invoke-FGGetRequestStream -MockWith {
            @([pscustomobject]@{ userId = 'u1'; appId = 'a1'; createdDateTime = '2026-01-09T10:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } })
        }

        Sync-EntraSignInLogs -SystemId 5 -Sps @([pscustomobject]@{ id = 'sp1'; appId = 'a1' }) -SignInLogsDays 2 -Timings ([ordered]@{})

        $out = $script:said -join "`n"
        # Day 1 is yesterday..today; day 2 is the day before that. Each holds one event.
        $out | Should -Match ([regex]::Escape('Slice 1/2 (2026-01-09T00:00:00Z..2026-01-10T00:00:00Z): 1 events'))
        $out | Should -Match ([regex]::Escape('Slice 2/2 (2026-01-08T00:00:00Z..2026-01-09T00:00:00Z): 1 events'))
        $out | Should -Match 'Pulled 2 events across 2 slices'
    }

    It 'counts an unusable event as skipped, not as aggregated' {
        # `-not (Add-...ToAggregate ...)` decides which events are skipped. With the
        # negation dropped, the meaning inverts: the events that DID aggregate get
        # counted as skipped and vice versa. One of each separates the two.
        Mock Get-Date -MockWith { [datetime]::SpecifyKind([datetime]'2026-01-10T00:00:00', 'Utc') }
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        # ASYMMETRIC on purpose: TWO events that aggregate against ONE that cannot. With
        # one of each, inverting the negation swaps two 1s and the message reads the same.
        Mock Invoke-FGGetRequestStream -MockWith {
            @(
                [pscustomobject]@{ userId = 'u1'; appId = 'a1';      createdDateTime = '2026-01-09T10:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } }
                [pscustomobject]@{ userId = 'u2'; appId = 'a1';      createdDateTime = '2026-01-09T10:30:00Z'; status = [pscustomobject]@{ errorCode = 0 } }
                [pscustomobject]@{ userId = 'u3'; appId = 'unknown'; createdDateTime = '2026-01-09T11:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } }
            )
        }

        Sync-EntraSignInLogs -SystemId 5 -Sps @([pscustomobject]@{ id = 'sp1'; appId = 'a1' }) -SignInLogsDays 1 -Timings ([ordered]@{})

        ($script:said -join "`n") | Should -Match 'Skipped 1 events'
        # ...and the two that DID aggregate are uploaded, as two distinct (user, app) pairs.
        (Get-Sent { $_.Endpoint -eq 'ingest/principal-activity' })[0].Records.Count | Should -Be 2
    }

    It 'records a PARTIAL slice failure and still uploads the slice that worked' {
        # The "every slice fails" test below throws at the all-failed guard, so the
        # partial branch underneath it never runs in any test. One failed day out of
        # two is the only input that reaches it, and it separates three things at
        # once: the all-failed guard must NOT fire (as -or it would, aborting a run
        # that merely lost one day), the partial branch must record how many failed,
        # and the single surviving (user, app) pair must still be uploaded rather
        # than dropped for being one.
        $script:sliceCall = 0
        Mock Invoke-FGGetRequestStream -MockWith {
            $script:sliceCall++
            if ($script:sliceCall -eq 1) { throw 'Graph 400 skiptoken expired' }
            @([pscustomobject]@{ userId = 'u1'; appId = 'a1'; createdDateTime = '2026-06-01T10:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } })
        }

        Sync-EntraSignInLogs -SystemId 4 -Sps @([pscustomobject]@{ id = 'sp1'; appId = 'a1' }) -SignInLogsDays 2 -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        # Naming the failed day too: the message is built from the loop index, so
        # 'day 1' is the difference between reporting the day that failed and
        # reporting a neighbour.
        $script:phaseErrors[0] | Should -BeLike 'SignInLogs: 1 of 2 day slice*day 1:*'
        $act = Get-Sent { $_.Endpoint -eq 'ingest/principal-activity' }
        $act | Should -HaveCount 1
        $act[0].Records.Count | Should -Be 1
        $act[0].Records[0].principalId | Should -Be 'u1'
    }

    It 'records a phase failure when every day slice fails' {
        Mock Invoke-FGGetRequestStream -MockWith { throw 'Graph 400 skiptoken expired' }
        Sync-EntraSignInLogs -SystemId 1 -Sps @([pscustomobject]@{ id = 'sp1'; appId = 'a1' }) -SignInLogsDays 2 -Timings ([ordered]@{})

        $script:phaseErrors | Should -HaveCount 1
        # 'SignInLogs:*' alone matches the PARTIAL message too, so it could not tell
        # the all-failed guard from the partial one. This is the abort path.
        $script:phaseErrors[0] | Should -BeLike '*All 2 sign-in log slices failed*'
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

    It 'Sync-EntraGovernanceResourceScopes skips an access package whose detail fetch fails' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessPackages/apGood' } -MockWith {
            [pscustomobject]@{ accessPackageResourceRoleScopes = @(
                [pscustomobject]@{ accessPackageResourceScope = [pscustomobject]@{ originId = 'grp1' }; accessPackageResourceRole = [pscustomobject]@{ displayName = 'Member'; originSystem = 'AadGroup' } }
            ) }
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessPackages/apBad' } -MockWith { throw 'AP fetch 504' }
        $aps = @([pscustomobject]@{ id = 'apBad'; displayName = 'Bad AP' }, [pscustomobject]@{ id = 'apGood'; displayName = 'Good AP' })
        Sync-EntraGovernanceResourceScopes -SystemId 1 -AccessPackages $aps

        # The good AP still produced its relationship; the failing AP was skipped, not fatal.
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

# ─── Sync-EntraGovernanceReviews + Get-EntraAccessReviewCertRecords ─────────────
Describe 'Sync-EntraGovernanceReviews' {
    BeforeEach { Reset-PhaseTestState; Mock Send-IngestBatch -MockWith $script:SendMock }

    It 'walks AP-scoped review definitions and uploads certification decisions' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessReviews/definitions\?' } -MockWith { @([pscustomobject]@{ id = 'rd1' }) }
        Mock Resolve-EntraAccessReviewApId -MockWith { @{ apId = 'ap-1' } }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/instances\?' } -MockWith { @([pscustomobject]@{ id = 'inst1' }) }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/decisions' } -MockWith {
            @([pscustomobject]@{ id = 'dec1'; decision = 'Approve'; principal = [pscustomobject]@{ id = 'u1'; displayName = 'Alice' } })
        }
        Sync-EntraGovernanceReviews -SystemId 3
        (Get-Sent { $_.Endpoint -eq 'ingest/governance/certifications' }).Count | Should -BeGreaterThan 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'skips definitions with no access-package id and uploads nothing' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessReviews/definitions\?' } -MockWith { @([pscustomobject]@{ id = 'rd1' }) }
        Mock Resolve-EntraAccessReviewApId -MockWith { @{ apId = $null; reason = 'nomatch'; queryStrings = @('someQuery') } }
        Sync-EntraGovernanceReviews -SystemId 3
        (Get-Sent { $_.Endpoint -eq 'ingest/governance/certifications' }).Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'reports how many definitions were skipped, why, and how many were kept' {
        # This summary is the only place the noScope / noApMatch tally is ever
        # shown, and nothing asserted it — so every counter start and every + and -
        # in the arithmetic was free. One definition of each kind makes all three
        # numbers distinct (1, 1, 2 skipped, 1 kept), which no single-outcome
        # fixture can do: with only "kept" cases the tally is 0 + 0 = 0 either way.
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessReviews/definitions\?' } -MockWith {
            @(
                [pscustomobject]@{ id = 'rd1' }   # kept
                [pscustomobject]@{ id = 'rd2' }   # skipped: no scope
                [pscustomobject]@{ id = 'rd4' }   # skipped: no scope (TWO of them, deliberately)
                [pscustomobject]@{ id = 'rd3' }   # skipped: scope, but no AP id in it
            )
        }
        # Deliberately ASYMMETRIC: two no-scope against one no-match. With one of each the
        # tally reads "1 (no scope) + 1 (no access-package id)" either way round, so the
        # branch that decides WHICH counter to bump cannot be told from its opposite.
        Mock Resolve-EntraAccessReviewApId -MockWith {
            switch ($Definition.id) {
                'rd1'   { @{ apId = 'ap-1' } }
                'rd2'   { @{ apId = $null; reason = 'noscope' } }
                'rd4'   { @{ apId = $null; reason = 'noscope' } }
                default { @{ apId = $null; reason = 'nomatch'; queryStrings = @('someQuery') } }
            }
        }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/instances\?' } -MockWith { @([pscustomobject]@{ id = 'inst1' }) }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/decisions' } -MockWith {
            @([pscustomobject]@{ id = 'dec1'; decision = 'Approve'; principal = [pscustomobject]@{ id = 'u1'; displayName = 'Alice' } })
        }

        Sync-EntraGovernanceReviews -SystemId 3

        $out = $script:said -join "`n"
        $out | Should -Match ([regex]::Escape('4 total; skipped 2 (no scope) + 1 (no access-package id) = 3 skipped; kept 1'))
        # THREE skips but only TWO sample lines: the sample budget is two, and it is a
        # budget rather than a per-skip log. Starting the counter anywhere but zero spends
        # one before the first skip happens; raising the ceiling logs every skip, which on
        # a tenant with hundreds of unmatched definitions is what the budget exists to stop.
        @($script:said | Where-Object { $_ -match 'sample skip' }) | Should -HaveCount 2
    }

    It 'records a phase failure when the definitions fetch throws' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match 'accessReviews/definitions\?' } -MockWith { throw 'Graph 400' }
        Sync-EntraGovernanceReviews -SystemId 3
        $script:phaseErrors[0] | Should -BeLike 'Governance/AccessReviews:*'
    }

    It 'Get-EntraAccessReviewCertRecords skips an instance whose decisions call fails' {
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/instances\?' } -MockWith { @([pscustomobject]@{ id = 'inst1' }) }
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/decisions' } -MockWith { throw 'HTTP 400 bad decisions' }
        @(Get-EntraAccessReviewCertRecords -Definition ([pscustomobject]@{ id = 'rd1' }) -ApId 'ap-1').Count | Should -Be 0
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
        Should -Invoke Remove-FGDeltaToken -Exactly 1
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

    It 'uploads sign-in activity for a SINGLE user with activity' {
        # `activityRecords.Count -gt 0`. Every other fixture here has users with no
        # signInActivity at all, so the guard is only ever seen with an empty list -- and
        # exactly one record is what separates "at least one" from "more than one". Read as
        # `-gt 1`, a tenant where only one person has ever signed in reports no activity.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith {
            @(
                [pscustomobject]@{ id = 'u1'; displayName = 'Alice'; userPrincipalName = 'a@x'; accountEnabled = $true
                                   signInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-06-01T10:00:00Z' } }
                [pscustomobject]@{ id = 'u2'; displayName = 'Bob';   userPrincipalName = 'b@x'; accountEnabled = $true }
            )
        }

        Sync-EntraPrincipals -SystemId 5 -SyncMode 'full' -Timings ([ordered]@{})

        $act = Get-Sent { $_.Endpoint -eq 'ingest/principal-activity' }
        $act | Should -HaveCount 1
        $act[0].Records.Count | Should -Be 1
        $act[0].Records[0].principalId | Should -Be 'u1'
    }

    It 'sends no activity batch when nobody has signed in' {
        # The paired case: without it, "always upload" passes the test above.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith {
            @([pscustomobject]@{ id = 'u1'; displayName = 'Alice'; userPrincipalName = 'a@x'; accountEnabled = $true })
        }

        Sync-EntraPrincipals -SystemId 5 -SyncMode 'full' -Timings ([ordered]@{})

        (Get-Sent { $_.Endpoint -eq 'ingest/principal-activity' }) | Should -HaveCount 0
    }

    It 'derives identities only when the filter names an attribute' {
        # `IdentityFilter.Count -gt 0 -and IdentityFilter['attribute']`. A non-empty filter
        # that names no attribute is a real configuration -- the wizard writes the key
        # before the value is chosen. Read as -or, identity correlation runs against a
        # filter with nothing to correlate on.
        Mock Invoke-FGGetRequest -ParameterFilter { $URI -match '/users\?\$select' } -MockWith {
            @([pscustomobject]@{ id = 'u1'; displayName = 'Alice'; userPrincipalName = 'a@x'; accountEnabled = $true })
        }
        Mock Sync-EntraIdentities -MockWith { }

        Sync-EntraPrincipals -SystemId 5 -SyncMode 'full' -Timings ([ordered]@{}) -IdentityFilter @{ mode = 'all' }
        Should -Invoke Sync-EntraIdentities -Exactly 0

        Sync-EntraPrincipals -SystemId 5 -SyncMode 'full' -Timings ([ordered]@{}) -IdentityFilter @{ attribute = 'employeeId' }
        Should -Invoke Sync-EntraIdentities -Exactly 1
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
        Should -Invoke Set-FGDeltaToken -Exactly 1 -ParameterFilter { $Token -eq 'primed' }
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

# ─── Resolve-EntraSyncConfig (pure) ─────────────────────────────────────────────
Describe 'Resolve-EntraSyncConfig' {

    It 'applies the documented defaults for an empty config' {
        $c = Resolve-EntraSyncConfig -RawConfig @{}
        $c.SyncMode | Should -Be 'delta'
        $c.SyncPrincipals | Should -BeTrue
        $c.SyncServicePrincipals | Should -BeFalse
        $c.SyncResources | Should -BeTrue
        $c.SyncGovernance | Should -BeTrue
        $c.SyncPim | Should -BeFalse
        # The five below were the only flags this test left out, and they are the
        # expensive ones: sign-in logs, OAuth2 grants, app roles, principal
        # relationships and directory roles all cost extra Graph calls (sign-in
        # logs additionally need AuditLog.Read.All consent). A default that
        # silently flipped to $true would make every new crawler do all of it.
        $c.SyncAssignments | Should -BeTrue
        $c.SyncSignInLogs | Should -BeFalse
        $c.SyncOAuth2Grants | Should -BeFalse
        $c.SyncAppRoles | Should -BeFalse
        $c.SyncPrincipalRelationships | Should -BeFalse
        $c.SyncDirectoryRoles | Should -BeFalse
        $c.RefreshViews | Should -BeTrue
        $c.SignInLogsDays | Should -Be 7
        @($c.CustomUserAttributes).Count | Should -Be 0
        $c.IdentityFilter.Count | Should -Be 0
    }

    It 'honours _syncMode=full and ignores an invalid value' {
        (Resolve-EntraSyncConfig -RawConfig @{ _syncMode = 'full' }).SyncMode | Should -Be 'full'
        (Resolve-EntraSyncConfig -RawConfig @{ _syncMode = 'bogus' }).SyncMode | Should -Be 'delta'
    }

    It 'applies selectedObjects overrides' {
        $c = Resolve-EntraSyncConfig -RawConfig @{ selectedObjects = @{ servicePrincipals = $true; pim = $true; identity = $false } }
        $c.SyncServicePrincipals | Should -BeTrue
        $c.SyncPim | Should -BeTrue
        $c.SyncPrincipals | Should -BeFalse
    }

    It 'lets usersGroupsMembers drive the three user/group toggles (after identity)' {
        $c = Resolve-EntraSyncConfig -RawConfig @{ selectedObjects = @{ identity = $true; usersGroupsMembers = $false } }
        $c.SyncPrincipals | Should -BeFalse
        $c.SyncResources | Should -BeFalse
        $c.SyncAssignments | Should -BeFalse
    }

    It 'defaults SyncPrincipalRelationships off and honours both toggle shapes' {
        (Resolve-EntraSyncConfig -RawConfig @{}).SyncPrincipalRelationships | Should -BeFalse
        (Resolve-EntraSyncConfig -RawConfig @{ selectedObjects = @{ principalRelationships = $true } }).SyncPrincipalRelationships | Should -BeTrue
        (Resolve-EntraSyncConfig -RawConfig @{ syncPrincipalRelationships = $true }).SyncPrincipalRelationships | Should -BeTrue
    }

    It 'applies direct backward-compat toggles and signInLogsDays' {
        $c = Resolve-EntraSyncConfig -RawConfig @{ syncGovernance = $false; syncSignInLogs = $true; signInLogsDays = 14 }
        $c.SyncGovernance | Should -BeFalse
        $c.SyncSignInLogs | Should -BeTrue
        $c.SignInLogsDays | Should -Be 14
    }

    It 'merges customUserAttributes + identityAttributes uniquely' {
        $c = Resolve-EntraSyncConfig -RawConfig @{ customUserAttributes = @('a','b'); identityAttributes = @('b','c') }
        @($c.CustomUserAttributes) | Should -Be @('a','b','c')
    }

    It 'adopts an identity filter only when it has an attribute' {
        (Resolve-EntraSyncConfig -RawConfig @{ identityFilter = @{ attribute = 'dept'; condition = 'equals'; value = 'x' } }).IdentityFilter.attribute | Should -Be 'dept'
        (Resolve-EntraSyncConfig -RawConfig @{ identityFilter = @{ condition = 'equals' } }).IdentityFilter.Count | Should -Be 0
    }

    It 'reads customGroupAttributes and aiNamePatterns' {
        $c = Resolve-EntraSyncConfig -RawConfig @{ customGroupAttributes = @('extensionAttribute1'); aiNamePatterns = @('bot*', '*copilot*') }
        @($c.CustomGroupAttributes) | Should -Be @('extensionAttribute1')
        @($c.AINamePatterns) | Should -Be @('bot*', '*copilot*')
    }
}

# ─── Initialize-EntraCrawlerRun ─────────────────────────────────────────────────
Describe 'Initialize-EntraCrawlerRun' {

    It 'returns the systemId from ingest/systems' {
        Mock Invoke-RestMethod -ParameterFilter { $Uri -match 'whoami' } -MockWith { @{ displayName = 'Worker' } }
        Mock Get-FGAccessToken -MockWith { }
        Mock Invoke-IngestAPI -ParameterFilter { $Endpoint -eq 'ingest/systems' } -MockWith { @{ systemIds = @(42) } }

        Initialize-EntraCrawlerRun -ApiBaseUrl 'http://x/api' -ApiKey 'k' -ConfigFile 'c.json' | Should -Be 42
    }

    It 'registers the tenant as enabled and sync-enabled' {
        # These two flags decide whether the tenant shows up in Identity Atlas and whether
        # it is ever crawled again. Registered as $false, a freshly connected tenant is
        # silently inert -- the run reports success and nothing follows it.
        Mock Invoke-RestMethod -ParameterFilter { $Uri -match 'whoami' } -MockWith { @{ displayName = 'Worker' } }
        Mock Get-FGAccessToken -MockWith { }
        $script:sysRecs = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI -ParameterFilter { $Endpoint -eq 'ingest/systems' } -MockWith {
            foreach ($r in @($Body.records)) { $script:sysRecs.Add($r) }
            @{ systemIds = @(42) }
        }

        Initialize-EntraCrawlerRun -ApiBaseUrl 'http://x/api' -ApiKey 'k' -ConfigFile 'c.json' | Out-Null

        $script:sysRecs | Should -HaveCount 1
        $script:sysRecs[0].enabled     | Should -BeTrue
        $script:sysRecs[0].syncEnabled | Should -BeTrue
        $script:sysRecs[0].systemType  | Should -Be 'EntraID'
    }

    It 'falls back to systemId 1 when systemIds comes back EMPTY rather than absent' {
        # The paired test below returns @() -- an empty array is falsy in PowerShell, so
        # the first half of `systemIds -and systemIds.Count -gt 0` already short-circuits
        # and the second half is never reached. A response with the key MISSING entirely
        # is the other shape a caller can send, and both must land on the same fallback.
        Mock Invoke-RestMethod -ParameterFilter { $Uri -match 'whoami' } -MockWith { @{ displayName = 'Worker' } }
        Mock Get-FGAccessToken -MockWith { }
        Mock Invoke-IngestAPI -ParameterFilter { $Endpoint -eq 'ingest/systems' } -MockWith { @{} }

        Initialize-EntraCrawlerRun -ApiBaseUrl 'http://x/api' -ApiKey 'k' -ConfigFile 'c.json' | Should -Be 1
    }

    It 'falls back to systemId 1 when none is returned' {
        Mock Invoke-RestMethod -ParameterFilter { $Uri -match 'whoami' } -MockWith { @{ displayName = 'Worker' } }
        Mock Get-FGAccessToken -MockWith { }
        Mock Invoke-IngestAPI -ParameterFilter { $Endpoint -eq 'ingest/systems' } -MockWith { @{ systemIds = @() } }

        Initialize-EntraCrawlerRun -ApiBaseUrl 'http://x/api' -ApiKey 'k' -ConfigFile 'c.json' | Should -Be 1
    }
}

# ─── Sync-EntraRefreshViews ─────────────────────────────────────────────────────
Describe 'Sync-EntraRefreshViews' {
    BeforeEach { Reset-PhaseTestState }

    It 'calls the refresh-views endpoint and records the phase timing' {
        Mock Invoke-IngestAPI -MockWith { @{} }
        $timings = [ordered]@{}
        Sync-EntraRefreshViews -Timings $timings
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Endpoint -eq 'ingest/refresh-views' }
        $timings.Contains('RefreshViews') | Should -BeTrue
    }

    It 'soft-fails when the refresh endpoint throws' {
        Mock Invoke-IngestAPI -MockWith { throw 'view refresh 500' }
        { Sync-EntraRefreshViews -Timings ([ordered]@{}) } | Should -Not -Throw
    }
}

# ─── Write-EntraPhaseSummary ────────────────────────────────────────────────────
Describe 'Write-EntraPhaseSummary' {
    # These used to assert only `Should -Not -Throw`, which is why every number in
    # this function survived mutation: the seconds, the percentages, the rounding
    # and both guards could all be wrong and still not throw. The summary is the
    # operator's only view of where a multi-hour crawl spent its time, so the
    # numbers ARE the behaviour — they get pinned.
    #
    # The clock is mocked so elapsed is exactly 10s; a phase of 1.234s then gives
    # values that differ at every mutation: 1.2s (1.23 at two decimals), 12.3%
    # (12.34 at two decimals, 12.4 if the 100 shifts, and 0 if the -gt 0 guard
    # flips). The decimal separator is culture-dependent, hence [.,].
    BeforeEach {
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Get-Date -MockWith { [datetime]'2026-01-01T00:00:10Z' }
    }

    It 'prints each phase with its seconds and its share of the run' {
        $timings = [ordered]@{ Principals = [TimeSpan]::FromSeconds(1.234) }

        Write-EntraPhaseSummary -PhaseTimings $timings -SyncStart ([datetime]'2026-01-01T00:00:00Z')

        $out = $script:said -join "`n"
        $out | Should -Match 'Per-phase breakdown'
        $out | Should -Match 'Principals\s+1[.,]2s\s+\(\s*12[.,]3%\)'
    }

    It 'accounts for unmeasured time in an "Other" row' {
        # 10s elapsed - 1.234s measured = 8.766s unaccounted -> 8.8s / 87.7%.
        # Read as elapsed PLUS the phase total, this row reports 11.2s of a 10s run.
        $timings = [ordered]@{ Principals = [TimeSpan]::FromSeconds(1.234) }

        Write-EntraPhaseSummary -PhaseTimings $timings -SyncStart ([datetime]'2026-01-01T00:00:00Z')

        ($script:said -join "`n") | Should -Match 'Other \(setup/etc\)\s+8[.,]8s\s+\(\s*87[.,]7%\)'
    }

    It 'omits the "Other" row when barely any time is unaccounted for' {
        # 0.5s unaccounted: below the threshold, so no row. The paired test above
        # has 8.766s, which stays above the threshold however it is nudged; this
        # one is what pins where the line actually sits.
        $timings = [ordered]@{ Principals = [TimeSpan]::FromSeconds(9.5) }

        Write-EntraPhaseSummary -PhaseTimings $timings -SyncStart ([datetime]'2026-01-01T00:00:00Z')

        ($script:said -join "`n") | Should -Not -Match 'Other \(setup/etc\)'
    }

    It 'prints the "Other" row for 1.5s unaccounted — the threshold is one second, not two' {
        $timings = [ordered]@{ Principals = [TimeSpan]::FromSeconds(8.5) }

        Write-EntraPhaseSummary -PhaseTimings $timings -SyncStart ([datetime]'2026-01-01T00:00:00Z')

        ($script:said -join "`n") | Should -Match 'Other \(setup/etc\)\s+1[.,]5s'
    }

    It 'prints a breakdown for a single phase — one timing is not none' {
        # Count -gt 0 against a one-entry table: as -gt 1 the whole breakdown
        # disappears for any run that recorded exactly one phase.
        $timings = [ordered]@{ Principals = [TimeSpan]::FromSeconds(1.234) }

        Write-EntraPhaseSummary -PhaseTimings $timings -SyncStart ([datetime]'2026-01-01T00:00:00Z')

        ($script:said -join "`n") | Should -Match 'Per-phase breakdown'
    }

    It 'prints no breakdown at all when nothing was timed' {
        Write-EntraPhaseSummary -PhaseTimings ([ordered]@{}) -SyncStart ([datetime]'2026-01-01T00:00:00Z')

        $out = $script:said -join "`n"
        $out | Should -Match 'Sync Complete'
        $out | Should -Not -Match 'Per-phase breakdown'
    }
}

# ─── Write-EntraSyncLog ─────────────────────────────────────────────────────────
Describe 'Write-EntraSyncLog' {
    BeforeEach { Reset-PhaseTestState }

    It 'writes a sync-log entry and posts phases when a job id is present' {
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith { @{} }
        $script:phases.Add(@{ name = 'Principals'; status = 'ok'; durationMs = 5 })

        Write-EntraSyncLog -SyncStart (Get-Date) -JobId 7 -ApiKey 'k' -ApiBaseUrl 'http://x/api'

        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Endpoint -eq 'ingest/sync-log' }
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -match '/jobs/7/phases' }
    }

    It 'skips the phases post when there is no job id' {
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith { @{} }

        Write-EntraSyncLog -SyncStart (Get-Date) -JobId 0 -ApiKey 'k' -ApiBaseUrl 'http://x/api'

        Should -Invoke Invoke-RestMethod -Exactly 0
    }

    It 'does not post an empty phase list even when the job id is good' {
        # The guard is `JobId -and JobId -gt 0 -and phases.Count -gt 0`. The two
        # existing cases are (id 7, one phase) and (id 0, no phases) — in both, all
        # three conditions agree, so neither can tell -and from -or. A good id with
        # nothing to report separates them: as -or it POSTs an empty phases array.
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith { @{} }

        Write-EntraSyncLog -SyncStart (Get-Date) -JobId 7 -ApiKey 'k' -ApiBaseUrl 'http://x/api'

        Should -Invoke Invoke-RestMethod -Exactly 0
    }

    It 'rejects a non-positive job id rather than posting to it' {
        # `JobId -gt 0` is there to reject a bad id, and -1 is the only value that
        # exercises it: 0 is already falsy, so the first clause alone stops it.
        # Read as -or, a negative id posts to /jobs/-1/phases.
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith { @{} }
        $script:phases.Add(@{ name = 'Principals'; status = 'ok'; durationMs = 5 })

        Write-EntraSyncLog -SyncStart (Get-Date) -JobId -1 -ApiKey 'k' -ApiBaseUrl 'http://x/api'

        Should -Invoke Invoke-RestMethod -Exactly 0
    }

    It 'records status=Warning with the joined errors when phases failed' {
        Mock Invoke-IngestAPI -MockWith { @{} }
        $script:phaseErrors.Add('Principals: boom')
        Write-EntraSyncLog -SyncStart (Get-Date) -JobId 0 -ApiKey 'k' -ApiBaseUrl 'http://x/api'
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Body.status -eq 'Warning' -and $Body.errorMessage -match 'boom' }
    }

    It 'soft-fails when the phases POST throws' {
        Mock Invoke-IngestAPI -MockWith { @{} }
        Mock Invoke-RestMethod -MockWith { throw 'jobs api 500' }
        $script:phases.Add(@{ name = 'Principals'; status = 'ok'; durationMs = 5 })
        { Write-EntraSyncLog -SyncStart (Get-Date) -JobId 7 -ApiKey 'k' -ApiBaseUrl 'http://x/api' } | Should -Not -Throw
    }

    It 'soft-fails when the sync-log write throws' {
        Mock Invoke-IngestAPI -MockWith { throw 'ingest 500' }
        { Write-EntraSyncLog -SyncStart (Get-Date) -JobId 0 -ApiKey 'k' -ApiBaseUrl 'http://x/api' } | Should -Not -Throw
    }
}

# ─── Complete-EntraDeltaModeFlip ────────────────────────────────────────────────
Describe 'Complete-EntraDeltaModeFlip' {

    It 'flips to delta after a full run scheduled by a config' {
        Mock Invoke-RestMethod -MockWith { @{} }
        Complete-EntraDeltaModeFlip -SyncMode 'full' -RawConfig @{ _scheduledByConfigId = 9 } -ApiBaseUrl 'http://x/api' -ApiKey 'k'
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -match '/configs/9/mark-delta-mode' }
    }

    It 'does nothing on a delta run' {
        Mock Invoke-RestMethod -MockWith { @{} }
        Complete-EntraDeltaModeFlip -SyncMode 'delta' -RawConfig @{ _scheduledByConfigId = 9 } -ApiBaseUrl 'http://x/api' -ApiKey 'k'
        Should -Invoke Invoke-RestMethod -Exactly 0
    }

    It 'does nothing on a full run that was not scheduled by a config' {
        Mock Invoke-RestMethod -MockWith { @{} }
        Complete-EntraDeltaModeFlip -SyncMode 'full' -RawConfig @{} -ApiBaseUrl 'http://x/api' -ApiKey 'k'
        Should -Invoke Invoke-RestMethod -Exactly 0
    }

    It 'soft-fails when the mark-delta-mode call throws' {
        Mock Invoke-RestMethod -MockWith { throw 'mark 500' }
        { Complete-EntraDeltaModeFlip -SyncMode 'full' -RawConfig @{ _scheduledByConfigId = 9 } -ApiBaseUrl 'http://x/api' -ApiKey 'k' } | Should -Not -Throw
    }
}
