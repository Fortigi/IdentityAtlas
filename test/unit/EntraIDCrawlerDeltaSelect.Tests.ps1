#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the delta-priming $select builder
    (tools/crawlers/entra-id/EntraIDCrawler.DeltaSelect.ps1).

.DESCRIPTION
    Get-EntraDeltaSelect is pure string work: it takes the $select the full
    fetch uses and returns the one the delta token should be primed with. The
    bug it exists to prevent is silent in both directions — priming with too
    little makes every later delta run miss attribute changes (a renamed
    department stays stale until the next full sync), and priming with a
    property /users/delta cannot serve makes Graph reject the priming call, so
    no token is stored and delta mode never engages at all.

    The inputs are the crawler's REAL selects, not toy strings, so the cases
    discriminate. `signInActivity` sits in the middle of the user select, which
    is what separates a correct filter from "drop the last property" or "take
    everything before signInActivity"; the SP select contains no unsupported
    property at all, so a builder that dropped something unconditionally would
    show up there and nowhere else.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    . (Join-Path $script:entraDir 'EntraIDCrawler.DeltaSelect.ps1')

    # Verbatim from Get-EntraUserSelect / $spSelectAttrs in EntraIDCrawler.Phases.ps1.
    $script:UserSelect = 'id,displayName,mail,userPrincipalName,accountEnabled,givenName,surname,department,jobTitle,companyName,employeeId,createdDateTime,userType,signInActivity,externalUserState,onPremisesDistinguishedName'
    $script:SpSelect = 'id,appId,displayName,servicePrincipalType,accountEnabled,tags,appOwnerOrganizationId,createdDateTime,notes,servicePrincipalNames,homepage,publisherName'
}

Describe 'Get-EntraDeltaSelect' {

    It 'drops signInActivity from the real user select and keeps every other property, in order' {
        # The whole point of the change: the primed token must track the same
        # attributes the full sync reads, minus the one delta cannot serve.
        Get-EntraDeltaSelect -Select $script:UserSelect | Should -Be 'id,displayName,mail,userPrincipalName,accountEnabled,givenName,surname,department,jobTitle,companyName,employeeId,createdDateTime,userType,externalUserState,onPremisesDistinguishedName'
    }

    It 'keeps the properties that follow the dropped one' {
        # Guards the "truncate at the unsupported property" failure:
        # externalUserState and onPremisesDistinguishedName come AFTER
        # signInActivity, and losing them is exactly as silent as losing all of them.
        $kept = (Get-EntraDeltaSelect -Select $script:UserSelect) -split ','
        $kept | Should -Contain 'externalUserState'
        $kept | Should -Contain 'onPremisesDistinguishedName'
        $kept | Should -Not -Contain 'signInActivity'
        $kept.Count | Should -Be 15
    }

    It 'returns the service-principal select unchanged when nothing is unsupported' {
        # SPs pass -Unsupported @(): every selected property is delta-tracked,
        # so a builder that dropped something unconditionally fails here.
        Get-EntraDeltaSelect -Select $script:SpSelect -Unsupported @() | Should -Be $script:SpSelect
    }

    It 'still drops the default unsupported set from the SP select when no override is passed' {
        # Pins that -Unsupported is what decides, not the shape of the input:
        # the same string with signInActivity appended loses it under the default.
        Get-EntraDeltaSelect -Select "$($script:SpSelect),signInActivity" |
            Should -Be $script:SpSelect
    }

    It 'trims surrounding whitespace on each property' {
        Get-EntraDeltaSelect -Select 'id, displayName , department' |
            Should -Be 'id,displayName,department'
    }

    It 'drops empty segments left by a trailing or doubled comma' {
        # A ",," would otherwise prime with an empty property name and make
        # Graph reject the whole call.
        Get-EntraDeltaSelect -Select 'id,,displayName,' | Should -Be 'id,displayName'
    }

    It 'preserves duplicates rather than silently rewriting the caller''s select' {
        Get-EntraDeltaSelect -Select 'id,displayName,id' | Should -Be 'id,displayName,id'
    }

    It 'falls back to id when the select is empty, whitespace or missing' {
        # Graph returns its default property set for a select-less delta query;
        # `id` is the minimum that still identifies a changed object.
        Get-EntraDeltaSelect -Select '' | Should -Be 'id'
        Get-EntraDeltaSelect -Select '   ' | Should -Be 'id'
        Get-EntraDeltaSelect | Should -Be 'id'
    }

    It 'falls back to id when every selected property is unsupported' {
        Get-EntraDeltaSelect -Select 'signInActivity' | Should -Be 'id'
        Get-EntraDeltaSelect -Select 'a,b' -Unsupported @('a', 'b') | Should -Be 'id'
    }

    It 'drops only exact property-name matches, not substrings' {
        # `signInActivity` must not take `signInActivityExtended` with it, and a
        # prefix match must not strip an unrelated property.
        Get-EntraDeltaSelect -Select 'id,signInActivityExtended,lastSignIn' |
            Should -Be 'id,signInActivityExtended,lastSignIn'
    }
}
