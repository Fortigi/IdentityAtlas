#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Additional Pester 5 unit tests for the Identity Atlas PowerShell SDK helpers
    in tools/powershell-sdk/helpers/.

.DESCRIPTION
    Raises code coverage of the helper layer. The Confirm-FG* / Resolve-FG*
    helpers call SDK getters/setters internally — those are mocked with
    -ModuleName IdentityAtlas so we exercise the helpers' branch logic
    (found / not-found / multiple-match / null-input) without hitting Graph.

    The pure helpers (Test-FGDistinguishedName, Convert-FGDistinguishedNameToOUPath,
    Get-FGEntraPortalLink, Get-FGServicePrincipalType, Add-FGEntraCalculatedAttributes)
    already have a baseline of tests in IdentityAtlas.Tests.ps1; here we add only
    deeper / additional branch cases that the baseline does not cover.

.USAGE
    Invoke-Pester -Path test/unit/SdkHelpers.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:modulePath = Join-Path $script:repoRoot 'setup/IdentityAtlas.psd1'
    Import-Module $script:modulePath -Force -ErrorAction Stop
}

# ─── Confirm-FGGroup ──────────────────────────────────────────────
Describe 'Confirm-FGGroup' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'returns the single matching group when exactly one exists' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { [pscustomobject]@{ id = 'g1'; displayName = 'Eng'; Description = 'Engineering' } }
        $r = Confirm-FGGroup -GroupName 'Eng'
        $r.id | Should -Be 'g1'
    }

    It 'updates description when it differs' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { [pscustomobject]@{ id = 'g1'; displayName = 'Eng'; Description = 'old' } }
        Mock -ModuleName IdentityAtlas Set-FGGroup { }
        Confirm-FGGroup -GroupName 'Eng' -GroupDescription 'new desc' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Set-FGGroup -Exactly 1 -ParameterFilter { $Description -eq 'new desc' }
    }

    It 'does not update description when it already matches' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { [pscustomobject]@{ id = 'g1'; displayName = 'Eng'; Description = 'match' } }
        Mock -ModuleName IdentityAtlas Set-FGGroup { }
        Confirm-FGGroup -GroupName 'Eng' -GroupDescription 'match' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Set-FGGroup -Exactly 0
    }

    It 'throws when more than one group matches' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { @(
            [pscustomobject]@{ id = 'g1'; displayName = 'Eng' },
            [pscustomobject]@{ id = 'g2'; displayName = 'Eng' }
        ) }
        { Confirm-FGGroup -GroupName 'Eng' } | Should -Throw '*More than one group*'
    }

    It 'creates the group (with description) when none exists and reads it back' {
        # Get-Group on line 62 resolves to Get-FGGroup, so one mock serves both
        # the initial existence check and the post-create read-back; New-FGGroup
        # flips the flag.
        $script:made = $false
        Mock -ModuleName IdentityAtlas Get-FGGroup { if ($script:made) { [pscustomobject]@{ id = 'new1'; displayName = 'Brand New' } } else { @() } }
        Mock -ModuleName IdentityAtlas New-FGGroup { $script:made = $true }
        $r = Confirm-FGGroup -GroupName 'Brand New' -GroupDescription 'desc'
        Should -Invoke -ModuleName IdentityAtlas New-FGGroup -Exactly 1
        $r.id | Should -Be 'new1'
    }

    It 'creates the group (no description) when none exists' {
        $script:made = $false
        Mock -ModuleName IdentityAtlas Get-FGGroup { if ($script:made) { [pscustomobject]@{ id = 'new2'; displayName = 'No Desc' } } else { @() } }
        Mock -ModuleName IdentityAtlas New-FGGroup { $script:made = $true }
        $r = Confirm-FGGroup -GroupName 'No Desc'
        $r.id | Should -Be 'new2'
    }

    It 'throws when a created group cannot be read back' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { @() }   # never returns an id
        Mock -ModuleName IdentityAtlas New-FGGroup { }
        Mock -ModuleName IdentityAtlas Start-Sleep { }
        { Confirm-FGGroup -GroupName 'Ghost' } | Should -Throw '*could not be read back*'
    }
}

