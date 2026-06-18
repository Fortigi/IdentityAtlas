#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests that enforce the manifest-based crawler plugin contract.

.DESCRIPTION
    Every user-facing crawler must have a CrawlerMeta.js alongside its crawler.json.
    Crawlers pending migration are listed in $pendingMigration — those tests are
    marked as Skipped with a clear reason. Remove a crawler from the list once its
    CrawlerMeta.js is in place.

    Library crawlers (used only as dependsOn, never run as a standalone job, e.g.
    the generic OData library) are excluded from the CrawlerMeta.js requirement.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/CrawlerManifest.Tests.ps1 -Output Detailed
#>

BeforeDiscovery {
    $libraryCrawlers  = @('odata')
    $pendingMigration = @('entra-id', 'csv', 'demo', 'custom-connector')

    $repoRoot     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $crawlersRoot = Join-Path $repoRoot 'tools' 'crawlers'

    $script:CrawlerList = Get-ChildItem -Path $crawlersRoot -Filter 'crawler.json' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -notmatch '[\\/]dev[\\/]|[\\/]node_modules[\\/]' } |
        ForEach-Object {
            $obj = Get-Content $_.FullName -Raw | ConvertFrom-Json
            @{
                Type      = $obj.type
                Dir       = $_.DirectoryName
                IsLibrary = ($libraryCrawlers  -contains $obj.type)
                IsPending = ($pendingMigration -contains $obj.type)
            }
        }
}

Describe 'Crawler manifest completeness' {

    BeforeAll {
        # Re-compute count at execution time (BeforeDiscovery scope is separate).
        $repoRoot     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $crawlersRoot = Join-Path $repoRoot 'tools' 'crawlers'
        $script:ManifestCount = (Get-ChildItem -Path $crawlersRoot -Filter 'crawler.json' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.DirectoryName -notmatch '[\\/]dev[\\/]|[\\/]node_modules[\\/]' }).Count
    }

    It 'discovers at least one crawler manifest' {
        $script:ManifestCount | Should -BeGreaterThan 0
    }

    Context '<Type> crawler' -ForEach $script:CrawlerList {

        It 'has CrawlerMeta.js for UI type-picker registration' {
            if ($IsLibrary) {
                Set-ItResult -Skipped -Because "'$Type' is a library crawler (dependsOn only) — CrawlerMeta.js not required"
                return
            }
            if ($IsPending) {
                Set-ItResult -Skipped -Because "'$Type' not yet migrated — add tools/crawlers/$Type/CrawlerMeta.js and remove from pendingMigration"
                return
            }
            Join-Path $Dir 'CrawlerMeta.js' | Should -Exist
        }

        It 'CrawlerMeta.js has a default export (when present)' {
            $metaPath = Join-Path $Dir 'CrawlerMeta.js'
            if (-not (Test-Path $metaPath)) {
                Set-ItResult -Skipped -Because 'no CrawlerMeta.js'
                return
            }
            Get-Content $metaPath -Raw | Should -Match 'export\s+default'
        }

        It 'CrawlerMeta.js exports id, name, and description (when present)' {
            $metaPath = Join-Path $Dir 'CrawlerMeta.js'
            if (-not (Test-Path $metaPath)) {
                Set-ItResult -Skipped -Because 'no CrawlerMeta.js'
                return
            }
            $content = Get-Content $metaPath -Raw
            $content | Should -Match "id\s*:"
            $content | Should -Match "name\s*:"
            $content | Should -Match "description\s*:"
        }

        It 'ConfigWizard.jsx has a default export (when present)' {
            $wizardPath = Join-Path $Dir 'ConfigWizard.jsx'
            if (-not (Test-Path $wizardPath)) {
                Set-ItResult -Skipped -Because 'no ConfigWizard.jsx'
                return
            }
            Get-Content $wizardPath -Raw | Should -Match 'export\s+default\s+(function|class|[a-zA-Z_$])'
        }

        It 'discover.js has a default export (when present)' {
            $discPath = Join-Path $Dir 'discover.js'
            if (-not (Test-Path $discPath)) {
                Set-ItResult -Skipped -Because 'no discover.js'
                return
            }
            Get-Content $discPath -Raw | Should -Match 'export\s+default'
        }
    }
}
