#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure record-shaping functions extracted into
    tools/crawlers/entra-id/EntraIDCrawler.Transform.ps1.

.DESCRIPTION
    Covers ConvertTo-EntraPrincipalRecord and ConvertTo-EntraSignInActivityRecord —
    the per-user mapping logic moved verbatim out of Start-EntraIDCrawler.ps1's
    Main body. These are pure (no HTTP, no script-scope writes), so they run
    against in-memory Graph fixtures with no mocks.

    This is the characterization test for the Principals-phase refactor: it pins
    the principal/activity record shape so the extraction can be proven behaviour-
    preserving. Get-UserAttrValue comes from EntraIDCrawler.Functions.ps1;
    Add-FGEntraCalculatedAttributes (a Graph SDK helper with its own tests) is
    stubbed so this unit stays hermetic.

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    # Get-UserAttrValue (used by ConvertTo-EntraPrincipalRecord for custom attrs).
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Transform.ps1')

    # Get-FGServicePrincipalType (pure SDK classifier) — used by
    # ConvertTo-EntraServicePrincipalRecord.
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'helpers' 'Get-FGServicePrincipalType.ps1')

    # Add-FGEntraCalculatedAttributes is a Graph SDK helper with its own tests.
    # Stub it so the transform unit stays hermetic; the stub stamps a marker key
    # when the user has a DN, so we can assert the calculated-attrs merge wiring.
    function Add-FGEntraCalculatedAttributes {
        param($Object, $Ext, $Type)
        if ($Object.onPremisesDistinguishedName) { $Ext['_calc'] = $Type }
    }
}

