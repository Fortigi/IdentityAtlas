#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The "Next steps" azure/deploy.ps1 prints after a deployment tell the operator
    what the deployment actually needs next.

.DESCRIPTION
    Sign-in is on from the first deploy (AUTH_ENABLED=true in
    azure/modules/app-service.bicep), and somebody without an app role sees no
    data. The script used to end with "(Optional) Admin -> Authentication to
    enable Entra ID sign-in": an operator following it opened an app they could
    not get into, looking for a switch that is read-only on Azure.

    deploy.ps1 is run here for real, with `az` replaced by a function that
    answers the calls the script makes. No Azure, no network.

.USAGE
    Invoke-Pester -Path test/unit/AzureDeployNextSteps.Tests.ps1 -Output Detailed
#>

Describe 'azure/deploy.ps1 next steps' {

    BeforeAll {
        $script:Root   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $script:Deploy = Join-Path $script:Root 'azure/deploy.ps1'

        # Runs deploy.ps1 against a fake az and returns what it printed, plus the
        # az calls it made. $ProvisioningState is what the deployment "returns".
        function Invoke-FakeDeploy {
            param([string]$ProvisioningState = 'Succeeded')

            $global:FakeAzCalls = [System.Collections.Generic.List[string]]::new()
            $global:FakeAzState = $ProvisioningState
            function global:az {
                $line = $args -join ' '
                $global:FakeAzCalls.Add($line)
                $global:LASTEXITCODE = 0
                if ($line -like 'account show*') { return '{"name":"Contoso","id":"00000000-0000-0000-0000-000000000001"}' }
                if ($line -like 'group show*')   { return '{"name":"ia-test"}' }
                if ($line -like 'deployment group create*') {
                    return @{
                        properties = @{
                            provisioningState = $global:FakeAzState
                            outputs = @{
                                appUrl              = @{ value = 'https://idatlas-abc1234-web.azurewebsites.net' }
                                appHostname         = @{ value = 'idatlas-abc1234-web.azurewebsites.net' }
                                namePrefixUsed      = @{ value = 'idatlas-abc1234' }
                                keyVaultUri         = @{ value = 'https://idatlas-abc1234-kv.vault.azure.net/' }
                                postgresFqdn        = @{ value = 'idatlas-abc1234-pg.postgres.database.azure.com' }
                                sizeProfileApplied  = @{ value = 's' }
                                logAnalyticsCreated = @{ value = $true }
                            }
                        }
                    } | ConvertTo-Json -Depth 6
                }
            }
            try {
                # A child scope (&), so the script's variables do not leak; 6>&1 captures Write-Host.
                $lines = & $script:Deploy -ResourceGroup 'ia-test' 6>&1 | ForEach-Object { "$_" }
            }
            finally {
                Remove-Item function:global:az -ErrorAction SilentlyContinue
            }
            $calls = @($global:FakeAzCalls)
            Remove-Variable -Name FakeAzCalls, FakeAzState -Scope Global -ErrorAction SilentlyContinue
            [pscustomobject]@{ Lines = @($lines); Calls = $calls }
        }

        $script:Run   = Invoke-FakeDeploy
        $start        = [array]::IndexOf($script:Run.Lines, ($script:Run.Lines | Where-Object { $_ -match 'Next steps:' } | Select-Object -First 1))
        $script:Steps = @($script:Run.Lines[$start..($script:Run.Lines.Count - 1)])
        $script:Text  = $script:Steps -join "`n"
    }

    It 'ran the deployment through the fake az, not a real one' {
        @($script:Run.Calls | Where-Object { $_ -like 'deployment group create*' }).Count | Should -Be 1
        ($script:Run.Lines -join "`n") | Should -Match '=== Deployment succeeded ==='
    }

    It 'prints the next steps last, starting with the App URL the deployment returned' {
        $script:Steps.Count | Should -BeGreaterThan 3
        $script:Steps[1] | Should -BeLike '  1. Open https://idatlas-abc1234-web.azurewebsites.net *'
    }

    It 'does not call Entra ID sign-in optional or something to enable in the app' {
        $script:Text | Should -Not -Match '(?i)optional'
        $script:Text | Should -Not -Match 'Admin . Authentication'
        $script:Text | Should -Not -Match '(?i)to enable Entra ID sign-in'
    }

    It 'says sign-in is required and names the setup page the operator lands on' {
        $script:Text | Should -Match 'Sign-in is required from the first deploy'
        $script:Text | Should -Match "'Entra ID setup required'"
    }

    It 'names the three things to do: register the app, create and assign the Admin role, fill in the IDs' {
        $step2 = ($script:Steps | Where-Object { $_ -match '^\s+2\. ' })
        $step2 | Should -Match 'register an Entra app \(SPA redirect URI = the App URL\)'
        $step2 | Should -Match "create the 'Admin' app role"
        $script:Text | Should -Match 'assign it to yourself'
        $script:Text | Should -Match 'AUTH_TENANT_ID / AUTH_CLIENT_ID on the Web App'
    }

    It 'puts setting up sign-in before using the Admin tab' {
        $signIn   = [array]::IndexOf($script:Steps, ($script:Steps | Where-Object { $_ -match 'Set up Entra ID sign-in' } | Select-Object -First 1))
        $crawlers = [array]::IndexOf($script:Steps, ($script:Steps | Where-Object { $_ -match 'Admin . Crawlers' } | Select-Object -First 1))
        $signIn   | Should -BeGreaterThan 0
        $crawlers | Should -BeGreaterThan $signIn
        $script:Steps[$crawlers] | Should -BeLike '  3. Sign in, then *'
    }

    It 'points at a walkthrough page that exists in the repository' {
        $script:Text -match 'Walkthrough \(Steps 2 and 3\): (\S+\.md)' | Should -BeTrue
        Join-Path $script:Root $Matches[1] | Should -Exist
    }

    It 'names the role, the setup page and the settings as the product spells them' {
        # The words the next steps borrow from elsewhere; a rename there must reach this output.
        Get-Content (Join-Path $script:Root 'app/ui/src/auth/AuthGateProvider.jsx') -Raw |
            Should -Match '>Entra ID setup required<'
        $bicep = Get-Content (Join-Path $script:Root 'azure/modules/app-service.bicep') -Raw
        $bicep | Should -Match "name: 'AUTH_ENABLED', value: 'true'"
        $bicep | Should -Match "name: 'AUTH_TENANT_ID'"
        $bicep | Should -Match "name: 'AUTH_CLIENT_ID'"
        Get-Content (Join-Path $script:Root 'app/api/src/auth/permissions.js') -Raw |
            Should -Match "Admin:\s*\[\s*'\*'\s*\]"
    }
}
