<#
.SYNOPSIS
    Fortigi Demo Corp — OAuth consent / shadow IT (CTF Track 3, flags 11-12).

.DESCRIPTION
    Two third-party enterprise apps and the delegated scopes users consented to.

    THIS SHAPE IS NOT ARBITRARY — it is what the shipped `risky-consent` context
    plugin reads (app/api/src/contexts/plugins/risky-consent.js):

      * The grant is a Resource, resourceType='DelegatedPermission', whose
        extendedAttributes carry `scope` (the permission string) and `clientSpId`
        (the consuming app's service-principal id, as text).
      * The plugin joins clientSpId -> Principals and reads that principal's
        extendedAttributes `appId` + `publisherName`.
      * Consent itself is a Direct assignment on the grant resource. (Migration
        045 rewrote the retired OAuth2Grant type to Direct, so this matches
        production data and shows up under "Direct Members".)

    Determinism (issue #705 risk R1): no LLM is involved. 'Files.ReadWrite.All'
    is in the plugin's curated HIGH_RISK set (riskyConsentRiskMap.js), so running
    the plugin with defaults always puts FileSync Pro's grant in "Risky Consent —
    High". FileSync Pro's publisher is 'Default Directory' — an unverified
    publisher — so it also lands in "Risky App Consent — Suspicious" via the
    offline heuristic, with no threat-feed call needed.

    Contoso Timesheets is the control: 'User.Read' classifies Low (below the
    plugin's default enabled tiers), its publisher is verified, and it has four
    consenters so the low-prevalence heuristic doesn't fire. It exists so that
    "which app is risky?" is a real question with a wrong answer available.
#>

Set-StrictMode -Version Latest

# Flag 11's answer: who consented to Files.ReadWrite.All. Spread across
# departments so no single department scope reveals it.
$script:RiskyConsenters = @('E0032', 'E0027', 'E0020', 'E0030', 'E0025')

# The control app's consenters. Victor Wang (E0029) is here and nowhere else:
# he has a never-expiring password, so anyone who forgets the "risky" half of
# flag 12 will wrongly include him. Four consenters also keeps this app above
# the plugin's low-prevalence threshold, so it is not flagged Suspicious.
$script:CleanConsenters = @('E0029', 'E0021', 'E0022', 'E0024')

function Add-DemoConsent {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']

    # The resource API these scopes are granted against.
    $graphSpId = Get-DemoPrincipalId 'SP-MSGRAPH'
    $null = Add-DemoPrincipal $State -Record @{
        id             = $graphSpId
        displayName    = 'Microsoft Graph'
        principalType  = 'ServicePrincipal'
        accountEnabled = $true
        systemId       = $sysEntra
        extendedAttributes = @{
            appId         = '00000003-0000-0000-c000-000000000000'
            publisherName = 'Microsoft Services'
        }
    }

    $apps = @(
        @{
            Key = 'filesync'; Name = 'FileSync Pro'; Scope = 'Files.ReadWrite.All'
            AppId = 'a3f1c7d4-9b2e-4c81-8e5a-6d0f2b7c1e93'
            # An unverified publisher is what the plugin's offline heuristic
            # keys on — this is the shadow-IT tell.
            Publisher = 'Default Directory'
            AppDesc = 'Third-party file synchronisation tool. Self-service consent, unverified publisher.'
            Consenters = $script:RiskyConsenters
        }
        @{
            Key = 'contoso'; Name = 'Contoso Timesheets'; Scope = 'User.Read'
            AppId = 'd82b6a10-4f3c-4a97-b1d5-3e9c8f0a2b46'
            Publisher = 'Contoso Ltd.'
            AppDesc = 'Approved timesheet application. Verified publisher, sign-in scope only.'
            Consenters = $script:CleanConsenters
        }
    )

    foreach ($app in $apps) {
        Add-DemoConsentApp $State -App $app -GraphSpId $graphSpId
    }
}

# One enterprise app: its service principal, its Application resource, the
# delegated scope it holds, and the users who consented.
function Add-DemoConsentApp {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][hashtable]$App,
        [Parameter(Mandatory)][string]$GraphSpId
    )

    $sysEntra = $State.SystemIds['entra']
    $spId     = Get-DemoPrincipalId "SP-$($App.Key.ToUpper())"
    $appResId = New-DemoGuid "res-app-$($App.Key)"
    $grantId  = New-DemoGuid "res-scope-$($App.Key)-$($App.Scope)"

    # The app's own service principal — the plugin resolves clientSpId to this
    # to read appId + publisherName.
    $null = Add-DemoPrincipal $State -Record @{
        id             = $spId
        displayName    = $App.Name
        principalType  = 'ServicePrincipal'
        accountEnabled = $true
        systemId       = $sysEntra
        extendedAttributes = @{
            appId         = $App.AppId
            publisherName = $App.Publisher
        }
    }

    $null = Add-DemoResource $State -Id $appResId -DisplayName $App.Name -ResourceType 'Application' `
        -SystemId $sysEntra -Description $App.AppDesc `
        -Extended @{ appId = $App.AppId; publisherName = $App.Publisher; clientSpId = $spId }

    # The delegated scope. `scope` + `clientSpId` are the two keys the
    # risky-consent plugin requires — renaming either makes the grant invisible
    # to it (see issue #719 for how that failure mode looks).
    $null = Add-DemoResource $State -Id $grantId -DisplayName $App.Scope -ResourceType 'DelegatedPermission' `
        -SystemId $sysEntra -Description "$($App.Scope) delegated to $($App.Name)." `
        -Extended @{
            scope        = $App.Scope
            clientSpId   = $spId
            targetApiSpId = $GraphSpId
            consentType  = 'Principal'
        }

    Add-DemoRelationship $State -ParentResourceId $appResId -ChildResourceId $grantId -RelationshipType 'DelegatesScope'

    foreach ($e in $App.Consenters) {
        Add-DemoAssignment $State -ResourceId $grantId -PrincipalId (Get-DemoPrincipalId $e) -AssignmentType 'Direct'
    }
}
