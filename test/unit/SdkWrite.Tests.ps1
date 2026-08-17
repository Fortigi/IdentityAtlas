#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester 5 unit tests for the IdentityAtlas PowerShell SDK write / config /
    JSON-file functions (tools/powershell-sdk/graph).

.DESCRIPTION
    Covers the WRITE wrappers (POST/PATCH/PUT/DELETE Graph helpers), the secure
    local config helpers (Get/Clear/Test-FGSecureConfigValue), Update-FGConfig,
    and the pure JSON-file transforms (Merge-FGJsonArrayFile,
    Remove-FGTrailingCommaFromJsonFile).

    The Graph write helpers (Invoke-FGPostRequest / Invoke-FGPatchRequest /
    Invoke-FGPutRequest / Invoke-FGDeleteRequest / Invoke-FGGetRequest) are
    mocked at module scope so no real HTTP is performed. Start-Sleep is mocked
    so the 45s waits in the catalog/access-package helpers don't slow the suite.

.USAGE
    Invoke-Pester -Path test/unit/SdkWrite.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    Import-Module (Join-Path $script:repoRoot 'setup/IdentityAtlas.psd1') -Force -ErrorAction Stop
}

# ─────────────────────────────────────────────────────────────────────────────
#  POST wrappers
# ─────────────────────────────────────────────────────────────────────────────

Describe 'Add-FGGroupMember' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs the member $ref to the group' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'ok' }
        $r = Add-FGGroupMember -Id 'g1' -MemberId 'u1'
        $r | Should -Be 'ok'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*groups/g1/members/$ref' -and
            $Body['@odata.id'] -like '*directoryObjects/u1'
        }
    }
}

Describe 'Add-FGGroupToAccessPackage' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs a resource-role-scope with origin ids derived from GroupID/CatalogGroupID' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'rrs' }
        Mock -ModuleName IdentityAtlas Start-Sleep {}
        $r = Add-FGGroupToAccessPackage -AccessPackageID 'ap1' -GroupID 'grp1' -CatalogGroupID 'cat1'
        $r | Should -Be 'rrs'
        Should -Invoke -ModuleName IdentityAtlas Start-Sleep -Exactly 1
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like "*accessPackages/ap1/accessPackageResourceRoleScopes" -and
            $Body.accessPackageResourceRole.originId -eq 'Member_grp1' -and
            $Body.accessPackageResourceRole.accessPackageResource.id -eq 'cat1' -and
            $Body.accessPackageResourceRole.accessPackageResource.originId -eq 'grp1' -and
            $Body.accessPackageResourceScope.originId -eq 'grp1'
        }
    }
}

Describe 'Add-FGGroupToCatalog' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'looks up the group then POSTs an AdminAdd resource request' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'req' }
        Mock -ModuleName IdentityAtlas Start-Sleep {}
        Mock -ModuleName IdentityAtlas Get-Group { [pscustomobject]@{ id = 'gid-99' } }
        $r = Add-FGGroupToCatalog -CatalogId 'c1' -GroupName 'My Group'
        $r | Should -Be 'req'
        Should -Invoke -ModuleName IdentityAtlas Get-Group -Exactly 1
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*accessPackageResourceRequests' -and
            $Body.catalogId -eq 'c1' -and
            $Body.requestType -eq 'AdminAdd' -and
            $Body.accessPackageResource.originId -eq 'gid-99'
        }
    }
}

Describe 'New-FGAccessPackage' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs an access package with catalogId/displayName/description' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'ap' }
        $r = New-FGAccessPackage -CatalogId 'c1' -DisplayName 'AP' -Description 'desc'
        $r | Should -Be 'ap'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*entitlementManagement/accessPackages' -and
            $Body.catalogId -eq 'c1' -and $Body.displayName -eq 'AP' -and $Body.description -eq 'desc'
        }
    }
}

Describe 'New-FGAccessPackagePolicy' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs the supplied policy object verbatim' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'pol' }
        $policy = @{ displayName = 'P'; foo = 'bar' }
        $r = New-FGAccessPackagePolicy -Policy $policy
        $r | Should -Be 'pol'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*accessPackageAssignmentPolicies' -and $Body.foo -eq 'bar'
        }
    }
}

