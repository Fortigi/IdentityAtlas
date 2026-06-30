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
