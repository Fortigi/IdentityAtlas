#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester 5 unit tests for the IdentityAtlas governance / application /
    service-principal READ functions in the PowerShell SDK.

.DESCRIPTION
    Covers the URI-building and branching logic of the following functions by
    mocking the Graph helper (Invoke-FGGetRequest) inside the IdentityAtlas
    module and asserting the URI that each function constructs:

      Get-FGAccessPackage, Get-FGAccessPackagesAssignments,
      Get-FGAccessPackagesPolicy, Get-FGAccessPackagesResource,
      Get-FGCatalog, Get-FGCatalogGroup, Get-FGServicePrincipal,
      Get-FGServicePrincipalWithSync, Get-FGApplication,
      Get-FGApplicationExtensionProperty, Get-FGAttributeMapping,
      Get-FGSynchronizationJob, Get-FGSynchronizationSchema.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    Import-Module (Join-Path $script:repoRoot 'setup/IdentityAtlas.psd1') -Force -ErrorAction Stop
    $Global:AccessToken = 'fake-token'
}

AfterAll {
    $Global:AccessToken = $null
}

Describe 'Get-FGAccessPackage' {
    It 'lists all access packages with no params' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'ap1' } }
        Get-FGAccessPackage | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages'
        }
    }

    It 'filters by displayName' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGAccessPackage -displayName 'HR Package' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*accessPackages?`$filter=displayName eq 'HR Package'"
        }
    }

    It 'filters by id' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGAccessPackage -id 'ap-123' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*accessPackages?`$filter=id eq 'ap-123'"
        }
    }

    It 'returns the helper output' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'ap1' } }
        (Get-FGAccessPackage).id | Should -Be 'ap1'
    }
}

Describe 'Get-FGAccessPackagesAssignments' {
    It 'builds the assignments URI with expand and filter' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGAccessPackagesAssignments -AccessPackageID 'ap-1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*accessPackageAssignments*' -and
            $URI -like '*$expand=accessPackage,target*' -and
            $URI -like "*accessPackage/id+eq+'ap-1'*"
        }
    }

    It 'returns all assignments when DeliveredOnly is not set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            @(
                [pscustomobject]@{ id = 'a'; assignmentStatus = 'Delivered' }
                [pscustomobject]@{ id = 'b'; assignmentStatus = 'Pending' }
            )
        }
        (Get-FGAccessPackagesAssignments -AccessPackageID 'ap-1').Count | Should -Be 2
    }

    It 'filters to Delivered when DeliveredOnly is set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            @(
                [pscustomobject]@{ id = 'a'; assignmentStatus = 'Delivered' }
                [pscustomobject]@{ id = 'b'; assignmentStatus = 'Pending' }
            )
        }
        $r = Get-FGAccessPackagesAssignments -AccessPackageID 'ap-1' -DeliveredOnly $true
        @($r).Count | Should -Be 1
        $r.assignmentStatus | Should -Be 'Delivered'
    }
}

Describe 'Get-FGAccessPackagesPolicy' {
    It 'lists all policies with no AccessPackageId' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGAccessPackagesPolicy | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignmentPolicies'
        }
    }

    It 'filters policies by AccessPackageId' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGAccessPackagesPolicy -AccessPackageId 'ap-9' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*accessPackageAssignmentPolicies*' -and
            $URI -like "*accessPackageId eq 'ap-9'*"
        }
    }
}

Describe 'Get-FGAccessPackagesResource' {
    It 'builds the resource role scopes expand URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGAccessPackagesResource -AccessPackageID 'ap-7' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like '*accessPackages/ap-7*' -and
            $URI -like '*accessPackageResourceRoleScopes*' -and
            $URI -like '*accessPackageResourceRole,accessPackageResourceScope*'
        }
    }
}

Describe 'Get-FGCatalog' {
    It 'lists all catalogs with no params' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGCatalog | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs'
        }
    }

    It 'filters catalogs by DisplayName' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGCatalog -DisplayName 'General' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*accessPackageCatalogs?`$filter=displayName eq 'General'"
        }
    }

    It 'filters catalogs by id' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGCatalog -id 'cat-1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*accessPackageCatalogs?`$filter=id eq 'cat-1'"
        }
    }
}

Describe 'Get-FGCatalogGroup' {
    It 'builds the catalog resources URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGCatalogGroup -CatalogId 'cat-99' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs/cat-99/accessPackageResources'
        }
    }
}

