#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the Identity Atlas v5 PowerShell module.

.DESCRIPTION
    v5 dropped all direct database access from the worker. The PowerShell layer
    is now significantly smaller — only Graph API wrappers, idempotent helpers,
    and (stubbed) risk scoring functions remain. The test suite was rewritten
    accordingly:

      - No more SQL helper assertions (Connect-FGSQLServer, Initialize-FG*, etc.)
      - No more app/db folder check (deleted in v5)
      - File count assertions adjusted to the smaller surface area
      - The "removed functions" list grew to include all the SQL helpers
        that v4 used to ship

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/IdentityAtlas.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:modulePath  = Join-Path $script:repoRoot 'setup\IdentityAtlas.psd1'

    $script:graphRoot   = Join-Path $script:repoRoot 'tools\powershell-sdk\graph'
    $script:helpersRoot = Join-Path $script:repoRoot 'tools\powershell-sdk\helpers'
    $script:riskRoot    = Join-Path $script:repoRoot 'tools\riskscoring'

    Import-Module $script:modulePath -Force -ErrorAction Stop

    $script:allPs1Files = @(
        Get-ChildItem -Path $script:graphRoot   -Include '*.ps1' -Recurse -ErrorAction SilentlyContinue
        Get-ChildItem -Path $script:helpersRoot -Include '*.ps1' -Recurse -ErrorAction SilentlyContinue
        Get-ChildItem -Path $script:riskRoot    -Include '*.ps1' -Recurse -ErrorAction SilentlyContinue
    )
}

Describe 'Module Import' {
    It 'imports without errors' {
        { Import-Module $script:modulePath -Force -ErrorAction Stop } | Should -Not -Throw
    }

    It 'manifest is valid' {
        { Test-ModuleManifest -Path $script:modulePath -ErrorAction Stop } | Should -Not -Throw
    }

    It 'version format matches Major.Minor.yyyyMMdd.HHmm' {
        $content = Get-Content $script:modulePath -Raw
        $content | Should -Match "ModuleVersion\s*=\s*'\d+\.\d+\.\d{8}\.\d{4}'"
    }
}

