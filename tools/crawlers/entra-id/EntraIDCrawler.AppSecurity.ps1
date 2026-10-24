<#
.SYNOPSIS
    Entra ID crawler — the security-relevant set-up of applications: credentials,
    publisher, sign-in audience, public-client and redirect settings (its own file so
    EntraIDCrawler.Transform.ps1 / .Phases.ps1 stay under the file-length ratchet).

.DESCRIPTION
    Two consumers:

      * ConvertTo-EntraServicePrincipalRecord (Transform.ps1) calls
        Add-EntraAppSecurityAttributes so every service principal carries its own
        credentials (a secret added to the SP itself is invisible in the portal's
        App registrations blade — a known persistence trick), verified publisher,
        sign-in audience, reply URLs and whether users need an assignment.

      * Sync-EntraAppRegistrations reads /applications — the app registrations owned
        by this tenant — and stores each as an `AppRegistration` resource (id = the
        application object id, linked to its service principal by `appId` in
        extendedAttributes). Only an app registration says whether public-client
        flows (ROPC / device code) are allowed, which redirect URIs and implicit
        grants it has, what it asks for (requiredResourceAccess) and which
        federated credentials let an outside workload sign in as it.

    Credential METADATA only: key id, name, type, usage, start and end. The secret
    hint, secretText, the certificate's key and customKeyIdentifier are never kept.
    Facts that depend on when you look ("expired", "expires within 30 days") are
    left to the reader; only time-invariant facts (validity length, latest end) are
    derived here.

    Dot-sourced by Start-EntraIDCrawler.ps1 (and auto-loaded by the dispatcher's
    *.ps1 glob). Everything but Sync-EntraAppRegistrations is pure.
#>

# Fields read from /applications. Credentials, public-client and web/spa settings,
# requiredResourceAccess and federatedIdentityCredentials are all covered by the
# Application.Read.All the crawler already needs.
$script:EntraAppRegistrationSelect = @(
    'id', 'appId', 'displayName', 'createdDateTime', 'signInAudience', 'publisherDomain',
    'verifiedPublisher', 'isFallbackPublicClient', 'publicClient', 'web', 'spa',
    'passwordCredentials', 'keyCredentials', 'requiredResourceAccess'
) -join ','

# A Graph instant → 'yyyy-MM-ddTHH:mm:ssZ', or $null when absent/unparseable.
# Invoke-RestMethod hands ISO strings back as [datetime]; a hand-built fixture
# hands back strings. An unspecified-kind [datetime] is read as UTC — Graph only
# ever sends UTC.
function ConvertTo-EntraUtcTime {
    [CmdletBinding()]
    [OutputType([datetime])]
    param([AllowNull()] $Value)
    if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
    if ($Value -is [datetime]) {
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) { return [datetime]::SpecifyKind($Value, [DateTimeKind]::Utc) }
        return $Value.ToUniversalTime()
    }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal
    if ([DateTimeOffset]::TryParse([string]$Value, [cultureinfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $parsed.UtcDateTime
    }
    return $null
}

function Format-EntraUtcTime {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] $Value)
    $utc = ConvertTo-EntraUtcTime -Value $Value
    if ($null -eq $utc) { return $null }
    return $utc.ToString('yyyy-MM-ddTHH:mm:ssZ', [cultureinfo]::InvariantCulture)
}

# One password or key credential → its metadata. $Type is 'Secret' or 'Certificate'.
function ConvertTo-EntraCredentialEntry {
    [CmdletBinding()]
    param($KeyInfo, [string]$Type)
    $entry = [ordered]@{
        type          = $Type
        keyId         = $KeyInfo.keyId
        displayName   = $KeyInfo.displayName
        startDateTime = Format-EntraUtcTime -Value $KeyInfo.startDateTime
        endDateTime   = Format-EntraUtcTime -Value $KeyInfo.endDateTime
    }
    if ($Type -eq 'Certificate') {
        $entry['usage']           = $KeyInfo.usage
        $entry['certificateType'] = $KeyInfo.type
    }
    return $entry
}

# Whole days between a credential's start and end, or $null when either is missing.
function Get-EntraCredentialValidityDays {
    [CmdletBinding()]
    param($Entry)
    $start = ConvertTo-EntraUtcTime -Value $Entry.startDateTime
    $end   = ConvertTo-EntraUtcTime -Value $Entry.endDateTime
    if ($null -eq $start -or $null -eq $end) { return $null }
    return [int][Math]::Floor(($end - $start).TotalDays)
}

