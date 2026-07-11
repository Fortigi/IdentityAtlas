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

    It 'sends records and deletes together in one body when both fit under BatchSize' {
        Mock Invoke-IngestAPI { @{ inserted = 1; updated = 0; deleted = 1 } }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records @([pscustomobject]@{ id = 'a' }) -DeletedIds @('d1')
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.ContainsKey('deletedIds') -and $Body.records }
        $r.inserted | Should -Be 1
        $r.deleted  | Should -Be 1
    }

    It 'sends deletes as a separate call before the chunked session when both exceed BatchSize' {
        $script:sawDeleteOnly = $false
        Mock Invoke-IngestAPI {
            if ($Body.ContainsKey('deletedIds') -and -not $Body.ContainsKey('syncSession')) { $script:sawDeleteOnly = $true; return @{ deleted = 2 } }
            @{ inserted = 1; updated = 0; deleted = 0; syncId = 's' }
        }
        $records = 1..7 | ForEach-Object { [pscustomobject]@{ id = "r$_" } }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records $records -DeletedIds @('d1', 'd2') -BatchSize 3
        $script:sawDeleteOnly | Should -BeTrue     # deletes went as their own call
        $r.deleted            | Should -Be 2        # folded into the total
        Should -Invoke Invoke-IngestAPI -Times 4    # 1 delete call + 3 record chunks
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

    It 'retries a transient error (HTTP 503) with backoff, then succeeds' {
        Mock Start-Sleep { }
        $script:calls = 0
        Mock Invoke-RestMethod {
            $script:calls++
            if ($script:calls -eq 1) {
                $resp = [pscustomobject]@{ StatusCode = 503 }
                $ex = [System.Exception]::new('ServiceNotAvailable')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
                throw $ex
            }
            @{ value = @([pscustomobject]@{ id = 'u1' }); '@odata.deltaLink' = 'https://g?$deltatoken=OK' }
        }
        $res = Invoke-FGGetDeltaRequest -URI 'https://graph/users/delta' -MaxRetries 2
        $res.deltaToken | Should -Be 'OK'
        $res.value.Count | Should -Be 1
        Should -Invoke Invoke-RestMethod -Times 2
        Should -Invoke Start-Sleep -Times 1
    }
}

