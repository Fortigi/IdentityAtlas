$Author = "Wim van den Heijkant"
$Company = "Fortigi"
$Copyright = "(c) 2026 Wim van den Heijkant / Fortigi. Licensed under the MIT License."
$Description = "PowerShell Module to assist with scripting against the Microsoft Graph. The sources for this module, including versioning can be found on GitHub: https://github.com/Fortigi/FortigiGraph"

$VersionMajor = "2"
$VersionMinor = "1"
$Version = $VersionMajor + "." + $VersionMinor + "." + (Get-Date -Format "yyyyMMdd") + "." + (Get-Date -Format "HHmm")

$Path = "C:\Source\Fortigi\GitHub\FortigiGraph"

Set-Location $Path

# Module manifest parameters
$manifestParams = @{
    Path = '.\IdentityAtlas.psd1'
    Author = $Author
    CompanyName = $Company
    Copyright = $Copyright
    ModuleVersion = $Version
    Description = $Description
    RootModule = '.\IdentityAtlas.psm1'
    Tags = @('MicrosoftGraph', 'Graph', 'AzureAD', 'EntraID', 'SQL', 'Azure', 'IdentityGovernance')
    LicenseUri = 'https://github.com/Fortigi/FortigiGraph/blob/main/LICENSE'
    ProjectUri = 'https://github.com/Fortigi/FortigiGraph'
}

New-ModuleManifest @manifestParams

Write-Host "Please provide API Key"
$APIKey = Read-Host -MaskInput

Publish-Module -Path $Path -NuGetApiKey $APIKey