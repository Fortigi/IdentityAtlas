#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Guard: crawler config resolution and Connect-* functions never write a secret
    to the host, the transcript, or an error message. (SEC-2026-09 L-10)

.DESCRIPTION
    Every job runs under Start-Transcript, and the transcript is served to admins by
    GET /admin/crawler-jobs/:id/log. Anything a crawler prints (Write-Host,
    warnings, verbose, errors) lands there. These tests run the config and
    authentication path of each crawler with a SENTINEL value in every secret field,
    capture every output stream (*>&1) plus the message of anything thrown, and
    assert the sentinel appears nowhere. Basic-auth headers are also checked in
    their base64 form, since printing the header would leak the password encoded.

    The HTTP boundary (Invoke-RestMethod) is mocked; nothing leaves the process.

.USAGE
    Invoke-Pester -Path test/unit/CrawlerSecretOutput.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:crawlers = Join-Path $script:repoRoot 'tools' 'crawlers'
    $script:S        = 'SENTINEL-s3cr3t-7f1c'

    # The Connect-* functions check every base and token URL with the public-URL guard
    # (tools/crawlers/shared/Assert-FGPublicUrl.ps1), which resolves the host through
    # DNS. The *.example.test hosts in this file never resolve, so every connection was
    # refused before it reached the mocked HTTP boundary. Each crawler block below
    # mocks the guard's DNS seam to a public address, so the guard still runs; it has
    # its own tests in AssertFGPublicUrl.Tests.ps1.
    $script:PublicTestAddress = '93.184.216.34'

    . (Join-Path $script:crawlers 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'graph' 'Get-FGAccessToken.ps1')

    # Every stream the transcript would record, plus the text of a thrown error.
    function Get-EmittedText {
        param([scriptblock]$Script)
        $lines = [System.Collections.Generic.List[string]]::new()
        try { & $Script *>&1 | ForEach-Object { $lines.Add(($_ | Out-String)) } }
        catch { $lines.Add($_.Exception.Message) }
        return ($lines -join "`n")
    }

    function Assert-NoSecret {
        param([string]$Text)
        $basic = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("svc-user:$script:S"))
        $Text | Should -Not -Match ([regex]::Escape($script:S))
        $Text | Should -Not -Match ([regex]::Escape($basic))
    }

    function New-SecretConfigFile {
        $cfg = @{
            baseUrl = 'https://idp.example.test/scim/v2'; authMethod = 'OAuth2CC'
            username = 'svc-user'; password = $script:S; apiToken = $script:S; clientId = 'client-1'
            clientSecret = $script:S; cookieString = $script:S; tokenEndpoint = 'https://idp.example.test/token'
            tenantId = 'tenant-1'
        }
        $path = Join-Path ([System.IO.Path]::GetTempPath()) "secret-output-$([guid]::NewGuid().ToString('N')).json"
        $cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $path -Encoding UTF8
        return $path
    }
}

AfterAll {
    foreach ($g in 'AccessToken', 'ClientId', 'ClientSecret', 'TenantId') {
        Remove-Variable -Name $g -Scope Global -ErrorAction SilentlyContinue
    }
}

Describe 'Sentinel self-check' {
    It 'the assertion does catch a printed secret, plain or inside a Basic header' {
        $plain = Get-EmittedText { Write-Host "cfg: password=$script:S" }
        { Assert-NoSecret -Text $plain } | Should -Throw
        $encoded = Get-EmittedText { Write-Warning ('Basic ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("svc-user:$script:S"))) }
        { Assert-NoSecret -Text $encoded } | Should -Throw
    }
}

Describe 'SCIM: Resolve-ScimConfig / Connect-ScimAPI' {
    BeforeAll {
        . (Join-Path $script:crawlers 'scim' 'ScimCrawler.Transform.ps1')
        . (Join-Path $script:crawlers 'scim' 'ScimCrawler.Functions.ps1')
        Mock Resolve-FGHostAddress { @($script:PublicTestAddress) }
    }

    It 'resolving the config prints nothing secret' {
        $path = New-SecretConfigFile
        try { Assert-NoSecret (Get-EmittedText { Resolve-ScimConfig -ConfigPath $path | Out-Null }) }
        finally { Remove-Item $path -Force }
    }

    It 'connecting with <_> prints nothing secret' -ForEach @('BasicAuth', 'ApiToken', 'OAuth2CC') {
        $method = $_
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = "$script:S-token"; expires_in = 3600 } }
        $text = Get-EmittedText {
            Connect-ScimAPI -BaseUrl 'https://idp.example.test/scim/v2' -AuthMethod $method -Username 'svc-user' -Password $script:S `
                -ApiToken $script:S -ClientId 'client-1' -ClientSecret $script:S -TokenEndpoint 'https://idp.example.test/token'
        }
        $text | Should -Match "authenticated via $method"   # the connect path really ran
        Assert-NoSecret $text
    }

    It 'a failed token request does not echo the secret in its error' {
        Mock Invoke-RestMethod { throw 'HTTP 401 Unauthorized' }
        $text = Get-EmittedText {
            Connect-ScimAPI -BaseUrl 'https://idp.example.test/scim/v2' -AuthMethod 'OAuth2CC' -ClientId 'client-1' `
                -ClientSecret $script:S -TokenEndpoint 'https://idp.example.test/token'
        }
        $text | Should -Match 'client-credentials grant failed'
        Assert-NoSecret $text
    }
}

