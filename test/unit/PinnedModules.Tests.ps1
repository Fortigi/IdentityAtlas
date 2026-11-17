#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }
<#
.SYNOPSIS
    tools/psmodules/PinnedModules.ps1 -- the one place CI's PowerShell Gallery
    modules are pinned, and what the weekly updater proposes.

.DESCRIPTION
    The guard at the end is the reason the pin file exists: PSComplexity's version
    was once written in four places and PSMutant's in three, and they drifted
    (#1556). It fails on an Install-Module of a pinned module with its own version
    anywhere in CI, the tools or the docs.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'psmodules' 'PinnedModules.ps1')

    function New-TestManifest {
        @{ modules = [ordered]@{
                Alpha = [ordered]@{ version = '1.2.0' }
                Beta  = [ordered]@{ version = '0.5.0'; skip = [ordered]@{ '0.9.1' = 'refuses the run'; '1.1.0' = 'later regression' } }
            } }
    }
}

Describe 'Select-PinnedModuleUpdate' {
    It 'proposes the newest version above the pin' {
        Select-PinnedModuleUpdate -Pinned '0.5.1' -Available '0.5.1', '0.7.1', '0.6.0', '0.5.2' | Should -Be '0.7.1'
    }

    It 'compares versions numerically, not as text' {
        # As text '0.10.0' sorts below '0.9.0'; a string compare would propose 0.9.0.
        Select-PinnedModuleUpdate -Pinned '0.8.0' -Available '0.9.0', '0.10.0' | Should -Be '0.10.0'
    }

    It 'proposes nothing when the pin is already the newest' {
        Select-PinnedModuleUpdate -Pinned '0.7.1' -Available '0.7.1', '0.7.0' | Should -BeNullOrEmpty
    }

    It 'never proposes a version below the pin' {
        Select-PinnedModuleUpdate -Pinned '2.0.0' -Available '1.9.9' | Should -BeNullOrEmpty
    }

    It 'passes over a skipped version to the newest one that is not' {
        Select-PinnedModuleUpdate -Pinned '0.5.0' -Available '0.9.0', '0.9.1' -Skip '0.9.1' | Should -Be '0.9.0'
    }

    It 'proposes nothing when the only newer version is skipped' {
        Select-PinnedModuleUpdate -Pinned '0.5.0' -Available '0.5.0', '0.9.1' -Skip '0.9.1' | Should -BeNullOrEmpty
    }

    It 'passes over every version below a "<" bound' {
        Select-PinnedModuleUpdate -Pinned '0.5.0' -Available '0.6.0', '0.9.0', '0.9.1' -Skip '<0.9.2' | Should -BeNullOrEmpty
    }

    It 'takes the bound itself: "<0.9.2" does not skip 0.9.2' {
        Select-PinnedModuleUpdate -Pinned '0.5.0' -Available '0.9.1', '0.9.2' -Skip '<0.9.2' | Should -Be '0.9.2'
    }

    It 'ignores a prerelease' {
        Select-PinnedModuleUpdate -Pinned '0.5.0' -Available '0.9.2-preview1', '0.6.0' | Should -Be '0.6.0'
    }
}