Describe 'Get-FGServicePrincipal' {
    It 'lists all service principals with no params' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGServicePrincipal | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/servicePrincipals'
        }
    }

    It 'filters by DisplayName' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGServicePrincipal -DisplayName 'My App' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*servicePrincipals?`$filter=displayName eq 'My App'"
        }
    }

    It 'filters by id' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGServicePrincipal -id 'sp-1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*servicePrincipals?`$filter=id eq 'sp-1'"
        }
    }
}

Describe 'Get-FGApplication' {
    It 'lists all applications with no params' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGApplication | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/applications'
        }
    }

    It 'filters by DisplayName' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGApplication -DisplayName 'My App' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*applications?`$filter=displayName eq 'My App'"
        }
    }

    It 'filters by id' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGApplication -id 'app-1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*applications?`$filter=id eq 'app-1'"
        }
    }
}

Describe 'Get-FGApplicationExtensionProperty' {
    It 'builds the extensionProperties URI for an app object id' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGApplicationExtensionProperty -id 'app-obj-1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/applications/app-obj-1/extensionProperties'
        }
    }
}

Describe 'Get-FGSynchronizationJob' {
    It 'lists all jobs for a service principal' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'job.1' } }
        Get-FGSynchronizationJob -ServicePrincipalId 'sp-1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/servicePrincipals/sp-1/synchronization/jobs'
        }
    }

    It 'gets a specific job by JobId' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ id = 'job.1' } }
        Get-FGSynchronizationJob -ServicePrincipalId 'sp-1' -JobId 'job.1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/servicePrincipals/sp-1/synchronization/jobs/job.1'
        }
    }

    It 'returns null on a 404 from the helper' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 404 } }
            $ex   = [System.Exception]::new('Not Found')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru |
                ForEach-Object { throw $_ }
        }
        Get-FGSynchronizationJob -ServicePrincipalId 'sp-missing' | Should -BeNullOrEmpty
    }

    It 'rethrows non-404 errors' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 500 } }
            $ex   = [System.Exception]::new('Server Error')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru |
                ForEach-Object { throw $_ }
        }
        { Get-FGSynchronizationJob -ServicePrincipalId 'sp-1' } | Should -Throw
    }
}

Describe 'Get-FGSynchronizationSchema' {
    It 'builds the job schema URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { [pscustomobject]@{ synchronizationRules = @() } }
        Get-FGSynchronizationSchema -ServicePrincipalId 'sp-1' -JobId 'job.1' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/servicePrincipals/sp-1/synchronization/jobs/job.1/schema'
        }
    }

    It 'builds the template schema URI' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        Get-FGSynchronizationSchema -ServicePrincipalId 'sp-1' -TemplateId 'customappsso' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/servicePrincipals/sp-1/synchronization/templates/customappsso/schema'
        }
    }

    It 'throws when neither JobId nor TemplateId is given' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest { }
        # ParameterSetName makes the call ambiguous with neither bound, so it
        # throws before reaching the explicit guard — either way it must throw.
        { Get-FGSynchronizationSchema -ServicePrincipalId 'sp-1' } | Should -Throw
    }

    It 'returns null on a 404 from the helper' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 404 } }
            $ex   = [System.Exception]::new('Not Found')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru |
                ForEach-Object { throw $_ }
        }
        Get-FGSynchronizationSchema -ServicePrincipalId 'sp-1' -JobId 'job.1' | Should -BeNullOrEmpty
    }
}

