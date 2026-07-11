#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the principal→principal relationship phase
    (tools/crawlers/entra-id/EntraIDCrawler.PrincipalRelationships.ps1).

.DESCRIPTION
    ConvertTo-EntraPrincipalRelationshipRecords is pure — it shapes owner/sponsor
    pairs into ingest records, dropping blanks, self-links and duplicates.
    Get-EntraAgentOwnerPairs / Get-EntraGuestSponsorPairs are covered by mocking
    their one mockable boundary (Get-FGGroupChildrenParallel).
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'
    $script:sdkDir   = Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'helpers'
    . (Join-Path $script:sdkDir 'Get-FGServicePrincipalType.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')   # provides Get-FGGroupChildrenParallel (mocked below)
    . (Join-Path $script:entraDir 'EntraIDCrawler.PrincipalRelationships.ps1')
}

Describe 'ConvertTo-EntraPrincipalRelationshipRecords' {

    It 'shapes pairs into records with subject=principalId, related=relatedPrincipalId' {
        $pairs = @(
            @{ subjectId = 'agent-1'; relatedId = 'owner-a' },
            @{ subjectId = 'agent-1'; relatedId = 'owner-b' }
        )
        # Wrap in @() — PowerShell unwraps a single-element result on assignment,
        # so a one-record return would otherwise arrive as a bare hashtable.
        $recs = @(ConvertTo-EntraPrincipalRelationshipRecords -Pairs $pairs -RelationshipType 'Owner')

        $recs.Count | Should -Be 2
        $recs[0].principalId        | Should -Be 'agent-1'
        $recs[0].relatedPrincipalId | Should -Be 'owner-a'
        $recs[0].relationshipType   | Should -Be 'Owner'
    }

    It 'stamps the Sponsor relationshipType' {
        $recs = @(ConvertTo-EntraPrincipalRelationshipRecords -Pairs @(@{ subjectId = 'guest-1'; relatedId = 'sponsor-1' }) -RelationshipType 'Sponsor')
        $recs[0].relationshipType | Should -Be 'Sponsor'
    }

    It 'drops pairs with a missing id' {
        $pairs = @(
            @{ subjectId = 'a'; relatedId = '' },
            @{ subjectId = ''; relatedId = 'b' },
            @{ subjectId = 'c'; relatedId = 'd' }
        )
        $recs = @(ConvertTo-EntraPrincipalRelationshipRecords -Pairs $pairs -RelationshipType 'Owner')
        $recs.Count | Should -Be 1
        $recs[0].principalId | Should -Be 'c'
    }

    It 'drops a self-link (a principal is never its own owner)' {
        $recs = @(ConvertTo-EntraPrincipalRelationshipRecords -Pairs @(@{ subjectId = 'x'; relatedId = 'x' }) -RelationshipType 'Owner')
        $recs.Count | Should -Be 0
    }

    It 'de-duplicates identical (subject, related) pairs' {
        $pairs = @(
            @{ subjectId = 'a'; relatedId = 'b' },
            @{ subjectId = 'a'; relatedId = 'b' }
        )
        $recs = @(ConvertTo-EntraPrincipalRelationshipRecords -Pairs $pairs -RelationshipType 'Owner')
        $recs.Count | Should -Be 1
    }

    It 'returns an empty array for no pairs' {
        $recs = ConvertTo-EntraPrincipalRelationshipRecords -Pairs @() -RelationshipType 'Owner'
        @($recs).Count | Should -Be 0
    }

    It 'rejects an unknown relationshipType (ValidateSet)' {
        { ConvertTo-EntraPrincipalRelationshipRecords -Pairs @() -RelationshipType 'Manager' } | Should -Throw
    }
}

Describe 'Get-EntraAgentOwnerPairs' {

    It 'classifies to AI agents and fetches only their owners' {
        $sps = @(
            [pscustomobject]@{ id = 'agent-1'; displayName = 'HR Copilot'; tags = @() },      # matches 'copilot' heuristic
            [pscustomobject]@{ id = 'plain-1'; displayName = 'Payroll App'; tags = @() }       # plain SP — excluded
        )
        Mock -CommandName Get-FGGroupChildrenParallel -MockWith {
            # Assert we only pass the classified agents through to the fetch.
            $Groups.Count | Should -Be 1
            $Groups[0].id | Should -Be 'agent-1'
            @{ records = @(@{ subjectId = 'agent-1'; relatedId = 'owner-a' }); errorCount = 0 }
        }
        Mock -CommandName Write-Host -MockWith {}

        $pairs = @(Get-EntraAgentOwnerPairs -ServicePrincipals $sps)
        $pairs.Count | Should -Be 1
        $pairs[0].subjectId | Should -Be 'agent-1'
        $pairs[0].relatedId | Should -Be 'owner-a'
    }

    It 'returns empty (and does not fetch) when there are no agents' {
        $sps = @([pscustomobject]@{ id = 'plain-1'; displayName = 'Payroll App'; tags = @() })
        Mock -CommandName Get-FGGroupChildrenParallel -MockWith { throw 'should not be called' }
        Mock -CommandName Write-Host -MockWith {}

        $pairs = Get-EntraAgentOwnerPairs -ServicePrincipals $sps
        @($pairs).Count | Should -Be 0
        Should -Invoke Get-FGGroupChildrenParallel -Times 0
    }
}

Describe 'Get-EntraGuestSponsorPairs' {

    It 'fetches sponsors for the guest list' {
        Mock -CommandName Get-FGGroupChildrenParallel -MockWith {
            $ChildPath | Should -Be 'sponsors'
            $EntityType | Should -Be 'users'
            @{ records = @(@{ subjectId = 'guest-1'; relatedId = 'sponsor-1' }); errorCount = 0 }
        }
        Mock -CommandName Write-Host -MockWith {}

        $pairs = @(Get-EntraGuestSponsorPairs -Guests @([pscustomobject]@{ id = 'guest-1' }))
        $pairs.Count | Should -Be 1
        $pairs[0].relatedId | Should -Be 'sponsor-1'
    }

    It 'returns empty for no guests without fetching' {
        Mock -CommandName Get-FGGroupChildrenParallel -MockWith { throw 'should not be called' }
        $pairs = Get-EntraGuestSponsorPairs -Guests @()
        @($pairs).Count | Should -Be 0
    }
}