Describe 'New-FGCatalog' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs a catalog with displayName/description/isExternallyVisible' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'cat' }
        $r = New-FGCatalog -CatalogName 'Cat' -Description 'd' -IsExternallyVisible 'false'
        $r | Should -Be 'cat'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*accessPackageCatalogs' -and
            $Body.displayName -eq 'Cat' -and $Body.isExternallyVisible -eq 'false'
        }
    }
}

Describe 'New-FGConnectedOrganization' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs a connected org with a domain identity source' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'org' }
        $r = New-FGConnectedOrganization -DisplayName 'Org' -Description 'd' -DomainName 'contoso.com'
        $r | Should -Be 'org'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*connectedOrganizations/' -and
            $Body.displayName -eq 'Org' -and
            $Body.state -eq 'configured' -and
            $Body.identitySources[0].domainName -eq 'contoso.com' -and
            $Body.identitySources[0].'@odata.type' -eq '#microsoft.graph.domainIdentitySource'
        }
    }
}

Describe 'New-FGGroup' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs a security group, defaulting mailNickname from the display name' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'grp' }
        $r = New-FGGroup -DisplayName 'My Group'
        $r | Should -Be 'grp'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*beta/groups' -and
            $Body.displayName -eq 'My Group' -and
            $Body.mailNickname -eq 'mygroup' -and
            $Body.securityEnabled -eq $true -and
            $Body.mailEnabled -eq $false
        }
    }

    It 'honours explicit optional parameters' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'grp2' }
        New-FGGroup -DisplayName 'X' -Description 'hello' -mailEnabled $true -mailNickname 'nick' -SecurityEnabled $false
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $Body.description -eq 'hello' -and $Body.mailNickname -eq 'nick' -and
            $Body.mailEnabled -eq $true -and $Body.securityEnabled -eq $false
        }
    }
}

Describe 'New-FGServicePrincipalSecret' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'POSTs addPassword with a default description' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'secret' }
        $r = New-FGServicePrincipalSecret -ServicePrincipalObjectID 'sp1'
        $r | Should -Be 'secret'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*servicePrincipals/sp1/addPassword' -and
            $Body.passwordCredential.displayName -like 'Created by*'
        }
    }

    It 'uses a supplied secret description' {
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'secret2' }
        New-FGServicePrincipalSecret -ServicePrincipalObjectID 'sp1' -SecretDescription 'mine'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $Body.passwordCredential.displayName -eq 'mine'
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
#  PATCH / PUT wrappers
# ─────────────────────────────────────────────────────────────────────────────

Describe 'Set-FGAccessPackage' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'PATCHes the access package with the supplied updates' {
        Mock -ModuleName IdentityAtlas Invoke-FGPatchRequest { 'patched' }
        $r = Set-FGAccessPackage -ObjectId 'ap1' -Updates @{ displayName = 'new' }
        $r | Should -Be 'patched'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPatchRequest -Exactly 1 -ParameterFilter {
            $URI -like '*accessPackages/ap1' -and $Body.displayName -eq 'new'
        }
    }
}

Describe 'Set-FGAccessPackagePolicy' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'PUTs the policy at the policy id URL' {
        Mock -ModuleName IdentityAtlas Invoke-FGPutRequest { 'put' }
        $r = Set-FGAccessPackagePolicy -Policy @{ a = 1 } -PolicyID 'pol1'
        $r | Should -Be 'put'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPutRequest -Exactly 1 -ParameterFilter {
            $URI -like '*accessPackageAssignmentPolicies/pol1' -and $Body.a -eq 1
        }
    }
}

Describe 'Set-FGDevice' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'PATCHes the device with the supplied updates' {
        Mock -ModuleName IdentityAtlas Invoke-FGPatchRequest { 'dev' }
        $r = Set-FGDevice -DeviceId 'd1' -Updates @{ accountEnabled = $false }
        $r | Should -Be 'dev'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPatchRequest -Exactly 1 -ParameterFilter {
            $URI -like '*beta/devices/d1' -and $Body.accountEnabled -eq $false
        }
    }
}