Describe 'Get-FGServicePrincipalWithSync' {
    It 'uses a user-supplied filter and finds the sync job' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-w'; displayName = 'Workday'; appId = 'w-app'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob {
            [pscustomobject]@{ id = 'job.1' }
        }
        $r = Get-FGServicePrincipalWithSync -Filter "startswith(displayName,'Workday')" 6>$null
        @($r).Count | Should -Be 1
        $r.DisplayName | Should -Be 'Workday'
        $r.AppType     | Should -Be 'HR Provisioning (Workday)'
        $r.JobCount    | Should -Be 1
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -ParameterFilter {
            $URI -like "*`$filter=startswith(displayName,'Workday')*"
        }
    }

    It 'returns empty when no service principal has sync jobs' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-x'; displayName = 'Some App'; appId = 'x'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { $null }
        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'Some App'" 6>$null
        @($r).Count | Should -Be 0
    }

    It 'includes job and schema details when requested' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-s'; displayName = 'SCIM App'; appId = 's'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob {
            [pscustomobject]@{ id = 'scim.123' }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationSchema {
            [pscustomobject]@{ synchronizationRules = @() }
        }
        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'SCIM App'" -IncludeJobs -IncludeSchema 6>$null
        $r.AppType | Should -Be 'SCIM Application'
        $r.Jobs    | Should -Not -BeNullOrEmpty
        $r.PSObject.Properties.Name | Should -Contain 'Schemas'
        Should -Invoke -ModuleName IdentityAtlas Get-FGSynchronizationSchema
    }

    It 'classifies a SuccessFactors app as HR provisioning' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-sf'; displayName = 'SuccessFactors'; appId = 'sf'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { [pscustomobject]@{ id = 'job.1' } }
        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'SuccessFactors'" 6>$null
        $r.AppType | Should -Be 'HR Provisioning (SuccessFactors)'
    }

    It 'classifies an Entra app as Cloud Sync / AD' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-ad'; displayName = 'Microsoft Entra Provisioning'; appId = 'ad'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { [pscustomobject]@{ id = 'job.1' } }
        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'x'" 6>$null
        $r.AppType | Should -Be 'Cloud Sync / AD'
    }

    It 'classifies an unrecognised app as Enterprise Application' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-e'; displayName = 'Some Random App'; appId = 'e'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { [pscustomobject]@{ id = 'job.1' } }
        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'x'" 6>$null
        $r.AppType | Should -Be 'Enterprise Application'
    }

    It 'skips the Cloud Sync SP unless -IncludeCloudSync is set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-cs'; displayName = 'Cloud Sync'; appId = '1a4721b3-e57f-4451-ae87-ef078703ec94'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { [pscustomobject]@{ id = 'job.1' } }
        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'x'" 6>$null
        @($r).Count | Should -Be 0
    }

    It 'includes the Cloud Sync SP when -IncludeCloudSync is set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-cs'; displayName = 'Cloud Sync'; appId = '1a4721b3-e57f-4451-ae87-ef078703ec94'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { [pscustomobject]@{ id = 'job.1' } }
        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'x'" -IncludeCloudSync 6>$null
        $r.AppType | Should -Be 'Cloud Sync'
    }

    It 'discovers candidates via the known-appId / HR-name / tag queries and deduplicates by id when no filter is given' {
        # Every discovery query (3 known appIds + 6 HR patterns + 2 tag queries) returns
        # the same SP, so the dedup-by-id step must collapse them to a single candidate.
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-dup'; displayName = 'Workday'; appId = 'w-app'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { [pscustomobject]@{ id = 'job.1' } }

        $r = Get-FGServicePrincipalWithSync 6>$null

        @($r).Count | Should -Be 1
        $r.DisplayName | Should -Be 'Workday'
        # 3 known appIds + 6 HR name patterns + gallery tag + SCIM tag = 11 discovery queries
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetRequest -Exactly 11
    }

    It 'continues silently when checking a service principal for sync jobs throws' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-err'; displayName = 'Broken App'; appId = 'b'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { throw 'permission denied' }

        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'Broken App'" 6>$null

        @($r).Count | Should -Be 0
    }

    It 'tolerates a schema-retrieval failure when -IncludeSchema is set' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetRequest {
            [pscustomobject]@{ id = 'sp-sf2'; displayName = 'SCIM App'; appId = 's2'; tags = @() }
        }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationJob { [pscustomobject]@{ id = 'scim.9' } }
        Mock -ModuleName IdentityAtlas Get-FGSynchronizationSchema { throw 'schema unavailable' }

        $r = Get-FGServicePrincipalWithSync -Filter "displayName eq 'SCIM App'" -IncludeSchema 6>$null

        $r.PSObject.Properties.Name | Should -Contain 'Schemas'
        $r.Schemas | Should -BeNullOrEmpty
    }
}