# ─── Confirm-FGUser ───────────────────────────────────────────────
Describe 'Confirm-FGUser' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'returns the user when exactly one matches' {
        Mock -ModuleName IdentityAtlas Get-FGUser { [pscustomobject]@{ id = 'u1'; userPrincipalName = 'a@x.com' } }
        (Confirm-FGUser -userPrincipalName 'a@x.com').id | Should -Be 'u1'
    }

    It 'accepts the UPN alias' {
        Mock -ModuleName IdentityAtlas Get-FGUser { [pscustomobject]@{ id = 'u1'; userPrincipalName = 'a@x.com' } }
        (Confirm-FGUser -UPN 'a@x.com').id | Should -Be 'u1'
    }

    It 'throws when more than one user matches' {
        Mock -ModuleName IdentityAtlas Get-FGUser { @(
            [pscustomobject]@{ id = 'u1' }, [pscustomobject]@{ id = 'u2' }
        ) }
        { Confirm-FGUser -userPrincipalName 'dup@x.com' } | Should -Throw '*More than one user*'
    }

    It 'returns nothing when the user is not found' {
        Mock -ModuleName IdentityAtlas Get-FGUser { @() }
        $r = Confirm-FGUser -userPrincipalName 'missing@x.com'
        $r | Should -BeNullOrEmpty
    }
}

# ─── Resolve-FGMemberObjectIds ────────────────────────────────────
Describe 'Resolve-FGMemberObjectIds' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'returns $null when Members is empty / not supplied' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { }
        Mock -ModuleName IdentityAtlas Get-FGUser { }
        Resolve-FGMemberObjectIds -GroupName 'G' | Should -BeNullOrEmpty
    }

    It 'resolves a member that is a group display name' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { [pscustomobject]@{ id = 'grp-1' } }
        Mock -ModuleName IdentityAtlas Get-FGUser { }
        Resolve-FGMemberObjectIds -GroupName 'G' -Members @('SubGroup') | Should -Be 'grp-1'
    }

    It 'resolves a member that is a user UPN when no group matches' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { }
        Mock -ModuleName IdentityAtlas Get-FGUser { [pscustomobject]@{ id = 'usr-1' } }
        Resolve-FGMemberObjectIds -GroupName 'G' -Members @('bob@x.com') | Should -Be 'usr-1'
    }

    It 'resolves multiple members in order' {
        # Get-FGGroup's real param is DisplayName (alias GroupName); Get-FGUser's
        # is userPrincipalName (alias UPN). The helper calls them with -DisplayName
        # and -UPN, but inside the mock body the bound variable uses the real name.
        Mock -ModuleName IdentityAtlas Get-FGGroup { if ($DisplayName -eq 'SubGroup') { [pscustomobject]@{ id = 'grp-1' } } }
        Mock -ModuleName IdentityAtlas Get-FGUser  { if ($userPrincipalName -eq 'bob@x.com') { [pscustomobject]@{ id = 'usr-1' } } }
        $r = Resolve-FGMemberObjectIds -GroupName 'G' -Members @('SubGroup', 'bob@x.com')
        $r | Should -Be @('grp-1', 'usr-1')
    }

    It 'throws when a member matches neither group nor user' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { }
        Mock -ModuleName IdentityAtlas Get-FGUser { }
        { Resolve-FGMemberObjectIds -GroupName 'G' -Members @('nobody') } | Should -Throw '*could not be found*'
    }

    It 'throws when a member matches more than one group' {
        Mock -ModuleName IdentityAtlas Get-FGGroup { [pscustomobject]@{ id = @('a', 'b') } }
        Mock -ModuleName IdentityAtlas Get-FGUser { }
        { Resolve-FGMemberObjectIds -GroupName 'G' -Members @('Ambiguous') } | Should -Throw '*More than one possible match*'
    }
}