# Count, latest end and longest validity over one kind of credential. Entries are
# already normalised, so their ISO end strings sort chronologically.
function Get-EntraCredentialStats {
    [CmdletBinding()]
    param([array]$Entries = @())
    $ends = @($Entries | ForEach-Object { $_.endDateTime } | Where-Object { $_ } | Sort-Object)
    $days = @($Entries | ForEach-Object { Get-EntraCredentialValidityDays -Entry $_ } | Where-Object { $null -ne $_ } | Sort-Object)
    return @{
        count           = $Entries.Count
        latestEnd       = if ($ends.Count -gt 0) { $ends[-1] } else { $null }
        maxValidityDays = if ($days.Count -gt 0) { $days[-1] } else { $null }
    }
}

# Write one kind's stats onto $Ext under <prefix>Count / <prefix>LatestEndDateTime /
# <prefix>MaxValidityDays. The count is always written (0 included) so "no secrets"
# reads differently from "credentials not collected".
function Add-EntraCredentialStats {
    [CmdletBinding()]
    param([hashtable]$Ext, [string]$Prefix, [array]$Entries = @())
    $stats = Get-EntraCredentialStats -Entries $Entries
    $Ext["${Prefix}Count"] = $stats.count
    if ($stats.latestEnd)               { $Ext["${Prefix}LatestEndDateTime"] = $stats.latestEnd }
    if ($null -ne $stats.maxValidityDays) { $Ext["${Prefix}MaxValidityDays"] = $stats.maxValidityDays }
}

# Credential metadata for an application or service principal. Writes nothing when
# neither credential collection was read (the property is absent, not empty), so a
# record shaped from a narrower $select doesn't claim to have no credentials.
function Add-EntraCredentialAttributes {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Object, [Parameter(Mandatory)] [hashtable]$Ext)
    if ($null -eq $Object.passwordCredentials -and $null -eq $Object.keyCredentials) { return }
    $secrets = @(@($Object.passwordCredentials) | Where-Object { $_ } | ForEach-Object { ConvertTo-EntraCredentialEntry -KeyInfo $_ -Type 'Secret' })
    $certs   = @(@($Object.keyCredentials) | Where-Object { $_ } | ForEach-Object { ConvertTo-EntraCredentialEntry -KeyInfo $_ -Type 'Certificate' })
    Add-EntraCredentialStats -Ext $Ext -Prefix 'secret' -Entries $secrets
    Add-EntraCredentialStats -Ext $Ext -Prefix 'certificate' -Entries $certs
    $all = [System.Collections.Generic.List[object]]::new()
    foreach ($c in @($secrets + $certs)) { $all.Add($c) }
    if ($all.Count -gt 0) { $Ext['credentials'] = $all }
}

# Publisher, audience and access settings shared by app registrations and service
# principals. Each is written only when the source object carries it.
function Add-EntraAppSecurityAttributes {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Object, [Parameter(Mandatory)] [hashtable]$Ext)
    if ($Object.signInAudience) { $Ext['signInAudience'] = $Object.signInAudience }
    if ($Object.verifiedPublisher.displayName) {
        $Ext['verifiedPublisherName'] = $Object.verifiedPublisher.displayName
        $Ext['verifiedPublisherId']   = $Object.verifiedPublisher.verifiedPublisherId
    }
    if ($null -ne $Object.appRoleAssignmentRequired) { $Ext['appRoleAssignmentRequired'] = [bool]$Object.appRoleAssignmentRequired }
    $replyUrls = @($Object.replyUrls | Where-Object { $_ })
    if ($replyUrls.Count -gt 0) { $Ext['replyUrls'] = $replyUrls -join ',' }
    Add-EntraCredentialAttributes -Object $Object -Ext $Ext
}

# Redirect URIs per platform, plus the implicit-grant switches on the web platform.
function Add-EntraAppRedirectAttributes {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Application, [Parameter(Mandatory)] [hashtable]$Ext)
    $platforms = [ordered]@{ publicClientRedirectUris = $Application.publicClient; webRedirectUris = $Application.web; spaRedirectUris = $Application.spa }
    foreach ($key in $platforms.Keys) {
        $uris = @($platforms[$key].redirectUris | Where-Object { $_ })
        if ($uris.Count -gt 0) { $Ext[$key] = $uris -join ',' }
    }
    $implicit = $Application.web.implicitGrantSettings
    if ($implicit) {
        $Ext['implicitGrantAccessTokens'] = [bool]$implicit.enableAccessTokenIssuance
        $Ext['implicitGrantIdTokens']     = [bool]$implicit.enableIdTokenIssuance
    }
}

# What the app asks for, per API: delegated scope ids and app-role ids, as the app
# registration lists them (requested, not necessarily consented).
function ConvertTo-EntraRequiredResourceAccess {
    [CmdletBinding()]
    param($RequiredResourceAccess)
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($rra in @($RequiredResourceAccess | Where-Object { $_ })) {
        $access = @($rra.resourceAccess)
        $out.Add([ordered]@{
            resourceAppId = $rra.resourceAppId
            scopes        = @($access | Where-Object { $_.type -eq 'Scope' } | ForEach-Object { $_.id })
            roles         = @($access | Where-Object { $_.type -eq 'Role' }  | ForEach-Object { $_.id })
        })
    }
    return , $out
}