Describe 'midPoint: Resolve-MidpointConfig / Connect-MidpointSession' {
    BeforeAll {
        . (Join-Path $script:crawlers 'midpoint' 'Invoke-MidpointApi.ps1')
        . (Join-Path $script:crawlers 'midpoint' 'MidpointCrawler.Functions.ps1')
        . (Join-Path $script:crawlers 'midpoint' 'MidpointCrawler.Transform.ps1')
        . (Join-Path $script:crawlers 'midpoint' 'MidpointCrawler.Phases.ps1')
        Mock Resolve-FGHostAddress { @($script:PublicTestAddress) }
    }

    It 'resolving the config prints nothing secret' {
        $path = New-SecretConfigFile
        try { Assert-NoSecret (Get-EmittedText { Resolve-MidpointConfig -ConfigPath $path | Out-Null }) }
        finally { Remove-Item $path -Force }
    }

    It 'connecting with <_> prints nothing secret' -ForEach @('BasicAuth', 'ApiToken', 'OAuth2CC', 'OAuth2ROPC') {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = "$script:S-token"; expires_in = 3600 } }
        $cfg = [pscustomobject]@{
            baseUrl = 'https://mp.example.test/midpoint'; authMethod = $_; username = 'svc-user'; password = $script:S
            apiToken = $script:S; clientId = 'client-1'; clientSecret = $script:S; tokenEndpoint = 'https://mp.example.test/token'
        }
        $text = Get-EmittedText { Connect-MidpointSession -Cfg $cfg }
        $text | Should -Match "authenticated via $_"
        Assert-NoSecret $text
    }
}

Describe 'OData / Omada: Resolve-OmadaConfig / Connect-OmadaSession / Connect-ODataAPI' {
    BeforeAll {
        Get-ChildItem (Join-Path $script:crawlers 'odata') -Filter '*.ps1' |
            Where-Object { $_.Name -notlike 'Start-*' -and $_.Name -notlike 'Test-*' } |
            ForEach-Object { . $_.FullName }
        . (Join-Path $script:crawlers 'omada' 'Get-OmadaHelpers.ps1')
        . (Join-Path $script:crawlers 'omada' 'OmadaCrawler.Functions.ps1')
        . (Join-Path $script:crawlers 'omada' 'OmadaCrawler.Transform.ps1')
        . (Join-Path $script:crawlers 'omada' 'OmadaCrawler.Phases.ps1')
        Mock Resolve-FGHostAddress { @($script:PublicTestAddress) }
    }

    It 'resolving the Omada config prints nothing secret' {
        $cfg = [pscustomobject]@{ baseUrl = 'https://omada.example.test'; authMethod = 'OAuth2CC'; clientId = 'client-1'; clientSecret = $script:S; password = $script:S }
        Assert-NoSecret (Get-EmittedText { Resolve-OmadaConfig -RawConfig @{ clientSecret = $script:S } -Cfg $cfg | Out-Null })
    }

    It 'connecting with <_> prints nothing secret' -ForEach @('FormCookie', 'OAuth2CC', 'OAuth2ROPC', 'ApiToken', 'CookieString', 'BasicAuth') {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = "$script:S-token"; expires_in = 3600 } }
        $cfg = [pscustomobject]@{
            authMethod = $_; username = 'svc-user'; password = $script:S; clientId = 'client-1'; clientSecret = $script:S
            tokenEndpoint = 'https://omada.example.test/token'; apiToken = $script:S; cookieString = $script:S
        }
        $text = Get-EmittedText {
            Connect-OmadaSession -Cfg $cfg -BaseUrl 'https://omada.example.test/odata/dataobjects' -ApiVersion 'v14' -SessionTimeoutMinutes 30
        }
        $text | Should -Match "authenticated via $_"
        Assert-NoSecret $text
    }

    It 'a failed form login does not echo the password in its error' {
        Mock Invoke-RestMethod { throw 'HTTP 401 Unauthorized' }
        $text = Get-EmittedText {
            Connect-ODataAPI -BaseUrl 'https://omada.example.test/odata/dataobjects' -AuthMethod 'FormCookie' -Username 'svc-user' -Password $script:S
        }
        $text | Should -Match 'FormCookie auth failed'
        Assert-NoSecret $text
    }
}

Describe 'Azure RM: Resolve-AzureRMConfig / Connect-AzureRMSession' {
    BeforeAll {
        . (Join-Path $script:crawlers 'azure-rm' 'Get-AzureRMHelpers.ps1')
        . (Join-Path $script:crawlers 'azure-rm' 'AzureRMCrawler.Phases.ps1')
    }

    It 'resolving the config and connecting print nothing secret' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = "$script:S-token" } }
        $path = New-SecretConfigFile
        try {
            $text = Get-EmittedText {
                $c = Resolve-AzureRMConfig -ConfigPath $path
                Connect-AzureRMSession -Config $c
            }
            $text | Should -Match 'authenticated to management.azure.com'
            Assert-NoSecret $text
        }
        finally { Remove-Item $path -Force }
    }
}

Describe 'Entra ID: Resolve-EntraSyncConfig / Get-FGAccessToken' {
    BeforeAll {
        . (Join-Path $script:crawlers 'entra-id' 'EntraIDCrawler.Phases.ps1')
    }

    It 'resolving the config prints nothing secret' {
        Assert-NoSecret (Get-EmittedText { Resolve-EntraSyncConfig -RawConfig @{ tenantId = 't'; clientId = 'c'; clientSecret = $script:S } | Out-Null })
    }

    It 'authenticating prints nothing secret, whether the token request succeeds or not' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = "$script:S-token" } }
        Assert-NoSecret (Get-EmittedText { Get-FGAccessToken -TenantId 't' -ClientId 'c' -ClientSecret $script:S })

        Mock Invoke-RestMethod { [pscustomobject]@{} }
        $text = Get-EmittedText { Get-FGAccessToken -TenantId 't' -ClientId 'c' -ClientSecret $script:S }
        $text | Should -Match 'Error retrieving Graph Access Token'
        Assert-NoSecret $text
    }
}
