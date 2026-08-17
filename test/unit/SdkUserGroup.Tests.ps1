#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester 5 unit tests for the IdentityAtlas PowerShell SDK — user / group /
    object READ functions under tools/powershell-sdk/graph/.

.DESCRIPTION
    Each function builds a Microsoft Graph URI and delegates to the
    Invoke-FGGetRequest helper. These tests mock that helper (module-scoped)
    and assert the URI that gets built for the happy path plus the optional
    parameter branches (filters, $expand, $top, transitive vs direct, to-file).
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    Import-Module (Join-Path $script:repoRoot 'setup/IdentityAtlas.psd1') -Force -ErrorAction Stop
}

Describe 'Get-FGUser' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    BeforeEach {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'u1' } }
    }

    It 'hits the users collection with no params' {
        Get-FGUser | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users'
        }
    }

    It 'filters by userPrincipalName' {
        Get-FGUser -userPrincipalName 'a@b.com' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*`$filter=userPrincipalName eq 'a@b.com'*"
        }
    }

    It 'appends id with "and" when a filter already exists' {
        Get-FGUser -userPrincipalName 'a@b.com' -id 'u1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*and id eq 'u1'*"
        }
    }

    It 'starts a filter with id when no upn given' {
        Get-FGUser -id 'u1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*`$filter=id eq 'u1'*"
        }
    }

    It 'starts a filter with userType' {
        Get-FGUser -UserType 'Guest' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*`$filter=userType eq 'Guest'*"
        }
    }

    It 'appends userType with "and" when a filter exists' {
        Get-FGUser -id 'u1' -UserType 'Member' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*and userType eq 'Member'*"
        }
    }

    It 'expands manager (& when query present)' {
        Get-FGUser -id 'u1' -IncludeManager $true | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*&$expand=manager*'
        }
    }

    It 'expands manager (? when no query present)' {
        Get-FGUser -IncludeManager $true | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*?$expand=manager*'
        }
    }

    It 'expands extensions (& when query present)' {
        Get-FGUser -id 'u1' -IncludeExtensions $true | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*&$expand=extensions*'
        }
    }

    It 'expands extensions (? when no query present)' {
        Get-FGUser -IncludeExtensions $true | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*?$expand=extensions*'
        }
    }

    It 'adds $top (& when query present)' {
        Get-FGUser -id 'u1' -Top 5 | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*&$top=5*'
        }
    }

    It 'adds $top (? when no query present)' {
        Get-FGUser -Top 5 | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*?$top=5*'
        }
    }

    It 'returns the helper result' {
        (Get-FGUser -id 'u1').id | Should -Be 'u1'
    }
}

Describe 'Get-FGUserMailFolder' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'builds the mailFolders URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'f1' } }
        Get-FGUserMailFolder -id 'u1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users/u1/mailFolders'
        }
    }
}

Describe 'Get-FGUserMail' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'requests messages directly when no folder given' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
        Get-FGUserMail -id 'u1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users/u1/messages'
        }
    }

    It 'resolves a named folder then requests its messages' {
        Mock -ModuleName IdentityAtlas Get-FGUserMailFolder {
            [pscustomobject]@{ displayName = 'Inbox'; id = 'folder123' }
        }
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
        Get-FGUserMail -id 'u1' -MailFolder 'Inbox' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users/u1/mailFolders/folder123/messages'
        }
    }

    It 'throws when the folder is not found' {
        Mock -ModuleName IdentityAtlas Get-FGUserMailFolder {
            [pscustomobject]@{ displayName = 'Other'; id = 'x' }
        }
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
        { Get-FGUserMail -id 'u1' -MailFolder 'Inbox' } | Should -Throw '*not found*'
    }
}

Describe 'Get-FGUserManager' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'builds the manager URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'm1' } }
        Get-FGUserManager -id 'u1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users/u1/manager'
        }
    }
}

Describe 'Get-FGUserMemberOf' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'builds the memberOf URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
        Get-FGUserMemberOf -userPrincipalName 'u1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users/u1/memberOf'
        }
    }
}

Describe 'Get-FGUserAccessPackagesAssignments' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'builds the access package assignments URI with target filter' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
        Get-FGUserAccessPackagesAssignments -id 'u1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*accessPackageAssignments*' -and $URI -like "*target/objectid+eq+'u1'*"
        }
    }

    It 'filters to Delivered when -DeliveredOnly is set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            @(
                [pscustomobject]@{ id = 'a'; assignmentStatus = 'Delivered' }
                [pscustomobject]@{ id = 'b'; assignmentStatus = 'Expired' }
            )
        }
        $result = Get-FGUserAccessPackagesAssignments -id 'u1' -DeliveredOnly $true
        $result.id | Should -Be 'a'
    }

    It 'returns all assignments without -DeliveredOnly' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            @(
                [pscustomobject]@{ id = 'a'; assignmentStatus = 'Delivered' }
                [pscustomobject]@{ id = 'b'; assignmentStatus = 'Expired' }
            )
        }
        (Get-FGUserAccessPackagesAssignments -id 'u1').Count | Should -Be 2
    }
}

Describe 'Get-FGGroup' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    BeforeEach {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'g1' } }
    }

    It 'hits the groups collection with no params' {
        Get-FGGroup | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/groups'
        }
    }

    It 'filters by displayName' {
        Get-FGGroup -DisplayName 'Admins' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*`$filter=displayName eq 'Admins'*"
        }
    }

    It 'filters by id' {
        Get-FGGroup -Id 'g1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*`$filter=id eq 'g1'*"
        }
    }

    It 'adds $top with & when filter present' {
        Get-FGGroup -Id 'g1' -Top 10 | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*&$top=10*'
        }
    }

    It 'adds $top with ? when no filter present' {
        Get-FGGroup -Top 10 | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*?$top=10*'
        }
    }
}

