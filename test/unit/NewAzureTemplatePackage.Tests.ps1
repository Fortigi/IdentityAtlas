#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The Azure template package a release ships deploys THAT release's images.

.DESCRIPTION
    tools/release/New-AzureTemplatePackage.ps1 runs in every cut workflow. These
    tests run it against the repository's real azure/ folder (so a change to the
    template that breaks the stamp fails here, not during a release) and against
    small fixtures for the edge cases.

.USAGE
    Invoke-Pester -Path test/unit/NewAzureTemplatePackage.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:Script = Join-Path $root 'tools/release/New-AzureTemplatePackage.ps1'
    $script:AzureDir = Join-Path $root 'azure'

    # Packages $AzureDir for $Version and returns the unpacked azure/ folder.
    $script:Package = {
        param([string] $Version, [string] $AzureDir = $script:AzureDir)
        $work = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $zip = Join-Path $work 'pkg.zip'
        & $script:Script -Version $Version -AzureDir $AzureDir -OutFile $zip | Out-Null
        if (-not (Test-Path $zip)) { return $null }
        Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'out')
        Join-Path $work 'out/azure'
    }

    # A minimal template pair in the compiled layout Bicep writes.
    $script:Fixture = {
        param([string] $BicepParam, [string] $JsonParams)
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content (Join-Path $dir 'main.bicep') "targetScope = 'resourceGroup'`n$BicepParam`n"
        Set-Content (Join-Path $dir 'main.json') "{`n  `"parameters`": {`n$JsonParams`n  }`n}"
        $dir
    }
}

Describe 'Packaging the repository''s Azure template' {

    It 'pins a release: imageTag defaults to X.Y.Z.0 in main.bicep and main.json' {
        $out = & $script:Package '6.0.2.0'
        (Get-Content (Join-Path $out 'main.json') -Raw | ConvertFrom-Json).parameters.imageTag.defaultValue | Should -BeExactly '6.0.2.0'
        Get-Content (Join-Path $out 'main.bicep') -Raw | Should -Match ([regex]::Escape("param imageTag string = '6.0.2.0'"))
    }

    It 'pins a pre-release under its own tag, without the .0 a release carries' {
        $out = & $script:Package '6.1.0-beta.2'
        (Get-Content (Join-Path $out 'main.json') -Raw | ConvertFrom-Json).parameters.imageTag.defaultValue | Should -BeExactly '6.1.0-beta.2'
    }

    It 'changes nothing else in the compiled template' {
        $out = & $script:Package '6.0.2.0'
        $shipped = Get-Content (Join-Path $out 'main.json') -Raw | ConvertFrom-Json
        $source = Get-Content (Join-Path $script:AzureDir 'main.json') -Raw | ConvertFrom-Json
        $shipped.parameters.imageTag.defaultValue = ''
        ($shipped | ConvertTo-Json -Depth 100) | Should -BeExactly ($source | ConvertTo-Json -Depth 100)
    }

    It 'ships everything a deployment needs: modules, the CLI wrapper and the auth step' {
        $out = & $script:Package '6.0.2.0'
        foreach ($f in 'deploy.ps1', 'main-auth.bicep', 'main-auth.json', 'main.parameters.example.json', 'modules/app-service.bicep', 'modules/bootstrap.bicep') {
            Join-Path $out $f | Should -Exist
        }
        Get-Content (Join-Path $out 'RELEASE') -Raw | Should -BeExactly "6.0.2.0`n"
    }

    It 'leaves the repository''s own template unstamped, for the Deploy to Azure button' {
        & $script:Package '6.0.2.0' | Out-Null
        (Get-Content (Join-Path $script:AzureDir 'main.json') -Raw | ConvertFrom-Json).parameters.imageTag.defaultValue | Should -BeExactly ''
    }

    It 'refuses a version that is not an image tag: <Version>' -ForEach @(
        @{ Version = 'v6.0.2' }, @{ Version = '6.0.2' }, @{ Version = 'latest' }, @{ Version = '6.1.0-beta.1.0' }
    ) {
        { & $script:Script -Version $Version -OutFile (Join-Path $TestDrive 'x.zip') } | Should -Throw
    }
}

Describe 'Templates the stamp cannot be applied to' {

    It 'writes no package, and does not fail the release, for a template from before imageTag existed' {
        $dir = & $script:Fixture "param imageChannel string = 'stable'" '    "imageChannel": { "type": "string", "defaultValue": "stable" }'
        $zip = Join-Path $TestDrive 'old.zip'
        { & $script:Script -Version '6.0.3.0' -AzureDir $dir -OutFile $zip -WarningAction SilentlyContinue } | Should -Not -Throw
        $zip | Should -Not -Exist
    }

    It 'stops when main.json was not rebuilt after main.bicep gained imageTag' {
        $dir = & $script:Fixture "param imageTag string = ''" '    "imageChannel": { "type": "string", "defaultValue": "stable" }'
        { & $script:Script -Version '6.0.3.0' -AzureDir $dir -OutFile (Join-Path $TestDrive 'y.zip') } | Should -Throw '*found 1 and 0*'
    }

    It 'stops when the template already pins a version, instead of shipping the wrong one' {
        $dir = & $script:Fixture "param imageTag string = '5.9.1.0'" "    `"imageTag`": {`n      `"type`": `"string`",`n      `"defaultValue`": `"5.9.1.0`"`n    }"
        { & $script:Script -Version '6.0.3.0' -AzureDir $dir -OutFile (Join-Path $TestDrive 'z.zip') } | Should -Throw '*found 0 and 0*'
    }
}
