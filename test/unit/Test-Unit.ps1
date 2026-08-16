# Unit Tests for FortigiGraph Module
# No Azure connection required — tests module structure, naming, and code quality
#
# Usage: pwsh -File _Test\Test-Unit.ps1

$ErrorActionPreference = "Continue"

# ── Test tracking ──────────────────────────────────────────────────────
$script:TestResults = @()
$script:TotalTests = 0
$script:PassedTests = 0
$script:FailedTests = 0
$script:ModuleLoaded = $false

function Write-TestHeader {
    param([string]$Message)
    Write-Host "`n$Message" -ForegroundColor Yellow
    Write-Host ("=" * $Message.Length) -ForegroundColor Yellow
}

function Add-TestResult {
    param(
        [string]$Category,
        [string]$TestName,
        [bool]$Passed,
        [string]$Message = ""
    )

    $script:TotalTests++
    if ($Passed) {
        $script:PassedTests++
        Write-Host "  ✓ $TestName" -ForegroundColor Green
    } else {
        $script:FailedTests++
        Write-Host "  ✗ $TestName — $Message" -ForegroundColor Red
    }

    $script:TestResults += [PSCustomObject]@{
        Category  = $Category
        TestName  = $TestName
        Passed    = $Passed
        Message   = $Message
    }
}

# Record one "function exists" result per name in a list
function Add-UTFunctionExistsResults {
    param([string[]]$Functions, [string]$Category)
    foreach ($func in $Functions) {
        $exists = $null -ne (Get-Command $func -ErrorAction SilentlyContinue)
        Add-TestResult -Category $Category -TestName "$func exists" -Passed $exists -Message $(if (-not $exists) { "Function not found" })
    }
}