Describe 'Set-PinnedModuleVersion' {
    It 'moves only the named module' {
        $m = Set-PinnedModuleVersion -Manifest (New-TestManifest) -Name Alpha -Version '1.3.0'
        $m.modules.Alpha.version | Should -Be '1.3.0'
        $m.modules.Beta.version | Should -Be '0.5.0'
    }

    It 'drops the skips the move has passed and keeps the ones above it' {
        $m = Set-PinnedModuleVersion -Manifest (New-TestManifest) -Name Beta -Version '1.0.0'
        @($m.modules.Beta.skip.Keys) | Should -Be @('1.1.0')
    }

    It 'drops a skip at exactly the new version' {
        $m = Set-PinnedModuleVersion -Manifest (New-TestManifest) -Name Beta -Version '1.1.0'
        $m.modules.Beta.Contains('skip') | Should -BeFalse -Because 'an emptied skip map is removed, not left as {}'
    }

    It 'drops a "<" bound once the pin reaches it, and not before' {
        $m = New-TestManifest
        $m.modules.Beta.skip = [ordered]@{ '<0.9.2' = 'psm1 hand-over' }
        (Set-PinnedModuleVersion -Manifest $m -Name Beta -Version '0.9.0').modules.Beta.skip.Keys | Should -Be @('<0.9.2')
        (Set-PinnedModuleVersion -Manifest $m -Name Beta -Version '0.9.2').modules.Beta.Contains('skip') | Should -BeFalse
    }

    It 'refuses a module that is not pinned' {
        { Set-PinnedModuleVersion -Manifest (New-TestManifest) -Name Gamma -Version '1.0.0' } | Should -Throw '*Gamma is not pinned*'
    }
}

Describe 'Get-PinnedModuleVersion' {
    It 'reads the pin' {
        Get-PinnedModuleVersion -Name Beta -Manifest (New-TestManifest) | Should -Be '0.5.0'
    }

    It 'refuses a module that is not pinned rather than installing whatever is newest' {
        { Get-PinnedModuleVersion -Name Gamma -Manifest (New-TestManifest) } | Should -Throw '*Gamma is not pinned*'
    }
}

Describe 'Get-PinnedModuleUpdate' {
    BeforeAll {
        Mock Find-Module {
            $versions = @{ Alpha = '1.2.0', '1.1.0'; Beta = '0.5.0', '0.9.1', '1.0.0', '1.1.0' }["$Name"]  # -Name binds as string[]
            $versions | ForEach-Object { [pscustomobject]@{ Name = $Name; Version = [version]$_ } }
        }
    }

    It 'reports only the modules that are behind' {
        $updates = @(Get-PinnedModuleUpdate -Manifest (New-TestManifest))
        $updates.Name | Should -Be @('Beta')
    }

    It 'reports the move and the skip reasons it makes obsolete' {
        $u = Get-PinnedModuleUpdate -Manifest (New-TestManifest)
        $u.From | Should -Be '0.5.0'
        $u.To | Should -Be '1.0.0' -Because '1.1.0 is skipped'
        $u.Spent | Should -Be @('0.9.1 -- refuses the run')
    }

    It 'asks the gallery for every version, not just the latest' {
        $null = Get-PinnedModuleUpdate -Manifest (New-TestManifest)
        Should -Invoke Find-Module -Times 2 -Exactly -ParameterFilter { $AllVersions -and $Repository -eq 'PSGallery' }
    }
}

Describe 'ConvertTo-PinnedModuleJson' {
    It 'writes LF line endings and a trailing newline on every OS' {
        $json = ConvertTo-PinnedModuleJson -Manifest (New-TestManifest)
        $json | Should -Not -Match "`r"
        $json | Should -Match "`n$"
    }

    It 'round-trips through Read-PinnedModuleManifest' {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) "pins-$([guid]::NewGuid().ToString('N')).json"
        try {
            [System.IO.File]::WriteAllText($path, (ConvertTo-PinnedModuleJson -Manifest (New-TestManifest)))
            $back = Read-PinnedModuleManifest -Path $path
            $back.modules.Beta.skip['0.9.1'] | Should -Be 'refuses the run'
        }
        finally { Remove-Item $path -ErrorAction SilentlyContinue }
    }
}