# ─── Invoke-FGGroupChildFetch ───────────────────────────────────────────────────
# The per-group fetch/retry/paginate logic, extracted out of the -Parallel block so
# it runs (and is coverage-instrumented) in the main runspace. Invoke-RestMethod and
# Start-Sleep are mocked so no real HTTP / waiting occurs.
Describe 'Invoke-FGGroupChildFetch' {

    It 'emits one record per child from a single page' {
        Mock Invoke-RestMethod { [pscustomobject]@{ value = @(
            [pscustomobject]@{ id = 'm1'; '@odata.type' = '#microsoft.graph.user' }
            [pscustomobject]@{ id = 'm2'; '@odata.type' = '#microsoft.graph.group' }
        ) } }
        $out = @(Invoke-FGGroupChildFetch -Group ([pscustomobject]@{ id = 'g1' }) -Token 'tok' -ChildPath 'members')
        $out.Count | Should -Be 2
        $out[0].kind | Should -Be 'record'
        $out[0].resourceId | Should -Be 'g1'
        $out[0].principalId | Should -Be 'm1'
        $out[1].childType | Should -Be '#microsoft.graph.group'
    }

    It 'follows @odata.nextLink across pages' {
        $script:page = 0
        Mock Invoke-RestMethod {
            $script:page++
            if ($script:page -eq 1) {
                [pscustomobject]@{ value = @([pscustomobject]@{ id = 'a' }); '@odata.nextLink' = 'https://graph/next' }
            } else {
                [pscustomobject]@{ value = @([pscustomobject]@{ id = 'b' }) }
            }
        }
        $out = @(Invoke-FGGroupChildFetch -Group ([pscustomobject]@{ id = 'g1' }) -Token 'tok' -ChildPath 'members')
        $out.principalId | Should -Be @('a', 'b')
        Should -Invoke Invoke-RestMethod -Times 2
    }

    It 'retries a transient 429 then succeeds' {
        Mock Start-Sleep { }
        $script:n = 0
        Mock Invoke-RestMethod {
            $script:n++
            if ($script:n -eq 1) {
                $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 429 } }
                $ex = [System.Exception]::new('Too Many Requests')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
                throw $ex
            }
            [pscustomobject]@{ value = @([pscustomobject]@{ id = 'ok' }) }
        }
        $out = @(Invoke-FGGroupChildFetch -Group ([pscustomobject]@{ id = 'g1' }) -Token 'tok' -ChildPath 'owners')
        $out.principalId | Should -Be 'ok'
        Should -Invoke Start-Sleep -Times 1
    }

    It 'retries a connection error with no status code' {
        Mock Start-Sleep { }
        $script:m = 0
        Mock Invoke-RestMethod {
            $script:m++
            if ($script:m -eq 1) { throw [System.Exception]::new('connection reset') }
            [pscustomobject]@{ value = @([pscustomobject]@{ id = 'recovered' }) }
        }
        $out = @(Invoke-FGGroupChildFetch -Group ([pscustomobject]@{ id = 'g1' }) -Token 'tok' -ChildPath 'members')
        $out.principalId | Should -Be 'recovered'
    }

    It 'returns a single error object on a permanent (404) failure' {
        Mock Start-Sleep { }
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 404 } }
            $ex = [System.Exception]::new('Not Found')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
            throw $ex
        }
        $out = @(Invoke-FGGroupChildFetch -Group ([pscustomobject]@{ id = 'g1' }) -Token 'tok' -ChildPath 'members')
        $out.Count | Should -Be 1
        $out[0].kind | Should -Be 'error'
        $out[0].resourceId | Should -Be 'g1'
        $out[0].message | Should -Be 'Not Found'
    }

    It 'gives up with an error object after exhausting retries on a persistent 503' {
        Mock Start-Sleep { }
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 503 } }
            $ex = [System.Exception]::new('Service Unavailable')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
            throw $ex
        }
        $out = @(Invoke-FGGroupChildFetch -Group ([pscustomobject]@{ id = 'g1' }) -Token 'tok' -ChildPath 'members')
        $out[0].kind | Should -Be 'error'
        # initial attempt + 3 retries = 4 calls (maxAttempts)
        Should -Invoke Invoke-RestMethod -Times 4
    }
}

