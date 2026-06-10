#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the manifest-driven crawler dispatcher.

.DESCRIPTION
    Tests Resolve-CrawlerDependencies, registry building, and hook dispatch
    without making any network calls or running real crawlers.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/Dispatcher.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

    # Dot-source the dispatcher to get Resolve-CrawlerDependencies in scope.
    # The dispatcher params are mandatory, so we pass dummy values then
    # immediately override — but actually we just need the function, not to run it.
    # Use a workaround: dot-source only the function definition via script blocks.
    $dispatcherPath = Join-Path $script:repoRoot 'setup\docker\Invoke-CrawlerJob.ps1'
    $dispatcherContent = Get-Content $dispatcherPath -Raw

    # Extract and load only the Resolve-CrawlerDependencies function
    $fnMatch = [regex]::Match($dispatcherContent, 'function Resolve-CrawlerDependencies \{[\s\S]+?\n\}')
    if ($fnMatch.Success) {
        $fnBlock = [scriptblock]::Create($fnMatch.Value)
        . $fnBlock
    } else {
        throw "Could not extract Resolve-CrawlerDependencies from dispatcher"
    }

    # Extract the loading loop body so tests can reproduce it exactly.
    # Matches: Get-ChildItem ... | Where-Object { $_.Name -ne $layerEntryPoint } | ForEach-Object { . $_.FullName }
    $script:dispatcherContent = $dispatcherContent

    # Helper: run the exact dependency-loading loop from the dispatcher.
    # Accepts a resolved list and registry; dot-sources library files per the dispatcher logic.
    function Invoke-DependencyLoader {
        param([string[]]$Resolved, [hashtable]$Registry)
        foreach ($layer in $Resolved) {
            $layerDir        = $Registry[$layer].Dir
            $layerEntryPoint = $Registry[$layer].Manifest['entryPoint']
            Get-ChildItem -Path $layerDir -Include '*.ps1' -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne $layerEntryPoint } |
                ForEach-Object { . $_.FullName }
        }
    }

    # Helper: build a minimal in-memory registry from a hashtable spec
    # e.g. @{ 'odata' = @(); 'omada' = @('odata') }
    function Build-Registry {
        param([hashtable]$Spec)
        $reg = @{}
        foreach ($type in $Spec.Keys) {
            $reg[$type] = @{
                Dir      = "tools/crawlers/$type"
                Manifest = @{
                    type        = $type
                    entryPoint  = "Start-${type}Crawler.ps1"
                    dependsOn   = $Spec[$type]
                    postSyncHooks = @()
                }
            }
        }
        return $reg
    }
}

# ─── Resolve-CrawlerDependencies ─────────────────────────────────────────────

Describe 'Resolve-CrawlerDependencies — no dependencies' {
    It 'returns just the type itself when dependsOn is empty' {
        $reg = Build-Registry @{ 'entra-id' = @() }
        $result = Resolve-CrawlerDependencies -Type 'entra-id' -Registry $reg
        $result | Should -Be @('entra-id')
    }
}

Describe 'Resolve-CrawlerDependencies — single dependency' {
    It 'loads dependency before the dependent crawler' {
        $reg = Build-Registry @{ 'odata' = @(); 'omada' = @('odata') }
        $result = Resolve-CrawlerDependencies -Type 'omada' -Registry $reg
        $result[0] | Should -Be 'odata'
        $result[1] | Should -Be 'omada'
    }
}

Describe 'Resolve-CrawlerDependencies — multi-level chain' {
    It 'resolves A→B→C in correct topological order' {
        $reg = Build-Registry @{ 'rest' = @(); 'odata' = @('rest'); 'omada' = @('odata') }
        $result = Resolve-CrawlerDependencies -Type 'omada' -Registry $reg
        $result[0] | Should -Be 'rest'
        $result[1] | Should -Be 'odata'
        $result[2] | Should -Be 'omada'
    }
}

Describe 'Resolve-CrawlerDependencies — cycle detection' {
    It 'throws a clear error naming the cycle when A depends on B depends on A' {
        $reg = Build-Registry @{ 'a' = @('b'); 'b' = @('a') }
        { Resolve-CrawlerDependencies -Type 'a' -Registry $reg } |
            Should -Throw -ExceptionType ([System.Management.Automation.RuntimeException])
    }

    It 'throws when a crawler depends on itself' {
        $reg = Build-Registry @{ 'self' = @('self') }
        { Resolve-CrawlerDependencies -Type 'self' -Registry $reg } |
            Should -Throw
    }
}

Describe 'Resolve-CrawlerDependencies — missing dependency' {
    It 'throws when a declared dependency is not in the registry' {
        $reg = Build-Registry @{ 'omada' = @('odata') }   # odata missing
        { Resolve-CrawlerDependencies -Type 'omada' -Registry $reg } |
            Should -Throw
    }
}

Describe 'Resolve-CrawlerDependencies — unknown type' {
    It 'throws when the requested type is not in the registry' {
        $reg = Build-Registry @{ 'entra-id' = @() }
        { Resolve-CrawlerDependencies -Type 'nonexistent' -Registry $reg } |
            Should -Throw
    }
}

