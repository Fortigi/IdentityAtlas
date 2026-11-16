<#
.SYNOPSIS
    Azure steps of the release test. Dot-source after ReleaseTest.Functions.ps1.

.DESCRIPTION
    The release test deploys into the IIDemos subscription, which also holds
    resource groups that have nothing to do with it. One rule keeps it out of
    those: every resource group it creates, deploys into, lists or deletes has
    a name that starts with `ia-reltest-`. Assert-ReleaseTestGroupName is the
    only gate, every function below that names a group calls it first, and
    test/unit/ReleaseTestAzure.Tests.ps1 proves both the filter and that no
    `az group`/`az deployment group` call in this file bypasses it.

    One resource group per variant per run, deleted at the end. Never reused:
    the Key Vault has purge protection on and its name derives from the
    resource group id, so a reused group would collide with last night's
    soft-deleted vault.
#>

Set-StrictMode -Version Latest

$script:GroupPrefix = 'ia-reltest-'
$script:GroupTag = 'purpose=ia-release-test'

# Variant -> what it deploys. Upgrade = previous stable's template first, then
# the candidate's over it in the same group, data kept.
$script:AzureVariants = [ordered]@{
    'main'          = @{ SignIn = $false; ReportGenerator = $false; Upgrade = $false }
    'main-rg'       = @{ SignIn = $false; ReportGenerator = $true; Upgrade = $false }
    'auth'          = @{ SignIn = $true; ReportGenerator = $false; Upgrade = $false }
    'auth-rg'       = @{ SignIn = $true; ReportGenerator = $true; Upgrade = $false }
    'main-upgrade'  = @{ SignIn = $false; ReportGenerator = $false; Upgrade = $true }
    'auth-upgrade'  = @{ SignIn = $true; ReportGenerator = $false; Upgrade = $true }
}

function Test-ReleaseTestGroupName {
    <#
    .SYNOPSIS
        True only for a name this test may touch.
    .DESCRIPTION
        Ordinal and case-sensitive on purpose: the test only ever creates
        lower-case names, so `IA-RELTEST-x` or `HRSystem` are someone else's.
        Something must follow the prefix, and only the characters this test
        uses are allowed, so no clever name sneaks through a looser match.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowNull()][AllowEmptyString()][string] $Name)
    if (-not $Name) { return $false }
    return $Name.StartsWith($script:GroupPrefix, [StringComparison]::Ordinal) -and
        ($Name -cmatch '^ia-reltest-[a-z0-9][a-z0-9-]{0,78}$')   # 90 characters at most, Azure's limit
}

function Assert-ReleaseTestGroupName {
    [CmdletBinding()]
    param([AllowNull()][AllowEmptyString()][string] $Name)
    if (-not (Test-ReleaseTestGroupName $Name)) {
        throw "Refusing to touch resource group '$Name': the release test only touches groups named $($script:GroupPrefix)*."
    }
}

function New-ReleaseTestGroupName {
    <# ia-reltest-<run id>-<attempt>-<variant>: unique per run, so a group is never reused. #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string] $RunId,
        [Parameter(Mandatory)][string] $Attempt,
        [Parameter(Mandatory)][string] $Variant
    )
    $name = "$($script:GroupPrefix)$RunId-$Attempt-$Variant"
    Assert-ReleaseTestGroupName $name
    $name
}

function Get-AzureVariant {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string] $Name)
    if (-not $script:AzureVariants.Contains($Name)) { throw "Unknown Azure variant '$Name'. Known: $($script:AzureVariants.Keys -join ', ')." }
    $script:AzureVariants[$Name]
}

function Get-AzureVariantName {
    [CmdletBinding()]
    [OutputType([string[]])]
    param()
    @($script:AzureVariants.Keys)
}

function Select-StaleReleaseTestGroup {
    <#
    .SYNOPSIS
        From `az group list` output, the release-test groups older than $MaxAgeHours.
    .DESCRIPTION
        A group qualifies only when its name passes the gate AND its createdAt
        tag is a date older than the limit. A group without a readable
        createdAt is left alone: it is not old enough to prove it is ours to
        delete, and the next night will see it again.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [object[]] $Groups = @(),
        [Parameter(Mandatory)][datetime] $Now,
        [int] $MaxAgeHours = 24
    )
    $stale = foreach ($g in $Groups) {
        $name = Get-Prop $g 'name'
        if (-not (Test-ReleaseTestGroupName $name)) { continue }
        $created = Get-Prop (Get-Prop $g 'tags') 'createdAt'
        $when = [datetime]::MinValue
        if (-not $created -or -not [datetime]::TryParse($created, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$when)) { continue }
        if ($when -lt $Now.ToUniversalTime().AddHours(-$MaxAgeHours)) { $name }
    }
    @($stale)
}

