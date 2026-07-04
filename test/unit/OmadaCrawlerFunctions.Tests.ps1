#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the helper functions extracted into
    tools/crawlers/omada/OmadaCrawler.Functions.ps1.

.DESCRIPTION
    Exercises the pure / mappable helpers directly (category + type mapping,
    type-mapping merge, phase tracking) and the ingest batching helper with a
    mocked Invoke-IngestAPI. No network calls are made.

    These cases do NOT overlap with test/unit/Omada.Tests.ps1 (which covers
    Get-OmadaRef* helpers, OData auth, and URL normalisation).

.USAGE
    Invoke-Pester -Path test/unit/OmadaCrawlerFunctions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:omadaRoot = Join-Path $script:repoRoot 'tools\crawlers\omada'

    # Shared ingest helpers (Invoke-IngestAPI, ConvertTo-JsonArray) — Send-IngestBatch calls these.
    . (Join-Path $script:repoRoot 'tools\crawlers\shared\Invoke-CrawlerIngest.ps1')
    # Omada-specific reference helpers (not under test here, but keep the load self-contained).
    . (Join-Path $script:omadaRoot 'Get-OmadaHelpers.ps1')
    # The functions under test.
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Functions.ps1')

    # ── Script-scope state the functions read at call time ──
    # Mirrors the defaults the Start script sets up in its Configuration region.
    $script:DefaultTypeMappings = @{
        identityTypeToIdentityAtlas    = @{ Employee = 'User'; Primary = 'User'; Person = 'User'; Contractor = 'ExternalUser'; 'External Worker' = 'ExternalUser'; 'Service Account' = 'ServicePrincipal'; 'Non-Person' = 'ServicePrincipal'; Machine = 'ServicePrincipal' }
        resourceTypeToIdentityAtlas    = @{ 'Business Role' = 'BusinessRole' }
        contextTypeToIdentityAtlas     = @{ 'OrgUnit' = 'OrgUnit'; 'Organisational Unit' = 'OrgUnit'; Department = 'Department'; Location = 'Location'; 'Cost Center' = 'CostCenter'; CostCenter = 'CostCenter' }
        identityTypesForIdentityTable  = @('Employee', 'Primary', 'Person')
        resourceTypesAsBusinessRoles   = @('Business Role')
    }
    $script:TypeMappings = $script:DefaultTypeMappings

    $script:ResourceCategoryMapping = @(
        @{ category = 'Role';       resourceType = 'BusinessRole' }
        @{ category = 'Permission'; resourceType = 'Resource' }
        @{ category = '';           resourceType = 'Resource' }  # default/catch-all
    )

    $script:phases = [System.Collections.Generic.List[object]]::new()
}

# ─── Map-ResourceCategory ─────────────────────────────────────────────────────
Describe 'Map-ResourceCategory' {
    It "maps 'Role' to BusinessRole" {
        Map-ResourceCategory -Category 'Role' | Should -Be 'BusinessRole'
    }
    It "maps 'Permission' to Resource" {
        Map-ResourceCategory -Category 'Permission' | Should -Be 'Resource'
    }
    It 'maps an unknown category to the catch-all (Resource)' {
        Map-ResourceCategory -Category 'SomethingElse' | Should -Be 'Resource'
    }
    It 'maps an empty category to the catch-all (Resource)' {
        Map-ResourceCategory -Category '' | Should -Be 'Resource'
    }
    It 'returns the literal Resource fallback when no catch-all entry exists' {
        $script:ResourceCategoryMapping = @( @{ category = 'Role'; resourceType = 'BusinessRole' } )
        Map-ResourceCategory -Category 'Unmapped' | Should -Be 'Resource'
        # restore for other tests
        $script:ResourceCategoryMapping = @(
            @{ category = 'Role';       resourceType = 'BusinessRole' }
            @{ category = 'Permission'; resourceType = 'Resource' }
            @{ category = '';           resourceType = 'Resource' }
        )
    }
}