# ─── Get-FGGroupChildrenParallel ────────────────────────────────────────────────
# The actual -Parallel execution is isolated in Invoke-FGGroupChildBatchParallel
# (runspace code can't be mocked/instrumented). Mocking that seam lets us cover the
# batch loop, token refresh, result fold and progress reporting in the main runspace.
Describe 'Get-FGGroupChildrenParallel' {

    AfterEach {
        Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue
    }

    It 'throws when no Graph access token is available' {
        Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue
        $groups = @([pscustomobject]@{ id = 'g1' })
        { Get-FGGroupChildrenParallel -Groups $groups -ChildPath 'members' `
            -RecordBuilder { param($o) $o } } | Should -Throw '*No Graph access token*'
    }

    It 'folds parallel records via the RecordBuilder and counts errors' {
        $Global:AccessToken = 'tok'
        Mock Invoke-FGGroupChildBatchParallel {
            @(
                [pscustomobject]@{ kind = 'record'; resourceId = 'g1'; principalId = 'm1' }
                [pscustomobject]@{ kind = 'record'; resourceId = 'g1'; principalId = 'm2' }
                [pscustomobject]@{ kind = 'error';  resourceId = 'g2'; message = 'boom' }
            )
        }
        $groups = @([pscustomobject]@{ id = 'g1' }, [pscustomobject]@{ id = 'g2' })
        $result = Get-FGGroupChildrenParallel -Groups $groups -ChildPath 'members' `
            -RecordBuilder { param($o) @{ resourceId = $o.resourceId; principalId = $o.principalId } }

        $result.records.Count | Should -Be 2
        $result.errorCount | Should -Be 1
        $result.records[0].principalId | Should -Be 'm1'
    }

    It 'processes the groups in batches of BatchSize' {
        $Global:AccessToken = 'tok'
        Mock Invoke-FGGroupChildBatchParallel { @() }
        $groups = 1..5 | ForEach-Object { [pscustomobject]@{ id = "g$_" } }
        Get-FGGroupChildrenParallel -Groups $groups -ChildPath 'members' -BatchSize 2 `
            -RecordBuilder { param($o) $o } | Out-Null
        # 5 groups / batch size 2 = 3 batches
        Should -Invoke Invoke-FGGroupChildBatchParallel -Times 3
    }

    It 'refreshes the token and reports progress (with an error tag) for each batch' {
        $Global:AccessToken = 'tok'
        # Include an error so the "· N errors" progress-detail branch is exercised.
        Mock Invoke-FGGroupChildBatchParallel {
            @([pscustomobject]@{ kind = 'error'; resourceId = 'g1'; message = 'boom' })
        }
        Mock Update-FGAccessTokenIfExpired { }
        Mock Update-CrawlerProgress { }
        $groups = @([pscustomobject]@{ id = 'g1' })
        $result = Get-FGGroupChildrenParallel -Groups $groups -ChildPath 'members' `
            -ProgressStep 'Sync' -ProgressStartPct 10 -ProgressEndPct 20 `
            -RecordBuilder { param($o) $o }
        $result.errorCount | Should -Be 1
        Should -Invoke Update-FGAccessTokenIfExpired -Times 1
        Should -Invoke Update-CrawlerProgress -Times 1 -ParameterFilter { $Detail -like '*1 errors*' }
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

# ─── Format-FGDelegatedPermissionName ────────────────────────────────────────────
Describe 'Format-FGDelegatedPermissionName' {
    It 'includes the consenting app so same-scope/different-app rows are distinct' {
        Format-FGDelegatedPermissionName -Scope 'Calendars.ReadWrite' -TargetName 'Microsoft Graph' -ClientName 'Amazon Alexa' |
            Should -Be 'Calendars.ReadWrite on Microsoft Graph (via Amazon Alexa)'
    }
    It 'omits the via-suffix when the client name is empty' {
        Format-FGDelegatedPermissionName -Scope 'User.Read' -TargetName 'Microsoft Graph' -ClientName '' |
            Should -Be 'User.Read on Microsoft Graph'
    }
    It 'omits the via-suffix when the client name is null' {
        Format-FGDelegatedPermissionName -Scope 'User.Read' -TargetName 'Microsoft Graph' -ClientName $null |
            Should -Be 'User.Read on Microsoft Graph'
    }
}

# ─── Get-FGGraphErrorDetail ─────────────────────────────────────────────────────
Describe 'Get-FGGraphErrorDetail' {
    It 'returns the plain exception message when there are no ErrorDetails' {
        $err = [System.Management.Automation.ErrorRecord]::new([System.Exception]::new('plain boom'), 'id', 'NotSpecified', $null)
        Get-FGGraphErrorDetail $err | Should -Be 'plain boom'
    }
    It 'appends the Graph error body from ErrorDetails.Message, truncated to 300 chars' {
        $err = [System.Management.Automation.ErrorRecord]::new([System.Exception]::new('HTTP 400'), 'id', 'NotSpecified', $null)
        $err.ErrorDetails = [System.Management.Automation.ErrorDetails]::new('x' * 400)
        $detail = Get-FGGraphErrorDetail $err
        $detail | Should -BeLike 'HTTP 400 | *...'
        $detail.Length | Should -BeLessThan 320
    }
}