Describe 'Set-FGUser' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'PATCHes the user with the supplied updates' {
        Mock -ModuleName IdentityAtlas Invoke-FGPatchRequest { 'usr' }
        $r = Set-FGUser -ObjectId 'u1' -Updates @{ jobTitle = 'CEO' }
        $r | Should -Be 'usr'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPatchRequest -Exactly 1 -ParameterFilter {
            $URI -like '*beta/users/u1' -and $Body.jobTitle -eq 'CEO'
        }
    }
}

Describe 'Set-FGGroup' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'PATCHes the group with only the bound Description property' {
        Mock -ModuleName IdentityAtlas Invoke-FGPatchRequest { 'ok' }
        Set-FGGroup -ObjectId 'g1' -Description 'd' | Should -Be 'ok'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPatchRequest -ParameterFilter {
            $URI -like '*groups/g1*' -and $Body.ContainsKey('Description') -and -not $Body.ContainsKey('Displayname')
        }
    }

    It 'includes Displayname only when it is supplied' {
        Mock -ModuleName IdentityAtlas Invoke-FGPatchRequest { 'ok' }
        Set-FGGroup -ObjectId 'g1' -Displayname 'New name' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPatchRequest -ParameterFilter {
            $Body.ContainsKey('Displayname') -and -not $Body.ContainsKey('Description')
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
#  DELETE wrappers
# ─────────────────────────────────────────────────────────────────────────────

Describe 'Remove-FGAccessPackage' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'DELETEs the access package (no force, no assignment cleanup)' {
        Mock -ModuleName IdentityAtlas Invoke-FGDeleteRequest { 'deleted' }
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { @() }
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'should-not-run' }
        $r = Remove-FGAccessPackage -AccessPackageID 'ap1'
        $r | Should -Be 'deleted'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGDeleteRequest -Exactly 1 -ParameterFilter {
            $URI -like '*accessPackages/ap1'
        }
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -Exactly 0
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 0
    }

    It 'with -Force True removes active assignments then DELETEs the package' {
        Mock -ModuleName IdentityAtlas Invoke-FGDeleteRequest { 'deleted' }
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            @(
                [pscustomobject]@{ id = 'a1'; state = 'delivered'; accessPackage = [pscustomobject]@{ id = 'ap1' } },
                [pscustomobject]@{ id = 'a2'; state = 'expired';   accessPackage = [pscustomobject]@{ id = 'ap1' } },
                [pscustomobject]@{ id = 'a3'; state = 'delivered'; accessPackage = [pscustomobject]@{ id = 'other' } }
            )
        }
        Mock -ModuleName IdentityAtlas Invoke-FGPostRequest { 'removed' }
        $r = Remove-FGAccessPackage -AccessPackageID 'ap1' -Force $true
        # The function emits the (uncaptured) AdminRemove POST result(s) plus the
        # final delete result, so the delete result is the last item in $r.
        @($r)[-1] | Should -Be 'deleted'
        # only a1 is active AND belongs to ap1 -> exactly one AdminRemove POST
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGPostRequest -Exactly 1 -ParameterFilter {
            $URI -like '*assignmentRequests' -and
            $Body.requestType -eq 'AdminRemove' -and
            $Body.assignment.id -eq 'a1'
        }
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGDeleteRequest -Exactly 1
    }
}

Describe 'Remove-FGDevice' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'DELETEs the device' {
        Mock -ModuleName IdentityAtlas Invoke-FGDeleteRequest { 'gone' }
        $r = Remove-FGDevice -Id 'd1'
        $r | Should -Be 'gone'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGDeleteRequest -Exactly 1 -ParameterFilter {
            $URI -like '*beta/devices/d1'
        }
    }
}