# ─── Map-IdentityTypeToAtlas ──────────────────────────────────────────────────
Describe 'Map-IdentityTypeToAtlas' {
    It "maps 'Employee' to User" {
        Map-IdentityTypeToAtlas -OmadaType 'Employee' | Should -Be 'User'
    }
    It "maps 'Contractor' to ExternalUser" {
        Map-IdentityTypeToAtlas -OmadaType 'Contractor' | Should -Be 'ExternalUser'
    }
    It "maps 'Service Account' to ServicePrincipal" {
        Map-IdentityTypeToAtlas -OmadaType 'Service Account' | Should -Be 'ServicePrincipal'
    }
    It "maps 'Machine' to ServicePrincipal" {
        Map-IdentityTypeToAtlas -OmadaType 'Machine' | Should -Be 'ServicePrincipal'
    }
    It "defaults an unknown type to 'User' (with a warning)" {
        Map-IdentityTypeToAtlas -OmadaType 'Wizard' | Should -Be 'User'
    }
}

# ─── Map-ResourceTypeToAtlas ──────────────────────────────────────────────────
Describe 'Map-ResourceTypeToAtlas' {
    It "maps the configured 'Business Role' to BusinessRole" {
        Map-ResourceTypeToAtlas -OmadaType 'Business Role' | Should -Be 'BusinessRole'
    }
    It 'strips whitespace from an unmapped multi-word type' {
        Map-ResourceTypeToAtlas -OmadaType 'Custom Resource Type' | Should -Be 'CustomResourceType'
    }
    It 'returns a single-word unmapped type unchanged' {
        Map-ResourceTypeToAtlas -OmadaType 'Widget' | Should -Be 'Widget'
    }
}

# ─── Map-ContextTypeToAtlas ───────────────────────────────────────────────────
Describe 'Map-ContextTypeToAtlas' {
    It "maps 'Organisational Unit' to OrgUnit" {
        Map-ContextTypeToAtlas -OmadaType 'Organisational Unit' | Should -Be 'OrgUnit'
    }
    It "maps 'Cost Center' to CostCenter" {
        Map-ContextTypeToAtlas -OmadaType 'Cost Center' | Should -Be 'CostCenter'
    }
    It "maps 'Department' to Department" {
        Map-ContextTypeToAtlas -OmadaType 'Department' | Should -Be 'Department'
    }
    It 'strips whitespace from an unmapped multi-word context type' {
        Map-ContextTypeToAtlas -OmadaType 'Some Region' | Should -Be 'SomeRegion'
    }
}

# ─── Merge-TypeMappings ───────────────────────────────────────────────────────
Describe 'Merge-TypeMappings' {
    It 'returns Defaults unchanged when Overrides is null' {
        $merged = Merge-TypeMappings -Defaults $script:DefaultTypeMappings -Overrides $null
        $merged | Should -Be $script:DefaultTypeMappings
    }

    It 'merges a PSCustomObject override hash into the corresponding default hash' {
        $overrides = [PSCustomObject]@{
            identityTypeToIdentityAtlas = [PSCustomObject]@{ Intern = 'ExternalUser' }
        }
        $merged = Merge-TypeMappings -Defaults $script:DefaultTypeMappings -Overrides $overrides
        # New key added
        $merged['identityTypeToIdentityAtlas']['Intern'] | Should -Be 'ExternalUser'
        # Existing default keys preserved
        $merged['identityTypeToIdentityAtlas']['Employee'] | Should -Be 'User'
    }

    It 'lets a PSCustomObject override replace an existing key value' {
        $overrides = [PSCustomObject]@{
            identityTypeToIdentityAtlas = [PSCustomObject]@{ Employee = 'ExternalUser' }
        }
        $merged = Merge-TypeMappings -Defaults $script:DefaultTypeMappings -Overrides $overrides
        $merged['identityTypeToIdentityAtlas']['Employee'] | Should -Be 'ExternalUser'
    }

    It 'replaces an array-valued key wholesale' {
        $overrides = [PSCustomObject]@{
            identityTypesForIdentityTable = @('Person')
        }
        $merged = Merge-TypeMappings -Defaults $script:DefaultTypeMappings -Overrides $overrides
        @($merged['identityTypesForIdentityTable']) | Should -Be @('Person')
    }

    It 'carries over default keys that have no override' {
        $overrides = [PSCustomObject]@{
            resourceTypeToIdentityAtlas = [PSCustomObject]@{ 'App Role' = 'AppRole' }
        }
        $merged = Merge-TypeMappings -Defaults $script:DefaultTypeMappings -Overrides $overrides
        $merged['contextTypeToIdentityAtlas']['Department'] | Should -Be 'Department'
    }

    It 'does not mutate the supplied Defaults hashtable' {
        $overrides = [PSCustomObject]@{
            identityTypeToIdentityAtlas = [PSCustomObject]@{ Employee = 'ExternalUser' }
        }
        Merge-TypeMappings -Defaults $script:DefaultTypeMappings -Overrides $overrides | Out-Null
        $script:DefaultTypeMappings['identityTypeToIdentityAtlas']['Employee'] | Should -Be 'User'
    }
}