# ─── Get-CrawlerRegistry (live crawlers) ─────────────────────────────────────

Describe 'Get-CrawlerRegistry — live crawler manifests' {
    BeforeAll {
        $script:modulePath = Join-Path $script:repoRoot 'setup\IdentityAtlas.psd1'
        Import-Module $script:modulePath -Force -ErrorAction Stop
        $script:registry = Get-CrawlerRegistry
    }

    It 'registry is not empty' {
        $script:registry.Count | Should -BeGreaterThan 0
    }

    It 'contains entra-id crawler' {
        $script:registry.ContainsKey('entra-id') | Should -BeTrue
    }

    It 'contains csv crawler' {
        $script:registry.ContainsKey('csv') | Should -BeTrue
    }

    It 'contains omada crawler' {
        $script:registry.ContainsKey('omada') | Should -BeTrue
    }

    It 'omada declares odata as a dependency' {
        $script:registry['omada'].Manifest['dependsOn'] | Should -Contain 'odata'
    }

    It 'each crawler entry point file exists on disk' {
        foreach ($key in $script:registry.Keys) {
            $entry = $script:registry[$key]
            $ep    = $entry.Manifest['entryPoint']
            if (-not $ep) { continue }
            $epPath = Join-Path $entry.Dir $ep
            $epPath | Should -Exist -Because "$key entry point must exist at $epPath"
        }
    }

    It 'each crawler.json has required fields: type, entryPoint' {
        foreach ($key in $script:registry.Keys) {
            $m = $script:registry[$key].Manifest
            $m['type'] | Should -Not -BeNullOrEmpty -Because "$key manifest needs a type"
            $m['entryPoint'] | Should -Not -BeNullOrEmpty -Because "$key manifest needs an entryPoint"
        }
    }
}

# ─── Dependency loader — entry point isolation ────────────────────────────────

Describe 'Dependency loader — entry points are never dot-sourced' {
    BeforeAll {
        # Build two fake crawler dirs in a temp location:
        #   odata/ — library ps1 + entry point that throws if executed
        #   omada/ — entry point that throws if executed (no lib files)
        $script:loaderTmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) "pester-loader-$([guid]::NewGuid().ToString('N'))")

        $odataDir = New-Item -ItemType Directory -Path (Join-Path $script:loaderTmp 'odata')
        Set-Content (Join-Path $odataDir 'OData-Helpers.ps1') "function Get-FakeODataHelper { 'loaded' }"
        Set-Content (Join-Path $odataDir 'Start-ODataCrawler.ps1') "throw 'BUG: odata entry point was dot-sourced by the loader'"

        $omadaDir = New-Item -ItemType Directory -Path (Join-Path $script:loaderTmp 'omada')
        Set-Content (Join-Path $omadaDir 'Start-OmadaCrawler.ps1') "throw 'BUG: omada entry point was dot-sourced by the loader'"

        $script:loaderRegistry = @{
            'odata' = @{ Dir = $odataDir.FullName; Manifest = @{ entryPoint = 'Start-ODataCrawler.ps1'; dependsOn = @() } }
            'omada' = @{ Dir = $omadaDir.FullName; Manifest = @{ entryPoint = 'Start-OmadaCrawler.ps1'; dependsOn = @('odata') } }
        }
    }

    AfterAll {
        Remove-Item $script:loaderTmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'does not throw when loading omada (which depends on odata)' {
        $resolved = Resolve-CrawlerDependencies -Type 'omada' -Registry $script:loaderRegistry
        { Invoke-DependencyLoader -Resolved $resolved -Registry $script:loaderRegistry } | Should -Not -Throw
    }

    It 'does not throw when loading a crawler with no dependencies' {
        $resolved = Resolve-CrawlerDependencies -Type 'odata' -Registry $script:loaderRegistry
        { Invoke-DependencyLoader -Resolved $resolved -Registry $script:loaderRegistry } | Should -Not -Throw
    }
}

# ─── Fresh-process bootstrap (node-launcher simulation) ──────────────────────

Describe 'Invoke-CrawlerJob.ps1 — fresh-process module bootstrap (node-launcher)' {
    It 'self-imports IdentityAtlas when spawned without a pre-loaded module' {
        # Simulate exactly what desktop-worker.cjs does: pwsh -NonInteractive -File
        # with no prior Import-Module. The script must self-bootstrap.
        $dispatcherPath = Join-Path $script:repoRoot 'setup' 'docker' 'Invoke-CrawlerJob.ps1'
        $savedRoot = $env:IA_APP_ROOT
        try {
            $env:IA_APP_ROOT = $script:repoRoot
            $output = & pwsh -NonInteractive -File $dispatcherPath `
                -JobId 0 -JobType 'entra-id' -Config '{}' -ApiKey 'test' 2>&1 |
                Out-String
        } finally {
            $env:IA_APP_ROOT = $savedRoot
        }

        $output | Should -Not -Match "The term 'Get-CrawlerRegistry' is not recognized"
    }
}
