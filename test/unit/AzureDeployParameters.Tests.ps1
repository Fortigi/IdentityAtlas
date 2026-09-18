#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Every template parameter the Azure CLI deploy path hands to main.bicep must
    actually be declared by main.bicep.

.DESCRIPTION
    `az deployment group create` rejects the whole deployment client-side with
    "unrecognized template parameter '<name>'" when it is handed a name the
    template does not declare -- nothing is deployed. Both callers are checked:
      1. azure/deploy.ps1                   -- inline "name=$Value" --parameters args
      2. azure/main.parameters.example.json -- the default parameters file

    Catches: a param turned into a var, renamed, or removed in main.bicep while a
    caller still passes it (issue #1085: namePrefix/location became vars).

.USAGE
    Invoke-Pester -Path test/unit/AzureDeployParameters.Tests.ps1 -Output Detailed
#>

BeforeDiscovery {
    $root     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $azureDir = Join-Path $root 'azure'

    # Inline "--parameters name=$Value" arguments in the CLI wrapper.
    $deploy = Get-Content (Join-Path $azureDir 'deploy.ps1') -Raw
    $passed = [regex]::Matches($deploy, '"([A-Za-z_]\w*)=\$') |
        ForEach-Object { @{ Name = $_.Groups[1].Value; Source = 'azure/deploy.ps1' } }

    # Keys of the parameters file deploy.ps1 passes with '@'.
    $file = Get-Content (Join-Path $azureDir 'main.parameters.example.json') -Raw | ConvertFrom-Json
    $passed += $file.parameters.PSObject.Properties.Name |
        ForEach-Object { @{ Name = $_; Source = 'azure/main.parameters.example.json' } }

    $script:PassedParams = $passed
}

Describe 'Azure CLI deploy passes only parameters main.bicep declares' {

    BeforeAll {
        # Re-computed at execution time — BeforeDiscovery's $script: scope is discarded before the
        # run phase starts; only -ForEach-bound values survive from discovery into a plain It block.
        $root     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $azureDir = Join-Path $root 'azure'

        $bicep = Get-Content (Join-Path $azureDir 'main.bicep') -Raw
        $script:Declared = [regex]::Matches($bicep, '(?m)^param\s+([A-Za-z_]\w*)\s') |
            ForEach-Object { $_.Groups[1].Value }

        $deploy = Get-Content (Join-Path $azureDir 'deploy.ps1') -Raw
        $passed = [regex]::Matches($deploy, '"([A-Za-z_]\w*)=\$') |
            ForEach-Object { @{ Name = $_.Groups[1].Value; Source = 'azure/deploy.ps1' } }

        $file = Get-Content (Join-Path $azureDir 'main.parameters.example.json') -Raw | ConvertFrom-Json
        $passed += $file.parameters.PSObject.Properties.Name |
            ForEach-Object { @{ Name = $_; Source = 'azure/main.parameters.example.json' } }

        $script:PassedParams = $passed
    }

    # Guards against a vacuous green: if either regex stops matching, the
    # -ForEach set empties out and every real assertion below disappears.
    It 'parses main.bicep parameter declarations' {
        $script:Declared | Should -Contain 'sizeProfile'
        $script:Declared | Should -Contain 'imageChannel'
    }

    It 'parses the inline parameters deploy.ps1 passes' {
        ($script:PassedParams | Where-Object { $_.Source -eq 'azure/deploy.ps1' }).Name |
            Should -Contain 'sizeProfile'
    }

    It 'parses the keys of main.parameters.example.json' {
        ($script:PassedParams | Where-Object { $_.Source -eq 'azure/main.parameters.example.json' }).Name.Count |
            Should -BeGreaterThan 0
    }

    It "<Source> passes '<Name>', declared by main.bicep" -ForEach $script:PassedParams {
        $Name | Should -BeIn $script:Declared -Because 'az aborts the deployment on an unknown template parameter (#1085)'
    }
}

Describe 'deploy.ps1 can be run by Windows PowerShell 5.1' {
    # 5.1 reads a .ps1 without a byte-order mark as ANSI, not UTF-8. This script's
    # box-drawing characters and arrows then decode into other characters — and the
    # third byte of "→" (0x92) becomes a typographic quote, which the parser treats as
    # a string delimiter: "The string is missing the terminator". The script would not
    # start at all, on the one shell a Windows operator has without installing
    # anything. A BOM (or pure ASCII) fixes it; PowerShell 7 is happy with either.
    BeforeAll {
        $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $script:DeployBytes = [System.IO.File]::ReadAllBytes((Join-Path $root 'azure/deploy.ps1'))
    }

    It 'is read as UTF-8 by every shell: a BOM, or no character that needs one' {
        $hasBom = $script:DeployBytes.Length -ge 3 -and
            $script:DeployBytes[0] -eq 0xEF -and $script:DeployBytes[1] -eq 0xBB -and $script:DeployBytes[2] -eq 0xBF
        $nonAscii = @($script:DeployBytes | Where-Object { $_ -gt 127 }).Count
        ($hasBom -or $nonAscii -eq 0) | Should -BeTrue -Because 'without a BOM, Windows PowerShell 5.1 fails to parse the non-ASCII characters'
    }

    It 'actually contains the characters that need the BOM, so the check above is not vacuous' {
        @($script:DeployBytes | Where-Object { $_ -gt 127 }).Count | Should -BeGreaterThan 0
    }
}
