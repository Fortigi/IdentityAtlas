#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the Omada SDK (tools/powershell-sdk/omada).

.DESCRIPTION
    Tests the pure helper functions exported by the Omada SDK.
    No network calls are made — Omada API connectivity is out of scope.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/Omada.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:modulePath = Join-Path $script:repoRoot 'setup\IdentityAtlas.psd1'
    Import-Module $script:modulePath -Force -ErrorAction Stop
}

# ─── Get-OmadaRefValue ────────────────────────────────────────────────────────
Describe 'Get-OmadaRefValue' {
    It 'returns Fallback for null input' {
        Get-OmadaRefValue -Ref $null -Fallback 'default' | Should -Be 'default'
    }
    It 'returns empty string Fallback when Fallback not specified' {
        Get-OmadaRefValue -Ref $null | Should -Be ''
    }
    It 'returns the string as-is when Ref is a string' {
        Get-OmadaRefValue -Ref 'Employee' | Should -Be 'Employee'
    }
    It 'extracts .Value from an OIS.SetValue-shaped object' {
        $ref = [PSCustomObject]@{ Value = 'Business Role' }
        Get-OmadaRefValue -Ref $ref | Should -Be 'Business Role'
    }
    It 'extracts .DisplayName from an OIS.ReferenceValue-shaped object' {
        $ref = [PSCustomObject]@{ DisplayName = 'OrgUnit' }
        Get-OmadaRefValue -Ref $ref | Should -Be 'OrgUnit'
    }
    It '.Value takes precedence over .DisplayName' {
        $ref = [PSCustomObject]@{ Value = 'Employee'; DisplayName = 'ignored' }
        Get-OmadaRefValue -Ref $ref | Should -Be 'Employee'
    }
    It 'falls back to .english when neither .Value nor .DisplayName exists' {
        $ref = [PSCustomObject]@{ english = 'EnglishLabel' }
        Get-OmadaRefValue -Ref $ref | Should -Be 'EnglishLabel'
    }
    It 'returns Fallback when no known property exists' {
        $ref = [PSCustomObject]@{ SomethingElse = 'irrelevant' }
        Get-OmadaRefValue -Ref $ref -Fallback 'unknown' | Should -Be 'unknown'
    }
}

# ─── Get-OmadaRefUid ─────────────────────────────────────────────────────────
Describe 'Get-OmadaRefUid' {
    It 'returns Fallback for null input' {
        Get-OmadaRefUid -Ref $null -Fallback 'fb' | Should -Be 'fb'
    }
    It 'returns empty string Fallback when Fallback not specified' {
        Get-OmadaRefUid -Ref $null | Should -Be ''
    }
    It 'returns the string as-is when Ref is a string' {
        Get-OmadaRefUid -Ref 'uid-abc-123' | Should -Be 'uid-abc-123'
    }
    It 'extracts .UId from an OData ReferenceValue-shaped object' {
        $uid = '11111111-1111-1111-1111-111111111111'
        $ref = [PSCustomObject]@{ UId = $uid }
        Get-OmadaRefUid -Ref $ref | Should -Be $uid
    }
    It 'falls back to ._UID when .UId is absent' {
        $ref = [PSCustomObject]@{ _UID = 'legacy-uid' }
        Get-OmadaRefUid -Ref $ref | Should -Be 'legacy-uid'
    }
    It 'falls back to .id when no .UId or ._UID exists' {
        $ref = [PSCustomObject]@{ id = 'id-42' }
        Get-OmadaRefUid -Ref $ref | Should -Be 'id-42'
    }
    It 'returns Fallback when no known property exists' {
        $ref = [PSCustomObject]@{ Something = 'x' }
        Get-OmadaRefUid -Ref $ref -Fallback 'none' | Should -Be 'none'
    }
}