Describe 'Get-FGAttributeMapping' {
    BeforeAll {
        $script:spWithSchema = [pscustomobject]@{
            DisplayName        = 'Workday'
            AppType            = 'HR Provisioning (Workday)'
            ServicePrincipalId = 'sp-1'
            AppId              = 'w-app'
            Schemas            = @(
                [pscustomobject]@{
                    JobId  = 'job.1'
                    Schema = [pscustomobject]@{
                        synchronizationRules = @(
                            [pscustomobject]@{
                                name                = 'Rule1'
                                sourceDirectoryName = 'Workday'
                                targetDirectoryName = 'Azure Active Directory'
                                objectMappings      = @(
                                    [pscustomobject]@{
                                        sourceObjectName  = 'Worker'
                                        targetObjectName  = 'User'
                                        enabled           = $true
                                        attributeMappings = @(
                                            [pscustomobject]@{
                                                targetAttributeName = 'mail'
                                                source = [pscustomobject]@{ expression = '[mail]'; type = 'Attribute'; name = 'mail' }
                                                flowType = 'Always'; flowBehavior = 'FlowWhenChanged'
                                                matchingPriority = 0; defaultValue = $null
                                            }
                                            [pscustomobject]@{
                                                targetAttributeName = 'displayName'
                                                source = [pscustomobject]@{ expression = "Join(' ', [givenName], [surname])"; type = 'Function'; name = 'Join' }
                                                flowType = 'Always'; flowBehavior = 'FlowWhenChanged'
                                                matchingPriority = $null; defaultValue = $null
                                            }
                                        )
                                    }
                                )
                            }
                        )
                    }
                }
            )
        }
    }

    It 'extracts all attribute mappings' {
        $m = Get-FGAttributeMapping -ServicePrincipalWithSync $script:spWithSchema
        @($m).Count | Should -Be 2
    }

    # Behavioural documentation, NOT a mutation kill — and worth saying so, since
    # the obvious guess is wrong. The bail-out is
    # `-not $schema -or -not $schema.synchronizationRules`, and reading that `-or`
    # as `-and` turns out to be an EQUIVALENT mutant: when the rules are absent,
    # skipping the guard just falls into `foreach ($rule in $null)`, which is a
    # no-op in PowerShell. Nothing observable changes except a Write-Verbose line.
    # Measured, after adding these cases failed to kill it.
    #
    # The cases still earn their place: they pin that an unusable schema yields no
    # mappings and does not throw, which is what callers depend on.
    It 'skips a sync job whose schema is unusable' -ForEach @(
        @{ Case = 'schema present but carrying no rules'; Schema = [pscustomobject]@{ synchronizationRules = $null } }
        @{ Case = 'no schema at all';                     Schema = $null }
    ) {
        $sp = [pscustomobject]@{
            DisplayName = 'Workday'; AppType = 'HR Provisioning (Workday)'
            ServicePrincipalId = 'sp-1'; AppId = 'w-app'
            Schemas = @([pscustomobject]@{ JobId = 'job.1'; Schema = $Schema })
        }
        # Assigned OUTSIDE any scriptblock: a `$m = ...` inside the one handed to
        # Should -Not -Throw runs in a child scope, so $m would stay $null out
        # here — and @($null).Count is 1, not 0, which reads as "one mapping was
        # emitted" and fails for a reason that has nothing to do with the code.
        $m = Get-FGAttributeMapping -ServicePrincipalWithSync $sp
        @($m).Count | Should -Be 0
    }

    It 'extracts source attributes from expressions via regex' {
        $m = Get-FGAttributeMapping -ServicePrincipalWithSync $script:spWithSchema
        $mail = $m | Where-Object { $_.TargetAttributeName -eq 'mail' }
        $mail.SourceAttributes | Should -Be 'mail'
        $join = $m | Where-Object { $_.TargetAttributeName -eq 'displayName' }
        @($join.SourceAttributes) | Should -Contain 'givenName'
        @($join.SourceAttributes) | Should -Contain 'surname'
    }

    It 'populates sync direction and app fields' {
        $m = Get-FGAttributeMapping -ServicePrincipalWithSync $script:spWithSchema
        $m[0].SyncDirection      | Should -Be 'Workday -> Azure Active Directory'
        $m[0].AppDisplayName     | Should -Be 'Workday'
        $m[0].ServicePrincipalId | Should -Be 'sp-1'
        $m[0].JobId              | Should -Be 'job.1'
    }

    It 'filters by ObjectType' {
        $m = Get-FGAttributeMapping -ServicePrincipalWithSync $script:spWithSchema -ObjectType 'User'
        @($m).Count | Should -Be 2
        $m2 = Get-FGAttributeMapping -ServicePrincipalWithSync $script:spWithSchema -ObjectType 'Group'
        @($m2).Count | Should -Be 0
    }

    It 'skips service principals without schemas' {
        $noSchema = [pscustomobject]@{ DisplayName = 'NoSync'; Schemas = $null }
        $m = Get-FGAttributeMapping -ServicePrincipalWithSync $noSchema
        @($m).Count | Should -Be 0
    }

    It 'accepts pipeline input' {
        $m = $script:spWithSchema | Get-FGAttributeMapping
        @($m).Count | Should -Be 2
    }
}
