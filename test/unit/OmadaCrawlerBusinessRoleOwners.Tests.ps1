#Requires -Modules Pester

BeforeAll {
    $script:repoRoot  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:omadaRoot = Join-Path $script:repoRoot 'tools' 'crawlers' 'omada'
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:omadaRoot 'Get-OmadaHelpers.ps1')
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Functions.ps1')
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Transform.ps1')
    . (Join-Path $script:omadaRoot 'OmadaCrawler.BusinessRoleOwners.ps1')

    # ConvertTo-AtlasResourceCategory reads this at call time.
    $script:ResourceCategoryMapping = @(
        @{ category = 'Business Role'; resourceType = 'BusinessRole' }
        @{ category = ''; resourceType = 'Resource' }
    )

    function New-Owner { param($Id, $Name) [pscustomobject]@{ UId = $Id; DisplayName = $Name } }
    function New-Role {
        param($Category = 'Business Role', $Explicit = @(), $Manual = @(), $Id = 'r1')
        [pscustomobject]@{ UId = $Id; NAME = 'Role'; ROLECATEGORY = [pscustomobject]@{ Value = $Category }; EXPLICITOWNER = $Explicit; MANUALOWNER = $Manual }
    }
}

Describe 'ConvertTo-OmadaBusinessRoleOwnerRecords' {

    It 'makes a single explicit owner Accountable' {
        $records = @(ConvertTo-OmadaBusinessRoleOwnerRecords -Resource (New-Role -Explicit @(New-Owner 'u1' 'Ann')))
        $records.Count | Should -Be 1
        $records[0].role | Should -Be 'Accountable'
        $records[0].holder | Should -Be 'u1'
        $records[0].holderName | Should -Be 'Ann'
        $records[0].resourceExternalId | Should -Be 'r1'
    }

    It 'makes several explicit owners Responsible, since none can be picked' {
        $records = @(ConvertTo-OmadaBusinessRoleOwnerRecords -Resource (New-Role -Explicit @((New-Owner 'u1' 'Ann'), (New-Owner 'u2' 'Bo'))))
        @($records.role | Select-Object -Unique) | Should -Be @('Responsible')
        $records.Count | Should -Be 2
    }

    It 'makes a manual owner Responsible' {
        $records = @(ConvertTo-OmadaBusinessRoleOwnerRecords -Resource (New-Role -Manual @(New-Owner 'u3' 'Cy')))
        $records[0].role | Should -Be 'Responsible'
    }

    It 'keeps an explicit Accountable who is also a manual owner in both roles, once each' {
        $ann = New-Owner 'u1' 'Ann'
        $records = @(ConvertTo-OmadaBusinessRoleOwnerRecords -Resource (New-Role -Explicit @($ann) -Manual @($ann, $ann)))
        $records.Count | Should -Be 2
        @($records.role | Sort-Object) | Should -Be @('Accountable', 'Responsible')
    }

    It 'skips an owner reference without an id' {
        $records = @(ConvertTo-OmadaBusinessRoleOwnerRecords -Resource (New-Role -Explicit @([pscustomobject]@{ DisplayName = 'No id' })))
        $records.Count | Should -Be 0
    }

    It 'returns nothing for a resource without an id' {
        @(ConvertTo-OmadaBusinessRoleOwnerRecords -Resource ([pscustomobject]@{ NAME = 'x' })).Count | Should -Be 0
    }
}

Describe 'Sync-OmadaBusinessRoleOwners' {

    BeforeEach {
        $script:phaseErrors = [System.Collections.Generic.List[string]]::new()
        $script:posts = [System.Collections.Generic.List[object]]::new()
        Mock Write-Phase {}
        Mock Invoke-IngestAPI { $script:posts.Add($Body); @{} }
    }

    It 'sends owners of business roles only' {
        $resources = @(
            (New-Role -Id 'br' -Explicit @(New-Owner 'u1' 'Ann'))
            (New-Role -Id 'perm' -Category 'Permission' -Explicit @(New-Owner 'u2' 'Bo'))
        )
        Sync-OmadaBusinessRoleOwners -SystemId 7 -AllResources $resources
        $script:posts.Count | Should -Be 1
        $script:posts[0].systemId | Should -Be 7
        @($script:posts[0].records).Count | Should -Be 1
        @($script:posts[0].records)[0].resourceExternalId | Should -Be 'br'
    }

    It 'sends nothing when no role has an owner' {
        Sync-OmadaBusinessRoleOwners -SystemId 7 -AllResources @(New-Role)
        $script:posts.Count | Should -Be 0
        $script:phaseErrors.Count | Should -Be 0
    }

    It 'splits into batches' {
        $owners = 1..5 | ForEach-Object { New-Owner "u$_" "N$_" }
        Sync-OmadaBusinessRoleOwners -SystemId 7 -AllResources @(New-Role -Manual $owners) -BatchSize 2
        $script:posts.Count | Should -Be 3
        @($script:posts[2].records).Count | Should -Be 1
    }

    It 'records a failure without stopping the crawl' {
        Mock Invoke-IngestAPI { throw 'HTTP 500' }
        { Sync-OmadaBusinessRoleOwners -SystemId 7 -AllResources @(New-Role -Explicit @(New-Owner 'u1' 'Ann')) } | Should -Not -Throw
        $script:phaseErrors[0] | Should -BeLike 'BusinessRoleOwners:*'
    }
}
