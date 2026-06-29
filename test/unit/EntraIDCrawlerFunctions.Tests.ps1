#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the extracted Entra ID crawler functions
    (EntraIDCrawler.Functions.ps1).

.DESCRIPTION
    These cover the nine functions moved verbatim out of Start-EntraIDCrawler.ps1:
        Send-IngestBatch, Get-FGDeltaToken, Set-FGDeltaToken, Remove-FGDeltaToken,
        Get-FGDeltaTokenFromLink, Invoke-FGGetDeltaRequest,
        Get-FGGroupChildrenParallel, Write-Phase, Get-UserAttrValue.

    The Start script's Main body is NOT run — only the function file is dot-sourced.
    Functions that hit the network (Send-IngestBatch via Invoke-IngestAPI; the
    delta-token helpers and Invoke-FGGetDeltaRequest via Invoke-RestMethod) are
    tested by mocking, so no real HTTP is performed. The functions read script-scope
    state ($ApiKey, $ApiBaseUrl, $Global:AccessToken, $script:phases) from the
    caller's scope at call time, exactly as they do when dot-sourced into the
    Start script.

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerFunctions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir   = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    # ConvertTo-JsonArray / Invoke-IngestAPI / Update-CrawlerProgress live in the
    # shared helpers; Send-IngestBatch and Get-FGGroupChildrenParallel call them.
    # (Invoke-IngestAPI is mocked per-test.)
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')

    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')

    # ── Script-scope state the functions read at call time ──────────────────────
    # (Normally set up by Start-EntraIDCrawler.ps1's param block / Main.)
    $script:ApiKey     = 'fgc_testkey'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0
    $script:phases     = [System.Collections.Generic.List[object]]::new()

    # Update-FGAccessTokenIfExpired comes from the Graph SDK in production; stub it
    # so Invoke-FGGetDeltaRequest can run without the module loaded.
    function Update-FGAccessTokenIfExpired { param([string]$DebugFlag) }
}

# ─── Get-UserAttrValue ──────────────────────────────────────────────────────────
Describe 'Get-UserAttrValue' {

    It 'returns a plain top-level attribute' {
        $user = [pscustomobject]@{ displayName = 'Alice' }
        Get-UserAttrValue -User $user -AttrName 'displayName' | Should -Be 'Alice'
    }

    It 'resolves extensionAttributeN from onPremisesExtensionAttributes' {
        $user = [pscustomobject]@{
            onPremisesExtensionAttributes = [pscustomobject]@{ extensionAttribute3 = 'cost-center-42' }
        }
        Get-UserAttrValue -User $user -AttrName 'extensionAttribute3' | Should -Be 'cost-center-42'
    }

    It 'returns $null for an extensionAttributeN when the parent object is absent' {
        $user = [pscustomobject]@{ displayName = 'Bob' }
        Get-UserAttrValue -User $user -AttrName 'extensionAttribute7' | Should -BeNullOrEmpty
    }

    It 'returns $null for a missing top-level attribute' {
        $user = [pscustomobject]@{ displayName = 'Carol' }
        Get-UserAttrValue -User $user -AttrName 'department' | Should -BeNullOrEmpty
    }
}

# ─── Get-FGDeltaTokenFromLink ───────────────────────────────────────────────────
Describe 'Get-FGDeltaTokenFromLink' {

    It 'returns $null for an empty link' {
        Get-FGDeltaTokenFromLink -DeltaLink '' | Should -BeNullOrEmpty
    }

    It 'returns $null when there is no deltatoken query param' {
        Get-FGDeltaTokenFromLink -DeltaLink 'https://graph.microsoft.com/beta/users/delta' | Should -BeNullOrEmpty
    }

    It 'extracts the deltatoken value' {
        $link = 'https://graph.microsoft.com/beta/users/delta?$deltatoken=ABC123'
        Get-FGDeltaTokenFromLink -DeltaLink $link | Should -Be 'ABC123'
    }

    It 'URL-decodes an escaped deltatoken value' {
        $link = 'https://graph.microsoft.com/beta/users/delta?$deltatoken=A%20B%2BC'
        Get-FGDeltaTokenFromLink -DeltaLink $link | Should -Be 'A B+C'
    }

    It 'stops at the next ampersand-delimited param' {
        $link = 'https://x/delta?$deltatoken=tok123&$top=999'
        Get-FGDeltaTokenFromLink -DeltaLink $link | Should -Be 'tok123'
    }
}

