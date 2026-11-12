#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for EntraIDCrawler.Auth.ps1 — how the Entra ID crawler
    signs in to Microsoft Graph (client secret or managed identity).

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerAuth.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

    # The real token functions (mocked per test) so their parameters bind as in production.
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'graph' 'Get-FGAccessToken.ps1')
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'graph' 'Get-FGAccessTokenManagedIdentity.ps1')
    # The unit under test.
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id' 'EntraIDCrawler.Auth.ps1')

    $script:savedIdentityClientId = $env:IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID
}

AfterAll {
    $env:IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID = $script:savedIdentityClientId
}

Describe 'Connect-EntraCrawlerGraph' {
    BeforeEach {
        $env:IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID = 'deployment-identity'
        $Global:TenantId = $null
        Mock Get-FGAccessToken -MockWith { }
        # What a real sign-in does: the tenant comes from the token.
        Mock Get-FGAccessTokenManagedIdentity -MockWith { $Global:TenantId = 'tenant-of-identity' }
    }

    AfterEach {
        $Global:TenantId = $null
    }

    It 'signs in with the client secret when authMethod is <Label>' -ForEach @(
        @{ Label = 'absent (a config saved before the choice existed)'; AuthMethod = '' }
        @{ Label = 'ClientSecret'; AuthMethod = 'ClientSecret' }
    ) {
        Connect-EntraCrawlerGraph -AuthMethod $AuthMethod -TenantId 'tid' -ClientId 'cid' -ClientSecret 'csecret'

        Should -Invoke Get-FGAccessToken -Exactly 1 -ParameterFilter {
            $TenantId -eq 'tid' -and $ClientId -eq 'cid' -and $ClientSecret -eq 'csecret'
        }
        Should -Invoke Get-FGAccessTokenManagedIdentity -Exactly 0
    }

    It 'signs in with the deployment identity, never with a secret that is still in the config' {
        Connect-EntraCrawlerGraph -AuthMethod 'ManagedIdentity' -TenantId 'tenant-of-identity' -ClientId 'cid' -ClientSecret 'left-over'

        Should -Invoke Get-FGAccessTokenManagedIdentity -Exactly 1 -ParameterFilter { $ClientId -eq 'deployment-identity' }
        Should -Invoke Get-FGAccessToken -Exactly 0
    }

    It 'ignores whitespace around the configured identity client ID' {
        $env:IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID = '  padded-id  '

        Connect-EntraCrawlerGraph -AuthMethod 'ManagedIdentity'

        Should -Invoke Get-FGAccessTokenManagedIdentity -Exactly 1 -ParameterFilter { $ClientId -eq 'padded-id' }
    }

    It 'refuses when the deployment has no crawler identity (<Label>), rather than using whatever identity is attached' -ForEach @(
        @{ Label = 'unset'; Value = $null }
        @{ Label = 'blank'; Value = '   ' }
    ) {
        $env:IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID = $Value

        { Connect-EntraCrawlerGraph -AuthMethod 'ManagedIdentity' -TenantId 'tid' } |
            Should -Throw '*IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID is not set*'

        Should -Invoke Get-FGAccessTokenManagedIdentity -Exactly 0
        Should -Invoke Get-FGAccessToken -Exactly 0
    }

    It 'refuses to crawl when the config names a different tenant than the identity lives in' {
        { Connect-EntraCrawlerGraph -AuthMethod 'ManagedIdentity' -TenantId 'some-other-tenant' } |
            Should -Throw '*belongs to tenant tenant-of-identity, but this crawler is configured for tenant some-other-tenant*'
    }

    It 'accepts the same tenant written in another case' {
        { Connect-EntraCrawlerGraph -AuthMethod 'ManagedIdentity' -TenantId 'TENANT-OF-IDENTITY' } | Should -Not -Throw
    }

    It 'accepts a config without a tenant: the identity decides' {
        { Connect-EntraCrawlerGraph -AuthMethod 'ManagedIdentity' } | Should -Not -Throw
        $Global:TenantId | Should -Be 'tenant-of-identity'
    }
}
