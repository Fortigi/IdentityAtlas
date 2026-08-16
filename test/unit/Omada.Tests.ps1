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
    # Load OData base functions (auth, pagination). Both filters matter:
    #   Start-*  entry points, which have mandatory params and throw by design.
    #   Test-*   Test-ODataCrawler.ps1 is a SCRIPT — dot-sourcing it RUNS the full
    #            OData integration suite, starting a mock HTTP server on a real
    #            port. Without this filter every run of this unit file paid ~50s
    #            and bound a socket, and every PSMutant mutant mapped to this file
    #            re-paid it (the measured baseline dropped 73s -> 10s on removing
    #            it). The integration suite belongs to CI's crawler-test loop, not
    #            to a unit run.
    Get-ChildItem (Join-Path $script:repoRoot 'tools\crawlers\odata') -Filter '*.ps1' |
        Where-Object { $_.Name -notlike 'Start-*' -and $_.Name -notlike 'Test-*' } |
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

# ─── Omada helper availability ────────────────────────────────────────────────
# The OData library's own surface, auth methods and Get-ODataAuthRoot are covered
# by test/unit/ODataLibrary.Tests.ps1. They used to live here only because Omada
# was the first crawler to need them; odata is a shared dependsOn base and any
# future OData consumer would have had to reach into this file for that coverage.
Describe 'Omada — function availability' {
    It 'exports <_>' -ForEach @(
        'Get-OmadaRefValue',
        'Get-OmadaRefUid'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
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
}