Describe 'ConvertTo-EntraPrincipalRecord' {

    It 'maps core attributes and stamps principalType = User' {
        $user = [pscustomobject]@{
            id = 'u1'; displayName = 'Alice'; mail = 'alice@contoso.com'
            accountEnabled = $true; givenName = 'Alice'; surname = 'A'
            department = 'IT'; jobTitle = 'Eng'; companyName = 'Contoso'
            employeeId = 'E1'; createdDateTime = '2020-01-01T00:00:00Z'
        }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['id']             | Should -Be 'u1'
        $rec['displayName']    | Should -Be 'Alice'
        $rec['email']          | Should -Be 'alice@contoso.com'
        $rec['principalType']  | Should -Be 'User'
        $rec['accountEnabled'] | Should -BeTrue
        $rec['department']     | Should -Be 'IT'
        $rec['employeeId']     | Should -Be 'E1'
    }

    It 'falls back to userPrincipalName when mail is absent' {
        $user = [pscustomobject]@{ id = 'u2'; displayName = 'Bob'; userPrincipalName = 'bob@contoso.com' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['email'] | Should -Be 'bob@contoso.com'
    }

    It 'coerces accountEnabled to a real boolean' {
        $user = [pscustomobject]@{ id = 'u3'; displayName = 'C'; accountEnabled = $false }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['accountEnabled'] | Should -BeOfType [bool]
        $rec['accountEnabled'] | Should -BeFalse
    }

    It 'adds managerId only when the expanded manager has an id' {
        $withMgr = [pscustomobject]@{ id = 'u4'; displayName = 'D'; manager = [pscustomobject]@{ id = 'm1' } }
        (ConvertTo-EntraPrincipalRecord -User $withMgr)['managerId'] | Should -Be 'm1'

        $noMgr = [pscustomobject]@{ id = 'u5'; displayName = 'E' }
        (ConvertTo-EntraPrincipalRecord -User $noMgr).ContainsKey('managerId') | Should -BeFalse
    }

    It 'puts userType and externalUserState into extendedAttributes when present' {
        $user = [pscustomobject]@{ id = 'u6'; displayName = 'F'; userType = 'Guest'; externalUserState = 'Accepted' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['extendedAttributes']['userType']          | Should -Be 'Guest'
        $rec['extendedAttributes']['externalUserState'] | Should -Be 'Accepted'
    }

    It 'omits extendedAttributes entirely when there is nothing to add' {
        $user = [pscustomobject]@{ id = 'u7'; displayName = 'G' }
        (ConvertTo-EntraPrincipalRecord -User $user).ContainsKey('extendedAttributes') | Should -BeFalse
    }

    It 'pulls non-empty custom attributes via Get-UserAttrValue, skipping blanks' {
        $user = [pscustomobject]@{ id = 'u8'; displayName = 'H'; officeLocation = 'Bldg 1'; costCenter = '' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user -CustomUserAttributes @('officeLocation','costCenter')
        $rec['extendedAttributes']['officeLocation'] | Should -Be 'Bldg 1'
        $rec['extendedAttributes'].ContainsKey('costCenter') | Should -BeFalse
    }

    It 'merges Add-FGEntraCalculatedAttributes output into extendedAttributes' {
        $user = [pscustomobject]@{ id = 'u9'; displayName = 'I'; onPremisesDistinguishedName = 'CN=I,OU=Staff,DC=x' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['extendedAttributes']['_calc'] | Should -Be 'User'
    }
}

Describe 'ConvertTo-EntraSignInActivityRecord' {

    It 'returns $null when the user has no signInActivity' {
        $user = [pscustomobject]@{ id = 'u1'; displayName = 'Alice' }
        ConvertTo-EntraSignInActivityRecord -User $user | Should -BeNullOrEmpty
    }

    It 'returns $null when signInActivity carries no timestamps' {
        $user = [pscustomobject]@{ id = 'u1'; signInActivity = [pscustomobject]@{} }
        ConvertTo-EntraSignInActivityRecord -User $user | Should -BeNullOrEmpty
    }

    It 'builds an aggregate SignIn record with the timestamps that are present' {
        $user = [pscustomobject]@{
            id = 'u1'
            signInActivity = [pscustomobject]@{
                lastSignInDateTime = '2026-01-01T00:00:00Z'
                lastSuccessfulSignInDateTime = '2026-01-02T00:00:00Z'
            }
        }
        $rec = ConvertTo-EntraSignInActivityRecord -User $user
        $rec['principalId']                  | Should -Be 'u1'
        $rec['activityType']                 | Should -Be 'SignIn'
        $rec['resourceId']                   | Should -Be '00000000-0000-0000-0000-000000000000'
        $rec['lastSignInDateTime']           | Should -Be '2026-01-01T00:00:00Z'
        $rec['lastSuccessfulSignInDateTime'] | Should -Be '2026-01-02T00:00:00Z'
        $rec.ContainsKey('lastNonInteractiveSignInDateTime') | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraServicePrincipalRecord' {

    It 'maps core fields and classifies a plain SP as ServicePrincipal' {
        $sp = [pscustomobject]@{
            id = 'sp1'; displayName = 'Contoso CRM'; accountEnabled = $true
            servicePrincipalType = 'Application'; createdDateTime = '2021-05-05T00:00:00Z'
        }
        $rec = ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp
        $rec['id']              | Should -Be 'sp1'
        $rec['principalType']   | Should -Be 'ServicePrincipal'
        $rec['accountEnabled']  | Should -BeOfType [bool]
        $rec['createdDateTime'] | Should -Be '2021-05-05T00:00:00Z'
    }

    It 'classifies servicePrincipalType=ManagedIdentity as ManagedIdentity' {
        $sp = [pscustomobject]@{ id = 'sp2'; displayName = 'mi-app'; servicePrincipalType = 'ManagedIdentity' }
        (ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp)['principalType'] | Should -Be 'ManagedIdentity'
    }

    It 'classifies a caller-supplied AI name pattern as AIAgent' {
        $sp = [pscustomobject]@{ id = 'sp3'; displayName = 'svc_ai_helper'; servicePrincipalType = 'Application' }
        (ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp -AINamePatterns @('svc_ai_'))['principalType'] | Should -Be 'AIAgent'
    }

    It 'joins tags and servicePrincipalNames arrays into comma strings in extendedAttributes' {
        $sp = [pscustomobject]@{
            id = 'sp4'; displayName = 'Plain App'; servicePrincipalType = 'Application'
            appId = 'app-4'; publisherName = 'Contoso'
            tags = @('foo','bar'); servicePrincipalNames = @('https://a','https://b')
        }
        $rec = ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp
        $rec['extendedAttributes']['appId']                 | Should -Be 'app-4'
        $rec['extendedAttributes']['publisherName']         | Should -Be 'Contoso'
        $rec['extendedAttributes']['tags']                  | Should -Be 'foo,bar'
        $rec['extendedAttributes']['servicePrincipalNames'] | Should -Be 'https://a,https://b'
    }

    It 'omits extendedAttributes when there is nothing to add' {
        # No servicePrincipalType/appId/tags/etc. → classifier defaults to
        # ServicePrincipal and the ext bag stays empty.
        $sp = [pscustomobject]@{ id = 'sp5'; displayName = 'Bare' }
        (ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp).ContainsKey('extendedAttributes') | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraSpActivityRecord' {

    It 'returns $null when there is no matched activity row' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity $null | Should -BeNullOrEmpty
    }

    It 'builds a ServicePrincipalSignIn record from primary timestamps' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        $act = [pscustomobject]@{
            lastSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-02-01T00:00:00Z' }
            lastNonInteractiveSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-02-02T00:00:00Z' }
        }
        $rec = ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity $act -AggregateResourceId 'agg'
        $rec['principalId']                     | Should -Be 'sp1'
        $rec['activityType']                    | Should -Be 'ServicePrincipalSignIn'
        $rec['resourceId']                      | Should -Be 'agg'
        $rec['lastSignInDateTime']              | Should -Be '2026-02-01T00:00:00Z'
        $rec['lastNonInteractiveSignInDateTime']| Should -Be '2026-02-02T00:00:00Z'
    }

    It 'emits only the client-variant timestamps into extendedAttributes when no primary timestamps exist' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        $act = [pscustomobject]@{
            applicationAuthenticationClientSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-03-01T00:00:00Z' }
            delegatedClientSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-03-02T00:00:00Z' }
        }
        $rec = ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity $act
        $rec.ContainsKey('lastSignInDateTime') | Should -BeFalse
        $rec['extendedAttributes']['lastApplicationAuthSignInDateTime'] | Should -Be '2026-03-01T00:00:00Z'
        $rec['extendedAttributes']['lastDelegatedClientSignInDateTime'] | Should -Be '2026-03-02T00:00:00Z'
    }

    It 'returns $null when the activity row carries no usable timestamp' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity ([pscustomobject]@{}) | Should -BeNullOrEmpty
    }
}