Describe 'Get-FGGroupMember' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'builds the members URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
        Get-FGGroupMember -Id 'g1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/groups/g1/members'
        }
    }
}

Describe 'Get-FGObject' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'builds the directoryObjects URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'o1' } }
        Get-FGObject -Id 'o1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/directoryObjects/o1'
        }
    }
}

Describe 'Get-FGDevice' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    BeforeEach {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
    }

    It 'hits the devices collection with no params' {
        Get-FGDevice | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/devices'
        }
    }

    It 'adds a lastSignIn filter when -DaysThreshold is set' {
        Get-FGDevice -DaysThreshold -30 | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*$filter=approximateLastSignInDateTime le *'
        }
    }

    It 'appends accountEnabled with "and" when a filter already exists' {
        Get-FGDevice -DaysThreshold -30 -AccountEnabled $false | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*and accountEnabled eq false*'
        }
    }

    It 'starts a filter with accountEnabled when no other filter exists' {
        Get-FGDevice -AccountEnabled $false | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*accountEnabled eq false*'
        }
    }
}

Describe 'Get-FGGroupMemberAll' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'queries direct members for each group' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id') {
                return @([pscustomobject]@{ id = 'g1' })
            }
            return @([pscustomobject]@{ id = 'm1'; '@odata.type' = '#microsoft.graph.user' })
        }
        $rows = @(Get-FGGroupMemberAll)
        $rows.Count       | Should -Be 1
        $rows[0].groupId  | Should -Be 'g1'
        $rows[0].memberId | Should -Be 'm1'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*/groups/g1/members?$select=id'
        }
    }

    It 'queries transitiveMembers when -Transitive is set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id') {
                return @([pscustomobject]@{ id = 'g1' })
            }
            return @([pscustomobject]@{ id = 'm1'; '@odata.type' = '#microsoft.graph.user' })
        }
        Get-FGGroupMemberAll -Transitive | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*/groups/g1/transitiveMembers?$select=id'
        }
    }
}

Describe 'Get-FGGroupTransitiveMemberAll' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'delegates to Get-FGGroupMemberAll -Transitive' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id') {
                return @([pscustomobject]@{ id = 'g1' })
            }
            return @([pscustomobject]@{ id = 'm1'; '@odata.type' = '#microsoft.graph.user' })
        }
        Get-FGGroupTransitiveMemberAll | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*/groups/g1/transitiveMembers?$select=id'
        }
    }
}