# ─── Confirm-FGGroupMember ────────────────────────────────────────
Describe 'Confirm-FGGroupMember' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'adds desired members when the group currently has none' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { @('m1', 'm2') }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { }   # no current members -> .id is $null
        Mock -ModuleName IdentityAtlas Add-FGGroupMember { }
        Confirm-FGGroupMember -GroupName 'g1' -Members @('a', 'b')
        Should -Invoke -ModuleName IdentityAtlas Add-FGGroupMember -Exactly 2
    }

    It 'removes current members when none are desired and RemoveMembers is set' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { $null }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { [pscustomobject]@{ id = 'cur1' }, [pscustomobject]@{ id = 'cur2' } }
        Mock -ModuleName IdentityAtlas Remove-FGGroupMember { }
        Confirm-FGGroupMember -GroupName 'g1' -Members @() -RemoveMembers $true
        Should -Invoke -ModuleName IdentityAtlas Remove-FGGroupMember -Exactly 2
    }

    It 'does not remove current members when RemoveMembers is not set' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { $null }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { [pscustomobject]@{ id = 'cur1' } }
        Mock -ModuleName IdentityAtlas Remove-FGGroupMember { }
        Confirm-FGGroupMember -GroupName 'g1' -Members @()
        Should -Invoke -ModuleName IdentityAtlas Remove-FGGroupMember -Exactly 0
    }

    It 'reconciles the diff: adds missing and removes extra (RemoveMembers on)' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { @('keep', 'add') }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { [pscustomobject]@{ id = 'keep' }, [pscustomobject]@{ id = 'remove' } }
        Mock -ModuleName IdentityAtlas Add-FGGroupMember { }
        Mock -ModuleName IdentityAtlas Remove-FGGroupMember { }
        Confirm-FGGroupMember -GroupName 'g1' -Members @('keep', 'add') -RemoveMembers $true
        Should -Invoke -ModuleName IdentityAtlas Add-FGGroupMember -Exactly 1 -ParameterFilter { $MemberId -eq 'add' }
        Should -Invoke -ModuleName IdentityAtlas Remove-FGGroupMember -Exactly 1 -ParameterFilter { $MemberId -eq 'remove' }
    }

    It 'makes no changes when current and desired members are identical' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { @('same1', 'same2') }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { [pscustomobject]@{ id = 'same1' }, [pscustomobject]@{ id = 'same2' } }
        Mock -ModuleName IdentityAtlas Add-FGGroupMember { }
        Mock -ModuleName IdentityAtlas Remove-FGGroupMember { }
        Confirm-FGGroupMember -GroupName 'g1' -Members @('same1', 'same2')
        Should -Invoke -ModuleName IdentityAtlas Add-FGGroupMember -Exactly 0
        Should -Invoke -ModuleName IdentityAtlas Remove-FGGroupMember -Exactly 0
    }
}

# ─── Confirm-FGNotGroupMember ─────────────────────────────────────
Describe 'Confirm-FGNotGroupMember' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'removes the listed member when it is currently in the group' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { @('m1') }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { [pscustomobject]@{ id = 'm1' }, [pscustomobject]@{ id = 'other' } }
        Mock -ModuleName IdentityAtlas Remove-FGGroupMember { }
        Confirm-FGNotGroupMember -GroupName 'g1' -Members @('a')
        Should -Invoke -ModuleName IdentityAtlas Remove-FGGroupMember -Exactly 1 -ParameterFilter { $MemberId -eq 'm1' }
    }

    It 'does nothing when the listed member is not in the group' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { @('m1') }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { [pscustomobject]@{ id = 'other' } }
        Mock -ModuleName IdentityAtlas Remove-FGGroupMember { }
        Confirm-FGNotGroupMember -GroupName 'g1' -Members @('a')
        Should -Invoke -ModuleName IdentityAtlas Remove-FGGroupMember -Exactly 0
    }

    It 'does nothing when the group has no current members' {
        Mock -ModuleName IdentityAtlas Confirm-FGGroup { [pscustomobject]@{ id = 'g1' } }
        Mock -ModuleName IdentityAtlas Resolve-FGMemberObjectIds { @('m1') }
        Mock -ModuleName IdentityAtlas Get-FGGroupMember { }
        Mock -ModuleName IdentityAtlas Remove-FGGroupMember { }
        Confirm-FGNotGroupMember -GroupName 'g1' -Members @('a')
        Should -Invoke -ModuleName IdentityAtlas Remove-FGGroupMember -Exactly 0
    }
}

