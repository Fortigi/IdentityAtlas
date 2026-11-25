#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The steps of an Azure release-test variant (tools/release/ReleaseTest.AzureFlow.ps1).

.DESCRIPTION
    An Azure install has sign-in on from the first deploy, so:
      - a Step-1-only deployment must be found locked, and a deployment that
        answers data without a token, or is configured already, must fail;
      - after main-auth.json the wait must hold out for the SSO client id,
        not settle for the pre-restart container that still answers;
      - demo data, totals and person-made data go through the Admin caller,
        in the operator's order: Step 1, Step 2, data, then Step 1 + Step 2
        of the candidate.
    Az and HTTP are mocked; each flow test checks the exact sequence of steps.

.USAGE
    Invoke-Pester -Path test/unit/ReleaseTestAzureFlow.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    foreach ($part in 'Functions', 'Docker', 'SignIn', 'CuratedData', 'Azure', 'AzureFlow') {
        . (Join-Path $script:Root "tools/release/ReleaseTest.$part.ps1")
    }
    $script:Ids = @{ TenantId = 'tenant'; SsoClientId = 'sso'; RoleCallerId = 'role'; NoRoleCallerId = 'norole'; AdminCallerId = 'admin' }
    function New-TestContext([string] $Variant, [hashtable] $Ids = $script:Ids) {
        New-AzureRunContext -Variant $Variant -Candidate 'v6.2.0-beta.1' -PreviousStable 'v6.1.1' -Group "ia-reltest-1-1-$Variant" -WorkDir 'w' -RepoAzure 'repo/azure' @Ids
    }
    function New-AuthConfig([bool] $Configured, [string] $ClientId) {
        [pscustomobject]@{ enabled = $true; configured = $Configured; tenantId = $(if ($Configured) { 'tenant' } else { '' }); clientId = $ClientId; platform = 'azure-app-service' }
    }
}

Describe 'New-AzureRunContext' {
    It 'names the missing Admin caller and where to set it up, before anything is deployed' {
        $ids = $script:Ids.Clone(); $ids.Remove('AdminCallerId')
        $err = { New-TestContext 'auth' $ids } | Should -Throw -PassThru
        $err.Exception.Message | Should -Match ([regex]::Escape('-AdminCallerId (RELEASE_TEST_ADMIN_CLIENT_ID)'))
        $err.Exception.Message | Should -Match ([regex]::Escape('docs/contributing/release-process.md'))
        $err.Exception.Message | Should -Not -Match 'NoRoleCallerId'   # only what is missing
    }
    It 'names every missing ID of a sign-in variant' {
        $err = { New-TestContext 'auth-upgrade' @{} } | Should -Throw -PassThru
        foreach ($v in 'AZURE_TENANT_ID', 'RELEASE_TEST_SSO_CLIENT_ID', 'AZURE_CLIENT_ID', 'RELEASE_TEST_NOROLE_CLIENT_ID', 'RELEASE_TEST_ADMIN_CLIENT_ID') {
            $err.Exception.Message | Should -Match $v
        }
    }
    It 'needs no sign-in IDs for a main variant' {
        (New-TestContext 'main-upgrade' @{}).V.Upgrade | Should -BeTrue
    }
    It 'refuses a foreign resource group' {
        { New-AzureRunContext -Variant main -Candidate edge -PreviousStable v6.1.1 -Group 'HRSystem' } | Should -Throw '*Refusing to touch resource group*'
    }
}