Describe 'Remove-FGGroupMember' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll  { $Global:AccessToken = $null }

    It 'DELETEs the member $ref' {
        Mock -ModuleName IdentityAtlas Invoke-FGDeleteRequest { 'removed' }
        $r = Remove-FGGroupMember -Id 'g1' -MemberId 'm1'
        $r | Should -Be 'removed'
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGDeleteRequest -Exactly 1 -ParameterFilter {
            $URI -like '*groups/g1/members/m1/$ref'
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
#  Update-FGConfig
# ─────────────────────────────────────────────────────────────────────────────

Describe 'Update-FGConfig' {

    It 'throws when the config file does not exist' {
        { Update-FGConfig -ConfigFile (Join-Path $TestDrive 'nope.json') } | Should -Throw
    }

    It 'reports no missing sections when config already matches template (Silent)' {
        $cfgPath = Join-Path $TestDrive 'cfg-full.json'
        $tplPath = Join-Path $TestDrive 'template.json'
        @{ Azure = @{}; Graph = @{}; LLM = @{}; Sync = @{ EntraGroups = @{} } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath
        @{ LLM = @{}; Sync = @{ EntraGroups = @{} } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $tplPath

        # Redirect the template lookup to our temp template.
        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }

        $result = Update-FGConfig -ConfigFile $cfgPath -Silent
        $result.Missing.Count | Should -Be 0
    }

    It 'reports missing top-level and Sync sections in Silent mode without modifying the file' {
        $cfgPath = Join-Path $TestDrive 'cfg-partial.json'
        $tplPath = Join-Path $TestDrive 'template2.json'
        @{ Azure = @{}; Sync = @{ EntraGroups = @{} } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath
        @{ Azure = @{}; RiskScoring = @{ enabled = $true }; Sync = @{ EntraGroups = @{}; Principals = @{ on = $true } } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $tplPath
        $before = Get-Content -Path $cfgPath -Raw

        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }

        $result = Update-FGConfig -ConfigFile $cfgPath -Silent
        $result.Missing | Should -Contain 'RiskScoring'
        $result.Missing | Should -Contain 'Principals'
        $result.Added.Count | Should -Be 0
        (Get-Content -Path $cfgPath -Raw) | Should -Be $before
    }

    It 'interactively adds a confirmed missing section and saves the file' {
        $cfgPath = Join-Path $TestDrive 'cfg-add.json'
        $tplPath = Join-Path $TestDrive 'template3.json'
        @{ Azure = @{}; Sync = @{ EntraGroups = @{} } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath
        @{ Azure = @{}; RiskScoring = @{ enabled = $true } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $tplPath

        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }
        Mock -ModuleName IdentityAtlas Read-Host { 'Y' }

        $result = Update-FGConfig -ConfigFile $cfgPath
        $result.Added | Should -Contain 'RiskScoring'
        $saved = Get-Content -Path $cfgPath -Raw | ConvertFrom-Json
        $saved.RiskScoring.enabled | Should -Be $true
    }

    It 'warns and returns when the template file is missing' {
        $cfgPath = Join-Path $TestDrive 'cfg-notpl.json'
        @{ Azure = @{} } | ConvertTo-Json | Set-Content -Path $cfgPath
        Mock -ModuleName IdentityAtlas Join-Path { Join-Path $TestDrive 'missing-template.json' } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }
        $result = Update-FGConfig -ConfigFile $cfgPath -Silent -WarningAction SilentlyContinue
        $result | Should -BeNullOrEmpty
    }

    It 'throws when the config file is empty / unparseable' {
        $cfgPath = Join-Path $TestDrive 'cfg-empty.json'
        Set-Content -Path $cfgPath -Value ''
        { Update-FGConfig -ConfigFile $cfgPath } | Should -Throw '*Failed to parse config file*'
    }

    It 'warns and returns when the template file is empty / unparseable' {
        $cfgPath = Join-Path $TestDrive 'cfg-badtpl.json'
        $tplPath = Join-Path $TestDrive 'template-empty.json'
        @{ Azure = @{} } | ConvertTo-Json | Set-Content -Path $cfgPath
        Set-Content -Path $tplPath -Value ''
        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }

        $result = Update-FGConfig -ConfigFile $cfgPath -Silent -WarningAction SilentlyContinue
        $result | Should -BeNullOrEmpty
    }

    It 'interactively adds a confirmed missing Sync sub-key and saves the file' {
        $cfgPath = Join-Path $TestDrive 'cfg-syncadd.json'
        $tplPath = Join-Path $TestDrive 'template-sync.json'
        @{ Azure = @{}; Sync = @{ EntraGroups = @{} } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath
        @{ Azure = @{}; Sync = @{ EntraGroups = @{}; Principals = @{ on = $true } } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $tplPath

        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }
        Mock -ModuleName IdentityAtlas Read-Host { 'Y' }

        $result = Update-FGConfig -ConfigFile $cfgPath
        $result.Added | Should -Contain 'Sync.Principals'
        $saved = Get-Content -Path $cfgPath -Raw | ConvertFrom-Json
        $saved.Sync.Principals.on | Should -Be $true
    }

    It 'truncates a long default preview when prompting' {
        # Template section whose compact-JSON default exceeds 120 chars triggers
        # the Substring(0,117)+"..." preview branch.
        $cfgPath = Join-Path $TestDrive 'cfg-trunc.json'
        $tplPath = Join-Path $TestDrive 'template-long.json'
        @{ Azure = @{} } | ConvertTo-Json | Set-Content -Path $cfgPath
        @{
            Azure       = @{}
            RiskScoring = @{
                enabled    = $false
                classifier = 'a-very-long-default-classifier-name-that-keeps-going-and-going'
                weights    = @{ admin = 10; guest = 1; external = 5; stale = 3; orphan = 7 }
                thresholds = @{ low = 1; medium = 5; high = 9; critical = 99 }
            }
        } | ConvertTo-Json -Depth 5 | Set-Content -Path $tplPath

        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }
        Mock -ModuleName IdentityAtlas Read-Host { 'N' }

        Update-FGConfig -ConfigFile $cfgPath | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Read-Host -Exactly 1
    }

    It 'truncates a long default preview for a missing Sync sub-key' {
        $cfgPath = Join-Path $TestDrive 'cfg-trunc-sync.json'
        $tplPath = Join-Path $TestDrive 'template-long-sync.json'
        @{ Azure = @{}; Sync = @{ EntraGroups = @{} } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath
        @{
            Azure = @{}
            Sync  = @{
                EntraGroups = @{}
                Principals  = @{
                    enabled    = $true
                    attributes = @('displayName', 'mail', 'department', 'jobTitle', 'manager', 'employeeId', 'officeLocation')
                    filters    = @{ includeGuests = $false; onlyEnabled = $true; minLastSignIn = '2020-01-01' }
                }
            }
        } | ConvertTo-Json -Depth 6 | Set-Content -Path $tplPath

        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }
        Mock -ModuleName IdentityAtlas Read-Host { 'N' }

        Update-FGConfig -ConfigFile $cfgPath | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Read-Host -Exactly 1
    }

    It 'warns but does not throw when saving the updated config fails' {
        $cfgPath = Join-Path $TestDrive 'cfg-savefail.json'
        $tplPath = Join-Path $TestDrive 'template-savefail.json'
        @{ Azure = @{} } | ConvertTo-Json | Set-Content -Path $cfgPath
        @{ Azure = @{}; RiskScoring = @{ enabled = $true } } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $tplPath

        Mock -ModuleName IdentityAtlas Join-Path { $tplPath } -ParameterFilter { $ChildPath -like '*tenantname.json.template' }
        Mock -ModuleName IdentityAtlas Read-Host { 'Y' }
        Mock -ModuleName IdentityAtlas Set-Content { throw 'disk full' } -ParameterFilter { $Path -eq $cfgPath }

        { Update-FGConfig -ConfigFile $cfgPath -WarningAction SilentlyContinue } | Should -Not -Throw
    }
}

# ─────────────────────────────────────────────────────────────────────────────
#  Secure config helpers (filesystem-backed, DPAPI on Windows)
# ─────────────────────────────────────────────────────────────────────────────

Describe 'Test-FGSecureConfigValue' {

    It 'returns $false when the config file does not exist' {
        Test-FGSecureConfigValue -ConfigPath (Join-Path $TestDrive 'nope.json') -PropertyPath 'Graph.ClientSecret' |
            Should -Be $false
    }

    It 'returns $true for a non-empty plaintext value' {
        $p = Join-Path $TestDrive 'sc-plain.json'
        @{ Graph = @{ ClientSecret = 'abc' } } | ConvertTo-Json | Set-Content -Path $p
        Test-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' | Should -Be $true
    }

    It 'returns $true for an encrypted value' {
        $p = Join-Path $TestDrive 'sc-enc.json'
        @{ Graph = @{ ClientSecret_Encrypted = 'cipher' } } | ConvertTo-Json | Set-Content -Path $p
        Test-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' | Should -Be $true
    }

    It 'returns $false when the value is empty / absent' {
        $p = Join-Path $TestDrive 'sc-empty.json'
        @{ Graph = @{ ClientSecret = '' } } | ConvertTo-Json | Set-Content -Path $p
        Test-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' | Should -Be $false
    }

    It 'returns $false when an intermediate path segment is missing' {
        $p = Join-Path $TestDrive 'sc-nopath.json'
        @{ Other = @{} } | ConvertTo-Json | Set-Content -Path $p
        Test-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' | Should -Be $false
    }

    It 'returns $false on malformed JSON' {
        $p = Join-Path $TestDrive 'sc-bad.json'
        '{ not valid json' | Set-Content -Path $p
        Test-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' -WarningAction SilentlyContinue |
            Should -Be $false
    }
}

Describe 'Clear-FGSecureConfigValue' {

    It 'warns and returns when the config file does not exist' {
        { Clear-FGSecureConfigValue -ConfigPath (Join-Path $TestDrive 'nope.json') -PropertyPath 'Graph.ClientSecret' -WarningAction SilentlyContinue } |
            Should -Not -Throw
    }

    It 'removes both plaintext and encrypted variants and saves the file' {
        $p = Join-Path $TestDrive 'clear-both.json'
        @{ Graph = @{ ClientSecret = 'abc'; ClientSecret_Encrypted = 'cipher'; KeepMe = 'x' } } |
            ConvertTo-Json | Set-Content -Path $p
        Clear-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret'
        $after = Get-Content -Path $p -Raw | ConvertFrom-Json
        $after.Graph.PSObject.Properties.Name | Should -Not -Contain 'ClientSecret'
        $after.Graph.PSObject.Properties.Name | Should -Not -Contain 'ClientSecret_Encrypted'
        $after.Graph.KeepMe | Should -Be 'x'
    }

    It 'warns when an intermediate path segment is missing' {
        $p = Join-Path $TestDrive 'clear-nopath.json'
        @{ Other = @{} } | ConvertTo-Json | Set-Content -Path $p
        { Clear-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' -WarningAction SilentlyContinue } |
            Should -Not -Throw
    }

    It 'is a no-op (no error) when nothing is stored at the key' {
        $p = Join-Path $TestDrive 'clear-nothing.json'
        @{ Graph = @{ Other = 'y' } } | ConvertTo-Json | Set-Content -Path $p
        { Clear-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' } | Should -Not -Throw
    }
}

Describe 'Get-FGSecureConfigValue' {

    It 'throws when the config file does not exist' {
        { Get-FGSecureConfigValue -ConfigPath (Join-Path $TestDrive 'nope.json') -PropertyPath 'Graph.ClientSecret' } |
            Should -Throw
    }

    It 'migrates a plaintext value to encrypted storage and returns the plaintext' {
        $p = Join-Path $TestDrive 'get-migrate.json'
        @{ Graph = @{ ClientSecret = 'plainvalue' } } | ConvertTo-Json | Set-Content -Path $p
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret'
        $val | Should -Be 'plainvalue'
        $after = Get-Content -Path $p -Raw | ConvertFrom-Json
        # plaintext gone, encrypted present
        $after.Graph.PSObject.Properties.Name | Should -Not -Contain 'ClientSecret'
        $after.Graph.PSObject.Properties.Name | Should -Contain 'ClientSecret_Encrypted'
    }

    It 'decrypts and returns a previously-encrypted value' {
        # Create an encrypted value the same way the function would (DPAPI / round-trip)
        $cipher = 'roundtrip' | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
        $p = Join-Path $TestDrive 'get-enc.json'
        @{ Graph = @{ ClientSecret_Encrypted = $cipher } } | ConvertTo-Json | Set-Content -Path $p
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret'
        $val | Should -Be 'roundtrip'
    }

    It 'returns a SecureString when -AsSecureString is used on an encrypted value' {
        $cipher = 'secret!' | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
        $p = Join-Path $TestDrive 'get-enc-ss.json'
        @{ Graph = @{ ClientSecret_Encrypted = $cipher } } | ConvertTo-Json | Set-Content -Path $p
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' -AsSecureString
        $val | Should -BeOfType ([System.Security.SecureString])
    }

    It 'returns $null for a missing optional value when -AllowEmpty is set and the prompt is empty' {
        $p = Join-Path $TestDrive 'get-allowempty.json'
        @{ Graph = @{} } | ConvertTo-Json | Set-Content -Path $p
        # Prompt returns an empty SecureString
        Mock -ModuleName IdentityAtlas Read-Host { [System.Security.SecureString]::new() }
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' -AllowEmpty
        $val | Should -BeNullOrEmpty
    }

    It 'prompts, encrypts and stores a new value, returning the plaintext' {
        $p = Join-Path $TestDrive 'get-prompt.json'
        @{ Graph = @{} } | ConvertTo-Json | Set-Content -Path $p
        $ss = ConvertTo-SecureString 'typedSecret' -AsPlainText -Force
        Mock -ModuleName IdentityAtlas Read-Host { $ss }
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret'
        $val | Should -Be 'typedSecret'
        $after = Get-Content -Path $p -Raw | ConvertFrom-Json
        $after.Graph.PSObject.Properties.Name | Should -Contain 'ClientSecret_Encrypted'
    }

    It 'creates missing intermediate objects along a deep property path' {
        $p = Join-Path $TestDrive 'get-deep.json'
        @{ Other = 'x' } | ConvertTo-Json | Set-Content -Path $p
        $ss = ConvertTo-SecureString 'deepSecret' -AsPlainText -Force
        Mock -ModuleName IdentityAtlas Read-Host { $ss }

        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Azure.Sql.Password'

        $val | Should -Be 'deepSecret'
        $after = Get-Content -Path $p -Raw | ConvertFrom-Json
        $after.Azure.Sql.PSObject.Properties.Name | Should -Contain 'Password_Encrypted'
    }

    It 'returns a SecureString from the migrate path when -AsSecureString is set' {
        $p = Join-Path $TestDrive 'get-migrate-ss.json'
        @{ Graph = @{ ClientSecret = 'legacyPlain' } } | ConvertTo-Json | Set-Content -Path $p
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' -AsSecureString
        $val | Should -BeOfType ([System.Security.SecureString])
    }

    It 'returns a SecureString from the prompt path when -AsSecureString is set' {
        $p = Join-Path $TestDrive 'get-prompt-ss.json'
        @{ Graph = @{} } | ConvertTo-Json | Set-Content -Path $p
        $ss = ConvertTo-SecureString 'promptSecret' -AsPlainText -Force
        Mock -ModuleName IdentityAtlas Read-Host { $ss }
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' -AsSecureString
        $val | Should -BeOfType ([System.Security.SecureString])
    }

    It 're-prompts after an empty entry when -AllowEmpty is not set' {
        $p = Join-Path $TestDrive 'get-retry.json'
        @{ Graph = @{} } | ConvertTo-Json | Set-Content -Path $p
        $script:scPromptNo = 0
        Mock -ModuleName IdentityAtlas Read-Host {
            $script:scPromptNo++
            if ($script:scPromptNo -eq 1) { [System.Security.SecureString]::new() }
            else { ConvertTo-SecureString 'secondTry' -AsPlainText -Force }
        }
        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret'
        $val | Should -Be 'secondTry'
        Should -Invoke -ModuleName IdentityAtlas Read-Host -Exactly 2
    }

    It 'removes a pre-existing empty plaintext key when prompting for a new value' {
        $p = Join-Path $TestDrive 'get-emptykey.json'
        # Empty plaintext counts as "absent" (whitespace), so we prompt — but the key
        # still exists and must be removed before saving the encrypted value.
        @{ Graph = @{ ClientSecret = '' } } | ConvertTo-Json | Set-Content -Path $p
        Mock -ModuleName IdentityAtlas Read-Host { ConvertTo-SecureString 'fresh' -AsPlainText -Force }

        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret'

        $val | Should -Be 'fresh'
        $after = Get-Content -Path $p -Raw | ConvertFrom-Json
        $after.Graph.PSObject.Properties.Name | Should -Not -Contain 'ClientSecret'
        $after.Graph.PSObject.Properties.Name | Should -Contain 'ClientSecret_Encrypted'
    }

    It 'falls back to prompting when a stored blob cannot be decrypted (foreign user)' {
        $p = Join-Path $TestDrive 'get-foreign.json'
        @{ Graph = @{ ClientSecret_Encrypted = 'unreadable-blob' } } | ConvertTo-Json | Set-Content -Path $p
        Mock -ModuleName IdentityAtlas ConvertTo-SecureString { throw 'key not valid' }
        # Build the prompt result without ConvertTo-SecureString (which is mocked to throw above).
        Mock -ModuleName IdentityAtlas Read-Host {
            $s = [System.Security.SecureString]::new()
            foreach ($c in 'recovered'.ToCharArray()) { $s.AppendChar($c) }
            $s.MakeReadOnly()
            $s
        }

        $val = Get-FGSecureConfigValue -ConfigPath $p -PropertyPath 'Graph.ClientSecret' -WarningAction SilentlyContinue

        $val | Should -Be 'recovered'
    }
}

# ─────────────────────────────────────────────────────────────────────────────
#  Pure JSON-file transforms
# ─────────────────────────────────────────────────────────────────────────────

Describe 'Merge-FGJsonArrayFile' {

    It 'merges two consecutive arrays into one by replacing ][ with a comma' {
        $f = Join-Path $TestDrive 'merge.json'
        # Two page-arrays back to back: [ {..} ] [ {..} ]
        @('[', '{"a":1}', ']', '[', '{"b":2}', ']') | Set-Content -Path $f
        Merge-FGJsonArrayFile -File $f
        $parsed = Get-Content -Path $f -Raw | ConvertFrom-Json
        @($parsed).Count | Should -Be 2
        $parsed[0].a | Should -Be 1
        $parsed[1].b | Should -Be 2
        # the temp Input.json is cleaned up
        (Test-Path (Join-Path $TestDrive 'Input.json')) | Should -Be $false
    }

    It 'passes a single already-valid array through unchanged in content' {
        $f = Join-Path $TestDrive 'merge-single.json'
        @('[', '{"a":1}', ']') | Set-Content -Path $f
        Merge-FGJsonArrayFile -File $f
        $parsed = Get-Content -Path $f -Raw | ConvertFrom-Json
        @($parsed).Count | Should -Be 1
        $parsed[0].a | Should -Be 1
    }
}

Describe 'Remove-FGTrailingCommaFromJsonFile' {

    It 'strips a trailing comma before the closing bracket' {
        $f = Join-Path $TestDrive 'trailing.json'
        @('[', '{"a":1}', ',', ']') | Set-Content -Path $f
        Remove-FGTrailingCommaFromJsonFile -File $f
        $parsed = Get-Content -Path $f -Raw | ConvertFrom-Json
        @($parsed).Count | Should -Be 1
        $parsed[0].a | Should -Be 1
        (Test-Path (Join-Path $TestDrive 'Input.json')) | Should -Be $false
    }

    It 'leaves a well-formed array intact' {
        $f = Join-Path $TestDrive 'trailing-ok.json'
        @('[', '{"a":1}', ']') | Set-Content -Path $f
        Remove-FGTrailingCommaFromJsonFile -File $f
        $parsed = Get-Content -Path $f -Raw | ConvertFrom-Json
        @($parsed).Count | Should -Be 1
        $parsed[0].a | Should -Be 1
    }
}
