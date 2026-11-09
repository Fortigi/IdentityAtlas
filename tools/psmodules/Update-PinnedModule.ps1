<#
.SYNOPSIS
    The PowerShell Gallery half of ps-module-updates.yml.

.DESCRIPTION
    -List prints, as JSON, every pinned module the gallery has a newer usable version
    of. -Name with -Version moves that one pin in .ci/powershell-modules.json. The
    workflow does the git and pull-request half.

.EXAMPLE
    pwsh tools/psmodules/Update-PinnedModule.ps1 -List
    pwsh tools/psmodules/Update-PinnedModule.ps1 -Name PSMutant -Version 0.9.2
#>
[CmdletBinding(DefaultParameterSetName = 'List')]
param(
    [Parameter(ParameterSetName = 'List')][switch]$List,
    [Parameter(Mandatory, ParameterSetName = 'Set')][string]$Name,
    [Parameter(Mandatory, ParameterSetName = 'Set')][string]$Version
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PinnedModules.ps1')

if ($PSCmdlet.ParameterSetName -eq 'List') {
    ConvertTo-Json -InputObject @(Get-PinnedModuleUpdate) -Depth 3 -Compress
    return
}

$path = Get-PinnedModuleManifestPath
$manifest = Set-PinnedModuleVersion -Manifest (Read-PinnedModuleManifest -Path $path) -Name $Name -Version $Version
[System.IO.File]::WriteAllText($path, (ConvertTo-PinnedModuleJson -Manifest $manifest))