Describe 'Locked-down state (Step 1 only)' {
    BeforeEach { Mock Write-Step {} }

    It 'checks the data endpoints and leaves out the public bootstrap ones' {
        $eps = Get-AzureLockedEndpoint
        foreach ($p in '/users?limit=1', '/admin/status', '/permissions?userLimit=1') { $eps | Should -Contain $p }
        foreach ($p in '/auth-config', '/version', '/features', '/openapi.json') { $eps | Should -Not -Contain $p }
    }
    It 'passes when sign-in is on, not configured, and every data endpoint answers 401' {
        Mock Invoke-Api { New-AuthConfig $false '' } -ParameterFilter { $Path -eq '/auth-config' }
        Mock Get-HttpStatus { 401 }
        { Assert-LockedDown -BaseUrl 'https://x/api' -Label 'fresh' } | Should -Not -Throw
        Should -Invoke Get-HttpStatus -Times (Get-AzureLockedEndpoint).Count -Exactly
        Should -Invoke Get-HttpStatus -Times 1 -Exactly -ParameterFilter { $Url -eq 'https://x/api/users?limit=1' -and -not $Token }
    }
    It 'fails when one data endpoint answers 200 without a token' {
        Mock Invoke-Api { New-AuthConfig $false '' } -ParameterFilter { $Path -eq '/auth-config' }
        Mock Get-HttpStatus { if ($Url -like '*/users?limit=1') { 200 } else { 401 } }
        $err = { Assert-LockedDown -BaseUrl 'https://x/api' -Label 'fresh' } | Should -Throw -PassThru
        $err.Exception.Message | Should -Match ([regex]::Escape('/users?limit=1 answered 200 without a token, expected 401'))
        $err.Exception.Message | Should -Not -Match 'admin/status'
    }
    It 'fails when sign-in is already configured' {
        Mock Invoke-Api { New-AuthConfig $true 'sso' } -ParameterFilter { $Path -eq '/auth-config' }
        Mock Get-HttpStatus { 401 }
        { Assert-LockedDown -BaseUrl 'https://x/api' -Label 'fresh' } | Should -Throw "*already configured (client 'sso')*"
    }
    It 'fails when sign-in is off' {
        Get-LockedDownProblem -AuthConfig ([pscustomobject]@{ enabled = $false; configured = $false }) -Status ([ordered]@{ '/users' = 401 }) |
            Should -BeLike 'sign-in is not on*'
    }
    It 'reports an endpoint that did not answer (0) as a problem' {
        @(Get-LockedDownProblem -AuthConfig (New-AuthConfig $false '') -Status ([ordered]@{ '/users' = 401; '/tags' = 0 })) |
            Should -Be @('/tags answered 0 without a token, expected 401')
    }
}

Describe 'Wait-SignIn' {
    BeforeEach {
        Mock Start-Sleep {}
        Mock Wait-SchemaReady {}
    }
    It 'keeps waiting past the pre-restart container and a wrong client until the SSO client is reported' {
        $script:Answers = [Collections.Queue]::new(@((New-AuthConfig $false ''), (New-AuthConfig $true 'other'), (New-AuthConfig $true 'sso')))
        Mock Invoke-Api { $script:Answers.Dequeue() } -ParameterFilter { $Path -eq '/auth-config' }
        Wait-SignIn -BaseUrl 'https://x/api' -SsoClientId 'sso' -TimeoutSec 60
        Should -Invoke Invoke-Api -Times 3 -Exactly -ParameterFilter { $Path -eq '/auth-config' }
        Should -Invoke Wait-SchemaReady -Times 1 -Exactly
    }
    It 'times out, and does not go on to schemaReady, when the client never matches' {
        Mock Invoke-Api { New-AuthConfig $true 'other' } -ParameterFilter { $Path -eq '/auth-config' }
        { Wait-SignIn -BaseUrl 'https://x/api' -SsoClientId 'sso' -TimeoutSec 0 } | Should -Throw '*Timed out*configured for client sso*'
        Should -Invoke Wait-SchemaReady -Times 0 -Exactly
    }
}

Describe 'Wait-Release' {
    BeforeEach {
        Mock Start-Sleep {}
        Mock Wait-SchemaReady {}
        Mock Assert-RunningVersion {}
    }
    It 'for edge over a release, waits until the version is no longer the old one' {
        $script:Versions = [Collections.Queue]::new(@('6.1.1.0', '6.1.1.0', '6.3.20261118.1200'))
        Mock Invoke-Api { [pscustomobject]@{ version = $script:Versions.Dequeue() } } -ParameterFilter { $Path -eq '/version' }
        Wait-Release -BaseUrl 'https://x/api' -Ref edge -Replacing v6.1.1
        Should -Invoke Invoke-Api -Times 3 -Exactly -ParameterFilter { $Path -eq '/version' }
        Should -Invoke Wait-SchemaReady -Times 1 -Exactly
    }
    It 'checks the pinned version and nothing more on a fresh deploy' {
        Mock Invoke-Api { throw 'not expected' } -ParameterFilter { $Path -eq '/version' }
        Wait-Release -BaseUrl 'https://x/api' -Ref v6.2.0-beta.1
        Should -Invoke Assert-RunningVersion -Times 1 -Exactly -ParameterFilter { $ImageTag -eq '6.2.0-beta.1' }
    }
}