# ─── Write-Phase ──────────────────────────────────────────────────────────────
Describe 'Write-Phase' {
    BeforeEach {
        $script:phases = [System.Collections.Generic.List[object]]::new()
    }

    It "records an 'ok' phase with duration in milliseconds" {
        Write-Phase -Name 'Identities' -Duration ([TimeSpan]::FromMilliseconds(1500))
        $script:phases.Count | Should -Be 1
        $script:phases[0].name       | Should -Be 'Identities'
        $script:phases[0].status     | Should -Be 'ok'
        $script:phases[0].durationMs | Should -Be 1500
    }

    It "records a 'failed' phase and stores the error message" {
        Write-Phase -Name 'Accounts' -Duration ([TimeSpan]::FromSeconds(1)) -ErrorMsg 'boom'
        $script:phases[0].status | Should -Be 'failed'
        $script:phases[0].error  | Should -Be 'boom'
    }

    It 'attaches a records hashtable when supplied' {
        Write-Phase -Name 'Resources' -Duration ([TimeSpan]::Zero) -Records @{ resources = 42 }
        $script:phases[0].records.resources | Should -Be 42
    }

    It 'omits error and records keys when not supplied' {
        Write-Phase -Name 'Contexts' -Duration ([TimeSpan]::Zero)
        $script:phases[0].ContainsKey('error')   | Should -BeFalse
        $script:phases[0].ContainsKey('records') | Should -BeFalse
    }
}

