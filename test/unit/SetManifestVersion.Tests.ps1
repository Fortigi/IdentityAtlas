#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The cut-* workflows stamp a version the manifest can still be imported with.

.DESCRIPTION
    cut-beta.yml used to write '6.2.0-beta.1' straight into ModuleVersion. That is
    not a System.Version, so Import-Module refused the manifest and every worker
    job of a portable beta failed. tools/release/Set-ManifestVersion.ps1 splits a
    pre-release into ModuleVersion + PSData.Prerelease. These tests stamp a copy
    of the real setup/IdentityAtlas.psd1 and import it.

.USAGE
    Invoke-Pester -Path test/unit/SetManifestVersion.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:Script = Join-Path $root 'tools/release/Set-ManifestVersion.ps1'
    $script:Source = Join-Path $root 'setup/IdentityAtlas.psd1'

    function New-ManifestCopy {
        # The real manifest, next to a stub root module so Import-Module can load it.
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        Copy-Item $script:Source (Join-Path $dir 'IdentityAtlas.psd1')
        Set-Content (Join-Path $dir 'IdentityAtlas.psm1') 'function Get-StampProbe { 1 }'
        Join-Path $dir 'IdentityAtlas.psd1'
    }

    function Import-Stamped([string] $Path) {
        try { Import-Module $Path -Force -PassThru -ErrorAction Stop }
        finally { Remove-Module IdentityAtlas -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Set-ManifestVersion' {
    It 'splits a beta into a numeric ModuleVersion and a Prerelease the module still imports with' {
        $psd1 = New-ManifestCopy
        & $script:Script -Path $psd1 -Version '6.2.0-beta.1'

        $module = Import-Stamped $psd1
        $module.Version | Should -Be ([version]'6.2.0')
        $module.PrivateData.PSData.Prerelease | Should -Be 'beta.1'
    }

    It 'keeps the whole label of a release candidate, dots and all' {
        $psd1 = New-ManifestCopy
        & $script:Script -Path $psd1 -Version '7.0.0-rc.12'

        $data = Import-PowerShellDataFile $psd1
        $data.ModuleVersion | Should -Be '7.0.0'
        $data.PrivateData.PSData.Prerelease | Should -Be 'rc.12'
    }

    It 'stamps a release version as given and leaves Prerelease commented out' {
        $psd1 = New-ManifestCopy
        & $script:Script -Path $psd1 -Version '6.1.2.0'

        $module = Import-Stamped $psd1
        $module.Version | Should -Be ([version]'6.1.2.0')
        $module.PrivateData.PSData.Keys | Should -Not -Contain 'Prerelease'
        (Get-Content $psd1 -Raw) | Should -Match "(?m)^\s*# Prerelease = ''"
    }

    It 'clears a Prerelease an earlier stamp left behind when a release is stamped over it' {
        $psd1 = New-ManifestCopy
        & $script:Script -Path $psd1 -Version '6.2.0-beta.3'
        & $script:Script -Path $psd1 -Version '6.2.0.0'

        $data = Import-PowerShellDataFile $psd1
        $data.ModuleVersion | Should -Be '6.2.0.0'
        $data.PrivateData.PSData.Keys | Should -Not -Contain 'Prerelease'
    }

    It 'leaves the rest of the manifest untouched' {
        $psd1 = New-ManifestCopy
        & $script:Script -Path $psd1 -Version '6.2.0-alpha.1'

        $before = (Get-Content $script:Source) -notmatch 'ModuleVersion =|Prerelease ='
        $after  = (Get-Content $psd1) -notmatch 'ModuleVersion =|Prerelease ='
        $after | Should -Be $before
    }

    It 'refuses a version that is not Major.Minor.Patch[-label]' -ForEach @(
        @{ Version = '6.2-beta.1' }, @{ Version = 'v6.2.0-beta.1' }, @{ Version = '6.2.0-' }, @{ Version = '6.2.0-beta_1' }
    ) {
        $psd1 = New-ManifestCopy
        { & $script:Script -Path $psd1 -Version $Version } | Should -Throw '*is not Major.Minor.Patch*'
        (Get-Content $psd1 -Raw) | Should -Be (Get-Content $script:Source -Raw)
    }

    It 'fails loudly when the manifest has no ModuleVersion line' {
        $psd1 = Join-Path $TestDrive 'empty.psd1'
        Set-Content $psd1 "@{ Author = 'x' }"
        { & $script:Script -Path $psd1 -Version '6.2.0-beta.1' } | Should -Throw '*No ModuleVersion line*'
    }

    It 'fails loudly when a beta has no Prerelease line to land in' {
        $psd1 = Join-Path $TestDrive 'noprerelease.psd1'
        Set-Content $psd1 "@{`n    ModuleVersion = '1.0.0.0'`n}"
        { & $script:Script -Path $psd1 -Version '6.2.0-beta.1' } | Should -Throw '*No Prerelease line*'
    }
}
