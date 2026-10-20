#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    No Key Vault parameter reference in the compiled Azure templates may be
    resolvable at preflight.

.DESCRIPTION
    Bicep's getSecret() compiles to a nested-deployment parameter of the form
    { "reference": { "keyVault": { "id": <expr> }, "secretName": ... } }.
    When <expr> can be evaluated before the deployment starts, ARM resolves the
    reference during PREFLIGHT VALIDATION. If the vault is created by the same
    deployment it does not exist yet, and the whole deployment is rejected with
    KeyVaultParameterReferenceNotFound ("The specified KeyVault ... could not be
    found"). Redeploys over an existing vault pass, so this is invisible unless
    someone installs fresh — v6.0.0 shipped that way and broke the README's
    Deploy to Azure button for every new install.

    The rule checked here: the vault ID must be built from a parameter of the
    enclosing nested template, and the parent must fill that parameter from a
    runtime value (a reference(...) — i.e. a module output). Anything else
    (constants, variables(), resourceGroup(), or a top-level parameter) is known
    at preflight.

.USAGE
    Invoke-Pester -Path test/unit/AzureKeyVaultReferences.Tests.ps1 -Output Detailed
#>

BeforeAll {
    # Walks a compiled ARM template and returns one entry per Key Vault parameter
    # reference, with Preflight = $true when ARM could resolve it before deploying.
    # $RuntimeParams = names of THIS template's parameters that its parent fills
    # from a runtime expression (empty for the top-level template).
    function Get-KeyVaultReferences {
        param(
            [Parameter(Mandatory)] $Template,
            [string[]] $RuntimeParams = @(),
            [string] $Path = '<root>'
        )
        foreach ($res in @($Template.resources)) {
            if ($res.type -ne 'Microsoft.Resources/deployments') { continue }
            $name = "$Path/$($res.name)"
            $params = $res.properties.parameters
            $childRuntime = @()
            if ($params) {
                foreach ($p in $params.PSObject.Properties) {
                    $kvId = $p.Value.reference.keyVault.id
                    if ($kvId) {
                        $usedParams = [regex]::Matches($kvId, "parameters\('([^']+)'\)") |
                            ForEach-Object { $_.Groups[1].Value }
                        $runtime = @($usedParams).Count -gt 0 -and
                            @($usedParams | Where-Object { $_ -notin $RuntimeParams }).Count -eq 0
                        [pscustomobject]@{
                            Deployment = $name
                            Parameter  = $p.Name
                            VaultId    = $kvId
                            Preflight  = -not $runtime
                        }
                    }
                    elseif ("$($p.Value.value)" -match 'reference\(') {
                        $childRuntime += $p.Name
                    }
                }
            }
            if ($res.properties.template) {
                Get-KeyVaultReferences -Template $res.properties.template -RuntimeParams $childRuntime -Path $name
            }
        }
    }

    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:MainRefs = @(Get-KeyVaultReferences -Template (
        Get-Content (Join-Path $root 'azure/main.json') -Raw | ConvertFrom-Json))
    $script:AuthRefs = @(Get-KeyVaultReferences -Template (
        Get-Content (Join-Path $root 'azure/main-auth.json') -Raw | ConvertFrom-Json))
}

Describe 'Key Vault references in the compiled Azure templates' {

    # The v6.0.0 shape, reduced: the vault is named statically at the top level.
    It 'flags a reference whose vault ID is a static top-level name' {
        $tpl = @'
{ "resources": [ { "type": "Microsoft.Resources/deployments", "name": "postgres",
  "properties": { "parameters": { "adminPassword": { "reference": {
    "keyVault": { "id": "[resourceId('Microsoft.KeyVault/vaults', variables('kvName'))]" },
    "secretName": "postgres-admin-password" } } }, "template": { "resources": [] } } } ] }
'@ | ConvertFrom-Json
        $refs = @(Get-KeyVaultReferences -Template $tpl)
        $refs.Count | Should -Be 1
        $refs[0].Preflight | Should -BeTrue
    }

    # A top-level parameter is known at preflight too — not a way around the rule.
    It 'flags a reference built from a top-level parameter' {
        $tpl = @'
{ "resources": [ { "type": "Microsoft.Resources/deployments", "name": "postgres",
  "properties": { "parameters": { "adminPassword": { "reference": {
    "keyVault": { "id": "[resourceId('Microsoft.KeyVault/vaults', parameters('kvName'))]" },
    "secretName": "s" } } }, "template": { "resources": [] } } } ] }
'@ | ConvertFrom-Json
        @(Get-KeyVaultReferences -Template $tpl)[0].Preflight | Should -BeTrue
    }

    It 'accepts a reference built from a parameter the parent fills with a module output' {
        $tpl = @'
{ "resources": [ { "type": "Microsoft.Resources/deployments", "name": "wrapper",
  "properties": {
    "parameters": { "keyVaultName": { "value": "[reference(resourceId('Microsoft.Resources/deployments', 'key-vault'), '2022-09-01').outputs.kvName.value]" } },
    "template": { "resources": [ { "type": "Microsoft.Resources/deployments", "name": "postgres-server",
      "properties": { "parameters": { "adminPassword": { "reference": {
        "keyVault": { "id": "[resourceId('Microsoft.KeyVault/vaults', parameters('keyVaultName'))]" },
        "secretName": "s" } } }, "template": { "resources": [] } } } ] } } } ] }
'@ | ConvertFrom-Json
        $refs = @(Get-KeyVaultReferences -Template $tpl)
        $refs.Count | Should -Be 1
        $refs[0].Preflight | Should -BeFalse
    }

    # Guards against a vacuous green: main.json does pass the Postgres password this way.
    It 'finds the Postgres password reference in azure/main.json' {
        @($script:MainRefs | Where-Object Parameter -eq 'adminPassword').Count | Should -Be 1
    }

    It 'azure/main.json has no reference ARM resolves at preflight' {
        $bad = @($script:MainRefs | Where-Object Preflight |
            ForEach-Object { "$($_.Deployment) -> $($_.Parameter): $($_.VaultId)" })
        $bad | Should -BeNullOrEmpty -Because 'a fresh install fails with KeyVaultParameterReferenceNotFound before the vault exists'
    }

    It 'azure/main-auth.json has no reference ARM resolves at preflight' {
        @($script:AuthRefs | Where-Object Preflight) | Should -BeNullOrEmpty
    }
}
