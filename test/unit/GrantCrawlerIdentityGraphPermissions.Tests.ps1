#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Guards azure/Grant-CrawlerIdentityGraphPermissions.ps1: the permissions it
    grants the crawler identity are exactly the ones the Entra ID crawler wizard
    checks for, and none of them can write.

.DESCRIPTION
    The script itself talks to Microsoft Graph through a signed-in Azure CLI, so
    it is exercised against a real tenant rather than here. What can drift
    silently is its permission list — a permission added to the crawler but not
    to the script leaves every managed-identity deployment one permission short.

.USAGE
    Invoke-Pester -Path test/unit/GrantCrawlerIdentityGraphPermissions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $scriptText = Get-Content (Join-Path $script:repoRoot 'azure' 'Grant-CrawlerIdentityGraphPermissions.ps1') -Raw
    $region = [regex]::Match($scriptText, '(?s)#region GraphPermissions(.*?)#endregion GraphPermissions').Groups[1].Value
    $script:granted = @([regex]::Matches($region, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })

    # GRAPH_PERMISSION_MAP in discover.js: `'<guid>': '<Permission.Name>',`
    $discover = Get-Content (Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id' 'discover.js') -Raw
    $map = [regex]::Match($discover, '(?s)const GRAPH_PERMISSION_MAP = \{(.*?)\n\};').Groups[1].Value
    $script:checked = @([regex]::Matches($map, "'[0-9a-f-]{36}':\s*'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
}

Describe 'Grant-CrawlerIdentityGraphPermissions.ps1' {
    It 'reads both lists (guard against a vacuous green)' {
        $script:granted.Count | Should -BeGreaterThan 8
        $script:checked.Count | Should -BeGreaterThan 8
    }

    It 'grants exactly the permissions the crawler wizard checks' {
        ($script:granted | Sort-Object) -join ',' | Should -Be (($script:checked | Sort-Object) -join ',')
    }

    It 'grants read permissions only' {
        $script:granted | Where-Object { $_ -notmatch '\.Read\.' } | Should -BeNullOrEmpty
        $script:granted | Where-Object { $_ -match 'Write' } | Should -BeNullOrEmpty
    }
}
