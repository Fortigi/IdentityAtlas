#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure record-shaping functions extracted into
    tools/crawlers/midpoint/MidpointCrawler.Transform.ps1.

.DESCRIPTION
    Covers the per-object mapping logic moved verbatim out of
    Start-MidpointCrawler.ps1's phase bodies. These are pure (no HTTP, no
    script-scope writes), so they run against in-memory midPoint fixtures with no
    mocks. Get-MidpointString / Test-MidpointEnabled come from Invoke-MidpointApi.ps1.

.USAGE
    Invoke-Pester -Path test/unit/MidpointCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:midpointDir = Join-Path $script:repoRoot 'tools\crawlers\midpoint'

    # midPoint pure helpers used by the transforms.
    . (Join-Path $script:midpointDir 'Invoke-MidpointApi.ps1')
    # The unit under test.
    . (Join-Path $script:midpointDir 'MidpointCrawler.Transform.ps1')
}

Describe 'ConvertTo-MidpointIdentityRecord' {

    It 'maps a user to an identity record, coercing midPoint string fields' {
        $u = [pscustomobject]@{
            oid = 'oid-1'; givenName = 'Alice'; familyName = 'Smith'; emailAddress = 'alice@x.com'
            employeeNumber = 'E1'; title = 'Engineer'; name = 'asmith'; lifecycleState = 'active'
        }
        $rec = ConvertTo-MidpointIdentityRecord -User $u -DisplayName 'Alice Smith' -Department 'IT'
        $rec.id          | Should -Be 'oid-1'
        $rec.externalId  | Should -Be 'oid-1'
        $rec.displayName | Should -Be 'Alice Smith'
        $rec.givenName   | Should -Be 'Alice'
        $rec.surname     | Should -Be 'Smith'
        $rec.email       | Should -Be 'alice@x.com'
        $rec.employeeId  | Should -Be 'E1'
        $rec.department  | Should -Be 'IT'
        $rec.extendedAttributes.name           | Should -Be 'asmith'
        $rec.extendedAttributes.lifecycleState | Should -Be 'active'
    }

    It 'falls back to empty strings for absent fields' {
        $rec = ConvertTo-MidpointIdentityRecord -User ([pscustomobject]@{ oid = 'oid-2' }) -DisplayName 'X'
        $rec.givenName  | Should -Be ''
        $rec.email      | Should -Be ''
        $rec.employeeId | Should -Be ''
    }
}

Describe 'ConvertTo-MidpointFocusPrincipalRecord' {

    It 'maps a user to a focus principal carrying principalType and the focus source flag' {
        $u = [pscustomobject]@{ oid = 'oid-1'; emailAddress = 'a@x.com'; title = 'Eng'; name = 'asmith'; activation = [pscustomobject]@{ effectiveStatus = 'enabled' } }
        $rec = ConvertTo-MidpointFocusPrincipalRecord -User $u -DisplayName 'Alice' -Department 'IT' -PrincipalType 'User'
        $rec.id             | Should -Be 'oid-1'
        $rec.principalType  | Should -Be 'User'
        $rec.accountEnabled | Should -BeTrue
        $rec.department     | Should -Be 'IT'
        $rec.extendedAttributes.source | Should -Be 'midpoint-focus'
    }

    It 'marks accountEnabled false when activation is disabled' {
        $u = [pscustomobject]@{ oid = 'oid-3'; activation = [pscustomobject]@{ effectiveStatus = 'disabled' } }
        (ConvertTo-MidpointFocusPrincipalRecord -User $u -DisplayName 'D' -PrincipalType 'User').accountEnabled | Should -BeFalse
    }
}

Describe 'New-MidpointIdentityMemberRecord' {

    It 'builds a primary identity-member link keyed on the user OID' {
        $rec = New-MidpointIdentityMemberRecord -Oid 'oid-9'
        $rec.identityId  | Should -Be 'oid-9'
        $rec.principalId | Should -Be 'oid-9'
        $rec.accountType | Should -Be 'Primary'
        $rec.isPrimary   | Should -BeTrue
    }
}
