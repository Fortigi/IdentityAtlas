#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the application security shapers and the app-registration
    phase (tools/crawlers/entra-id/EntraIDCrawler.AppSecurity.ps1).

.DESCRIPTION
    The shapers are pure and run against in-memory fixtures. The fixtures are chosen
    to tell right from almost-right: the longest-valid secret is not the last one, an
    instant arrives with a +02:00 offset, appRoleAssignmentRequired is $false (not
    absent), and an empty credential list must read differently from an unread one.
    Sync-EntraAppRegistrations is exercised with the Graph and ingest boundaries mocked.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'
    # Update-CrawlerProgress lives here; Send-IngestBatch / Write-Phase in Functions.ps1.
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerDeltaToken.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.AppSecurity.ps1')

    $script:ApiKey     = 'fgc_testkey'
    $script:ApiBaseUrl = 'https://example.test/api'
    $script:JobId      = 0   # Update-CrawlerProgress no-ops when JobId <= 0

    function Invoke-FGGetRequest { param([string]$URI, [int]$MaxRetries, [int]$TimeoutSec) }

    # A realistic /applications object (the shape Graph returned for a live tenant).
    function New-TestApplication {
        param([hashtable]$Override = @{})
        $app = [ordered]@{
            id = 'obj-1'; appId = 'app-1'; displayName = 'Payroll Connector'
            createdDateTime = '2024-03-01T08:00:00Z'; signInAudience = 'AzureADMultipleOrgs'
            publisherDomain = 'contoso.onmicrosoft.com'
            verifiedPublisher = [pscustomobject]@{ displayName = $null; verifiedPublisherId = $null; addedDateTime = $null }
            isFallbackPublicClient = $true
            publicClient = [pscustomobject]@{ redirectUris = @('http://localhost') }
            web = [pscustomobject]@{
                redirectUris = @('https://payroll.contoso.com/signin', 'https://*.contoso.com/cb')
                implicitGrantSettings = [pscustomobject]@{ enableAccessTokenIssuance = $true; enableIdTokenIssuance = $false }
            }
            spa = [pscustomobject]@{ redirectUris = @() }
            passwordCredentials = @(
                [pscustomobject]@{ keyId = 'k-forever'; displayName = 'never expires'; hint = 'Xy~'; secretText = $null
                    customKeyIdentifier = $null; startDateTime = '2024-03-01T08:00:00Z'; endDateTime = '2299-12-31T08:00:00Z' }
                [pscustomobject]@{ keyId = 'k-short'; displayName = 'rotated'; hint = 'Ab1'; secretText = $null
                    customKeyIdentifier = $null; startDateTime = '2026-01-01T00:00:00Z'; endDateTime = '2026-07-01T00:00:00Z' }
            )
            keyCredentials = @(
                [pscustomobject]@{ keyId = 'c1'; displayName = 'CN=payroll'; type = 'AsymmetricX509Cert'; usage = 'Verify'
                    key = 'MIIBASE64'; customKeyIdentifier = 'THUMB'; startDateTime = '2025-01-01T00:00:00Z'; endDateTime = '2027-01-01T00:00:00Z' }
            )
            requiredResourceAccess = @(
                [pscustomobject]@{ resourceAppId = '00000003-0000-0000-c000-000000000000'; resourceAccess = @(
                    [pscustomobject]@{ id = 'scope-a'; type = 'Scope' }
                    [pscustomobject]@{ id = 'role-a';  type = 'Role' }
                    [pscustomobject]@{ id = 'scope-b'; type = 'Scope' }) }
                [pscustomobject]@{ resourceAppId = '00000003-0000-0ff1-ce00-000000000000'; resourceAccess = @(
                    [pscustomobject]@{ id = 'role-b'; type = 'Role' }) }
            )
            federatedIdentityCredentials = @(
                [pscustomobject]@{ id = 'f1'; name = 'gh-deploy'; issuer = 'https://token.actions.githubusercontent.com'
                    subject = 'repo:contoso/payroll:ref:refs/heads/main'; audiences = @('api://AzureADTokenExchange'); description = $null
                    claimsMatchingExpression = $null }
                [pscustomobject]@{ id = 'f2'; name = 'flexible'; issuer = 'https://token.actions.githubusercontent.com'
                    subject = $null; audiences = @('api://AzureADTokenExchange', 'other'); description = $null
                    claimsMatchingExpression = [pscustomobject]@{ value = "claims['sub'] matches 'repo:contoso/*'"; languageVersion = 1 } }
            )
        }
        foreach ($k in $Override.Keys) { $app[$k] = $Override[$k] }
        return [pscustomobject]$app
    }
}