Describe 'Get-FGGroupMemberAllToFile' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'writes a JSON array of members to the file' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id') {
                return @([pscustomobject]@{ id = 'g1' })
            }
            return @([pscustomobject]@{ id = 'm1'; '@odata.type' = '#microsoft.graph.user' })
        }
        Mock -ModuleName IdentityAtlas Remove-FGTrailingCommaFromJsonFile { }

        $file = Join-Path $TestDrive ("fg_members_{0}.json" -f [guid]::NewGuid())
        try {
            Get-FGGroupMemberAllToFile -File $file
            Test-Path $file | Should -BeTrue
            $content = Get-Content $file -Raw
            $content | Should -Match 'g1'
            $content | Should -Match 'm1'
            Should -Invoke -ModuleName IdentityAtlas Remove-FGTrailingCommaFromJsonFile -Exactly 1
        }
        finally {
            if (Test-Path $file) { Remove-Item $file -Force }
        }
    }

    It 'uses the transitiveMembers segment when -Transitive is set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id') {
                return @([pscustomobject]@{ id = 'g1' })
            }
            return @()
        }
        Mock -ModuleName IdentityAtlas Remove-FGTrailingCommaFromJsonFile { }

        $file = Join-Path $TestDrive ("fg_members_{0}.json" -f [guid]::NewGuid())
        try {
            Get-FGGroupMemberAllToFile -File $file -Transitive
            Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
                $URI -like '*/groups/g1/transitiveMembers?$select=id'
            }
        }
        finally {
            if (Test-Path $file) { Remove-Item $file -Force }
        }
    }
}

Describe 'Get-FGGroupTransitiveMemberAllToFile' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'delegates to the to-file helper with -Transitive' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id') {
                return @([pscustomobject]@{ id = 'g1' })
            }
            return @()
        }
        Mock -ModuleName IdentityAtlas Remove-FGTrailingCommaFromJsonFile { }

        $file = Join-Path $TestDrive ("fg_members_{0}.json" -f [guid]::NewGuid())
        try {
            Get-FGGroupTransitiveMemberAllToFile -File $file
            Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
                $URI -like '*/groups/g1/transitiveMembers?$select=id'
            }
        }
        finally {
            if (Test-Path $file) { Remove-Item $file -Force }
        }
    }
}

Describe 'Get-FGGroupEligibleMemberAll' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'returns eligible memberships for PIM-enabled groups' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id,displayName,groupTypes') {
                return @([pscustomobject]@{ id = 'g1'; displayName = 'Grp'; groupTypes = @() })
            }
            return @([pscustomobject]@{ groupId = 'g1'; principalId = 'p1' })
        }
        $result = @(Get-FGGroupEligibleMemberAll)
        $result.Count       | Should -Be 1
        $result[0].groupId  | Should -Be 'g1'
        $result[0].memberId | Should -Be 'p1'
    }

    It 'skips dynamic membership groups' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            param($URI)
            if ($URI -like '*groups?$select=id,displayName,groupTypes') {
                return @([pscustomobject]@{ id = 'g1'; displayName = 'Dyn'; groupTypes = @('DynamicMembership') })
            }
            return @([pscustomobject]@{ groupId = 'g1'; principalId = 'p1' })
        }
        $result = Get-FGGroupEligibleMemberAll
        $result.Count | Should -Be 0
        # eligibility endpoint must never be queried for a dynamic-only group
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -Exactly 0 -ParameterFilter {
            $URI -like '*eligibilitySchedules*'
        }
    }

    It 'returns null when the top-level groups call fails' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { throw 'boom' }
        # 2>$null silences the function's by-design "failed" error-stream log (it's
        # exercised on purpose here) so it doesn't read as a failure in CI output.
        Get-FGGroupEligibleMemberAll 2>$null | Should -BeNullOrEmpty
    }
}
