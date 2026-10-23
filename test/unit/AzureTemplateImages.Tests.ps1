#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Which images the Azure template deploys, from where, and that a redeploy of
    an unchanged template changes nothing.

.DESCRIPTION
    Checked against the COMPILED azure/main.json — what the Deploy to Azure
    button and `az deployment` actually run — not the Bicep source.

    1. imageTag pins an exact release for all three images; empty falls back to
       the imageChannel's floating tag. Evaluated, not pattern-matched: the
       template's own _imageTag expression is run by a small ARM-expression
       evaluator below, so a wrong precedence or a swapped branch fails.
    2. containerRegistryResourceId switches all three images to the customer's
       own registry and pulls them with a pull-only identity; without it nothing
       of that is deployed and the images come from ghcr.io.
    3. No parameter defaults to newGuid(): such a default is a new value on every
       deployment, so a redeploy that changed nothing still restarted containers
       (the report generator's API key did exactly that).

.USAGE
    Invoke-Pester -Path test/unit/AzureTemplateImages.Tests.ps1 -Output Detailed
#>

BeforeAll {
    # Evaluates the subset of the ARM template language the image selection uses:
    # string literals and if / not / empty / equals / parameters(). Anything else
    # throws, so a template change that needs more fails loudly here instead of
    # being evaluated wrongly.
    function Invoke-ArmExpression {
        param([Parameter(Mandatory)][string] $Expression, [hashtable] $Parameters = @{})
        $script:src = $Expression.Trim()
        if ($script:src.StartsWith('[') -and $script:src.EndsWith(']')) { $script:src = $script:src.Substring(1, $script:src.Length - 2) }
        $script:pos = 0
        $value = Read-ArmTerm $Parameters
        if ($script:pos -ne $script:src.Length) { throw "Unparsed input at $($script:pos): $($script:src.Substring($script:pos))" }
        return $value
    }
    function Skip-ArmSpace { while ($script:pos -lt $script:src.Length -and $script:src[$script:pos] -eq ' ') { $script:pos++ } }
    function Read-ArmTerm([hashtable] $Parameters) {
        Skip-ArmSpace
        if ($script:src[$script:pos] -eq "'") {
            $sb = [System.Text.StringBuilder]::new(); $script:pos++
            while ($true) {
                $c = $script:src[$script:pos]
                if ($c -eq "'") {
                    if ($script:pos + 1 -lt $script:src.Length -and $script:src[$script:pos + 1] -eq "'") { [void]$sb.Append("'"); $script:pos += 2; continue }
                    $script:pos++; break
                }
                [void]$sb.Append($c); $script:pos++
            }
            return $sb.ToString()
        }
        $start = $script:pos
        while ($script:src[$script:pos] -match '[A-Za-z]') { $script:pos++ }
        $name = $script:src.Substring($start, $script:pos - $start)
        if ($script:src[$script:pos] -ne '(') { throw "Expected '(' after '$name'" }
        $script:pos++
        $fnArgs = @()
        Skip-ArmSpace
        while ($script:src[$script:pos] -ne ')') {
            $fnArgs += , (Read-ArmTerm $Parameters)
            Skip-ArmSpace
            if ($script:src[$script:pos] -eq ',') { $script:pos++ }
        }
        $script:pos++
        switch ($name) {
            'if'         { if ($fnArgs[0]) { return $fnArgs[1] } else { return $fnArgs[2] } }
            'not'        { return -not $fnArgs[0] }
            'empty'      { return [string]::IsNullOrEmpty($fnArgs[0]) }
            'equals'     { return $fnArgs[0] -ceq $fnArgs[1] }
            'parameters' { return $Parameters[$fnArgs[0]] }
            default      { throw "Function '$name' is not supported by this evaluator" }
        }
    }

    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:Template = Get-Content (Join-Path $root 'azure/main.json') -Raw | ConvertFrom-Json
    $script:Module = { param($name) $script:Template.resources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' -and $_.name -eq $name } }

    # Resolves the deployed image tag for a set of inputs, defaults filled in from
    # the template's own parameter defaults — the way ARM fills them.
    $script:ResolveTag = {
        param([hashtable] $Given)
        $params = @{}
        foreach ($p in $script:Template.parameters.PSObject.Properties) { $params[$p.Name] = $p.Value.defaultValue }
        foreach ($k in $Given.Keys) { $params[$k] = $Given[$k] }
        Invoke-ArmExpression $script:Template.variables._imageTag $params
    }

    # The expression a module parameter is set to. Bicep compiles a plain value to
    # { value: <expr> }, but a conditional one to a single string expression that
    # builds that object: "[if(cond, createObject('value', ...), ...)]".
    $script:ParamExpr = {
        param($Module, [string] $Name)
        $v = (& $script:Module $Module).properties.parameters.$Name
        if ($v -is [string]) { $v } else { "$($v.value)" }
    }
}

Describe 'The image version a deployment runs' {

    It 'runs the stable channel by default: the latest release' {
        & $script:ResolveTag @{} | Should -BeExactly 'latest'
    }

    It 'runs the edge channel when asked for it' {
        & $script:ResolveTag @{ imageChannel = 'edge' } | Should -BeExactly 'edge'
    }

    It 'runs exactly the release named in imageTag, whatever the channel says' {
        & $script:ResolveTag @{ imageTag = '6.0.2.0' } | Should -BeExactly '6.0.2.0'
        & $script:ResolveTag @{ imageTag = '6.1.0-beta.1'; imageChannel = 'edge' } | Should -BeExactly '6.1.0-beta.1'
    }

    It 'treats an empty imageTag as not set, so existing deployments keep their channel' {
        & $script:ResolveTag @{ imageTag = ''; imageChannel = 'edge' } | Should -BeExactly 'edge'
        $script:Template.parameters.imageTag.defaultValue | Should -BeExactly ''
    }

    # deploy.ps1 always passes this file. A value for imageTag in it — even an
    # empty one — replaces the template's own default, so a template whose
    # default pins a release would quietly follow the channel instead.
    It 'is not set by the parameters file deploy.ps1 passes by default' {
        $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $file = Get-Content (Join-Path $root 'azure/main.parameters.example.json') -Raw | ConvertFrom-Json
        $file.parameters.PSObject.Properties.Name | Should -Not -Contain 'imageTag'
        $file.parameters.PSObject.Properties.Name | Should -Contain 'imageChannel' -Because 'the check above is only meaningful on the real file'
    }

    It 'gives all three images that same version' -ForEach @(
        @{ Module = 'app-service';              Repo = 'fortigi/identity-atlas' }
        @{ Module = 'aca-app-worker';           Repo = 'fortigi/identity-atlas-worker' }
        @{ Module = 'aca-app-report-generator'; Repo = 'fortigi/identity-atlas-report-generator' }
    ) {
        $image = (& $script:Module $Module).properties.parameters.image.value
        $image | Should -Match ([regex]::Escape("'{0}/$Repo`:{1}'"))
        $image | Should -Match ([regex]::Escape("variables('_imageTag'))]")) -Because 'the tag must be the one resolved above, last argument of the format()'
    }
}

Describe 'Where the images are pulled from' {

    It 'pulls from ghcr.io when no registry is configured' -ForEach @(
        @{ Module = 'app-service' }, @{ Module = 'aca-app-worker' }, @{ Module = 'aca-app-report-generator' }
    ) {
        $image = (& $script:Module $Module).properties.parameters.image.value
        $image | Should -Match ([regex]::Escape("if(variables('privateRegistry'), reference(")) -Because 'a configured registry must replace the host'
        $image | Should -Match ([regex]::Escape(".outputs.loginServer.value, 'ghcr.io')")) -Because 'without one the host stays ghcr.io'
        $script:Template.parameters.containerRegistryResourceId.defaultValue | Should -BeExactly ''
    }

    It 'deploys the pull identity and its AcrPull grant only when a registry is configured' -ForEach @(
        @{ Module = 'registry-pull-identity' }, @{ Module = 'acr-pull-role' }
    ) {
        (& $script:Module $Module).condition | Should -BeExactly "[variables('privateRegistry')]"
        $script:Template.variables.privateRegistry | Should -BeExactly "[not(empty(parameters('containerRegistryResourceId')))]"
    }

    It 'grants AcrPull in the registry''s own subscription and resource group, after the ID was validated' {
        $role = & $script:Module 'acr-pull-role'
        $role.subscriptionId | Should -BeExactly "[variables('_acrIdParts')[2]]"
        $role.resourceGroup | Should -BeExactly "[variables('_acrIdParts')[4]]"
        $role.properties.parameters.registryName.value | Should -BeExactly "[variables('_acrIdParts')[8]]"
        $role.dependsOn | Should -Contain "[resourceId('Microsoft.Resources/deployments', 'bootstrap')]"
    }

    It 'splits a registry resource ID into subscription, resource group and name at those indexes' {
        # The indexes above are only right for this exact ID shape.
        $parts = '/subscriptions/1111/resourceGroups/rg-shared/providers/Microsoft.ContainerRegistry/registries/contosoacr' -split '/'
        $parts[2] | Should -Be '1111'
        $parts[4] | Should -Be 'rg-shared'
        $parts[8] | Should -Be 'contosoacr'
    }

    It 'hands the pull identity to the web app, the worker and the report generator' -ForEach @(
        @{ Module = 'app-service' }, @{ Module = 'aca-app-worker' }, @{ Module = 'aca-app-report-generator' }
    ) {
        & $script:ParamExpr $Module 'pullIdentityId' | Should -Match ([regex]::Escape("'registry-pull-identity'")) -Because 'without it a private registry refuses the pull'
        & $script:ParamExpr $Module 'registryServer' | Should -Match ([regex]::Escape('.outputs.loginServer.value'))
    }
}

Describe 'A redeploy that changes nothing rotates nothing' {

    It 'has no parameter that defaults to a new value on every deployment' {
        $rotating = @($script:Template.parameters.PSObject.Properties |
            Where-Object { "$($_.Value.defaultValue)" -match 'newGuid\(|utcNow\(' } | ForEach-Object Name)
        $rotating | Should -BeNullOrEmpty -Because 'a fresh default per deployment restarts the containers that receive it on every run'
    }

    # The app settings are replaced as a whole on every deployment, so sign-in
    # survives a redeploy only when it is one of the template's own inputs.
    It 'keeps Entra sign-in configured when it is passed to the template' {
        $web = & $script:Module 'app-service'
        $web.properties.parameters.entraTenantId.value | Should -BeExactly "[parameters('entraTenantId')]"
        $web.properties.parameters.entraClientId.value | Should -BeExactly "[parameters('entraClientId')]"
        $settings = ($web.properties.template.resources | Where-Object type -eq 'Microsoft.Web/sites').properties.siteConfig.appSettings
        $settings | Should -Match ([regex]::Escape("createObject('name', 'AUTH_TENANT_ID', 'value', parameters('entraTenantId'))"))
        $settings | Should -Match ([regex]::Escape("createObject('name', 'AUTH_CLIENT_ID', 'value', parameters('entraClientId'))"))
        $script:Template.parameters.entraTenantId.defaultValue | Should -BeExactly '' -Because 'empty keeps the Step 2 path working as before'
    }

    It 'reads the report generator key from Key Vault, where the bootstrap script keeps it' {
        $rg = & $script:Module 'aca-app-report-generator'
        $ref = $rg.properties.template.resources |
            Where-Object { $_.type -eq 'Microsoft.Resources/deployments' } |
            ForEach-Object { $_.properties.parameters.apiKey.reference }
        $ref.secretName | Should -BeExactly 'report-generator-api-key'
        & $script:ParamExpr 'app-service' 'reportGeneratorKeySecretUri' | Should -Match ([regex]::Escape(".outputs.reportGeneratorKeySecretUri.value"))
    }
}

Describe 'The evaluator these tests rely on' {
    # It decides the outcome of the version tests above, so it is pinned too.
    It 'evaluates nested if/not/empty/equals over parameters and string literals' {
        Invoke-ArmExpression "[if(not(empty(parameters('a'))), parameters('a'), if(equals(parameters('b'), 'x'), 'it''s x', 'other'))]" @{ a = ''; b = 'x' } |
            Should -BeExactly "it's x"
        Invoke-ArmExpression "[if(not(empty(parameters('a'))), parameters('a'), 'other')]" @{ a = 'A' } | Should -BeExactly 'A'
    }

    It 'refuses a function it does not know instead of guessing' {
        { Invoke-ArmExpression "[concat('a', 'b')]" } | Should -Throw '*not supported*'
    }
}

Describe 'deploy.ps1 accepts only versions that are published as image tags' {
    BeforeAll {
        $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'azure/deploy.ps1'), [ref]$null, [ref]$null)
        $param = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'ImageTag' }
        $attr = $param.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidatePattern' }
        $script:Pattern = $attr.PositionalArguments[0].Value
    }

    It 'accepts <Tag>' -ForEach @(
        @{ Tag = '' }, @{ Tag = '6.0.2.0' }, @{ Tag = '6.1.0-beta.1' }, @{ Tag = '6.1.0-rc.12' }, @{ Tag = '10.20.30.0' }
    ) {
        $Tag | Should -Match $script:Pattern
    }

    # Each is a plausible slip: the git tag, the version without .0, a channel name,
    # or a beta written with the .0 a release carries.
    It 'rejects <Tag>' -ForEach @(
        @{ Tag = 'v6.0.2' }, @{ Tag = '6.0.2' }, @{ Tag = 'latest' }, @{ Tag = '6.0.2.1' }, @{ Tag = '6.1.0-beta.1.0' }, @{ Tag = ' 6.0.2.0' }
    ) {
        $Tag | Should -Not -Match $script:Pattern
    }
}