Describe 'The variants, step by step' {
    BeforeEach {
        $script:Log = [Collections.Generic.List[string]]::new()
        $script:TokenRound = 0
        Mock Write-Step {}
        Mock Get-AzureTemplateDir { "t/$Ref" }
        Mock Invoke-ReleaseTestDeployment {
            $script:Log.Add("deploy $Name $($TemplateFile -replace '\\', '/')")
            [pscustomobject]@{ appHostname = [pscustomobject]@{ value = 'idatlas-x-web.azurewebsites.net' } }
        }
        Mock Wait-Release { $script:Log.Add("wait-release $Ref$(if ($Replacing) { " over $Replacing" })") }
        Mock Assert-LockedDown { $script:Log.Add("locked: $Label") }
        Mock Wait-SignIn { $script:Log.Add("wait-signin $SsoClientId") }
        Mock Get-SignInToken {
            $script:TokenRound++
            $script:Log.Add("tokens admin=$AdminCallerId")
            @{ 'admin' = "ADMIN$($script:TokenRound)"; 'role' = 'R'; 'no-role' = 'N'; 'other-audience' = 'O'; 'none' = ''; 'garbage' = 'g' }
        }
        Mock Assert-AuthConfig { $script:Log.Add("auth-config $SsoClientId") }
        Mock Invoke-SignInCheck { $script:Log.Add("signin-checks admin=$($Tokens['admin'])"); @() }
        Mock Invoke-DemoLoad { $script:Log.Add("demo $Token") }
        Mock Invoke-SmokeTest { $script:Log.Add("smoke $Token"); @() }
        Mock Get-ApiTotal { $script:Log.Add("totals $Token"); @{ Users = 40; Resources = 90; Matrix = 40 } }
        Mock New-CuratedData { $script:Log.Add("curated-make $Token"); @{ Ids = @{}; Expected = [ordered]@{}; ReadToken = 'fgr_x' } }
        Mock Assert-CuratedData { $script:Log.Add("curated-check $Token") }
        Mock Assert-ReportGeneratorDeployed { $script:Log.Add('report-generator') }
    }

    It 'auth-upgrade: previous Step 1 + 2, data as Admin, candidate Step 1 (locked) + 2, then the same data as a fresh Admin token' {
        Invoke-AzureUpgrade (New-TestContext 'auth-upgrade')
        $script:Log | Should -Be @(
            'deploy previous-main t/v6.1.1/main.json'
            'wait-release v6.1.1'
            'locked: previous, after main.json'
            'deploy previous-auth t/v6.1.1/main-auth.json'
            'wait-signin sso'
            'tokens admin=admin'
            'demo ADMIN1'
            'totals ADMIN1'
            'curated-make ADMIN1'
            'deploy candidate-main t/v6.2.0-beta.1/main.json'
            'wait-release v6.2.0-beta.1 over v6.1.1'
            'locked: candidate, after main.json'
            'deploy candidate-auth t/v6.2.0-beta.1/main-auth.json'
            'wait-signin sso'
            'auth-config sso'
            'tokens admin=admin'
            'signin-checks admin=ADMIN2'
            'totals ADMIN2'
            'curated-check ADMIN2'
        )
    }
    It 'auth-upgrade fails when the totals differ after the upgrade' {
        $script:Calls = 0
        Mock Get-ApiTotal { $script:Calls++; @{ Users = $(if ($script:Calls -eq 1) { 40 } else { 39 }); Resources = 90; Matrix = 40 } }
        { Invoke-AzureUpgrade (New-TestContext 'auth-upgrade') } | Should -Throw '*After the upgrade: Users changed from 40 to 39*'
        Should -Invoke Assert-CuratedData -Times 0 -Exactly
    }
    It 'auth-upgrade refuses to compare against a previous release without users' {
        Mock Get-ApiTotal { @{ Users = 0; Resources = 0; Matrix = 0 } }
        { Invoke-AzureUpgrade (New-TestContext 'auth-upgrade') } | Should -Throw '*previous release shows no users*'
        Should -Invoke Invoke-ReleaseTestDeployment -Times 0 -Exactly -ParameterFilter { $Name -like 'candidate-*' }
    }
    It 'main-upgrade: Step 1 twice, locked both times, no data and no tokens' {
        Invoke-AzureUpgrade (New-TestContext 'main-upgrade' @{})
        $script:Log | Should -Be @(
            'deploy previous-main t/v6.1.1/main.json'
            'wait-release v6.1.1'
            'locked: previous, after main.json'
            'deploy candidate-main t/v6.2.0-beta.1/main.json'
            'wait-release v6.2.0-beta.1 over v6.1.1'
            'locked: candidate, after main.json'
        )
    }
    It 'auth-rg: Step 1 (locked), Step 2, sign-in checks, demo data and reads as Admin, report generator' {
        Invoke-AzureFresh (New-TestContext 'auth-rg')
        $script:Log | Should -Be @(
            'deploy fresh-main t/v6.2.0-beta.1/main.json'
            'wait-release v6.2.0-beta.1'
            'locked: fresh, after main.json'
            'deploy fresh-auth t/v6.2.0-beta.1/main-auth.json'
            'wait-signin sso'
            'auth-config sso'
            'tokens admin=admin'
            'signin-checks admin=ADMIN1'
            'demo ADMIN1'
            'smoke ADMIN1'
            'totals ADMIN1'
            'report-generator'
        )
    }
    It 'auth fails when the Admin caller cannot read every smoke endpoint' {
        Mock Invoke-SmokeTest { @('/admin/status -> 403') }
        { Invoke-AzureFresh (New-TestContext 'auth') } | Should -Throw '*Admin caller: /admin/status -> 403*'
    }
    It 'main: Step 1 and the lock, nothing loaded, no report generator' {
        Invoke-AzureFresh (New-TestContext 'main' @{})
        $script:Log | Should -Be @('deploy fresh-main t/v6.2.0-beta.1/main.json', 'wait-release v6.2.0-beta.1', 'locked: fresh, after main.json')
    }
    It 'main-rg also checks the report generator' {
        Invoke-AzureFresh (New-TestContext 'main-rg' @{})
        $script:Log[-1] | Should -Be 'report-generator'
    }
    It 'passes the SSO app to main-auth.json and the report-generator switch to main.json' {
        Invoke-AzureFresh (New-TestContext 'auth-rg')
        Should -Invoke Invoke-ReleaseTestDeployment -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'fresh-auth' -and ($ParametersJson | ConvertFrom-Json).parameters.entraClientId.value -eq 'sso' -and
            ($ParametersJson | ConvertFrom-Json).parameters.entraTenantId.value -eq 'tenant' -and $Group -eq 'ia-reltest-1-1-auth-rg'
        }
        Should -Invoke Invoke-ReleaseTestDeployment -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'fresh-main' -and ($ParametersJson | ConvertFrom-Json).parameters.deployReportGenerator.value -eq $true
        }
    }
}