Describe 'Format-EntraUtcTime' {
    It 'normalises a string with an offset to UTC' {
        Format-EntraUtcTime -Value '2026-01-01T10:00:00+02:00' | Should -Be '2026-01-01T08:00:00Z'
    }
    It 'reads an unspecified-kind [datetime] as UTC (Graph only sends UTC)' {
        Format-EntraUtcTime -Value ([datetime]::new(2026, 5, 6, 7, 8, 9)) | Should -Be '2026-05-06T07:08:09Z'
    }
    It 'converts a local [datetime] and a DateTimeOffset to UTC' {
        $local = [datetime]::SpecifyKind([datetime]::new(2026, 5, 6, 7, 8, 9), [DateTimeKind]::Local)
        Format-EntraUtcTime -Value $local | Should -Be $local.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Format-EntraUtcTime -Value ([DateTimeOffset]::new(2026, 5, 6, 7, 8, 9, [TimeSpan]::FromHours(-5))) | Should -Be '2026-05-06T12:08:09Z'
    }
    It 'returns $null for nothing or nonsense' {
        Format-EntraUtcTime -Value $null | Should -BeNullOrEmpty
        Format-EntraUtcTime -Value 'not a date' | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraCredentialEntry' {
    It 'keeps a secret''s metadata and drops the hint and secret text' {
        $e = ConvertTo-EntraCredentialEntry -Type 'Secret' -KeyInfo ([pscustomobject]@{
            keyId = 'k'; displayName = 'n'; hint = 'Xy~'; secretText = 'shh'; startDateTime = '2026-01-01T00:00:00Z'; endDateTime = '2027-01-01T00:00:00Z' })
        @($e.Keys) -join ',' | Should -Be 'type,keyId,displayName,startDateTime,endDateTime'
        $e.type | Should -Be 'Secret'
        $e.endDateTime | Should -Be '2027-01-01T00:00:00Z'
    }
    It 'keeps a certificate''s usage and type, never its key or thumbprint' {
        $e = ConvertTo-EntraCredentialEntry -Type 'Certificate' -KeyInfo ([pscustomobject]@{
            keyId = 'c'; displayName = 'CN=x'; type = 'AsymmetricX509Cert'; usage = 'Sign'; key = 'MIIB'; customKeyIdentifier = 'THUMB' })
        $e.usage           | Should -Be 'Sign'
        $e.certificateType | Should -Be 'AsymmetricX509Cert'
        $e.Contains('key') | Should -BeFalse
        $e.Contains('customKeyIdentifier') | Should -BeFalse
    }
}

Describe 'Get-EntraCredentialValidityDays' {
    It 'counts whole days between start and end' {
        Get-EntraCredentialValidityDays -Entry @{ startDateTime = '2026-01-01T00:00:00Z'; endDateTime = '2026-01-31T12:00:00Z' } | Should -Be 30
    }
    It 'is $null when either end is missing' {
        Get-EntraCredentialValidityDays -Entry @{ startDateTime = $null; endDateTime = '2026-01-31T00:00:00Z' } | Should -BeNullOrEmpty
        Get-EntraCredentialValidityDays -Entry @{ startDateTime = '2026-01-01T00:00:00Z'; endDateTime = $null } | Should -BeNullOrEmpty
    }
}

Describe 'Add-EntraCredentialAttributes' {
    It 'summarises each kind: count, latest end and longest validity — not just the last entry' {
        $ext = @{}
        Add-EntraCredentialAttributes -Object (New-TestApplication) -Ext $ext
        $ext['secretCount']             | Should -Be 2
        $ext['secretLatestEndDateTime'] | Should -Be '2299-12-31T08:00:00Z'
        # The ~276-year secret is listed FIRST; a "take the last one" bug would report 181.
        $ext['secretMaxValidityDays']   | Should -Be 100746
        $ext['certificateCount']        | Should -Be 1
        $ext['certificateLatestEndDateTime'] | Should -Be '2027-01-01T00:00:00Z'
        $ext['certificateMaxValidityDays']   | Should -Be 730
        @($ext['credentials']).Count    | Should -Be 3
        ($ext['credentials'] | ForEach-Object { $_.type }) -join ',' | Should -Be 'Secret,Secret,Certificate'
    }
    It 'records zero counts (and no list) for an object read with empty credential lists' {
        $ext = @{}
        Add-EntraCredentialAttributes -Object ([pscustomobject]@{ passwordCredentials = @(); keyCredentials = @() }) -Ext $ext
        $ext['secretCount']      | Should -Be 0
        $ext['certificateCount'] | Should -Be 0
        $ext.ContainsKey('credentials')             | Should -BeFalse
        $ext.ContainsKey('secretLatestEndDateTime') | Should -BeFalse
        $ext.ContainsKey('secretMaxValidityDays')   | Should -BeFalse
    }
    It 'writes nothing when the credentials were not read at all' {
        $ext = @{}
        Add-EntraCredentialAttributes -Object ([pscustomobject]@{ id = 'x' }) -Ext $ext
        $ext.Count | Should -Be 0
    }
    It 'still summarises when only one of the two collections was read' {
        $ext = @{}
        Add-EntraCredentialAttributes -Ext $ext -Object ([pscustomobject]@{
            keyCredentials = @([pscustomobject]@{ keyId = 'c'; startDateTime = '2026-01-01T00:00:00Z'; endDateTime = '2026-01-11T00:00:00Z' }) })
        $ext['certificateCount'] | Should -Be 1
        $ext['secretCount']      | Should -Be 0
        $ext['certificateMaxValidityDays'] | Should -Be 10
    }
}

Describe 'Add-EntraAppSecurityAttributes' {
    It 'writes a $false assignment requirement (anyone may sign in) rather than dropping it' {
        $ext = @{}
        Add-EntraAppSecurityAttributes -Object ([pscustomobject]@{ appRoleAssignmentRequired = $false }) -Ext $ext
        $ext.ContainsKey('appRoleAssignmentRequired') | Should -BeTrue
        $ext['appRoleAssignmentRequired'] | Should -BeFalse
    }
    It 'skips an unverified publisher (Graph returns the object with null fields)' {
        $ext = @{}
        Add-EntraAppSecurityAttributes -Object (New-TestApplication) -Ext $ext
        $ext.ContainsKey('verifiedPublisherName') | Should -BeFalse
        $ext['signInAudience'] | Should -Be 'AzureADMultipleOrgs'
    }
    It 'keeps a verified publisher''s name and id' {
        $ext = @{}
        Add-EntraAppSecurityAttributes -Ext $ext -Object ([pscustomobject]@{
            verifiedPublisher = [pscustomobject]@{ displayName = 'Microsoft Corporation'; verifiedPublisherId = '5206095' } })
        $ext['verifiedPublisherName'] | Should -Be 'Microsoft Corporation'
        $ext['verifiedPublisherId']   | Should -Be '5206095'
    }
    It 'writes nothing for an object without any of these properties' {
        $ext = @{}
        Add-EntraAppSecurityAttributes -Object ([pscustomobject]@{ id = 'x'; replyUrls = @() }) -Ext $ext
        $ext.Count | Should -Be 0
    }
}

Describe 'ConvertTo-EntraAppRegistrationRecord' {
    It 'shapes an app registration into an AppRegistration resource with its security set-up' {
        $rec = ConvertTo-EntraAppRegistrationRecord -Application (New-TestApplication)
        $rec.id              | Should -Be 'obj-1'
        $rec.displayName     | Should -Be 'Payroll Connector'
        $rec.resourceType    | Should -Be 'AppRegistration'
        $rec.enabled         | Should -BeTrue
        $rec.createdDateTime | Should -Be '2024-03-01T08:00:00Z'
        $ext = $rec.extendedAttributes
        $ext.appId                    | Should -Be 'app-1'
        $ext.publisherDomain          | Should -Be 'contoso.onmicrosoft.com'
        $ext.isFallbackPublicClient   | Should -BeTrue
        $ext.publicClientRedirectUris | Should -Be 'http://localhost'
        $ext.webRedirectUris          | Should -Be 'https://payroll.contoso.com/signin,https://*.contoso.com/cb'
        $ext.ContainsKey('spaRedirectUris') | Should -BeFalse
        $ext.implicitGrantAccessTokens | Should -BeTrue
        $ext.implicitGrantIdTokens     | Should -BeFalse
        $ext.secretCount               | Should -Be 2
    }

    It 'counts requested delegated and application permissions per kind, across APIs' {
        $ext = (ConvertTo-EntraAppRegistrationRecord -Application (New-TestApplication)).extendedAttributes
        $ext.requestedDelegatedPermissionCount   | Should -Be 2
        $ext.requestedApplicationPermissionCount | Should -Be 2
        $graph = $ext.requiredResourceAccess | Where-Object { $_.resourceAppId -eq '00000003-0000-0000-c000-000000000000' }
        $graph.scopes -join ',' | Should -Be 'scope-a,scope-b'
        $graph.roles  -join ',' | Should -Be 'role-a'
        ($ext.requiredResourceAccess | Where-Object { $_.resourceAppId -like '*0ff1*' }).roles -join ',' | Should -Be 'role-b'
    }

    It 'keeps each federated credential''s issuer, subject, audiences and flexible expression' {
        $ext = (ConvertTo-EntraAppRegistrationRecord -Application (New-TestApplication)).extendedAttributes
        $ext.federatedCredentialCount | Should -Be 2
        $fixed = $ext.federatedCredentials | Where-Object { $_.name -eq 'gh-deploy' }
        $fixed.subject   | Should -Be 'repo:contoso/payroll:ref:refs/heads/main'
        $fixed.claimsMatchingExpression | Should -BeNullOrEmpty
        $flex = $ext.federatedCredentials | Where-Object { $_.name -eq 'flexible' }
        $flex.claimsMatchingExpression | Should -Be "claims['sub'] matches 'repo:contoso/*'"
        $flex.audiences | Should -Be 'api://AzureADTokenExchange,other'
    }

    It 'reads an unset public-client switch as off, and falls back to the appId for a nameless app' {
        $rec = ConvertTo-EntraAppRegistrationRecord -Application (New-TestApplication -Override @{
            displayName = $null; isFallbackPublicClient = $null; federatedIdentityCredentials = @(); requiredResourceAccess = @()
            web = [pscustomobject]@{ redirectUris = @() }; createdDateTime = $null })
        $rec.displayName | Should -Be 'app-1'
        $rec.ContainsKey('createdDateTime') | Should -BeFalse
        $ext = $rec.extendedAttributes
        $ext.isFallbackPublicClient | Should -BeFalse
        $ext.federatedCredentialCount | Should -Be 0
        $ext.ContainsKey('federatedCredentials') | Should -BeFalse
        $ext.requestedApplicationPermissionCount | Should -Be 0
        $ext.ContainsKey('requiredResourceAccess') | Should -BeFalse
        $ext.ContainsKey('implicitGrantAccessTokens') | Should -BeFalse
    }

    It 'omits the federated and requested-permission keys when those were not read' {
        $ext = (ConvertTo-EntraAppRegistrationRecord -Application ([pscustomobject]@{ id = 'o'; appId = 'a'; displayName = 'n' })).extendedAttributes
        $ext.ContainsKey('federatedCredentialCount') | Should -BeFalse
        $ext.ContainsKey('requestedDelegatedPermissionCount') | Should -BeFalse
        $ext.ContainsKey('secretCount') | Should -BeFalse
    }
}

Describe 'Sync-EntraAppRegistrations' {
    BeforeEach {
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:phases      = [System.Collections.Generic.List[object]]::new()
        $script:sent        = [System.Collections.Generic.List[object]]::new()
        Mock Send-IngestBatch -MockWith {
            $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; SyncMode = $SyncMode; Scope = $Scope; Records = @($Records) })
        }
    }

    It 'reads every app registration with credentials and federated credentials, and full-syncs them on their own type' {
        Mock Invoke-FGGetRequest -MockWith { @((New-TestApplication), (New-TestApplication -Override @{ id = 'obj-2'; appId = 'app-2' })) }
        $timings = [ordered]@{}

        Sync-EntraAppRegistrations -SystemId 4 -Timings $timings

        Should -Invoke Invoke-FGGetRequest -Exactly 1 -ParameterFilter {
            $URI -like 'https://graph.microsoft.com/beta/applications?$select=*' -and
            $URI -match 'passwordCredentials' -and $URI -match 'keyCredentials' -and $URI -match 'isFallbackPublicClient' -and
            $URI -match '\$expand=federatedIdentityCredentials'
        }
        $script:sent.Count | Should -Be 1
        $script:sent[0].Endpoint | Should -Be 'ingest/resources'
        $script:sent[0].SyncMode | Should -Be 'full'
        $script:sent[0].Scope.resourceType | Should -Be 'AppRegistration'
        ($script:sent[0].Records.id) -join ',' | Should -Be 'obj-1,obj-2'
        $timings.Contains('AppRegistrations') | Should -BeTrue
        ($script:phases | Where-Object { $_.name -eq 'AppRegistrations' }).status | Should -Be 'ok'
    }

    It 'sends nothing (and so deletes nothing) when Graph returns no app registrations' {
        Mock Invoke-FGGetRequest -MockWith { @() }
        Sync-EntraAppRegistrations -SystemId 4 -Timings ([ordered]@{})
        $script:sent.Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'records a failed phase instead of throwing when Graph refuses' {
        Mock Invoke-FGGetRequest -MockWith { throw 'Graph 403 Authorization_RequestDenied' }
        { Sync-EntraAppRegistrations -SystemId 4 -Timings ([ordered]@{}) } | Should -Not -Throw
        $script:phaseErrors | Should -HaveCount 1
        $script:phaseErrors[0] | Should -BeLike 'AppRegistrations:*403*'
        ($script:phases | Where-Object { $_.name -eq 'AppRegistrations' }).status | Should -Be 'failed'
        $script:sent.Count | Should -Be 0
    }
}
