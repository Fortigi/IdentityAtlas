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

Describe 'the report generator IP allow-list reaches az through a parameters file' {
    # Inline JSON does not survive Windows: `az` is a batch wrapper there, cmd.exe eats
    # the double quotes out of `name=["1.2.3.4/32"]`, and az refuses what is left with
    # "Failed to parse string as JSON". Observed on a real deployment with 20 outbound
    # addresses — the deployment never started. A parameters file is read by az itself.
    BeforeAll {
        $root     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $azureDir = Join-Path $root 'azure'
        $script:DeployText = Get-Content (Join-Path $azureDir 'deploy.ps1') -Raw
        $bicep = Get-Content (Join-Path $azureDir 'main.bicep') -Raw
        $script:DeclaredParams = [regex]::Matches($bicep, '(?m)^param\s+([A-Za-z_]\w*)\s') |
            ForEach-Object { $_.Groups[1].Value }

        # The writer itself, lifted out of the script: the script cannot be dot-sourced
        # (it deploys), so the function is taken from its syntax tree and defined here.
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $azureDir 'deploy.ps1'), [ref]$null, [ref]$null)
        $fn = $ast.Find({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Name -eq 'New-CallerIpsParameterFile' }, $true)
        $fn | Should -Not -BeNullOrEmpty -Because 'the test drives the real writer, not a copy'
        . ([scriptblock]::Create($fn.Extent.Text))

        $script:WriteParams = {
            param([string[]]$Cidrs)
            $path = New-CallerIpsParameterFile -Cidrs $Cidrs -Directory $TestDrive
            $json = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            Remove-Item -LiteralPath $path -Force
            return $json
        }
    }

    It 'writes the addresses as a JSON array az accepts' {
        $json = & $script:WriteParams @('20.1.2.3/32', '4.5.6.7/32')
        $json.contentVersion | Should -Be '1.0.0.0'
        $json.'$schema' | Should -Match 'deploymentParameters\.json'
        , $json.parameters.reportGeneratorAllowedCallerIps.value | Should -BeOfType [array]
        $json.parameters.reportGeneratorAllowedCallerIps.value | Should -Be @('20.1.2.3/32', '4.5.6.7/32')
    }

    It 'keeps one address an array, which the template requires' {
        $json = & $script:WriteParams @('20.1.2.3/32')
        , $json.parameters.reportGeneratorAllowedCallerIps.value | Should -BeOfType [array]
        @($json.parameters.reportGeneratorAllowedCallerIps.value).Count | Should -Be 1
    }

    It 'names a parameter main.bicep declares' {
        'reportGeneratorAllowedCallerIps' | Should -BeIn $script:DeclaredParams
    }

    It 'hands az the file and never an inline JSON array' {
        $script:DeployText | Should -Match '--parameters., "@\$callerIpsFile"'
        $script:DeployText | Should -Not -Match 'reportGeneratorAllowedCallerIps=\$\(ConvertTo-Json'
    }

    It 'deletes the temporary file even when the deployment fails' {
        $script:DeployText | Should -Match 'finally\s*\{[^}]*Remove-Item -LiteralPath \$callerIpsFile'
    }
}

Describe 'an Azure deployment made before the Key Vault password change stays updatable' {
    # The template reads the Postgres password with kvRef.getSecret(). ARM resolves that
    # during preflight, before it updates anything, so the template cannot switch
    # template access on for its own vault: updating a deployment created earlier fails
    # at submission with KeyVaultParameterReferenceSecretRetrieveFailed ("Access denied
    # to first party service"). Seen on a real deployment from May 2026. deploy.ps1
    # therefore settles the flag, and the secret, before deploying.
    BeforeAll {
        $root    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $deploy  = Join-Path $root 'azure/deploy.ps1'
        $script:DeployText = Get-Content $deploy -Raw
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($deploy, [ref]$null, [ref]$null)
        foreach ($name in 'Get-VaultsMissingTemplateAccess', 'New-PostgresPassword') {
            $fn = $ast.Find({ param($n)
                $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
            $fn | Should -Not -BeNullOrEmpty -Because "the test drives $name from the script itself"
            . ([scriptblock]::Create($fn.Extent.Text))
        }
    }

    It 'picks exactly the vaults whose template access is off' {
        $json = @'
[{"name":"old-vault","templateDeployment":false},
 {"name":"new-vault","templateDeployment":true},
 {"name":"unknown-vault","templateDeployment":null}]
'@
        Get-VaultsMissingTemplateAccess -VaultListJson $json | Should -Be @('old-vault', 'unknown-vault')
    }

    It 'asks for nothing when every vault already allows it, or the group has none' {
        Get-VaultsMissingTemplateAccess -VaultListJson '[{"name":"new-vault","templateDeployment":true}]' | Should -BeNullOrEmpty
        Get-VaultsMissingTemplateAccess -VaultListJson '[]' | Should -BeNullOrEmpty
        Get-VaultsMissingTemplateAccess -VaultListJson '' | Should -BeNullOrEmpty
        Get-VaultsMissingTemplateAccess -VaultListJson '   ' | Should -BeNullOrEmpty
    }

    It 'generates a password Postgres accepts, and a different one every time' {
        $passwords = 1..25 | ForEach-Object { New-PostgresPassword }
        foreach ($p in $passwords) {
            $p.Length | Should -Be 35
            $p | Should -Match '^[A-Za-z0-9]+$'
            $p | Should -MatchExactly '[A-Z]'
            $p | Should -MatchExactly '[a-z]'
            $p | Should -MatchExactly '[0-9]'
        }
        ($passwords | Select-Object -Unique).Count | Should -Be 25
    }

    It 'settles the vault before the deployment is submitted, not after' {
        $initialize = $script:DeployText.IndexOf('Initialize-ExistingVault -ResourceGroup')
        $submit     = $script:DeployText.IndexOf('az @deployArgs')
        $initialize | Should -BeGreaterThan 0
        $submit | Should -BeGreaterThan $initialize -Because 'ARM resolves the Key Vault reference at submission'
    }
}