# ─── Confirm-FGCatalog ────────────────────────────────────────────
Describe 'Confirm-FGCatalog' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'returns the catalog when exactly one matches' {
        Mock -ModuleName IdentityAtlas Get-FGCatalog { [pscustomobject]@{ id = 'c1'; displayName = 'Cat' } }
        $r = Confirm-FGCatalog -CatalogName 'Cat' -Description 'd' -IsExternallyVisible 'true'
        $r.id | Should -Be 'c1'
    }

    It 'throws when more than one catalog matches' {
        Mock -ModuleName IdentityAtlas Get-FGCatalog { @(
            [pscustomobject]@{ id = 'c1'; displayName = 'Cat' },
            [pscustomobject]@{ id = 'c2'; displayName = 'Cat' }
        ) }
        { Confirm-FGCatalog -CatalogName 'Cat' -Description 'd' -IsExternallyVisible 'true' } | Should -Throw '*More than one catalog*'
    }

    It 'creates the catalog when none exists and returns it on re-read' {
        $script:made = $false
        Mock -ModuleName IdentityAtlas Get-FGCatalog {
            if ($script:made) { [pscustomobject]@{ id = 'cN'; displayName = 'New Cat' } } else { @() }
        }
        Mock -ModuleName IdentityAtlas New-FGCatalog { $script:made = $true }
        $r = Confirm-FGCatalog -CatalogName 'New Cat' -Description 'd' -IsExternallyVisible 'false'
        Should -Invoke -ModuleName IdentityAtlas New-FGCatalog -Exactly 1
        $r.id | Should -Be 'cN'
    }
}

# ─── Confirm-FGGroupInCatalog ─────────────────────────────────────
Describe 'Confirm-FGGroupInCatalog' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'confirms a group that is already in the catalog' {
        Mock -ModuleName IdentityAtlas Get-FGCatalogGroup { [pscustomobject]@{ id = 'cg1'; displayName = 'Eng' } }
        Mock -ModuleName IdentityAtlas Add-FGGroupToCatalog { }
        $cat = [pscustomobject]@{ id = 'c1'; displayName = 'Cat' }
        $r = Confirm-FGGroupInCatalog -Catalog $cat -GroupName 'Eng'
        Should -Invoke -ModuleName IdentityAtlas Add-FGGroupToCatalog -Exactly 0
        $r.id | Should -Be 'cg1'
    }

    It 'throws when more than one catalog group matches' {
        Mock -ModuleName IdentityAtlas Get-FGCatalogGroup { @(
            [pscustomobject]@{ id = 'cg1'; displayName = 'Eng' },
            [pscustomobject]@{ id = 'cg2'; displayName = 'Eng' }
        ) }
        $cat = [pscustomobject]@{ id = 'c1'; displayName = 'Cat' }
        { Confirm-FGGroupInCatalog -Catalog $cat -GroupName 'Eng' } | Should -Throw '*More than one group*'
    }

    It 'adds the group to the catalog when not present, then returns it' {
        $script:added = $false
        Mock -ModuleName IdentityAtlas Get-FGCatalogGroup {
            if ($script:added) { [pscustomobject]@{ id = 'cgN'; displayName = 'Eng' } } else { @() }
        }
        Mock -ModuleName IdentityAtlas Add-FGGroupToCatalog { $script:added = $true }
        $cat = [pscustomobject]@{ id = 'c1'; displayName = 'Cat' }
        $r = Confirm-FGGroupInCatalog -Catalog $cat -GroupName 'Eng'
        Should -Invoke -ModuleName IdentityAtlas Add-FGGroupToCatalog -Exactly 1
        $r.id | Should -Be 'cgN'
    }
}

