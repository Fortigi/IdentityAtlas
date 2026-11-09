<#
.SYNOPSIS
    Install and import the pinned version of each named module (.ci/powershell-modules.json).

.EXAMPLE
    pwsh tools/psmodules/Install-PinnedModule.ps1 PSComplexity
#>
param([Parameter(Mandatory)][string[]]$Name)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PinnedModules.ps1')

foreach ($module in $Name) {
    Install-PinnedModule -Name $module
    Write-Host "$module $(Get-PinnedModuleVersion -Name $module) installed"
}
