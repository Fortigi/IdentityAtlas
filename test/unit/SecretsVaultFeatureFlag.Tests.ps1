#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The secrets-vault check must not depend on an earlier step having switched
    risk scoring on.

.DESCRIPTION
    /admin/llm answers 404 while the riskScoring flag is off. The flag used to be
    switched on only by Configure-LLM, which needs an LLM key, so the vault check
    failed on every full integration run without one (Dependabot PRs). The fake
    API below refuses /admin/llm while the flag is off, as the real one does.
#>

BeforeAll {
    $script:vaultScript = Join-Path $PSScriptRoot '..' 'nightly' 'Test-SecretsVault.ps1'

    # The fake's state is global because $script: inside the mock and the callback
    # resolves to Test-SecretsVault.ps1 while that script runs, not to this file.
    # Docker is not needed: the script only uses it for two psql statements.
    function global:docker {
        $sql = [string]$args[-1]
        if ($sql -match '^UPDATE') { return 'UPDATE 1' }
        return 'stored-ciphertext'
    }

    function script:Invoke-VaultScript {
        param([bool]$FlagOn, [switch]$RefuseToggle)
        $global:vaultApi = @{ flag = $FlagOn; refuseToggle = [bool]$RefuseToggle; puts = 0 }
        $global:vaultResults = @{}
        $collect = { param($Name, $Passed, $Detail) $global:vaultResults[$Name] = $Passed }
        & $script:vaultScript -ApiBaseUrl 'http://fake/api' -WriteResult $collect 6>$null
    }
}

AfterAll {
    Remove-Item -Path Function:\docker -ErrorAction SilentlyContinue
    Remove-Variable -Name vaultApi, vaultResults -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Test-SecretsVault.ps1 and the riskScoring flag' {
    BeforeEach {
        Mock Invoke-RestMethod {
            $path = ([string]$Uri).Replace('http://fake/api', '')
            if ($path -eq '/features') { return [pscustomobject]@{ riskScoring = $global:vaultApi.flag } }
            if ($path -eq '/admin/features/toggle') {
                if ($global:vaultApi.refuseToggle) { throw 'toggle refused' }
                $global:vaultApi.flag = ($Body | ConvertFrom-Json).enabled
                return
            }
            if (-not $global:vaultApi.flag) { throw '404 (Not Found)' }
            switch ($path) {
                '/admin/llm/status' { return [pscustomobject]@{ apiKeySet = $true; configured = $true } }
                '/admin/llm/test'   { throw 'decryption failed' }
                default {
                    if ("$Method" -eq 'Put') { $global:vaultApi.puts++ }
                    return [pscustomobject]@{ ok = $true }
                }
            }
        }
    }

    It 'runs every vault check when the flag starts off, then switches it back off' {
        Invoke-VaultScript -FlagOn $false

        foreach ($check in 'Vault/FeatureOn', 'Vault/SaveSecret', 'Vault/KeyIsSet', 'Vault/EncryptionVerified', 'Vault/TamperDetected', 'Vault/Cleanup') {
            $global:vaultResults[$check] | Should -BeTrue -Because "$check must run and pass"
        }
        $global:vaultApi.puts | Should -Be 1
        $global:vaultApi.flag | Should -BeFalse
    }

    It 'leaves the flag on when it was already on' {
        Invoke-VaultScript -FlagOn $true

        $global:vaultResults['Vault/SaveSecret'] | Should -BeTrue
        $global:vaultApi.flag | Should -BeTrue
    }

    It 'reports a refused toggle and saves no secret' {
        Invoke-VaultScript -FlagOn $false -RefuseToggle

        $global:vaultResults['Vault/FeatureOn'] | Should -BeFalse
        $global:vaultResults.ContainsKey('Vault/SaveSecret') | Should -BeFalse
        $global:vaultApi.puts | Should -Be 0
    }

    It 'reports an unreadable feature list and stops' {
        Mock Invoke-RestMethod { throw 'api down' }

        Invoke-VaultScript -FlagOn $false

        $global:vaultResults['Vault/FeatureFlags'] | Should -BeFalse
        $global:vaultResults.ContainsKey('Vault/SaveSecret') | Should -BeFalse
    }
}