function Get-DeploymentParameter {
    <#
    .SYNOPSIS
        The ARM parameters for one deployment, as the JSON parameters file
        `az deployment group create --parameters @file` reads.
    .DESCRIPTION
        xs is the cheapest profile (about EUR 45/month; the test pays for an
        hour). A release template is pinned to its own images through the
        imageTag default New-AzureTemplatePackage.ps1 stamps in, so only edge,
        which has no package, sets imageChannel.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $ImageTag, [switch] $ReportGenerator)
    $p = [ordered]@{
        sizeProfile           = @{ value = 'xs' }
        deployReportGenerator = @{ value = [bool]$ReportGenerator }
    }
    if ($ImageTag -eq 'edge') { $p.imageChannel = @{ value = 'edge' } } else { $p.imageTag = @{ value = $ImageTag } }
    [ordered]@{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = $p
    } | ConvertTo-Json -Depth 5
}

function Invoke-Az {
    <#
    .SYNOPSIS
        az <args> -o json, parsed; throws with az's own message on failure.
    .DESCRIPTION
        Pass only --long flags: an advanced function takes a short flag such as
        -d or -v as its own -Debug / -Verbose (a test checks every call).
    #>
    [CmdletBinding()]
    param([Parameter(ValueFromRemainingArguments)][string[]] $Arguments)
    $out = & az @Arguments --only-show-errors -o json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "az $($Arguments[0..1] -join ' ') failed:`n$($out -join "`n")" }
    $text = ($out | Where-Object { $_ -is [string] }) -join "`n"
    if ($text.Trim()) { return $text | ConvertFrom-Json }
    return $null
}

function New-ReleaseTestGroup {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string] $Name, [string] $Location = 'westeurope', [string] $RunUrl = '')
    Assert-ReleaseTestGroupName $Name
    if (-not $PSCmdlet.ShouldProcess($Name, 'create resource group')) { return }
    $created = (Get-Date).ToUniversalTime().ToString('o')
    Invoke-Az group create --name $Name --location $Location --tags $script:GroupTag "createdAt=$created" "run=$RunUrl" | Out-Null
}

function Remove-ReleaseTestGroup {
    <# Starts the deletion and returns: deleting a group takes minutes and nothing waits for it. #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string] $Name)
    Assert-ReleaseTestGroupName $Name
    if (-not $PSCmdlet.ShouldProcess($Name, 'delete resource group')) { return }
    $exists = Invoke-Az group exists --name $Name
    if ($exists -eq $true) { Invoke-Az group delete --name $Name --yes --no-wait | Out-Null }
}

function Get-StaleReleaseTestGroup {
    <# Lists only groups carrying the release-test tag (filtered by Azure), then the name gate again. #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([int] $MaxAgeHours = 24)
    $groups = @(Invoke-Az group list --tag $script:GroupTag)
    Select-StaleReleaseTestGroup -Groups $groups -Now (Get-Date) -MaxAgeHours $MaxAgeHours
}

function Invoke-ReleaseTestDeployment {
    <# One ARM deployment into a release-test group; returns its outputs. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Group,
        [Parameter(Mandatory)][string] $TemplateFile,
        [Parameter(Mandatory)][string] $ParametersJson,
        [Parameter(Mandatory)][string] $Name
    )
    Assert-ReleaseTestGroupName $Group
    $file = Join-Path ([IO.Path]::GetTempPath()) "$Name.parameters.json"
    Set-Content -Path $file -Value $ParametersJson -Encoding utf8
    $result = Invoke-Az deployment group create --resource-group $Group --name $Name --template-file $TemplateFile --parameters "@$file"
    Get-Prop (Get-Prop $result 'properties') 'outputs'
}

function Get-AppApiUrl {
    <# https://<appHostname>/api from a deployment's outputs. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Outputs)
    $hostName = Get-Prop (Get-Prop $Outputs 'appHostname') 'value'
    if (-not $hostName) { throw 'The deployment returned no appHostname output.' }
    "https://$hostName/api"
}