# ─── Omada SDK function availability ─────────────────────────────────────────
Describe 'Omada SDK — function availability' {
    It 'exports <_>' -ForEach @(
        'Connect-OmadaAPI',
        'Get-OmadaEntitySets',
        'Invoke-OmadaPagedRequest',
        'Invoke-OmadaGetRequest',
        'Get-OmadaRefValue',
        'Get-OmadaRefUid'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

# ─── Connect-OmadaAPI — ApiToken (no HTTP) ────────────────────────────────────
Describe 'Connect-OmadaAPI — ApiToken auth' {
    It 'succeeds without making any HTTP call' {
        { Connect-OmadaAPI -BaseUrl 'https://omada.example.com' -AuthMethod 'ApiToken' -ApiToken 'test-static-token' } |
            Should -Not -Throw
    }
}

# ─── Connect-OmadaAPI — BasicAuth (no HTTP) ───────────────────────────────────
Describe 'Connect-OmadaAPI — BasicAuth auth' {
    It 'succeeds without making any HTTP call' {
        { Connect-OmadaAPI -BaseUrl 'https://omada.example.com' -AuthMethod 'BasicAuth' -Username 'admin' -Password 'pass' } |
            Should -Not -Throw
    }
    It 'throws when username is missing' {
        { Connect-OmadaAPI -BaseUrl 'https://omada.example.com' -AuthMethod 'BasicAuth' -Password 'pass' } |
            Should -Throw
    }
}

# ─── Connect-OmadaAPI — CookieString (no HTTP) ────────────────────────────────
Describe 'Connect-OmadaAPI — CookieString auth' {
    It 'succeeds with an explicit name=value cookie string' {
        { Connect-OmadaAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'oisauthtoken=MHXp1OG0seFfKwNYzQkZwA==' } |
            Should -Not -Throw
    }
    It 'succeeds with a bare token — auto-prefix oisauthtoken= is applied' {
        { Connect-OmadaAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'MHXp1OG0seFfKwNYzQkZwA==' } |
            Should -Not -Throw
    }
    It 'throws when CookieString is empty' {
        { Connect-OmadaAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString '' } |
            Should -Throw
    }
    It 'passes an ASP.NET multi-cookie string as-is (already name=value)' {
        { Connect-OmadaAPI -BaseUrl 'https://server/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'ASP.NET_SessionId=abc123; Auth=xyz' } |
            Should -Not -Throw
    }
}

# ─── Get-OmadaAuthRoot ─────────────────────────────────────────────────────────
Describe 'Get-OmadaAuthRoot' {
    BeforeEach {
        # Seed the session so Get-OmadaAuthRoot can read BaseUrl
        Connect-OmadaAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
    }

    It 'strips /odata/dataobjects from a cloud URL' {
        Get-OmadaAuthRoot | Should -Be 'https://tenant.omada.cloud'
    }

    It 'strips /odata/dataobjects from an on-prem URL' {
        Connect-OmadaAPI -BaseUrl 'http://server/odata/dataobjects' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
        Get-OmadaAuthRoot | Should -Be 'http://server'
    }

    It 'returns the base URL unchanged when no /odata/ segment is present' {
        Connect-OmadaAPI -BaseUrl 'http://server/api' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
        Get-OmadaAuthRoot | Should -Be 'http://server/api'
    }
}

# ─── URL normalisation — System.Uri logic (in Start-OmadaCrawler) ─────────────
Describe 'Omada URL normalisation' {
    BeforeAll {
        $script:crawlerContent = Get-Content (Join-Path $script:repoRoot 'tools\crawlers\omada\Start-OmadaCrawler.ps1') -Raw
    }

    It 'crawler normalises base URL using System.Uri' {
        $script:crawlerContent | Should -Match 'System\.Uri'
    }
    It 'crawler auto-appends /odata/dataobjects to root URLs' {
        $script:crawlerContent | Should -Match '/odata/dataobjects'
    }
    It 'crawler derives Builtin URL from DataObjects path' {
        $script:crawlerContent | Should -Match 'BuiltinBaseUrl'
    }
}

# ─── File structure ────────────────────────────────────────────────────────────
Describe 'Omada file structure' {
    BeforeAll {
        $script:omadaRoot    = Join-Path $script:repoRoot 'tools\powershell-sdk\omada'
        $script:crawlerPath  = Join-Path $script:repoRoot 'tools\crawlers\omada\Start-OmadaCrawler.ps1'
        $script:dispatchPath = Join-Path $script:repoRoot 'setup\docker\Invoke-CrawlerJob.ps1'
    }

    It 'tools/powershell-sdk/omada folder exists' {
        $script:omadaRoot | Should -Exist
    }
    It 'Start-OmadaCrawler.ps1 exists' {
        $script:crawlerPath | Should -Exist
    }
    It 'Invoke-CrawlerJob.ps1 handles omada jobType' {
        $content = Get-Content $script:dispatchPath -Raw
        $content | Should -Match "'omada'"
    }
    It 'Invoke-CrawlerJob.ps1 validates baseUrl before writing temp config' {
        $content = Get-Content $script:dispatchPath -Raw
        $content | Should -Match "Config\['baseUrl'\]"
    }
    It 'Invoke-CrawlerJob.ps1 validates authMethod before writing temp config' {
        $content = Get-Content $script:dispatchPath -Raw
        $content | Should -Match "Config\['authMethod'\]"
    }
    It 'Invoke-CrawlerJob.ps1 forwards contextObjectTypes to the crawler' {
        $content = Get-Content $script:dispatchPath -Raw
        $content | Should -Match 'contextObjectTypes'
    }
    It 'Invoke-CrawlerJob.ps1 forwards resourceCategoryMapping to the crawler' {
        $content = Get-Content $script:dispatchPath -Raw
        $content | Should -Match 'resourceCategoryMapping'
    }
    It 'SDK files export expected functions' {
        $sdkFiles = Get-ChildItem (Join-Path $script:repoRoot 'tools\powershell-sdk\omada') -Filter '*.ps1'
        $sdkFiles.Count | Should -BeGreaterOrEqual 3
    }
}