# Record one alias-points-to-function result per pair in a list
function Add-UTAliasResults {
    param([object[]]$Pairs, [string]$Category)
    foreach ($pair in $Pairs) {
        $alias = Get-Alias $pair.Alias -ErrorAction SilentlyContinue
        $correct = $alias -and ($alias.Definition -eq $pair.Function)
        Add-TestResult -Category $Category -TestName "Alias $($pair.Alias) → $($pair.Function)" -Passed $correct -Message $(if (-not $correct) { "Alias missing or points to wrong function" })
    }
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 1: Module Import
# ══════════════════════════════════════════════════════════════════════
function Test-UTModuleImport {
    param([string]$ModuleRoot)
    Write-TestHeader "1. Module Import"

    $modulePath = Join-Path $ModuleRoot "IdentityAtlas.psd1"
    $script:ModuleLoaded = $false

    try {
        Import-Module $modulePath -Force -ErrorAction Stop
        $script:ModuleLoaded = $true
        Add-TestResult -Category "Import" -TestName "Module imports without errors" -Passed $true
    } catch {
        Add-TestResult -Category "Import" -TestName "Module imports without errors" -Passed $false -Message $_.Exception.Message
    }

    # Check module manifest
    try {
        $manifest = Test-ModuleManifest -Path $modulePath -ErrorAction Stop
        Add-TestResult -Category "Import" -TestName "Module manifest is valid" -Passed $true
    } catch {
        Add-TestResult -Category "Import" -TestName "Module manifest is valid" -Passed $false -Message $_.Exception.Message
    }

    # Check version format (Major.Minor.yyyyMMdd.HHmm)
    $psdContent = Get-Content $modulePath -Raw
    if ($psdContent -match "ModuleVersion\s*=\s*'(\d+\.\d+\.\d{8}\.\d{4})'") {
        Add-TestResult -Category "Import" -TestName "Version format is Major.Minor.yyyyMMdd.HHmm" -Passed $true
    } else {
        Add-TestResult -Category "Import" -TestName "Version format is Major.Minor.yyyyMMdd.HHmm" -Passed $false -Message "Could not match expected pattern"
    }

    if (-not $script:ModuleLoaded) {
        Write-Host "`nModule failed to load — cannot run remaining tests." -ForegroundColor Red
        Stop-Transcript | Out-Null
        exit 1
    }
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 2: Function Availability
# ══════════════════════════════════════════════════════════════════════
function Test-UTFunctionAvailability {
    Write-TestHeader "2. Function Availability — Base (20 functions)"
    $baseFunctions = @(
        "Get-FGAccessToken", "Get-FGAccessTokenInteractive", "Get-FGAccessTokenWithRefreshToken",
        "Get-FGAccessTokenDetail", "Confirm-FGAccessTokenValidity",
        "Update-FGAccessTokenIfExpired",
        "Invoke-FGGetRequest", "Invoke-FGGetRequestToFile",
        "Invoke-FGPostRequest", "Invoke-FGPatchRequest", "Invoke-FGPutRequest", "Invoke-FGDeleteRequest",
        "Use-FGExistingAccessTokenString", "Use-FGExistingMSALToken",
        "Read-FGToken", "Save-FGToken",
        "Test-FGConnection",
        "Get-FGSecureConfigValue", "Clear-FGSecureConfigValue", "Test-FGSecureConfigValue"
    )
    Add-UTFunctionExistsResults -Functions $baseFunctions -Category "Functions-Base"

    Write-TestHeader "2b. Function Availability — Generic (sample of 49)"
    $genericSample = @(
        "Get-FGUser", "Get-FGGroup", "Get-FGDevice", "Get-FGApplication", "Get-FGServicePrincipal",
        "Get-FGCatalog", "Get-FGAccessPackage", "Get-FGAccessPackagesAssignments", "Get-FGAccessPackagesPolicy",
        "Get-FGGroupMember", "Get-FGGroupMemberAll", "Get-FGGroupMemberAllToFile",
        "Get-FGGroupTransitiveMemberAll", "Get-FGGroupEligibleMemberAll",
        "Get-FGUserMail", "Get-FGUserMailFolder", "Get-FGUserManager", "Get-FGUserMemberOf",
        "New-FGGroup", "New-FGAccessPackage", "New-FGCatalog", "New-FGAccessPackagePolicy",
        "Set-FGAccessPackage", "Set-FGAccessPackagePolicy",
        "Add-FGGroupMember", "Add-FGGroupToAccessPackage", "Add-FGGroupToCatalog",
        "Remove-FGAccessPackage", "Remove-FGDevice", "Remove-FGGroupMember"
    )
    Add-UTFunctionExistsResults -Functions $genericSample -Category "Functions-Generic"

    # v5: SQL helper functions were removed in the postgres migration. The worker
    # container has no DB driver — all persistence flows through the REST API.

    Write-TestHeader "2d. Function Availability — Sync (16 functions)"
    $syncFunctions = @(
        "Start-FGSync",
        "Sync-FGUser", "Sync-FGGroup",
        "Sync-FGGroupMember", "Sync-FGGroupEligibleMember", "Sync-FGGroupOwner",
        "Sync-FGCatalog", "Sync-FGAccessPackage",
        "Sync-FGAccessPackageAssignment", "Sync-FGAccessPackageResourceRoleScope",
        "Sync-FGAccessPackageAssignmentPolicy", "Sync-FGAccessPackageAssignmentRequest",
        "Sync-FGAccessPackageAccessReview",
        "Initialize-FGSyncTable", "New-FGDataTableFromGraphObjects"
    )
    Add-UTFunctionExistsResults -Functions $syncFunctions -Category "Functions-Sync"

    Write-TestHeader "2e. Function Availability — Automation (8 functions)"
    $automationFunctions = @(
        "New-FGAzureAutomationAccount",
        "Get-FGAutomationRunbook", "Start-FGAutomationRunbook", "Get-FGAutomationJob",
        "New-FGUI", "Update-FGUI", "Remove-FGUI", "Set-FGUI"
    )
    Add-UTFunctionExistsResults -Functions $automationFunctions -Category "Functions-Automation"

    Write-TestHeader "2f. Function Availability — Specific (9 functions)"
    $specificFunctions = @(
        "Confirm-FGUser", "Confirm-FGGroup", "Confirm-FGGroupMember", "Confirm-FGNotGroupMember",
        "Confirm-FGCatalog", "Confirm-FGGroupInCatalog",
        "Confirm-FGAccessPackage", "Confirm-FGAccessPackagePolicy",
        "Confirm-FGAccessPackageResource"
    )
    Add-UTFunctionExistsResults -Functions $specificFunctions -Category "Functions-Specific"

    Write-TestHeader "2g. Function Availability — RiskScoring (13 functions)"
    $riskFunctions = @(
        "New-FGRiskProfile", "New-FGRiskClassifiers",
        "Invoke-FGRiskScoring", "Invoke-FGLLMRequest",
        "Save-FGRiskProfile", "Save-FGRiskClassifiers", "Save-FGResourceClusters",
        "Get-FGRiskProfile", "Get-FGRiskClassifiers",
        "Export-FGRiskProfile", "Export-FGRiskClassifiers",
        "Import-FGRiskProfile", "Import-FGRiskClassifiers"
    )
    Add-UTFunctionExistsResults -Functions $riskFunctions -Category "Functions-RiskScoring"

    Write-TestHeader "2h. Function Availability — Account Correlation (4 functions)"
    $correlationFunctions = @(
        "Invoke-FGAccountCorrelation",
        "New-FGCorrelationRuleset",
        "Get-FGCorrelationRuleset",
        "Save-FGCorrelationRuleset"
    )
    Add-UTFunctionExistsResults -Functions $correlationFunctions -Category "Functions-Correlation"

    # Verify correlation function aliases
    $correlationAliases = @(
        @{ Function = "Invoke-FGAccountCorrelation"; Alias = "Invoke-AccountCorrelation" },
        @{ Function = "New-FGCorrelationRuleset";    Alias = "New-CorrelationRuleset" },
        @{ Function = "Get-FGCorrelationRuleset";    Alias = "Get-CorrelationRuleset" },
        @{ Function = "Save-FGCorrelationRuleset";   Alias = "Save-CorrelationRuleset" }
    )
    Add-UTAliasResults -Pairs $correlationAliases -Category "Functions-Correlation"
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 3: Removed Function Verification
# ══════════════════════════════════════════════════════════════════════
function Test-UTRemovedFunctions {
    Write-TestHeader "3. Removed Functions (should NOT exist)"

    $removedFunctions = @(
        "Sync-FGGroupTransitiveMember"  # Replaced by vw_GraphGroupMembersRecursive SQL view
    )

    foreach ($func in $removedFunctions) {
        $exists = $null -ne (Get-Command $func -ErrorAction SilentlyContinue)
        Add-TestResult -Category "Removed" -TestName "$func should not exist" -Passed (-not $exists) -Message $(if ($exists) { "Function still present — should have been removed" })
    }
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 4: Alias Verification
# ══════════════════════════════════════════════════════════════════════
function Test-UTAliasVerification {
    Write-TestHeader "4. Alias Verification (sample)"

    $aliasPairs = @(
        @{ Function = "Get-FGUser";           Alias = "Get-User" },
        @{ Function = "Get-FGGroup";          Alias = "Get-Group" },
        @{ Function = "Get-FGAccessToken";    Alias = "Get-AccessToken" },
        @{ Function = "Invoke-FGGetRequest";  Alias = "Invoke-GetRequest" },
        @{ Function = "Invoke-FGPostRequest"; Alias = "Invoke-PostRequest" },
        @{ Function = "Invoke-FGPutRequest";  Alias = "Invoke-PutRequest" }
    )
    Add-UTAliasResults -Pairs $aliasPairs -Category "Aliases"
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 5: File Structure Validation
# ══════════════════════════════════════════════════════════════════════

# Check that all function folders exist
function Test-UTFolderStructure {
    param([string]$ModuleRoot, [string[]]$ExpectedFolders)
    foreach ($folder in $ExpectedFolders) {
        $path = Join-Path $ModuleRoot "Functions\$folder"
        $exists = Test-Path $path
        Add-TestResult -Category "Structure" -TestName "Functions/$folder folder exists" -Passed $exists -Message $(if (-not $exists) { "Folder not found" })
    }
}

# Check function file naming convention (Verb-FGNoun.ps1)
function Test-UTFileNaming {
    $badNames = @()
    foreach ($file in $script:AllPs1Files) {
        if ($file.BaseName -notmatch '^[A-Z][a-z]+-FG[A-Z]') {
            $badNames += $file.Name
        }
    }
    Add-TestResult -Category "Structure" -TestName "All function files follow Verb-FGNoun naming" -Passed ($badNames.Count -eq 0) -Message $(if ($badNames.Count -gt 0) { "Non-conforming: $($badNames -join ', ')" })
}

# Check one function per file
function Test-UTSingleFunctionPerFile {
    param([string]$ModuleRoot, [string[]]$ExpectedFolders)
    foreach ($folder in $ExpectedFolders) {
        $folderPath = Join-Path $ModuleRoot "Functions\$folder"
        if (-not (Test-Path $folderPath)) { continue }

        $files = Get-ChildItem -Path $folderPath -Filter "*.ps1"
        # Known exceptions: large orchestrators that intentionally contain private helper functions
        $knownMultiFunctionExceptions = @("Start-FGSync.ps1")

        foreach ($file in $files) {
            if ($file.Name -in $knownMultiFunctionExceptions) { continue }
            $content = Get-Content $file.FullName -Raw
            $functionCount = ([regex]::Matches($content, '(?m)^function\s+')).Count
            if ($functionCount -gt 1) {
                Add-TestResult -Category "Structure" -TestName "Single function per file: $($file.Name)" -Passed $false -Message "Contains $functionCount functions"
            }
        }
    }
    Add-TestResult -Category "Structure" -TestName "One function per file rule" -Passed (($script:TestResults | Where-Object { $_.TestName -like "Single function*" -and -not $_.Passed } | Measure-Object).Count -eq 0)
}

# Check IdentityAtlas.psm1 loads all expected categories
function Test-UTPsm1Categories {
    param([string]$ModuleRoot)
    $psm1Content = Get-Content (Join-Path $ModuleRoot "IdentityAtlas.psm1") -Raw
    $loadedCategories = @("functions\base", "functions\generic", "functions\specific", "functions\SQL", "functions\sync", "functions\automation")
    foreach ($cat in $loadedCategories) {
        $loaded = $psm1Content -match [regex]::Escape($cat)
        Add-TestResult -Category "Structure" -TestName "PSM1 loads $cat" -Passed $loaded -Message $(if (-not $loaded) { "Category not dot-sourced in IdentityAtlas.psm1" })
    }
}

function Test-UTFileStructure {
    param([string]$ModuleRoot)
    Write-TestHeader "5. File Structure Validation"

    $expectedFolders = @("Base", "Generic", "Specific", "SQL", "Sync", "Automation", "RiskScoring")
    Test-UTFolderStructure -ModuleRoot $ModuleRoot -ExpectedFolders $expectedFolders

    $script:AllPs1Files = Get-ChildItem -Path (Join-Path $ModuleRoot "Functions") -Include "*.ps1" -Recurse
    Test-UTFileNaming
    Test-UTSingleFunctionPerFile -ModuleRoot $ModuleRoot -ExpectedFolders $expectedFolders
    Test-UTPsm1Categories -ModuleRoot $ModuleRoot
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 6: Code Quality Checks
# ══════════════════════════════════════════════════════════════════════

# Check for [cmdletbinding()] on all functions
function Test-UTCmdletBinding {
    $missingCmdletBinding = @()
    foreach ($file in $script:AllPs1Files) {
        $content = Get-Content $file.FullName -Raw
        if ($content -match '(?m)^function\s+' -and $content -notmatch '(?i)\[cmdletbinding\(') {
            $missingCmdletBinding += $file.Name
        }
    }
    Add-TestResult -Category "Quality" -TestName "All functions have [cmdletbinding()]" -Passed ($missingCmdletBinding.Count -eq 0) -Message $(if ($missingCmdletBinding.Count -gt 0) { "Missing: $($missingCmdletBinding -join ', ')" })
}

# Check for Dutch comments
function Test-UTDutchComments {
    $dutchPatterns = @('# Controleer', '# Verwijder', '# Maak', '# Als er', '# Haal', '# Sla op', '# Voeg toe')
    $dutchFiles = @()
    foreach ($file in $script:AllPs1Files) {
        $content = Get-Content $file.FullName -Raw
        foreach ($pattern in $dutchPatterns) {
            if ($content -match [regex]::Escape($pattern)) {
                $dutchFiles += "$($file.Name) ($pattern)"
                break
            }
        }
    }
    Add-TestResult -Category "Quality" -TestName "No Dutch comments in code" -Passed ($dutchFiles.Count -eq 0) -Message $(if ($dutchFiles.Count -gt 0) { "Found in: $($dutchFiles -join ', ')" })
}

# Check for hardcoded secrets (basic patterns)
function Test-UTHardcodedSecrets {
    $secretPatterns = @(
        'password\s*=\s*"[^"$]',        # password = "literal"
        'secret\s*=\s*"[^"$]',          # secret = "literal"
        'apikey\s*=\s*"[^"$]',          # apikey = "literal"
        'Bearer\s+ey[A-Za-z0-9]'        # Bearer token
    )
    $hardcodedSecrets = @()
    foreach ($file in $script:AllPs1Files) {
        $content = Get-Content $file.FullName -Raw
        foreach ($pattern in $secretPatterns) {
            if ($content -match $pattern) {
                $hardcodedSecrets += $file.Name
                break
            }
        }
    }
    Add-TestResult -Category "Quality" -TestName "No hardcoded secrets in PowerShell files" -Passed ($hardcodedSecrets.Count -eq 0) -Message $(if ($hardcodedSecrets.Count -gt 0) { "Potential secrets in: $($hardcodedSecrets -join ', ')" })
}

# Check for Write-Output (should use return instead)
function Test-UTWriteOutput {
    $writeOutputFiles = @()
    foreach ($file in $script:AllPs1Files) {
        $content = Get-Content $file.FullName -Raw
        # New-FGAzureAutomationAccount.ps1 intentionally uses Write-Output inside runbook script strings
        if ($content -match 'Write-Output\s' -and $file.Name -ne 'New-FGAzureAutomationAccount.ps1') {
            $writeOutputFiles += $file.Name
        }
    }
    Add-TestResult -Category "Quality" -TestName "No Write-Output usage (use return instead)" -Passed ($writeOutputFiles.Count -eq 0) -Message $(if ($writeOutputFiles.Count -gt 0) { "Found in: $($writeOutputFiles -join ', ')" })
}

# Check for "More then one" typos
function Test-UTMoreThanOneTypo {
    $typoFiles = @()
    foreach ($file in $script:AllPs1Files) {
        $content = Get-Content $file.FullName -Raw
        if ($content -match 'More then one') {
            $typoFiles += $file.Name
        }
    }
    Add-TestResult -Category "Quality" -TestName 'No "More then one" typos (should be "than")' -Passed ($typoFiles.Count -eq 0) -Message $(if ($typoFiles.Count -gt 0) { "Found in: $($typoFiles -join ', ')" })
}

# Check for "cataloge" typos
function Test-UTCatalogeTypo {
    $catalogeFiles = @()
    foreach ($file in $script:AllPs1Files) {
        $content = Get-Content $file.FullName -Raw
        if ($content -match 'cataloge') {
            $catalogeFiles += $file.Name
        }
    }
    Add-TestResult -Category "Quality" -TestName 'No "cataloge" typos (should be "catalog")' -Passed ($catalogeFiles.Count -eq 0) -Message $(if ($catalogeFiles.Count -gt 0) { "Found in: $($catalogeFiles -join ', ')" })
}

# Check that $ReturnValue += is not used on first assignment in Base HTTP functions
function Test-UTReturnValueAssignment {
    param([string]$ModuleRoot)
    $baseHttpFiles = @("Invoke-FGPostRequest.ps1", "Invoke-FGPatchRequest.ps1", "Invoke-FGPutRequest.ps1", "Invoke-FGDeleteRequest.ps1")
    $returnValueIssues = @()
    foreach ($fileName in $baseHttpFiles) {
        $file = Join-Path $ModuleRoot "Functions\Base\$fileName"
        if (-not (Test-Path $file)) { continue }

        $lines = Get-Content $file
        $foundFirstAssignment = $false
        foreach ($line in $lines) {
            if ($line -match '\$ReturnValue\s*=\s*\$Result') {
                $foundFirstAssignment = $true
                break
            }
            if ($line -match '\$ReturnValue\s*\+=\s*\$Result') {
                $returnValueIssues += $fileName
                break
            }
        }
    }
    Add-TestResult -Category "Quality" -TestName "Base HTTP functions use = not += for first assignment" -Passed ($returnValueIssues.Count -eq 0) -Message $(if ($returnValueIssues.Count -gt 0) { "Issues in: $($returnValueIssues -join ', ')" })
}

function Test-UTCodeQuality {
    param([string]$ModuleRoot)
    Write-TestHeader "6. Code Quality Checks"

    Test-UTCmdletBinding
    Test-UTDutchComments
    Test-UTHardcodedSecrets
    Test-UTWriteOutput
    Test-UTMoreThanOneTypo
    Test-UTCatalogeTypo
    Test-UTReturnValueAssignment -ModuleRoot $ModuleRoot
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 7: Config Template Validation
# ══════════════════════════════════════════════════════════════════════
function Test-UTConfigTemplate {
    param([string]$ModuleRoot)
    Write-TestHeader "7. Config Template"

    $templatePath = Join-Path $ModuleRoot "Config\tenantname.json.template"
    $templateExists = Test-Path $templatePath
    Add-TestResult -Category "Config" -TestName "Config template exists" -Passed $templateExists

    if (-not $templateExists) { return }

    try {
        $template = Get-Content $templatePath -Raw | ConvertFrom-Json
        Add-TestResult -Category "Config" -TestName "Config template is valid JSON" -Passed $true

        # Check required sections
        $requiredSections = @("Azure", "Graph", "Sync")
        foreach ($section in $requiredSections) {
            $hasSection = $null -ne $template.$section
            Add-TestResult -Category "Config" -TestName "Template has '$section' section" -Passed $hasSection
        }
    } catch {
        Add-TestResult -Category "Config" -TestName "Config template is valid JSON" -Passed $false -Message $_.Exception.Message
    }
}

# ══════════════════════════════════════════════════════════════════════
# SECTION 8: Function Count Verification
# ══════════════════════════════════════════════════════════════════════
function Test-UTFunctionCount {
    param([string]$ModuleRoot)
    Write-TestHeader "8. Function Count Verification"

    $folderCounts = @{
        "Base"        = 21
        "Generic"     = @{ Min = 45; Max = 55 }   # Allow some variance
        "Specific"    = 9
        "SQL"         = @{ Min = 20; Max = 28 }
        "Sync"        = @{ Min = 14; Max = 18 }
        "Automation"  = 8
        "RiskScoring" = 13
    }

    foreach ($folder in $folderCounts.Keys) {
        $folderPath = Join-Path $ModuleRoot "Functions\$folder"
        if (-not (Test-Path $folderPath)) { continue }

        $count = (Get-ChildItem -Path $folderPath -Filter "*.ps1" | Measure-Object).Count
        $expected = $folderCounts[$folder]

        if ($expected -is [hashtable]) {
            $passed = $count -ge $expected.Min -and $count -le $expected.Max
            $expectedStr = "$($expected.Min)-$($expected.Max)"
        } else {
            $passed = $count -eq $expected
            $expectedStr = "$expected"
        }

        Add-TestResult -Category "Counts" -TestName "$folder has $count functions (expected $expectedStr)" -Passed $passed -Message $(if (-not $passed) { "Actual: $count" })
    }

    # Total function count
    $totalFiles = (Get-ChildItem -Path (Join-Path $ModuleRoot "Functions") -Include "*.ps1" -Recurse | Measure-Object).Count
    $totalInRange = $totalFiles -ge 135 -and $totalFiles -le 150
    Add-TestResult -Category "Counts" -TestName "Total functions: $totalFiles (expected ~140)" -Passed $totalInRange
}

# ══════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════
function Write-UTSummary {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Test Summary" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Total:  $($script:TotalTests)" -ForegroundColor White
    Write-Host "  Passed: $($script:PassedTests)" -ForegroundColor Green
    Write-Host "  Failed: $($script:FailedTests)" -ForegroundColor $(if ($script:FailedTests -gt 0) { "Red" } else { "Green" })

    # Category breakdown
    $categories = $script:TestResults | Group-Object Category
    foreach ($cat in $categories) {
        $passed = ($cat.Group | Where-Object Passed).Count
        $total = $cat.Group.Count
        $color = if ($passed -eq $total) { "Green" } else { "Yellow" }
        Write-Host "    $($cat.Name): $passed/$total" -ForegroundColor $color
    }

    if ($script:FailedTests -gt 0) {
        Write-Host "`nFailed Tests:" -ForegroundColor Red
        $script:TestResults | Where-Object { -not $_.Passed } | ForEach-Object {
            Write-Host "  ✗ [$($_.Category)] $($_.TestName): $($_.Message)" -ForegroundColor Red
        }
    }

    Write-Host ""

    Stop-Transcript | Out-Null
    Write-Host "Log saved to: $script:transcriptFile" -ForegroundColor Gray
}

# ── Entry point ─────────────────────────────────────────────────────────
$transcriptDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $transcriptDir)) { New-Item -ItemType Directory -Path $transcriptDir -Force | Out-Null }
$script:transcriptFile = Join-Path $transcriptDir "unit-test-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
Start-Transcript -Path $script:transcriptFile -Force | Out-Null

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "FortigiGraph Unit Test Suite" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "No Azure connection required`n" -ForegroundColor Gray

$moduleRoot = Split-Path -Parent $PSScriptRoot

Test-UTModuleImport -ModuleRoot $moduleRoot
Test-UTFunctionAvailability
Test-UTRemovedFunctions
Test-UTAliasVerification
Test-UTFileStructure -ModuleRoot $moduleRoot
Test-UTCodeQuality -ModuleRoot $moduleRoot
Test-UTConfigTemplate -ModuleRoot $moduleRoot
Test-UTFunctionCount -ModuleRoot $moduleRoot
Write-UTSummary

exit $(if ($script:FailedTests -gt 0) { 1 } else { 0 })
