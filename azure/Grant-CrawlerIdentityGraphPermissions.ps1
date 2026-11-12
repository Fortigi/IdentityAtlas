<#
.SYNOPSIS
    Grants the Identity Atlas crawler identity the Microsoft Graph read
    permissions the Entra ID crawler needs.

.DESCRIPTION
    The Azure deployment creates a user-assigned managed identity
    (<prefix>-mi-crawler) that an Entra ID crawler can sign in with instead of an
    app registration's client secret. The deployment gives that identity NO
    permissions: granting a managed identity Microsoft Graph application
    permissions needs a directory administrator and cannot be done in the Azure
    Portal. This script does it, with the Azure CLI session you are signed in with.

    It grants read-only application permissions only — the same list the crawler
    wizard checks and docs/sync/entra-id.md documents. Running it again is safe:
    permissions the identity already holds are skipped.

    You need to be signed in (`az login`) to the tenant the deployment lives in as
    a Privileged Role Administrator or Global Administrator.

    A managed identity's token is cached by Azure. Grant the permissions BEFORE the
    first crawl or wizard validation and they work straight away; granted
    afterwards, they can take an hour or more to show up.

.PARAMETER ResourceGroup
    The resource group Identity Atlas was deployed to. The script finds the
    crawler identity (<prefix>-mi-crawler) in it.

.PARAMETER PrincipalId
    Object (principal) ID of the crawler identity — the deployment output
    `crawlerIdentityPrincipalId`. Use this instead of -ResourceGroup when you
    know it.

.EXAMPLE
    ./Grant-CrawlerIdentityGraphPermissions.ps1 -ResourceGroup ia-prod

.EXAMPLE
    ./Grant-CrawlerIdentityGraphPermissions.ps1 -PrincipalId 11111111-2222-3333-4444-555555555555 -WhatIf
#>

[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'ByResourceGroup')]
Param(
    [Parameter(Mandatory, ParameterSetName = 'ByResourceGroup')]
    [string]$ResourceGroup,

    [Parameter(Mandatory, ParameterSetName = 'ByPrincipalId')]
    [string]$PrincipalId
)

$ErrorActionPreference = 'Stop'

# The Microsoft Graph application permissions the Entra ID crawler reads with.
# Keep in step with GRAPH_PERMISSION_MAP in tools/crawlers/entra-id/discover.js —
# test/unit/GrantCrawlerIdentityGraphPermissions.Tests.ps1 fails when they differ.
#region GraphPermissions
$GraphPermissions = @(
    'User.Read.All'
    'Group.Read.All'
    'GroupMember.Read.All'
    'Directory.Read.All'
    'Application.Read.All'
    'PrivilegedEligibilitySchedule.Read.AzureADGroup'
    'EntitlementManagement.Read.All'
    'AccessReview.Read.All'
    'AuditLog.Read.All'
    'DelegatedPermissionGrant.Read.All'
    'RoleManagement.Read.Directory'
    'RoleEligibilitySchedule.Read.Directory'
)
#endregion GraphPermissions

$GraphAppId = '00000003-0000-0000-c000-000000000000'
$GraphUrl = 'https://graph.microsoft.com/v1.0'

# One Microsoft Graph call through the Azure CLI session. Throws on failure.
function Invoke-GraphCli {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Method,
        [Parameter(Mandatory)] [string]$Url,
        [hashtable]$Body
    )
    $azArgs = @('rest', '--method', $Method, '--url', $Url, '--only-show-errors')
    $bodyFile = $null
    if ($Body) {
        # Through a file: a JSON body on the command line does not survive every shell.
        $bodyFile = [System.IO.Path]::GetTempFileName()
        Set-Content -LiteralPath $bodyFile -Value (ConvertTo-Json -InputObject $Body -Compress) -Encoding utf8NoBOM
        $azArgs += @('--headers', 'Content-Type=application/json', '--body', "@$bodyFile")
    }

    try {
        $out = az @azArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Microsoft Graph call failed: $Method $Url"
        }

        return ($out | ConvertFrom-Json)
    }
    finally {
        if ($bodyFile) {
            Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($PSCmdlet.ParameterSetName -eq 'ByResourceGroup') {
    $PrincipalId = az identity list --resource-group $ResourceGroup --query "[?ends_with(name, '-mi-crawler')].principalId | [0]" --output tsv
    if ($LASTEXITCODE -ne 0 -or -not $PrincipalId) {
        throw "No crawler identity (<prefix>-mi-crawler) found in resource group '$ResourceGroup'. Deploy Identity Atlas there first, or pass -PrincipalId."
    }
}

Write-Host "Crawler identity (principal ID): $PrincipalId" -ForegroundColor Cyan

# Microsoft Graph's own service principal in this tenant: its object ID and the
# catalogue of application permissions. Through `az ad sp show` rather than a
# raw URL — the appId='…' key syntax does not survive every shell's quoting.
$graph = az ad sp show --id $GraphAppId --query '{id:id, appRoles:appRoles}' --only-show-errors | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $graph.id) {
    throw "Could not read the Microsoft Graph service principal. Are you signed in (az login) to the right tenant?"
}

$held = @((Invoke-GraphCli -Method GET -Url "$GraphUrl/servicePrincipals/$PrincipalId/appRoleAssignments").value |
        Where-Object { $_.resourceId -eq $graph.id } |
        ForEach-Object { $_.appRoleId })

$granted = 0
foreach ($name in $GraphPermissions) {
    $role = $graph.appRoles | Where-Object { $_.value -eq $name -and $_.allowedMemberTypes -contains 'Application' } | Select-Object -First 1
    if (-not $role) {
        throw "Microsoft Graph has no application permission named '$name'."
    }

    if ($held -contains $role.id) {
        Write-Host "  already granted  $name" -ForegroundColor Green
        continue
    }

    if ($PSCmdlet.ShouldProcess($name, 'Grant Microsoft Graph application permission')) {
        Invoke-GraphCli -Method POST -Url "$GraphUrl/servicePrincipals/$PrincipalId/appRoleAssignments" -Body @{
            principalId = $PrincipalId
            resourceId  = $graph.id
            appRoleId   = $role.id
        } | Out-Null
        Write-Host "  granted          $name" -ForegroundColor Green
        $granted++
    }
}

Write-Host "Done: $granted permission(s) granted, $($GraphPermissions.Count - $granted) left as they were." -ForegroundColor Cyan