# ─── Send-IngestBatch ─────────────────────────────────────────────────────────
Describe 'Send-IngestBatch' {
    It 'sends an empty full-sync batch when there are no records' {
        Mock Invoke-IngestAPI { return @{ inserted = 0; updated = 0; deleted = 3 } }
        $r = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId 7 -SyncMode 'full' -Records @()
        $r.deleted | Should -Be 3
        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly -ParameterFilter {
            $Body.records.Count -eq 0 -and $Body.systemId -eq 7 -and $Body.syncMode -eq 'full'
        }
    }

    It 'sends a single batch when records fit under BatchSize' {
        Mock Invoke-IngestAPI { return @{ inserted = 2; updated = 0; deleted = 0 } }
        $recs = @([PSCustomObject]@{ id = 'a' }, [PSCustomObject]@{ id = 'b' })
        $r = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId 1 -Records $recs
        $r.inserted | Should -Be 2
        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly
    }

    It 'passes the supplied scope through to the ingest body' {
        Mock Invoke-IngestAPI { return @{ inserted = 1 } }
        $recs = @([PSCustomObject]@{ id = 'x' })
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId 1 `
            -Scope @{ principalType = 'User' } -Records $recs | Out-Null
        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly -ParameterFilter {
            $Body.scope.principalType -eq 'User'
        }
    }

    It 'sends a separate delta delete batch when DeletedIds are supplied' {
        Mock Invoke-IngestAPI { return @{ inserted = 1; updated = 0; deleted = 0 } }
        $recs = @([PSCustomObject]@{ id = 'keep' })
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId 1 `
            -Records $recs -DeletedIds @('gone1', 'gone2') | Out-Null
        # One delete (delta) call + one upsert (full) call
        Should -Invoke Invoke-IngestAPI -Times 2 -Exactly
        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly -ParameterFilter {
            $Body.syncMode -eq 'delta' -and $Body.deletedIds.Count -eq 2
        }
    }

    It 'chunks large record sets into multiple session batches and sums the results' {
        Mock Invoke-IngestAPI { return @{ syncId = 'sess-1'; inserted = 1; updated = 0; deleted = 0 } }
        $recs = 1..5 | ForEach-Object { [PSCustomObject]@{ id = "r$_" } }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records $recs -BatchSize 2
        # 5 records / chunk size 2 = 3 chunks
        Should -Invoke Invoke-IngestAPI -Times 3 -Exactly
        $r.inserted | Should -Be 3
    }

    It 'marks the first chunk as a session start' {
        Mock Invoke-IngestAPI { return @{ syncId = 'sess-1'; inserted = 1 } }
        $recs = 1..5 | ForEach-Object { [PSCustomObject]@{ id = "r$_" } }
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records $recs -BatchSize 2 | Out-Null
        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly -ParameterFilter {
            $Body.syncSession -eq 'start'
        }
        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly -ParameterFilter {
            $Body.syncSession -eq 'end'
        }
    }
}

Describe 'Get-OmadaStr / Get-OmadaEnumStr / Join-OmadaDisplayNames' {
    It 'Get-OmadaStr coalesces a set scalar to string, else the fallback' {
        Get-OmadaStr 'hello'            | Should -Be 'hello'
        Get-OmadaStr $null             | Should -Be ''
        Get-OmadaStr 0                 | Should -Be ''        # 0 is falsy -> fallback
        Get-OmadaStr '' -Fallback 'x'  | Should -Be 'x'
    }
    It 'Get-OmadaEnumStr reads .Value of a set enum ref, else the fallback' {
        Get-OmadaEnumStr ([pscustomobject]@{ Value = 'Active' })    | Should -Be 'Active'
        Get-OmadaEnumStr $null                                      | Should -Be ''
        Get-OmadaEnumStr $null -Fallback 'Active'                   | Should -Be 'Active'
    }
    It 'Join-OmadaDisplayNames joins DisplayName with "; ", empty for null/empty' {
        Join-OmadaDisplayNames @([pscustomobject]@{ DisplayName = 'A' }, [pscustomobject]@{ DisplayName = 'B' }) | Should -Be 'A; B'
        Join-OmadaDisplayNames $null | Should -Be ''
        Join-OmadaDisplayNames @()   | Should -Be ''
    }
}

Describe 'Merge-OmadaOverrideValue' {
    It 'merges a PSCustomObject override onto the default hashtable' {
        $r = Merge-OmadaOverrideValue -DefaultValue @{ a = 1; b = 2 } -Override ([pscustomobject]@{ b = 3; c = 4 })
        $r.a | Should -Be 1
        $r.b | Should -Be 3
        $r.c | Should -Be 4
    }
    It 'replaces wholesale for an array override' {
        (Merge-OmadaOverrideValue -DefaultValue @(1) -Override @(2, 3)) | Should -Be @(2, 3)
    }
    It 'replaces for a scalar override' {
        Merge-OmadaOverrideValue -DefaultValue 'x' -Override 'y' | Should -Be 'y'
    }
}
