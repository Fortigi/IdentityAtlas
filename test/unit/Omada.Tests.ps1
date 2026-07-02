#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the OData base layer and Omada-specific helpers.

.DESCRIPTION
    Tests the pure helper functions from the OData base crawler and Omada helpers.
    No network calls are made — API connectivity is out of scope.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/Omada.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    # Load OData base functions (auth, pagination) — exclude Start-*.ps1 entry points (they have mandatory params)
    Get-ChildItem (Join-Path $script:repoRoot 'tools\crawlers\odata') -Filter '*.ps1' |
        Where-Object { $_.Name -notlike 'Start-*' } |
        ForEach-Object { . $_.FullName }
    # Load Omada-specific helpers (Get-OmadaRefValue, Get-OmadaRefUid)
    . (Join-Path $script:repoRoot 'tools\crawlers\omada\Get-OmadaHelpers.ps1')
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

# ─── OData function availability ─────────────────────────────────────────────
Describe 'OData — function availability' {
    It 'exports <_>' -ForEach @(
        'Connect-ODataAPI',
        'Invoke-ODataPagedRequest',
        'Invoke-ODataGetRequest',
        'Get-ODataEntitySets',
        'Get-OmadaRefValue',
        'Get-OmadaRefUid'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

# ─── Connect-ODataAPI — ApiToken (no HTTP) ───────────────────────────────────
Describe 'Connect-ODataAPI — ApiToken auth' {
    It 'succeeds without making any HTTP call' {
        { Connect-ODataAPI -BaseUrl 'https://omada.example.com' -AuthMethod 'ApiToken' -ApiToken 'test-static-token' } |
            Should -Not -Throw
    }
}

# ─── Connect-ODataAPI — BasicAuth (no HTTP) ──────────────────────────────────
Describe 'Connect-ODataAPI — BasicAuth auth' {
    It 'succeeds without making any HTTP call' {
        { Connect-ODataAPI -BaseUrl 'https://omada.example.com' -AuthMethod 'BasicAuth' -Username 'admin' -Password 'pass' } |
            Should -Not -Throw
    }
    It 'throws when username is missing' {
        { Connect-ODataAPI -BaseUrl 'https://omada.example.com' -AuthMethod 'BasicAuth' -Password 'pass' } |
            Should -Throw
    }
}

# ─── Connect-ODataAPI — CookieString (no HTTP) ───────────────────────────────
Describe 'Connect-ODataAPI — CookieString auth' {
    It 'succeeds with an explicit name=value cookie string' {
        { Connect-ODataAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'oisauthtoken=MHXp1OG0seFfKwNYzQkZwA==' } |
            Should -Not -Throw
    }
    It 'succeeds with a bare token — auto-prefix oisauthtoken= is applied' {
        { Connect-ODataAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'MHXp1OG0seFfKwNYzQkZwA==' } |
            Should -Not -Throw
    }
    It 'throws when CookieString is empty' {
        { Connect-ODataAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString '' } |
            Should -Throw
    }
    It 'passes an ASP.NET multi-cookie string as-is (already name=value)' {
        { Connect-ODataAPI -BaseUrl 'https://server/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'ASP.NET_SessionId=abc123; Auth=xyz' } |
            Should -Not -Throw
    }
}

# ─── Get-ODataAuthRoot ────────────────────────────────────────────────────────
Describe 'Get-ODataAuthRoot' {
    BeforeEach {
        # Seed the session so Get-ODataAuthRoot can read BaseUrl
        Connect-ODataAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
    }

    It 'strips /odata/dataobjects from a cloud URL' {
        Get-ODataAuthRoot | Should -Be 'https://tenant.omada.cloud'
    }

    It 'strips /odata/dataobjects from an on-prem URL' {
        Connect-ODataAPI -BaseUrl 'http://server/odata/dataobjects' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
        Get-ODataAuthRoot | Should -Be 'http://server'
    }

    It 'returns the base URL unchanged when no /odata/ segment is present' {
        Connect-ODataAPI -BaseUrl 'http://server/api' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
        Get-ODataAuthRoot | Should -Be 'http://server/api'
    }
}

# ─── URL normalisation — System.Uri logic (Resolve-OmadaConfig in Phases) ─────
Describe 'Omada URL normalisation' {
    BeforeAll {
        # The base-URL normalisation moved into Resolve-OmadaConfig
        # (OmadaCrawler.Phases.ps1); read both the entry point and the phases
        # file so the assertions track the logic wherever it lives.
        $omadaDir = Join-Path $script:repoRoot 'tools\crawlers\omada'
        $script:crawlerContent = (Get-Content (Join-Path $omadaDir 'Start-OmadaCrawler.ps1') -Raw) +
                                 (Get-Content (Join-Path $omadaDir 'OmadaCrawler.Phases.ps1') -Raw)
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
        $script:odataRoot    = Join-Path $script:repoRoot 'tools\crawlers\odata'
        $script:omadaRoot    = Join-Path $script:repoRoot 'tools\crawlers\omada'
        $script:crawlerPath  = Join-Path $script:omadaRoot 'Start-OmadaCrawler.ps1'
        $script:dispatchPath = Join-Path $script:repoRoot 'setup\docker\Invoke-CrawlerJob.ps1'
    }

    It 'tools/crawlers/odata folder exists with OData protocol files' {
        Get-ChildItem $script:odataRoot -Filter '*.ps1' | Should -Not -BeNullOrEmpty
    }
    It 'tools/crawlers/omada/crawler.json exists and declares dependsOn odata' {
        $manifest = Get-Content (Join-Path $script:omadaRoot 'crawler.json') -Raw | ConvertFrom-Json
        $manifest.dependsOn | Should -Contain 'odata'
    }
    It 'Start-OmadaCrawler.ps1 exists' {
        $script:crawlerPath | Should -Exist
    }
    It 'the crawler uses Connect-ODataAPI (not Connect-OmadaAPI)' {
        # The auth call moved into Connect-OmadaSession (OmadaCrawler.Phases.ps1);
        # read both files so the assertion tracks the OData connect wherever it lives.
        $content = (Get-Content $script:crawlerPath -Raw) +
                   (Get-Content (Join-Path $script:omadaRoot 'OmadaCrawler.Phases.ps1') -Raw)
        $content | Should -Match 'Connect-ODataAPI'
        $content | Should -Not -Match 'Connect-OmadaAPI'
    }
    It 'Invoke-CrawlerJob.ps1 dispatches via registry (no hardcoded jobType switch)' {
        # Step-2: the dispatcher is fully generic — it uses Get-CrawlerRegistry,
        # not a switch($JobType) with hardcoded crawler types.
        $content = Get-Content $script:dispatchPath -Raw
        $content | Should -Match 'Get-CrawlerRegistry'
        $content | Should -Not -Match "switch\s*\(\s*\`$JobType"
    }
    It 'Start-OmadaCrawler.ps1 reads contextObjectTypes from config' {
        # contextObjectTypes moved from the dispatcher into the crawler config section.
        $content = Get-Content $script:crawlerPath -Raw
        $content | Should -Match 'contextObjectTypes'
    }
    It 'Start-OmadaCrawler.ps1 reads resourceCategoryMapping from config' {
        # resourceCategoryMapping moved from the dispatcher into the crawler config section.
        $content = Get-Content $script:crawlerPath -Raw
        $content | Should -Match 'resourceCategoryMapping'
    }
    It 'OData base has at least 3 PS1 files' {
        $odataFiles = Get-ChildItem $script:odataRoot -Filter '*.ps1'
        $odataFiles.Count | Should -BeGreaterOrEqual 3
    }
}