# Requested permissions (raw list + per-kind counts) onto $Ext.
function Add-EntraRequestedPermissionAttributes {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Application, [Parameter(Mandatory)] [hashtable]$Ext)
    if ($null -eq $Application.requiredResourceAccess) { return }
    $requested = ConvertTo-EntraRequiredResourceAccess -RequiredResourceAccess $Application.requiredResourceAccess
    $Ext['requestedDelegatedPermissionCount']    = [int](($requested | ForEach-Object { $_.scopes.Count } | Measure-Object -Sum).Sum)
    $Ext['requestedApplicationPermissionCount'] = [int](($requested | ForEach-Object { $_.roles.Count } | Measure-Object -Sum).Sum)
    if ($requested.Count -gt 0) { $Ext['requiredResourceAccess'] = $requested }
}

# Federated identity credentials: which outside issuer/subject may sign in as the app.
function Add-EntraFederatedCredentialAttributes {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Application, [Parameter(Mandatory)] [hashtable]$Ext)
    if ($null -eq $Application.federatedIdentityCredentials) { return }
    $fics = [System.Collections.Generic.List[object]]::new()
    foreach ($f in @($Application.federatedIdentityCredentials | Where-Object { $_ })) {
        $fics.Add([ordered]@{
            name                     = $f.name
            issuer                   = $f.issuer
            subject                  = $f.subject
            claimsMatchingExpression = $f.claimsMatchingExpression.value
            audiences                = (@($f.audiences) -join ',')
        })
    }
    $Ext['federatedCredentialCount'] = $fics.Count
    if ($fics.Count -gt 0) { $Ext['federatedCredentials'] = $fics }
}

# One /applications object → an `AppRegistration` resource record.
function ConvertTo-EntraAppRegistrationRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Application)
    $rec = @{
        id           = $Application.id
        displayName  = if ($Application.displayName) { $Application.displayName } else { $Application.appId }
        resourceType = 'AppRegistration'
        enabled      = $true
    }
    $created = Format-EntraUtcTime -Value $Application.createdDateTime
    if ($created) { $rec['createdDateTime'] = $created }

    $ext = @{ appId = $Application.appId }
    if ($Application.publisherDomain) { $ext['publisherDomain'] = $Application.publisherDomain }
    # Unset means "No" in the portal (public-client flows off), so null reads as false.
    $ext['isFallbackPublicClient'] = ($Application.isFallbackPublicClient -eq $true)
    Add-EntraAppSecurityAttributes -Object $Application -Ext $ext
    Add-EntraAppRedirectAttributes -Application $Application -Ext $ext
    Add-EntraRequestedPermissionAttributes -Application $Application -Ext $ext
    Add-EntraFederatedCredentialAttributes -Application $Application -Ext $ext
    $rec['extendedAttributes'] = $ext
    return $rec
}

# ─── Sync App Registrations phase ────────────────────────────────
# Every app registration in the tenant, with its credentials, public-client and
# redirect settings, requested permissions and federated credentials. One paged
# read (federated credentials ride along via $expand). Full-synced on its own
# resourceType so a deleted app registration is reconciled away. Opt-in via
# SyncAppRegistrations; full runs only (no delta feed is kept for it).
function Sync-EntraAppRegistrations {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing app registrations..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing app registrations' -Pct 82 -Detail 'Fetching app registrations from Microsoft Graph...'
    try {
        $apps = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/applications?`$select=$($script:EntraAppRegistrationSelect)&`$expand=federatedIdentityCredentials&`$top=999")
        $records = @($apps | Where-Object { $_.id } | ForEach-Object { ConvertTo-EntraAppRegistrationRecord -Application $_ })
        Write-Host "  App registrations: $($records.Count)" -ForegroundColor Gray
        if ($records.Count -eq 0) {
            Write-Host "  Nothing to ingest" -ForegroundColor Yellow
        } else {
            Update-CrawlerProgress -Detail "Uploading $($records.Count) app registrations..."
            Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ resourceType = 'AppRegistration' } -Records $records
        }
    }
    catch {
        Write-Host "  App registration sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("AppRegistrations: $($_.Exception.Message)")
        Write-Host "  (Requires Application.Read.All.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); if ($Timings) { $Timings['AppRegistrations'] = $__phaseSW.Elapsed }
    $__err = $script:phaseErrors | Where-Object { $_.StartsWith('AppRegistrations:') } | Select-Object -Last 1
    $__errMsg = if ($__err) { $__err.Substring('AppRegistrations:'.Length).Trim() } else { $null }
    Write-Phase -Name 'AppRegistrations' -Duration $__phaseSW.Elapsed -ErrorMsg $__errMsg
}