# ─── Get-FGDeltaToken ───────────────────────────────────────────────────────────
Describe 'Get-FGDeltaToken' {

    It 'returns the token from a successful API response' {
        Mock Invoke-RestMethod { @{ token = 'persisted-tok' } }
        Get-FGDeltaToken -SystemId 5 -Endpoint 'users/delta' | Should -Be 'persisted-tok'
    }

    It 'returns $null when the API yields no token' {
        Mock Invoke-RestMethod { @{ token = $null } }
        Get-FGDeltaToken -SystemId 5 -Endpoint 'users/delta' | Should -BeNullOrEmpty
    }

    It 'returns $null (and does not throw) when the lookup errors' {
        Mock Invoke-RestMethod { throw 'boom' }
        Get-FGDeltaToken -SystemId 5 -Endpoint 'users/delta' | Should -BeNullOrEmpty
    }

    It 'URL-encodes the endpoint slash and passes the systemId in the query' {
        $script:capturedUri = $null
        Mock Invoke-RestMethod { $script:capturedUri = $Uri; @{ token = 't' } }
        Get-FGDeltaToken -SystemId 9 -Endpoint 'service/principals' | Out-Null
        Should -Invoke Invoke-RestMethod -Times 1
        # The endpoint is run through [uri]::EscapeDataString — its '/' becomes %2F.
        $script:capturedUri | Should -BeLike '*service%2Fprincipals*'
        $script:capturedUri | Should -BeLike '*systemId=9*'
    }
}

# ─── Set-FGDeltaToken ───────────────────────────────────────────────────────────
Describe 'Set-FGDeltaToken' {

    It 'does nothing (no API call) when the token is empty' {
        Mock Invoke-RestMethod {}
        Set-FGDeltaToken -SystemId 1 -Endpoint 'users/delta' -Token ''
        Should -Invoke Invoke-RestMethod -Times 0
    }

    It 'PUTs the token to the API' {
        Mock Invoke-RestMethod {}
        Set-FGDeltaToken -SystemId 3 -Endpoint 'users/delta' -Token 'newtok' -RecordsLastSeen 42
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'Put' -and $Body -match 'newtok' -and $Body -match '42'
        }
    }

    It 'swallows API errors without throwing' {
        Mock Invoke-RestMethod { throw 'save failed' }
        { Set-FGDeltaToken -SystemId 3 -Endpoint 'users/delta' -Token 'x' } | Should -Not -Throw
    }
}

# ─── Remove-FGDeltaToken ────────────────────────────────────────────────────────
Describe 'Remove-FGDeltaToken' {

    It 'issues a DELETE for the endpoint + systemId' {
        Mock Invoke-RestMethod {}
        Remove-FGDeltaToken -SystemId 7 -Endpoint 'users/delta'
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'Delete' -and $Uri -like '*systemId=7*'
        }
    }

    It 'swallows API errors without throwing' {
        Mock Invoke-RestMethod { throw 'delete failed' }
        { Remove-FGDeltaToken -SystemId 7 -Endpoint 'users/delta' } | Should -Not -Throw
    }
}

# ─── Send-IngestBatch ───────────────────────────────────────────────────────────
Describe 'Send-IngestBatch' {

    It 'returns zeros and skips the API when there is nothing to send' {
        Mock Invoke-IngestAPI {}
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records @()
        $r.inserted | Should -Be 0
        $r.updated  | Should -Be 0
        $r.deleted  | Should -Be 0
        Should -Invoke Invoke-IngestAPI -Times 0
    }

    It 'sends a single batch when records fit under BatchSize' {
        Mock Invoke-IngestAPI { @{ inserted = 2; updated = 1; deleted = 0 } }
        $records = @([pscustomobject]@{ id = 'a' }, [pscustomobject]@{ id = 'b' })
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records $records
        $r.inserted | Should -Be 2
        Should -Invoke Invoke-IngestAPI -Times 1
    }

    It 'includes deletedIds in the body when supplied' {
        Mock Invoke-IngestAPI { @{ inserted = 0; updated = 0; deleted = 3 } }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records @() -DeletedIds @('x','y','z')
        $r.deleted | Should -Be 3
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.ContainsKey('deletedIds') }
    }

    It 'chunks records that exceed BatchSize into start/continue/end sessions' {
        $script:sessions = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-IngestAPI {
            $script:sessions.Add([string]$Body.syncSession)
            @{ inserted = 1; updated = 0; deleted = 0; syncId = 'sess-1' }
        }
        $records = 1..7 | ForEach-Object { [pscustomobject]@{ id = "r$_" } }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records $records -BatchSize 3
        # 7 records / 3 per batch = 3 calls
        Should -Invoke Invoke-IngestAPI -Times 3
        $script:sessions[0]  | Should -Be 'start'
        $script:sessions[-1] | Should -Be 'end'
        $r.inserted | Should -Be 3
    }
}

