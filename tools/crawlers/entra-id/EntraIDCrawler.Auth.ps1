<#
.SYNOPSIS
    How the Entra ID crawler signs in to Microsoft Graph.

.DESCRIPTION
    Two methods, chosen by the crawler config's `authMethod`:

      ClientSecret     (default, and what a config without `authMethod` means)
                       an app registration's client ID + secret.
      ManagedIdentity  the user-assigned managed identity the Azure deployment
                       attaches to the worker. No secret exists, so there is
                       nothing to store, leak or let expire.

    Which identity is used is decided by the deployment
    (IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID), never by a crawler config: the
    worker can carry other identities (image pull) that must not be used to read
    a tenant.

    Dot-sourced by Start-EntraIDCrawler.ps1.
#>
[CmdletBinding()]
param()

# Sign in to Graph. Credentials stay in memory only — never via a credentials
# file (SEC-2026-09 L-07).
function Connect-EntraCrawlerGraph {
    [CmdletBinding()]
    param(
        [string]$AuthMethod,
        [string]$TenantId, [string]$ClientId, [string]$ClientSecret
    )
    if ($AuthMethod -ne 'ManagedIdentity') {
        Get-FGAccessToken -TenantId $TenantId -ClientId $ClientId -ClientSecret $ClientSecret | Out-Null
        return
    }

    $identityClientId = "$($env:IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID)".Trim()
    if (-not $identityClientId) {
        throw "This crawler is set to sign in with a managed identity, but this deployment has none configured for crawlers (IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID is not set on the worker)."
    }

    Get-FGAccessTokenManagedIdentity -ClientId $identityClientId | Out-Null

    # A managed identity only ever gets a token for its own tenant. A config that
    # names another tenant would otherwise crawl this directory under that name.
    if ($TenantId -and $Global:TenantId -and ($TenantId -ne $Global:TenantId)) {
        throw "The managed identity belongs to tenant $($Global:TenantId), but this crawler is configured for tenant $TenantId. A managed identity can only read the tenant it lives in."
    }
}
