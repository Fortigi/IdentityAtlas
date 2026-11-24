#Requires -Modules Pester

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id' 'EntraIDCrawler.GovernanceParticipants.ps1')

    function New-Subject {
        param([string]$Type, [hashtable]$Extra = @{})
        $h = @{ '@odata.type' = "#microsoft.graph.$Type" } + $Extra
        [pscustomobject]$h
    }
    function Select-Part { param($List, $Kind) return , @($List | Where-Object { $_.participation -eq $Kind }) }
}

Describe 'ConvertTo-EntraParticipant' {

    It 'maps <type> to <expected>' -ForEach @(
        @{ type = 'singleUser'; expected = 'User' }
        @{ type = 'groupMembers'; expected = 'Group' }
        @{ type = 'requestorManager'; expected = 'Manager' }
        @{ type = 'targetManager'; expected = 'Manager' }
        @{ type = 'internalSponsors'; expected = 'Sponsor' }
        @{ type = 'externalSponsors'; expected = 'Sponsor' }
        @{ type = 'connectedOrganizationMembers'; expected = 'Organization' }
        @{ type = 'attributeRuleMembers'; expected = 'Rule' }
        @{ type = 'allUsers'; expected = 'Everyone' }
        @{ type = 'somethingNew'; expected = 'Other' }
    ) {
        (ConvertTo-EntraParticipant -Subject (New-Subject $type) -Participation 'Approver').subjectType | Should -Be $expected
    }

    It 'keeps the ids, rule, manager level and flags' {
        $s = New-Subject 'singleUser' @{ userId = 'u1'; groupId = 'g1'; membershipRule = 'r'; managerLevel = 2; description = 'Carla' }
        $p = ConvertTo-EntraParticipant -Subject $s -Participation 'Reviewer' -Stage 3 -IsFallback -OnBehalf
        $p.principalId | Should -Be 'u1'
        $p.groupId | Should -Be 'g1'
        $p.rule | Should -Be 'r'
        $p.managerLevel | Should -Be 2
        $p.displayName | Should -Be 'Carla'
        $p.stage | Should -Be 3
        $p.isFallback | Should -BeTrue
        $p.onBehalf | Should -BeTrue
    }

    It 'leaves out what the subject does not have' {
        $p = ConvertTo-EntraParticipant -Subject (New-Subject 'requestorManager') -Participation 'Approver'
        foreach ($key in 'principalId', 'groupId', 'rule', 'managerLevel') { $p.ContainsKey($key) | Should -BeFalse }
        $p.isFallback | Should -BeFalse
    }
}

Describe 'Get-EntraPolicyParticipants' {

    It 'lists approvers per stage and marks fallback and escalation' {
        $policy = [pscustomobject]@{
            requestApprovalSettings = [pscustomobject]@{
                isApprovalRequiredForAdd = $true
                stages = @(
                    [pscustomobject]@{
                        primaryApprovers = @(New-Subject 'singleUser' @{ userId = 'a1' })
                        fallbackPrimaryApprovers = @(New-Subject 'singleUser' @{ userId = 'a2' })
                        escalationApprovers = @(New-Subject 'singleUser' @{ userId = 'a3' })
                        fallbackEscalationApprovers = @(New-Subject 'singleUser' @{ userId = 'a4' })
                    }
                    [pscustomobject]@{ primaryApprovers = @(New-Subject 'requestorManager') }
                )
            }
        }
        $approvers = Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Approver'
        $approvers.Count | Should -Be 5
        @($approvers | Where-Object { -not $_.isFallback }).Count | Should -Be 2
        ($approvers | Where-Object { $_.principalId -eq 'a1' }).stage | Should -Be 1
        ($approvers | Where-Object { $_.subjectType -eq 'Manager' }).stage | Should -Be 2
    }

    It 'ignores approvers on a policy that needs no approval' {
        $policy = [pscustomobject]@{ requestApprovalSettings = [pscustomobject]@{
            isApprovalRequiredForAdd = $false
            stages = @([pscustomobject]@{ primaryApprovers = @(New-Subject 'singleUser' @{ userId = 'a1' }) })
        } }
        (Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Approver').Count | Should -Be 0
    }

    It 'lists primary and fallback reviewers' {
        $policy = [pscustomobject]@{ reviewSettings = [pscustomobject]@{
            isEnabled = $true
            primaryReviewers = @(New-Subject 'targetManager' @{ managerLevel = 1 })
            fallbackReviewers = @(New-Subject 'singleUser' @{ userId = 'r1'; description = 'Carla Cash' })
        } }
        $reviewers = Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Reviewer'
        $reviewers.Count | Should -Be 2
        ($reviewers | Where-Object { $_.isFallback }).principalId | Should -Be 'r1'
        ($reviewers | Where-Object { -not $_.isFallback }).subjectType | Should -Be 'Manager'
    }

    It 'adds a self-review' {
        $policy = [pscustomobject]@{ reviewSettings = [pscustomobject]@{ isEnabled = $true; isSelfReview = $true } }
        (Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Reviewer')[0].subjectType | Should -Be 'Self'
    }

    It 'lists no reviewers when reviews are disabled' {
        $policy = [pscustomobject]@{ reviewSettings = [pscustomobject]@{ isEnabled = $false; primaryReviewers = @(New-Subject 'singleUser' @{ userId = 'r1' }) } }
        (Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Reviewer').Count | Should -Be 0
    }

    It 'states a broad request scope in words' {
        $policy = [pscustomobject]@{ allowedTargetScope = 'allMemberUsers'; requestorSettings = [pscustomobject]@{ enableTargetsToSelfAddAccess = $true } }
        $r = Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Requestor'
        $r.Count | Should -Be 1
        $r[0].subjectType | Should -Be 'Everyone'
        $r[0].displayName | Should -Be 'All member users'
    }

    It 'lists the specific targets of a request scope' {
        $policy = [pscustomobject]@{
            allowedTargetScope = 'specificDirectoryUsers'
            specificAllowedTargets = @((New-Subject 'groupMembers' @{ groupId = 'g1' }), (New-Subject 'attributeRuleMembers' @{ membershipRule = 'x' }))
            requestorSettings = [pscustomobject]@{ enableTargetsToSelfAddAccess = $true }
        }
        $r = Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Requestor'
        @($r.subjectType) | Should -Be @('Group', 'Rule')
    }

    It 'treats targets as no request scope when nobody can request for themselves' {
        $policy = [pscustomobject]@{
            allowedTargetScope = 'specificDirectoryUsers'
            specificAllowedTargets = @(New-Subject 'attributeRuleMembers' @{ membershipRule = 'x' })
            requestorSettings = [pscustomobject]@{ enableTargetsToSelfAddAccess = $false }
        }
        (Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Requestor').Count | Should -Be 0
    }

    It 'marks who may request on behalf of someone else' {
        $policy = [pscustomobject]@{ requestorSettings = [pscustomobject]@{
            enableOnBehalfRequestorsToAddAccess = $true
            onBehalfRequestors = @(New-Subject 'targetManager' @{ managerLevel = 1 })
        } }
        $r = Select-Part (Get-EntraPolicyParticipants -Policy $policy) 'Requestor'
        $r[0].onBehalf | Should -BeTrue
        $r[0].subjectType | Should -Be 'Manager'
    }

    It 'returns an empty array for a policy with none of these' {
        $list = Get-EntraPolicyParticipants -Policy ([pscustomobject]@{ id = 'p' })
        @($list).Count | Should -Be 0
    }
}