# ─── Confirm-FGAccessPackage ──────────────────────────────────────
Describe 'Confirm-FGAccessPackage' {
    BeforeAll {
        $Global:AccessToken = 'fake-token'
        $script:cat = [pscustomobject]@{ id = 'c1'; displayName = 'Cat' }
    }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    # Note: the helper calls Get-AccessPackage (line 17) AND Get-FGAccessPackage
    # (line 41); the former is an alias of the latter, so a single
    # Get-FGAccessPackage mock serves both call sites.
    It 'confirms an existing AP and leaves matching description alone' {
        Mock -ModuleName IdentityAtlas Get-FGAccessPackage { [pscustomobject]@{ id = 'ap1'; displayName = 'AP'; catalogId = 'c1'; Description = 'd' } }
        Mock -ModuleName IdentityAtlas Set-FGAccessPackage { }
        $r = Confirm-FGAccessPackage -Catalog $script:cat -DisplayName 'AP' -Description 'd'
        Should -Invoke -ModuleName IdentityAtlas Set-FGAccessPackage -Exactly 0
        $r.id | Should -Be 'ap1'
    }

    It 'updates the description of an existing AP when it differs' {
        Mock -ModuleName IdentityAtlas Get-FGAccessPackage { [pscustomobject]@{ id = 'ap1'; displayName = 'AP'; catalogId = 'c1'; Description = 'old' } }
        Mock -ModuleName IdentityAtlas Set-FGAccessPackage { }
        Confirm-FGAccessPackage -Catalog $script:cat -DisplayName 'AP' -Description 'new' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Set-FGAccessPackage -Exactly 1
    }

    It 'throws when more than one AP matches' {
        Mock -ModuleName IdentityAtlas Get-FGAccessPackage { @(
            [pscustomobject]@{ id = 'ap1'; displayName = 'AP'; catalogId = 'c1' },
            [pscustomobject]@{ id = 'ap2'; displayName = 'AP'; catalogId = 'c1' }
        ) }
        { Confirm-FGAccessPackage -Catalog $script:cat -DisplayName 'AP' -Description 'd' } | Should -Throw '*More than one AccessPackage*'
    }

    It 'creates a new AP when none exists' {
        $script:made = $false
        Mock -ModuleName IdentityAtlas New-FGAccessPackage { $script:made = $true }
        Mock -ModuleName IdentityAtlas Get-FGAccessPackage { if ($script:made) { [pscustomobject]@{ id = 'apN'; displayName = 'AP'; catalogId = 'c1' } } else { @() } }
        $r = Confirm-FGAccessPackage -Catalog $script:cat -DisplayName 'AP' -Description 'd'
        Should -Invoke -ModuleName IdentityAtlas New-FGAccessPackage -Exactly 1
        $r.id | Should -Be 'apN'
    }
}