Describe 'Install-PinnedModule' {
    BeforeAll {
        Mock Install-Module {}
        Mock Import-Module {}
    }

    It 'installs and imports exactly the pinned version when it is missing' {
        Mock Get-Module {}
        Install-PinnedModule -Name Beta -Manifest (New-TestManifest)
        Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter { $Name -eq 'Beta' -and $RequiredVersion -eq '0.5.0' }
        Should -Invoke Import-Module -Times 1 -Exactly -ParameterFilter { $RequiredVersion -eq '0.5.0' }
    }

    It 'does not reinstall when the pinned version is already there, even beside newer ones' {
        Mock Get-Module { [pscustomobject]@{ Version = [version]'0.9.1' }, [pscustomobject]@{ Version = [version]'0.5.0' } }
        Install-PinnedModule -Name Beta -Manifest (New-TestManifest)
        Should -Invoke Install-Module -Times 0 -Exactly
        Should -Invoke Import-Module -Times 1 -Exactly -ParameterFilter { $RequiredVersion -eq '0.5.0' }
    }

    It 'installs the pin when only a newer version is present' {
        Mock Get-Module { [pscustomobject]@{ Version = [version]'0.9.1' } }
        Install-PinnedModule -Name Beta -Manifest (New-TestManifest)
        Should -Invoke Install-Module -Times 1 -Exactly
    }
}

Describe 'The pin file is the only place a version is written' {
    BeforeAll {
        $script:manifest = Read-PinnedModuleManifest -Path (Get-PinnedModuleManifestPath -Root $script:repoRoot)
        $script:names = @($script:manifest.modules.Keys)
        $roots = '.github', 'tools', 'docs', 'test', 'setup' | ForEach-Object { Join-Path $script:repoRoot $_ }
        $script:files = @(Get-ChildItem $roots -Recurse -File -Include *.yml, *.yaml, *.ps1, *.psm1, *.md, *.sh |
                # This file is excluded: its last test spells out the lines the guard must catch.
                Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.Name -ne 'PinnedModules.Tests.ps1' }) +
            @(Get-Item (Join-Path $script:repoRoot 'CONTRIBUTING.md'))
    }

    It 'pins the modules CI uses' {
        $script:names | Should -Contain 'PSComplexity'
        $script:names | Should -Contain 'PSMutant'
    }

    It 'every pinned version is a plain stable version' {
        foreach ($n in $script:names) {
            $script:manifest.modules[$n].version | Should -Match '^\d+\.\d+\.\d+$' -Because "$n's pin"
        }
    }

    It 'every skip is a version or a "<" bound' {
        foreach ($n in $script:names) {
            $skip = $script:manifest.modules[$n].skip
            if ($skip) { foreach ($v in $skip.Keys) { $v | Should -Match '^<?\d+\.\d+\.\d+$' -Because "$n skip '$v'" } }
        }
    }

    It 'every skip carries a reason' {
        foreach ($n in $script:names) {
            $skip = $script:manifest.modules[$n].skip
            if ($skip) { foreach ($v in $skip.Keys) { $skip[$v] | Should -Match '\S{3}' -Because "$n skip $v needs its reason" } }
        }
    }

    It 'nothing installs a pinned module at a version of its own' {
        $rx = "Install-Module\s+(-Name\s+)?($($script:names -join '|'))\b[^\r\n]*-(Required|Minimum|Maximum)Version"
        $offenders = foreach ($f in $script:files) {
            Select-String -LiteralPath $f.FullName -Pattern $rx | ForEach-Object {
                "$([System.IO.Path]::GetRelativePath($script:repoRoot, $f.FullName)):$($_.LineNumber)"
            }
        }
        $offenders | Should -BeNullOrEmpty -Because 'install through tools/psmodules/Install-PinnedModule.ps1 so the version lives only in .ci/powershell-modules.json'
    }

    It 'the guard would catch one' {
        # Without this the test above passes just as well when its pattern matches nothing.
        $rx = "Install-Module\s+(-Name\s+)?($($script:names -join '|'))\b[^\r\n]*-(Required|Minimum|Maximum)Version"
        'Install-Module PSMutant -RequiredVersion 0.5.0 -Force' | Should -Match $rx
        'Install-Module -Name PSComplexity -MinimumVersion 0.5.1' | Should -Match $rx
    }
}