# ─── Invoke-FGGetDeltaRequest ───────────────────────────────────────────────────
Describe 'Invoke-FGGetDeltaRequest' {

    BeforeEach {
        $Global:AccessToken = 'graph-token'
    }

    AfterEach {
        Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue
    }

    It 'throws when there is no access token' {
        Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue
        { Invoke-FGGetDeltaRequest -URI 'https://graph/users/delta' } | Should -Throw '*No Access Token*'
    }

    It 'collects a single page and returns the deltaToken extracted from the deltaLink' {
        Mock Invoke-RestMethod {
            @{
                value             = @([pscustomobject]@{ id = 'u1' }, [pscustomobject]@{ id = 'u2' })
                '@odata.deltaLink' = 'https://graph/users/delta?$deltatoken=TOKEN9'
            }
        }
        $res = Invoke-FGGetDeltaRequest -URI 'https://graph/users/delta'
        $res.value.Count | Should -Be 2
        $res.deltaToken  | Should -Be 'TOKEN9'
        Should -Invoke Invoke-RestMethod -Times 1
    }

    It 'follows @odata.nextLink across pages' {
        Mock Invoke-RestMethod -ParameterFilter { $Uri -eq 'https://graph/users/delta' } -MockWith {
            @{ value = @([pscustomobject]@{ id = 'p1' }); '@odata.nextLink' = 'https://graph/users/delta?page=2' }
        }
        Mock Invoke-RestMethod -ParameterFilter { $Uri -eq 'https://graph/users/delta?page=2' } -MockWith {
            @{ value = @([pscustomobject]@{ id = 'p2' }); '@odata.deltaLink' = 'https://graph/d?$deltatoken=END' }
        }
        $res = Invoke-FGGetDeltaRequest -URI 'https://graph/users/delta'
        $res.value.Count | Should -Be 2
        $res.deltaToken  | Should -Be 'END'
    }

    It 'surfaces an InvalidOperationException when Graph rejects the token (HTTP 400)' {
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = 400 }
            $ex   = [System.Exception]::new('SyncStateNotFound')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
            throw $ex
        }
        { Invoke-FGGetDeltaRequest -URI 'https://graph/users/delta' -MaxRetries 0 } |
            Should -Throw -ExceptionType ([System.InvalidOperationException])
    }
}