# ─── Confirm-FGAccessPackagePolicy ────────────────────────────────
Describe 'Confirm-FGAccessPackagePolicy' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'throws when the policy has no accessPackageId' {
        $p = [pscustomobject]@{ displayName = 'P' }
        { Confirm-FGAccessPackagePolicy -Policy $p } | Should -Throw "*doesn't contain accessPackageId*"
    }

    It 'throws when the policy has no displayName' {
        $p = [pscustomobject]@{ accessPackageId = 'ap1' }
        { Confirm-FGAccessPackagePolicy -Policy $p } | Should -Throw "*doesn't contain displayName*"
    }

    It 'updates an existing matching policy' {
        $p = [pscustomobject]@{ accessPackageId = 'ap1'; displayName = 'P' }
        Mock -ModuleName IdentityAtlas Get-FGAccessPackagesPolicy { [pscustomobject]@{ id = 'pol1'; displayName = 'P'; accessPackageId = 'ap1' } }
        Mock -ModuleName IdentityAtlas Set-FGAccessPackagePolicy { }
        $r = Confirm-FGAccessPackagePolicy -Policy $p
        Should -Invoke -ModuleName IdentityAtlas Set-FGAccessPackagePolicy -Exactly 1
        $r.id | Should -Be 'pol1'
    }

    It 'throws when more than one policy matches' {
        $p = [pscustomobject]@{ accessPackageId = 'ap1'; displayName = 'P' }
        Mock -ModuleName IdentityAtlas Get-FGAccessPackagesPolicy { @(
            [pscustomobject]@{ id = 'pol1'; displayName = 'P'; accessPackageId = 'ap1' },
            [pscustomobject]@{ id = 'pol2'; displayName = 'P'; accessPackageId = 'ap1' }
        ) }
        { Confirm-FGAccessPackagePolicy -Policy $p } | Should -Throw '*More than one policy*'
    }

    It 'creates a new policy when none matches' {
        $p = [pscustomobject]@{ accessPackageId = 'ap1'; displayName = 'P' }
        $script:made = $false
        Mock -ModuleName IdentityAtlas Get-FGAccessPackagesPolicy { if ($script:made) { [pscustomobject]@{ id = 'polN'; displayName = 'P'; accessPackageId = 'ap1' } } else { @() } }
        Mock -ModuleName IdentityAtlas New-FGAccessPackagePolicy { $script:made = $true }
        $r = Confirm-FGAccessPackagePolicy -Policy $p
        Should -Invoke -ModuleName IdentityAtlas New-FGAccessPackagePolicy -Exactly 1
        $r.id | Should -Be 'polN'
    }
}

# ─── Confirm-FGAccessPackageResource ──────────────────────────────
Describe 'Confirm-FGAccessPackageResource' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { Remove-Variable -Name AccessToken -Scope Global -ErrorAction SilentlyContinue }

    It 'confirms an already-linked resource without re-adding it' {
        $ap    = [pscustomobject]@{ id = 'ap1'; displayName = 'AP' }
        $group = [pscustomobject]@{ id = 'grp1'; displayName = 'Eng' }
        $cg    = [pscustomobject]@{ id = 'cg1' }
        Mock -ModuleName IdentityAtlas Get-FGAccessPackagesResource {
            [pscustomobject]@{
                accessPackageResourceRoleScopes = [pscustomobject]@{
                    accessPackageResourceScope = [pscustomobject]@{ originId = 'grp1' }
                }
            }
        }
        Mock -ModuleName IdentityAtlas Add-FGGroupToAccessPackage {}
        Confirm-FGAccessPackageResource -AccessPackage $ap -Group $group -CatalogGroup $cg | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Add-FGGroupToAccessPackage -Exactly 0
    }

    It 'adds the resource when it is not yet linked' {
        $ap    = [pscustomobject]@{ id = 'ap1'; displayName = 'AP' }
        $group = [pscustomobject]@{ id = 'grp1'; displayName = 'Eng' }
        $cg    = [pscustomobject]@{ id = 'cg1' }
        Mock -ModuleName IdentityAtlas Get-FGAccessPackagesResource {
            [pscustomobject]@{
                accessPackageResourceRoleScopes = [pscustomobject]@{
                    accessPackageResourceScope = [pscustomobject]@{ originId = 'someoneelse' }
                }
            }
        }
        Mock -ModuleName IdentityAtlas Add-FGGroupToAccessPackage {}
        Confirm-FGAccessPackageResource -AccessPackage $ap -Group $group -CatalogGroup $cg | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Add-FGGroupToAccessPackage -Exactly 1 -ParameterFilter { $GroupId -eq 'grp1' }
    }
}

