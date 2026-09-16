# Simple diagnostic test to check if things are working
# Run this first to verify setup

param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigFile = (Join-Path $PSScriptRoot "config.iidemo.json")
)

# Secure config functions now loaded from module (Get-FGSecureConfigValue, etc.)

# Start transcript (unique per config file) and print the banner
function Start-STTranscript {
    $configBaseName = [System.IO.Path]::GetFileNameWithoutExtension($ConfigFile)
    $script:transcriptFile = Join-Path $PSScriptRoot "logs\simple-test-$configBaseName.log"
    Start-Transcript -Path $script:transcriptFile -Force

    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "FortigiGraph Simple Diagnostic Test" -ForegroundColor Cyan
    Write-Host "============================================`n" -ForegroundColor Cyan
    Write-Host "Transcript logging to: $script:transcriptFile`n" -ForegroundColor Gray
}

# Test 1: Check config file exists
function Test-STConfigFile {
    Write-Host "[1/5] Checking config file..." -ForegroundColor Yellow
    if (Test-Path $ConfigFile) {
        Write-Host "  ✓ Config file found: $ConfigFile" -ForegroundColor Green
        $script:config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        Write-Host "  ✓ Config loaded successfully" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Config file not found: $ConfigFile" -ForegroundColor Red
        exit 1
    }
}

# Test 2: Check module
function Test-STModule {
    Write-Host "`n[2/5] Checking module..." -ForegroundColor Yellow
    $moduleRoot = Split-Path -Parent $PSScriptRoot
    $modulePath = Join-Path $moduleRoot "IdentityAtlas.psd1"

    if (-not (Test-Path $modulePath)) {
        Write-Host "  ✗ Module file not found" -ForegroundColor Red
        exit 1
    }

    Write-Host "  ✓ Module file found: $modulePath" -ForegroundColor Green
    try {
        Import-Module $modulePath -Force
        Write-Host "  ✓ Module imported successfully" -ForegroundColor Green
    } catch {
        Write-Host "  ✗ Failed to import module: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# Test 3: Check Azure context
function Test-STAzureContext {
    Write-Host "`n[3/5] Checking Azure connection..." -ForegroundColor Yellow
    try {
        $azContext = Get-AzContext -ErrorAction SilentlyContinue

        # Check if we have a context at all
        if (-not $azContext) {
            Write-Host "  → Not connected to Azure. Connecting to tenant..." -ForegroundColor Yellow
            Connect-AzAccount -TenantId $config.Graph.TenantId -SubscriptionId $config.Azure.SubscriptionId
            $azContext = Get-AzContext
        } else {
            # We have a context, but is it the right tenant and subscription?
            $correctTenant = $azContext.Tenant.Id -eq $config.Graph.TenantId
            $correctSubscription = $azContext.Subscription.Id -eq $config.Azure.SubscriptionId

            if (-not $correctTenant -or -not $correctSubscription) {
                Write-Host "  → Switching to correct tenant/subscription..." -ForegroundColor Yellow
                Write-Host "    Current Tenant: $($azContext.Tenant.Id)" -ForegroundColor Gray
                Write-Host "    Target Tenant: $($config.Graph.TenantId)" -ForegroundColor Gray

                # Try to switch context
                try {
                    Set-AzContext -TenantId $config.Graph.TenantId -SubscriptionId $config.Azure.SubscriptionId -ErrorAction Stop | Out-Null
                    $azContext = Get-AzContext
                } catch {
                    # Context doesn't exist for this tenant/subscription, need to reconnect
                    Write-Host "  → Context not found. Connecting to tenant..." -ForegroundColor Yellow
                    Connect-AzAccount -TenantId $config.Graph.TenantId -SubscriptionId $config.Azure.SubscriptionId
                    $azContext = Get-AzContext
                }
            }
        }

        if ($azContext) {
            Write-Host "  ✓ Azure context verified" -ForegroundColor Green
            Write-Host "    Account: $($azContext.Account.Id)" -ForegroundColor Cyan
            Write-Host "    Tenant: $($azContext.Tenant.Id)" -ForegroundColor Cyan
            Write-Host "    Subscription: $($azContext.Subscription.Name) ($($azContext.Subscription.Id))" -ForegroundColor Cyan
        } else {
            Write-Host "  ✗ Failed to connect to Azure" -ForegroundColor Red
            exit 1
        }
    } catch {
        Write-Host "  ✗ Azure connection failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# Test 4: Validate config values
function Test-STConfigValues {
    Write-Host "`n[4/5] Validating configuration..." -ForegroundColor Yellow
    $issues = @()

    if ([string]::IsNullOrWhiteSpace($config.Azure.SubscriptionId) -or $config.Azure.SubscriptionId -like "YOUR-*") {
        $issues += "Azure.SubscriptionId not set"
    }
    if ([string]::IsNullOrWhiteSpace($config.Graph.TenantId) -or $config.Graph.TenantId -like "YOUR-*") {
        $issues += "Graph.TenantId not set"
    }
    if ([string]::IsNullOrWhiteSpace($config.Graph.ClientId) -or $config.Graph.ClientId -like "YOUR-*") {
        $issues += "Graph.ClientId not set"
    }

    if ($issues.Count -gt 0) {
        Write-Host "  ✗ Configuration issues found:" -ForegroundColor Red
        foreach ($issue in $issues) {
            Write-Host "    - $issue" -ForegroundColor Yellow
        }
        Write-Host "`n  Please edit: $ConfigFile" -ForegroundColor Yellow
        exit 1
    } else {
        Write-Host "  ✓ Configuration validated" -ForegroundColor Green
    }
}

# Test 5: Check Graph SDK functions are available (v5: no SQL helpers)
function Test-STGraphFunctions {
    Write-Host "`n[5/5] Checking Graph SDK functions..." -ForegroundColor Yellow
    $functions = @(
        "Get-FGAccessToken",
        "Invoke-FGGetRequest",
        "Invoke-FGPostRequest",
        "Get-FGUser",
        "Get-FGGroup",
        "Get-FGAccessPackage"
    )

    $missing = @()
    foreach ($func in $functions) {
        if (Get-Command $func -ErrorAction SilentlyContinue) {
            Write-Host "  ✓ $func" -ForegroundColor Green
        } else {
            $missing += $func
            Write-Host "  ✗ $func" -ForegroundColor Red
        }
    }

    if ($missing.Count -gt 0) {
        Write-Host "`n  Missing functions - module may not be properly loaded" -ForegroundColor Red
        exit 1
    }
}

# Summary + stop transcript (only reached when every check passed)
function Write-STSummary {
    Write-Host "`n============================================" -ForegroundColor Cyan
    Write-Host "All checks passed! ✓" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "`nYou're ready to run the full integration test:" -ForegroundColor White
    Write-Host "  pwsh -File _Test\Test-Integration.ps1 -ConfigFile $ConfigFile" -ForegroundColor Cyan
    Write-Host ""

    # Stop transcript
    Stop-Transcript
    Write-Host "Diagnostic log saved to: $script:transcriptFile" -ForegroundColor Cyan
}

Start-STTranscript
Test-STConfigFile
Test-STModule
Test-STAzureContext
Test-STConfigValues
Test-STGraphFunctions
Write-STSummary