# ─── Get-FGGroupChildrenParallel ────────────────────────────────────────────────
Describe 'Get-FGGroupChildrenParallel' {

    # The parallel ForEach-Object block runs in fresh runspaces that can't see
    # Pester mocks, so we exercise the parent-thread setup + token guard without
    # entering the network path: with no token available the function throws
    # before the parallel block. This covers the loop entry, batch slicing, and
    # the "no access token" guard.

    AfterEach {
        Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue
    }

    It 'throws when no Graph access token is available' {
        Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue
        $groups = @([pscustomobject]@{ id = 'g1' })
        { Get-FGGroupChildrenParallel -Groups $groups -ChildPath 'members' `
            -RecordBuilder { param($o) $o } } | Should -Throw '*No Graph access token*'
    }
}

# ─── Write-Phase ────────────────────────────────────────────────────────────────
Describe 'Write-Phase' {

    BeforeEach {
        $script:phases = [System.Collections.Generic.List[object]]::new()
    }

    It "records an 'ok' phase with duration when no error is given" {
        Write-Phase -Name 'Sync Users' -Duration ([TimeSpan]::FromMilliseconds(1500))
        $script:phases.Count        | Should -Be 1
        $script:phases[0].name      | Should -Be 'Sync Users'
        $script:phases[0].status    | Should -Be 'ok'
        $script:phases[0].durationMs | Should -Be 1500
        $script:phases[0].ContainsKey('error') | Should -BeFalse
    }

    It "records a 'failed' phase carrying the error message" {
        Write-Phase -Name 'Sync Groups' -Duration ([TimeSpan]::FromSeconds(2)) -ErrorMsg 'graph 400'
        $script:phases[0].status | Should -Be 'failed'
        $script:phases[0].error  | Should -Be 'graph 400'
    }

    It 'attaches a records hashtable when supplied' {
        Write-Phase -Name 'Sync Owners' -Duration ([TimeSpan]::Zero) -Records @{ inserted = 9 }
        $script:phases[0].records.inserted | Should -Be 9
    }
}

Describe 'ConvertTo-FilterValue' {
    It 'returns the value unchanged when either value or sample is null' {
        ConvertTo-FilterValue -Value 'x' -Sample $null | Should -Be 'x'
        ConvertTo-FilterValue -Value $null -Sample 'y' | Should -BeNullOrEmpty
    }

    It 'coerces truthy strings to $true against a bool sample' {
        foreach ($t in 'true', '1', 'yes', 'on', 'TRUE', ' On ') {
            ConvertTo-FilterValue -Value $t -Sample $true | Should -BeTrue
        }
    }

    It 'coerces falsy strings to $false against a bool sample' {
        foreach ($f in 'false', '0', 'no', 'off', 'FALSE') {
            ConvertTo-FilterValue -Value $f -Sample $true | Should -BeFalse
        }
    }

    It 'passes a real bool through unchanged against a bool sample' {
        ConvertTo-FilterValue -Value $true -Sample $false | Should -BeTrue
    }

    It 'coerces a numeric string to an int against an int sample' {
        $r = ConvertTo-FilterValue -Value '42' -Sample 7
        $r | Should -Be 42
        $r | Should -BeOfType [int]
    }

    It 'returns the original value for a non-numeric string against an int sample' {
        ConvertTo-FilterValue -Value 'abc' -Sample 7 | Should -Be 'abc'
    }

    It 'passes values through unchanged against a string sample' {
        ConvertTo-FilterValue -Value 'Engineering' -Sample 'Sales' | Should -Be 'Engineering'
    }
}

Describe 'New-OwnershipResourceId' {
    It 'is deterministic and shaped like a GUID' {
        $a = New-OwnershipResourceId -GroupId 'grp-1'
        $b = New-OwnershipResourceId -GroupId 'grp-1'
        $a | Should -Be $b
        $a | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    }

    It 'produces distinct ids for distinct groups' {
        (New-OwnershipResourceId -GroupId 'grp-1') | Should -Not -Be (New-OwnershipResourceId -GroupId 'grp-2')
    }
}

Describe 'New-OAuth2ScopeResourceId' {
    It 'is deterministic for the same client/api/scope triple' {
        $a = New-OAuth2ScopeResourceId -ClientSpId 'c' -TargetApiSpId 'api' -Scope 'User.Read'
        $b = New-OAuth2ScopeResourceId -ClientSpId 'c' -TargetApiSpId 'api' -Scope 'User.Read'
        $a | Should -Be $b
        $a | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    }

    It 'changes when any component of the triple changes' {
        $base = New-OAuth2ScopeResourceId -ClientSpId 'c' -TargetApiSpId 'api' -Scope 'User.Read'
        (New-OAuth2ScopeResourceId -ClientSpId 'c2'  -TargetApiSpId 'api'  -Scope 'User.Read') | Should -Not -Be $base
        (New-OAuth2ScopeResourceId -ClientSpId 'c'   -TargetApiSpId 'api2' -Scope 'User.Read') | Should -Not -Be $base
        (New-OAuth2ScopeResourceId -ClientSpId 'c'   -TargetApiSpId 'api'  -Scope 'Mail.Read') | Should -Not -Be $base
    }
}

Describe 'New-AppRoleResourceId' {
    It 'is deterministic for the same SP/appRole pair' {
        $a = New-AppRoleResourceId -SpId 'sp' -AppRoleId 'role'
        $b = New-AppRoleResourceId -SpId 'sp' -AppRoleId 'role'
        $a | Should -Be $b
        $a | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    }

    It 'produces distinct ids for distinct app roles on the same SP' {
        (New-AppRoleResourceId -SpId 'sp' -AppRoleId 'r1') | Should -Not -Be (New-AppRoleResourceId -SpId 'sp' -AppRoleId 'r2')
    }
}

Describe 'Resolve-DirectoryRolePrincipalType' {
    It 'maps a service principal odata type' {
        Resolve-DirectoryRolePrincipalType -Principal ([pscustomobject]@{ '@odata.type' = '#microsoft.graph.servicePrincipal' }) | Should -Be 'ServicePrincipal'
    }

    It 'maps a group odata type' {
        Resolve-DirectoryRolePrincipalType -Principal ([pscustomobject]@{ '@odata.type' = '#microsoft.graph.group' }) | Should -Be 'Group'
    }

    It 'maps a user odata type' {
        Resolve-DirectoryRolePrincipalType -Principal ([pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' }) | Should -Be 'User'
    }

    It 'defaults to User for an unknown or missing odata type' {
        Resolve-DirectoryRolePrincipalType -Principal ([pscustomobject]@{ '@odata.type' = '#microsoft.graph.device' }) | Should -Be 'User'
        Resolve-DirectoryRolePrincipalType -Principal ([pscustomobject]@{ id = 'x' }) | Should -Be 'User'
    }
}