# ─── Get-FGServicePrincipalType (additional branch cases) ─────────
Describe 'Get-FGServicePrincipalType — additional cases' {
    It 'skips empty / null tag entries without misclassifying' {
        $sp = [pscustomobject]@{
            displayName          = 'Plain App'
            servicePrincipalType = 'Application'
            tags                 = @($null, '', 'WindowsAzureActiveDirectoryIntegratedApp')
        }
        Get-FGServicePrincipalType -ServicePrincipal $sp | Should -Be 'ServicePrincipal'
    }

    It 'matches the cognitive-service built-in name pattern' {
        $sp = [pscustomobject]@{ displayName = 'my-cognitive-service-host'; servicePrincipalType = 'Application'; tags = @() }
        Get-FGServicePrincipalType -ServicePrincipal $sp | Should -Be 'AIAgent'
    }

    It 'ignores blank entries in caller-supplied AINamePatterns' {
        $sp = [pscustomobject]@{ displayName = 'ordinary-svc'; servicePrincipalType = 'Application'; tags = @() }
        Get-FGServicePrincipalType -ServicePrincipal $sp -AINamePatterns @('', $null) | Should -Be 'ServicePrincipal'
    }
}

# ─── Test-FGDistinguishedName (additional branch cases) ───────────
Describe 'Test-FGDistinguishedName — additional cases' {
    It 'accepts a UID-prefixed DN' {
        Test-FGDistinguishedName 'UID=jdoe,OU=People,DC=example,DC=com' | Should -BeTrue
    }
    It 'rejects a value with a comma but only one RDN prefix' {
        Test-FGDistinguishedName 'CN=admin, the boss' | Should -BeFalse
    }
}

# ─── Convert-FGDistinguishedNameToOUPath (additional cases) ───────
Describe 'Convert-FGDistinguishedNameToOUPath — additional cases' {
    It 'returns whitespace-only input as $null' {
        Convert-FGDistinguishedNameToOUPath '   ' | Should -BeNullOrEmpty
    }
    It 'handles a single OU segment' {
        Convert-FGDistinguishedNameToOUPath 'CN=x,OU=Only,DC=c' | Should -Be 'Only'
    }
}

# ─── Get-FGEntraPortalLink (Application branches) ─────────────────
Describe 'Get-FGEntraPortalLink — Application type' {
    BeforeAll {
        $script:objId = '55555555-5555-5555-5555-555555555555'
        $script:appId = '66666666-6666-6666-6666-666666666666'
    }
    It 'produces an Application URL with both appId and objectId' {
        $link = Get-FGEntraPortalLink -Id $script:objId -AppId $script:appId -Type 'Application'
        $link | Should -Match 'ApplicationMenuBlade'
        $link | Should -Match ([regex]::Escape($script:appId))
        $link | Should -Match ([regex]::Escape($script:objId))
    }
    It 'falls back to objectId-only Application URL when appId missing' {
        $link = Get-FGEntraPortalLink -Id $script:objId -Type 'Application'
        $link | Should -Match 'ApplicationMenuBlade'
        $link | Should -Match ([regex]::Escape($script:objId))
        $link | Should -Not -Match 'appId'
    }
    It 'returns $null for whitespace-only id' {
        Get-FGEntraPortalLink -Id '   ' -Type 'User' | Should -BeNullOrEmpty
    }
    It 'produces a User profile blade URL' {
        $link = Get-FGEntraPortalLink -Id $script:objId -Type 'User'
        $link | Should -Match 'UserProfileMenuBlade'
        $link | Should -Match ([regex]::Escape($script:objId))
    }
    It 'produces a Group details blade URL' {
        $link = Get-FGEntraPortalLink -Id $script:objId -Type 'Group'
        $link | Should -Match 'GroupDetailsMenuBlade'
        $link | Should -Match ([regex]::Escape($script:objId))
    }
    It 'produces a ServicePrincipal (Enterprise App) URL with appId when supplied' {
        $link = Get-FGEntraPortalLink -Id $script:objId -AppId $script:appId -Type 'ServicePrincipal'
        $link | Should -Match 'ManagedAppMenuBlade'
        $link | Should -Match ([regex]::Escape($script:appId))
    }
    It 'produces a ServicePrincipal URL without the appId segment when appId is missing' {
        $link = Get-FGEntraPortalLink -Id $script:objId -Type 'ServicePrincipal'
        $link | Should -Match 'ManagedAppMenuBlade'
        $link | Should -Not -Match '/appId/'
    }
}