Describe 'Function Availability — Graph / Base' {
    It 'exports <_>' -ForEach @(
        'Get-FGAccessToken', 'Get-FGAccessTokenInteractive', 'Get-FGAccessTokenWithRefreshToken',
        'Get-FGAccessTokenDetail', 'Confirm-FGAccessTokenValidity',
        'Update-FGAccessTokenIfExpired',
        'Invoke-FGGetRequest', 'Invoke-FGGetRequestToFile',
        'Invoke-FGPostRequest', 'Invoke-FGPatchRequest', 'Invoke-FGPutRequest', 'Invoke-FGDeleteRequest',
        'Use-FGExistingAccessTokenString', 'Use-FGExistingMSALToken',
        'Read-FGToken', 'Save-FGToken',
        'Test-FGConnection',
        'Get-FGSecureConfigValue', 'Clear-FGSecureConfigValue', 'Test-FGSecureConfigValue'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

Describe 'Function Availability — Generic Graph API (sample)' {
    It 'exports <_>' -ForEach @(
        'Get-FGUser', 'Get-FGGroup', 'Get-FGDevice', 'Get-FGApplication', 'Get-FGServicePrincipal',
        'Get-FGCatalog', 'Get-FGAccessPackage', 'Get-FGAccessPackagesAssignments', 'Get-FGAccessPackagesPolicy',
        'Get-FGGroupMember', 'Get-FGGroupMemberAll', 'Get-FGGroupMemberAllToFile',
        'Get-FGGroupTransitiveMemberAll', 'Get-FGGroupEligibleMemberAll',
        'Get-FGUserMail', 'Get-FGUserMailFolder', 'Get-FGUserManager', 'Get-FGUserMemberOf',
        'New-FGGroup', 'New-FGAccessPackage', 'New-FGCatalog', 'New-FGAccessPackagePolicy',
        'Set-FGAccessPackage', 'Set-FGAccessPackagePolicy',
        'Add-FGGroupMember', 'Add-FGGroupToAccessPackage', 'Add-FGGroupToCatalog',
        'Remove-FGAccessPackage', 'Remove-FGDevice', 'Remove-FGGroupMember'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

Describe 'Function Availability — Helpers (idempotent)' {
    It 'exports <_>' -ForEach @(
        'Confirm-FGUser', 'Confirm-FGGroup', 'Confirm-FGGroupMember', 'Confirm-FGNotGroupMember',
        'Confirm-FGAccessPackage', 'Confirm-FGAccessPackagePolicy', 'Confirm-FGAccessPackageResource',
        'Confirm-FGCatalog', 'Confirm-FGGroupInCatalog',
        'Get-FGServicePrincipalType',
        'Add-FGEntraCalculatedAttributes', 'Get-FGEntraPortalLink',
        'Test-FGDistinguishedName', 'Convert-FGDistinguishedNameToOUPath'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

# ─── Test-FGDistinguishedName ─────────────────────────────────────
# Positive rate matters: every $true turns into an `_OuPath` key in
# extendedAttributes. False positives pollute the filter UI.
Describe 'Test-FGDistinguishedName' {
    It 'returns $true for a canonical AD user DN' {
        Test-FGDistinguishedName 'CN=204374,OU=Users,OU=Accounts,OU=Clients,DC=fujitsu,DC=ad,DC=portofrotterdam,DC=com' |
            Should -BeTrue
    }
    It 'returns $true for an OU-only DN (no CN)' {
        Test-FGDistinguishedName 'OU=Finance,OU=Departments,DC=contoso,DC=com' | Should -BeTrue
    }
    It 'returns $false for a plain email' {
        Test-FGDistinguishedName 'alice@contoso.com' | Should -BeFalse
    }
    It 'returns $false for a single-field pseudo-DN (no hierarchy)' {
        Test-FGDistinguishedName 'CN=admin' | Should -BeFalse
    }
    It 'returns $false for free text that happens to contain OU=' {
        Test-FGDistinguishedName 'See notes: deploy to OU=west-region' | Should -BeFalse
    }
    It 'returns $false for null / empty / whitespace' {
        Test-FGDistinguishedName $null    | Should -BeFalse
        Test-FGDistinguishedName ''       | Should -BeFalse
        Test-FGDistinguishedName '   '    | Should -BeFalse
    }
}

# ─── Convert-FGDistinguishedNameToOUPath ──────────────────────────
# The user-facing contract: root → leaf, OU-only, backslash separator.
Describe 'Convert-FGDistinguishedNameToOUPath' {
    It 'converts the canonical example' {
        # The motivating case from the feature request — same DN the product
        # manager asked us to translate. Locking it down as a regression test.
        $dn = 'CN=204374,OU=Users,OU=Accounts,OU=Clients,DC=fujitsu,DC=ad,DC=portofrotterdam,DC=com'
        Convert-FGDistinguishedNameToOUPath $dn | Should -Be 'Clients\Accounts\Users'
    }
    It 'drops CN and DC components' {
        Convert-FGDistinguishedNameToOUPath 'CN=x,OU=A,OU=B,DC=c' | Should -Be 'B\A'
    }
    It 'returns $null when there are no OU segments' {
        Convert-FGDistinguishedNameToOUPath 'CN=user,DC=contoso,DC=com' | Should -BeNullOrEmpty
    }
    It 'returns $null on null / empty input' {
        Convert-FGDistinguishedNameToOUPath $null | Should -BeNullOrEmpty
        Convert-FGDistinguishedNameToOUPath ''    | Should -BeNullOrEmpty
    }
    It 'is case-insensitive on RDN attribute name' {
        Convert-FGDistinguishedNameToOUPath 'ou=Finance,ou=Depts,dc=x' | Should -Be 'Depts\Finance'
    }
}

# ─── Get-FGEntraPortalLink ────────────────────────────────────────
# Drift-resistant: the UI hardcodes these same blade URLs on the detail
# pages. If Microsoft ever changes them, BOTH sides break together and
# the test catches it — better than silent half-broken links.
Describe 'Get-FGEntraPortalLink' {
    BeforeAll {
        # Pester 5 runs each It in its own scriptblock; Describe-level locals
        # aren't visible inside. BeforeAll assigned to $script: makes them
        # reachable from every It in this Describe.
        $script:userId  = '11111111-1111-1111-1111-111111111111'
        $script:groupId = '22222222-2222-2222-2222-222222222222'
        $script:spId    = '33333333-3333-3333-3333-333333333333'
        $script:appId   = '44444444-4444-4444-4444-444444444444'
    }
    It 'produces a User profile URL' {
        $link = Get-FGEntraPortalLink -Id $script:userId -Type 'User'
        $link | Should -Match 'entra\.microsoft\.com'
        $link | Should -Match 'UserProfileMenuBlade'
        $link | Should -Match ([regex]::Escape($script:userId))
    }
    It 'produces a Group details URL' {
        $link = Get-FGEntraPortalLink -Id $script:groupId -Type 'Group'
        $link | Should -Match 'GroupDetailsMenuBlade'
        $link | Should -Match ([regex]::Escape($script:groupId))
    }
    It 'produces a ServicePrincipal URL with both objectId and appId' {
        $link = Get-FGEntraPortalLink -Id $script:spId -AppId $script:appId -Type 'ServicePrincipal'
        $link | Should -Match 'ManagedAppMenuBlade'
        $link | Should -Match ([regex]::Escape($script:spId))
        $link | Should -Match ([regex]::Escape($script:appId))
    }
    It 'still produces a ServicePrincipal URL when appId is missing (graceful degradation)' {
        $link = Get-FGEntraPortalLink -Id $script:spId -Type 'ServicePrincipal'
        $link | Should -Match 'ManagedAppMenuBlade'
        $link | Should -Match ([regex]::Escape($script:spId))
    }
    It 'returns $null when id is empty' {
        Get-FGEntraPortalLink -Id '' -Type 'User' | Should -BeNullOrEmpty
    }
}

# ─── Add-FGEntraCalculatedAttributes ──────────────────────────────
# Integration test of the helper as a whole: given a realistic Graph-
# shaped object + extendedAttributes, the right calculated keys land
# on the output.
Describe 'Add-FGEntraCalculatedAttributes' {
    It 'adds Link and an _OuPath for onPremisesDistinguishedName on a user' {
        $user = [pscustomobject]@{
            id                           = '11111111-1111-1111-1111-111111111111'
            displayName                  = 'Wim van den Heijkant'
            onPremisesDistinguishedName  = 'CN=204374,OU=Users,OU=Accounts,OU=Clients,DC=fujitsu,DC=ad,DC=portofrotterdam,DC=com'
        }
        $ext = @{ userType = 'Member' }
        $out = Add-FGEntraCalculatedAttributes -Object $user -Ext $ext -Type 'User'
        $out['Link']                                 | Should -Match 'UserProfileMenuBlade'
        $out['onPremisesDistinguishedName_OuPath']   | Should -Be 'Clients\Accounts\Users'
        $out['userType']                             | Should -Be 'Member'  # not mangled
    }
    It 'translates DN-shaped values that live inside extendedAttributes (custom extension attrs)' {
        $sp = [pscustomobject]@{ id = '22222222-2222-2222-2222-222222222222'; appId = '33333333-3333-3333-3333-333333333333' }
        $ext = @{
            fgGroupDN = 'CN=svc-app,OU=Services,OU=Shared,DC=contoso,DC=com'
        }
        Add-FGEntraCalculatedAttributes -Object $sp -Ext $ext -Type 'ServicePrincipal' | Out-Null
        $ext['fgGroupDN_OuPath'] | Should -Be 'Shared\Services'
    }
    It 'never overwrites an existing Link key that a caller already set' {
        $user = [pscustomobject]@{ id = '11111111-1111-1111-1111-111111111111' }
        $ext = @{ Link = 'https://existing.example' }
        Add-FGEntraCalculatedAttributes -Object $user -Ext $ext -Type 'User' | Out-Null
        $ext['Link'] | Should -Be 'https://existing.example'
    }
    It 'does nothing on objects that have no DN-shaped values and no id' {
        $obj = [pscustomobject]@{ displayName = 'no id yet' }
        $ext = @{}
        Add-FGEntraCalculatedAttributes -Object $obj -Ext $ext -Type 'User' | Out-Null
        $ext.Count | Should -Be 0
    }
    It 'emits multiple *_OuPath fields when several attributes look like DNs' {
        # The motivating "if there are multiple fields that have similarly
        # looking DNs, translate all of them" clause of the feature request.
        $group = [pscustomobject]@{ id = '44444444-4444-4444-4444-444444444444' }
        $ext = @{
            fgGroupDN    = 'CN=x,OU=A,OU=B,DC=c'
            ownerGroupDN = 'CN=y,OU=P,OU=Q,DC=d'
        }
        Add-FGEntraCalculatedAttributes -Object $group -Ext $ext -Type 'Group' | Out-Null
        $ext['fgGroupDN_OuPath']    | Should -Be 'B\A'
        $ext['ownerGroupDN_OuPath'] | Should -Be 'Q\P'
    }
}

# ─── Get-FGServicePrincipalType ───────────────────────────────────
# Tests pin the classification taxonomy from CLAUDE.md. Any change to the
# ordering (e.g. Managed Identity must win over tag-based AI detection) needs
# a corresponding change here; otherwise crawler output silently shifts
# principalType labels and breaks risk-scoring heuristics downstream.
Describe 'Get-FGServicePrincipalType — classification rules' {
    It 'classifies servicePrincipalType=ManagedIdentity as ManagedIdentity (even when tags look AI)' {
        # Rule 1 is authoritative: MI must win over tag-based AI detection.
        $sp = [pscustomobject]@{
            displayName          = 'Copilot ghost tenant'
            servicePrincipalType = 'ManagedIdentity'
            tags                 = @('AzureOpenAI')
        }
        Get-FGServicePrincipalType -ServicePrincipal $sp | Should -Be 'ManagedIdentity'
    }

    It 'classifies AI platform tags as AIAgent' {
        foreach ($tag in @('CopilotStudio','PowerVirtualAgents','AzureOpenAI','CognitiveServices')) {
            $sp = [pscustomobject]@{
                displayName          = 'benign-sounding-sp'
                servicePrincipalType = 'Application'
                tags                 = @('SomeOtherTag', $tag)
            }
            Get-FGServicePrincipalType -ServicePrincipal $sp |
                Should -Be 'AIAgent' -Because "tag '$tag' must trigger AIAgent"
        }
    }

    It 'classifies Entra Agent ID tags (AgenticInstance, AgenticApp) as AIAgent' {
        # Entra Agent ID (GA 2025) stamps SPs with these exact tags. These
        # identities are first-class AI agents and must not be left as generic
        # ServicePrincipal — risk scoring and UX both depend on the distinction.
        foreach ($tag in @('AgenticInstance','AgenticApp')) {
            $sp = [pscustomobject]@{
                displayName          = 'some-agent-123'
                servicePrincipalType = 'Application'
                tags                 = @('WindowsAzureActiveDirectoryIntegratedApp', $tag)
            }
            Get-FGServicePrincipalType -ServicePrincipal $sp |
                Should -Be 'AIAgent' -Because "Entra Agent ID tag '$tag' must trigger AIAgent"
        }
    }

    It 'classifies Power Virtual Agents tag prefix as AIAgent' {
        # PVA stamps per-instance tags of the form `power-virtual-agents-<guid>`
        # — we prefix-match because matching one-GUID-per-tag in a fixed list
        # obviously doesn't work.
        $sp = [pscustomobject]@{
            displayName          = 'Copilot Studio flow host'
            servicePrincipalType = 'Application'
            tags                 = @('power-virtual-agents-3fa85f64-5717-4562-b3fc-2c963f66afa6')
        }
        Get-FGServicePrincipalType -ServicePrincipal $sp | Should -Be 'AIAgent'
    }

    It 'does not match a displayName fragment against a tag-like unrelated name' {
        # 'gptools' contains 'gpt' as substring but not as a word — the built-in
        # pattern uses \bgpt\b. This guards against false positives on things
        # like "GitOps Toolkit".
        $sp = [pscustomobject]@{
            displayName          = 'GPTools Support'
            servicePrincipalType = 'Application'
            tags                 = @()
        }
        Get-FGServicePrincipalType -ServicePrincipal $sp | Should -Be 'ServicePrincipal'
    }

    It 'classifies AI displayNames as AIAgent (case-insensitive)' {
        foreach ($name in @('Microsoft Copilot', 'my-OpenAI-proxy', 'Team Bot', 'GPT Assistant')) {
            $sp = [pscustomobject]@{
                displayName          = $name
                servicePrincipalType = 'Application'
                tags                 = @()
            }
            Get-FGServicePrincipalType -ServicePrincipal $sp |
                Should -Be 'AIAgent' -Because "displayName '$name' should trigger AIAgent"
        }
    }

    It 'honours caller-supplied AINamePatterns' {
        $sp = [pscustomobject]@{
            displayName          = 'acme-agent-service'
            servicePrincipalType = 'Application'
            tags                 = @()
        }
        Get-FGServicePrincipalType -ServicePrincipal $sp -AINamePatterns @('acme-agent-') |
            Should -Be 'AIAgent'
    }

    It 'returns ServicePrincipal for an ordinary enterprise app' {
        $sp = [pscustomobject]@{
            displayName          = 'Jira Integration'
            servicePrincipalType = 'Application'
            tags                 = @('WindowsAzureActiveDirectoryIntegratedApp')
        }
        Get-FGServicePrincipalType -ServicePrincipal $sp | Should -Be 'ServicePrincipal'
    }

    It 'handles an SP with no tags and no displayName gracefully' {
        $sp = [pscustomobject]@{
            displayName          = $null
            servicePrincipalType = 'Application'
            tags                 = $null
        }
        Get-FGServicePrincipalType -ServicePrincipal $sp | Should -Be 'ServicePrincipal'
    }
}

Describe 'Function Availability — RiskScoring (v5 stubs)' {
    # In v5 these are stub functions that print a "not yet implemented" warning.
    # They still need to be exported so the module loads cleanly.
    It 'exports <_>' -ForEach @(
        'New-FGRiskProfile', 'New-FGRiskClassifiers',
        'Invoke-FGRiskScoring', 'Invoke-FGLLMRequest',
        'Save-FGRiskProfile', 'Save-FGRiskClassifiers', 'Save-FGResourceClusters',
        'Get-FGRiskProfile', 'Get-FGRiskClassifiers',
        'Export-FGRiskProfile', 'Export-FGRiskClassifiers',
        'Import-FGRiskProfile', 'Import-FGRiskClassifiers'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

Describe 'Removed Functions (must NOT exist in v5)' {
    It '<_> is gone' -ForEach @(
        # Direct SQL helpers — replaced by the Node ingest API in v5
        'Connect-FGSQLServer', 'New-FGSQLConnection', 'Test-FGSQLConnection',
        'Initialize-FGSQLTable', 'Invoke-FGSQLCommand', 'Invoke-FGSQLQuery',
        'Invoke-FGSQLBulkMerge', 'Invoke-FGSQLBulkDelete', 'Invoke-FGSQLBulkCopy',
        'Get-FGSQLTable', 'Get-FGSQLTableSchema', 'Clear-FGSQLTable',
        'Add-FGSQLTableColumn', 'New-FGSQLReadOnlyUser',
        'Initialize-FGSystemTables', 'Initialize-FGGovernanceTables',
        'Initialize-FGResourceViews', 'Initialize-FGResourceIndexes',
        'Initialize-FGAccessPackageViews', 'Initialize-FGGroupMembershipViews',
        'Initialize-FGGroupMembershipIndexes', 'Initialize-FGCrawlerTables',
        'Initialize-FGRiskScoreTables', 'Initialize-FGActivityTables',
        'New-FGAzureSQLServer', 'Remove-FGAzureSQLServer',
        'Write-FGSyncLog', 'Get-FGSyncLog',
        'Sync-FGGroupTransitiveMember',
        'Sync-FGUser', 'Sync-FGGroup', 'Start-FGSync', 'Start-FGCSVSync',
        'New-FGUI', 'Update-FGUI', 'Remove-FGUI', 'Set-FGUI',
        'New-FGAzureAutomationAccount',
        'Get-FGAutomationRunbook', 'Start-FGAutomationRunbook', 'Get-FGAutomationJob'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
    }
}

Describe 'Alias Verification' {
    It '<Alias> maps to <Function>' -ForEach @(
        @{ Function = 'Get-FGUser';           Alias = 'Get-User' },
        @{ Function = 'Get-FGGroup';          Alias = 'Get-Group' },
        @{ Function = 'Get-FGAccessToken';    Alias = 'Get-AccessToken' },
        @{ Function = 'Invoke-FGGetRequest';  Alias = 'Invoke-GetRequest' },
        @{ Function = 'Invoke-FGPostRequest'; Alias = 'Invoke-PostRequest' }
    ) {
        $a = Get-Alias $Alias -ErrorAction SilentlyContinue
        $a | Should -Not -BeNullOrEmpty
        $a.Definition | Should -Be $Function
    }
}

Describe 'File Structure' {
    It 'tools/powershell-sdk/graph folder exists' {
        $script:graphRoot | Should -Exist
    }
    It 'tools/powershell-sdk/helpers folder exists' {
        $script:helpersRoot | Should -Exist
    }
    It 'tools/riskscoring folder exists' {
        $script:riskRoot | Should -Exist
    }

    It 'all .ps1 files follow Verb-FGNoun naming' {
        $bad = $script:allPs1Files | Where-Object { $_.BaseName -notmatch '^[A-Z][a-z]+-FG[A-Z]' }
        $bad | Should -BeNullOrEmpty -Because "bad names: $($bad.BaseName -join ', ')"
    }

    It 'IdentityAtlas.psm1 dot-sources <_>' -ForEach @(
        "tools\powershell-sdk\graph",
        "tools\powershell-sdk\helpers",
        "tools\riskscoring"
    ) {
        $psm1 = Get-Content (Join-Path $script:repoRoot 'setup\IdentityAtlas.psm1') -Raw
        $psm1 | Should -Match ([regex]::Escape($_))
    }

    It 'app/db folder is gone (v5 — schema lives in postgres migrations)' {
        Join-Path $script:repoRoot 'app\db' | Should -Not -Exist
    }

    It 'app/api/src/db/migrations folder exists' {
        Join-Path $script:repoRoot 'app\api\src\db\migrations' | Should -Exist
    }

    It 'setup/azure folder is gone (Docker-only)' {
        Join-Path $script:repoRoot 'setup\azure' | Should -Not -Exist
    }
}

Describe 'Code Quality' {
    It 'all functions have [CmdletBinding()]' {
        $missing = $script:allPs1Files | Where-Object {
            $c = Get-Content $_.FullName -Raw
            $c -match '(?m)^function\s+' -and $c -notmatch '(?i)\[cmdletbinding\('
        }
        # v5 risk scoring stubs are simple function definitions without
        # [CmdletBinding()] — they're explicitly excluded.
        $missing = $missing | Where-Object { $_.FullName -notmatch 'riskscoring' }
        $missing | Should -BeNullOrEmpty -Because "missing in: $($missing.Name -join ', ')"
    }

    It 'no Dutch comments' {
        $dutch = @('# Controleer','# Verwijder','# Maak','# Als er','# Haal','# Sla op','# Voeg toe')
        $found = $script:allPs1Files | Where-Object {
            $c = Get-Content $_.FullName -Raw
            $dutch | Where-Object { $c -match [regex]::Escape($_) }
        }
        $found | Should -BeNullOrEmpty -Because "found in: $($found.Name -join ', ')"
    }

    It 'no hardcoded secrets' {
        $patterns = @('password\s*=\s*"[^"$]', 'secret\s*=\s*"[^"$]', 'Bearer\s+ey[A-Za-z0-9]')
        $found = $script:allPs1Files | Where-Object {
            $c = Get-Content $_.FullName -Raw
            $patterns | Where-Object { $c -match $_ }
        }
        $found | Should -BeNullOrEmpty -Because "secrets found in: $($found.Name -join ', ')"
    }
}

Describe 'Postgres Schema Files' {
    BeforeAll {
        $script:migrationsDir = Join-Path $script:repoRoot 'app\api\src\db\migrations'
    }

    It 'has at least one migration file' {
        (Get-ChildItem $script:migrationsDir -Filter '*.sql').Count | Should -BeGreaterOrEqual 1
    }

    It 'all migrations are numbered NNN_*.sql' {
        $bad = Get-ChildItem $script:migrationsDir -Filter '*.sql' | Where-Object {
            $_.Name -notmatch '^\d{3}_[a-z_]+\.sql$'
        }
        $bad | Should -BeNullOrEmpty -Because "bad names: $($bad.Name -join ', ')"
    }

    It 'no SQL Server-specific syntax in migration files' {
        $bad = Get-ChildItem $script:migrationsDir -Filter '*.sql' | Where-Object {
            $c = Get-Content $_.FullName -Raw
            $c -match '\bIDENTITY\s*\(' -or $c -match '\bNVARCHAR\b' -or
            $c -match '\bDATETIME2\b' -or $c -match '\bUNIQUEIDENTIFIER\b' -or
            $c -match 'SYSTEM_VERSIONING'
        }
        $bad | Should -BeNullOrEmpty -Because "found in: $($bad.Name -join ', ')"
    }
}
