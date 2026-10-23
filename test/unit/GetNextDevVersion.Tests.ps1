#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    main's dev-build version follows the major of the newest release tag.

.DESCRIPTION
    tools/release/Get-NextDevVersion.ps1 runs in bump-version.yml on every PR
    merge. Before it existed, Major was read from the .psd1 only, and main stayed
    on 5.x after v6.0.0 shipped.

.USAGE
    Invoke-Pester -Path test/unit/GetNextDevVersion.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:Script = Join-Path $root 'tools/release/Get-NextDevVersion.ps1'
    $script:Now = [datetime]'2026-10-23T14:05:00'
}

Describe 'Get-NextDevVersion' {
    It 'increments Minor and stamps the time when no tag is ahead' {
        & $script:Script -CurrentVersion '6.41.20261022.1333' -Tags 'v6.0.3', 'v5.9.2' -Now $script:Now |
            Should -Be '6.42.20261023.1405'
    }

    It 'moves to the release major and restarts Minor when a newer major is tagged' {
        & $script:Script -CurrentVersion '5.835.20261022.1333' -Tags 'v5.9.2', 'v6.0.3', 'v6.0.0' -Now $script:Now |
            Should -Be '6.1.20261023.1405'
    }

    It 'takes the highest major among several newer tags, not the last one listed' {
        & $script:Script -CurrentVersion '5.835.20261022.1333' -Tags 'v7.0.0', 'v6.0.3' -Now $script:Now |
            Should -Be '7.1.20261023.1405'
    }

    It 'counts a pre-release of the next major, cut from main' {
        & $script:Script -CurrentVersion '6.90.20261022.1333' -Tags 'v6.0.3', 'v7.0.0-beta.1' -Now $script:Now |
            Should -Be '7.1.20261023.1405'
    }

    It 'reads tags as git ls-remote prints them (refs/tags/ prefix)' {
        & $script:Script -CurrentVersion '5.835.20261022.1333' -Tags 'refs/tags/v6.0.3' -Now $script:Now |
            Should -Be '6.1.20261023.1405'
    }

    It 'never lowers Major when the .psd1 is ahead of every tag' {
        & $script:Script -CurrentVersion '7.3.20261022.1333' -Tags 'v6.0.3' -Now $script:Now |
            Should -Be '7.4.20261023.1405'
    }

    It 'ignores tags that are not vMajor.Minor.Patch' {
        & $script:Script -CurrentVersion '6.41.20261022.1333' -Tags 'v9', 'release-9.0.0', 'v9.x.0' -Now $script:Now |
            Should -Be '6.42.20261023.1405'
    }

    It 'works with no tags at all' {
        & $script:Script -CurrentVersion '6.41.20261022.1333' -Now $script:Now |
            Should -Be '6.42.20261023.1405'
    }

    It 'refuses a version that is not four numeric parts' {
        { & $script:Script -CurrentVersion '6.0.3' -Now $script:Now } | Should -Throw '*not Major.Minor.Build.Revision*'
    }
}