Describe 'Get-AzureTemplateDir' {
    It 'uses this checkout for edge' { Get-AzureTemplateDir (New-TestContext 'main' @{}) 'edge' | Should -Be 'repo/azure' }
    It 'reuses a release package it already unpacked' {
        $ctx = New-TestContext 'main' @{}
        $ctx.TemplateDirs['v6.1.1'] = 'w/v6.1.1/azure'
        Get-AzureTemplateDir $ctx 'v6.1.1' | Should -Be 'w/v6.1.1/azure'
    }
}

Describe 'Assert-ReportGeneratorDeployed' {
    It 'passes for a provisioned report-generator app' {
        Mock Invoke-Az { @([pscustomobject]@{ name = 'idatlas-x-worker'; properties = [pscustomobject]@{ provisioningState = 'Failed' } }, [pscustomobject]@{ name = 'idatlas-x-report-generator'; properties = [pscustomobject]@{ provisioningState = 'Succeeded' } }) }
        { Assert-ReportGeneratorDeployed (New-TestContext 'main-rg' @{}) } | Should -Not -Throw
        Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq 'containerapp list --resource-group ia-reltest-1-1-main-rg' }
    }
    It 'fails when it is missing, or not provisioned' {
        Mock Invoke-Az { @([pscustomobject]@{ name = 'idatlas-x-worker'; properties = [pscustomobject]@{ provisioningState = 'Succeeded' } }) }
        { Assert-ReportGeneratorDeployed (New-TestContext 'main-rg' @{}) } | Should -Throw '*no report-generator*'
        Mock Invoke-Az { @([pscustomobject]@{ name = 'idatlas-x-report-generator'; properties = [pscustomobject]@{ provisioningState = 'Failed' } }) }
        { Assert-ReportGeneratorDeployed (New-TestContext 'main-rg' @{}) } | Should -Throw "*is 'Failed'*"
    }
    It 'refuses a foreign group before calling az' {
        Mock Invoke-Az { throw 'az must not be called' }
        { Assert-ReportGeneratorDeployed @{ Group = 'HRSystem' } } | Should -Throw '*Refusing to touch resource group*'
        Should -Invoke Invoke-Az -Times 0 -Exactly
    }
}
