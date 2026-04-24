<#
.SYNOPSIS
    Dispatches a CrawlerJob to the appropriate crawler script.

.DESCRIPTION
    Called by the scheduler when a job is picked up from dbo.CrawlerJobs.
    Dispatches based on jobType: demo, entra-id, csv.
    Updates progress in SQL during execution.

.PARAMETER JobId
    The CrawlerJobs.id for progress reporting.

.PARAMETER JobType
    One of: demo, entra-id, csv

.PARAMETER Config
    Hashtable parsed from the job's config JSON column.

.PARAMETER ApiKey
    The built-in crawler API key.
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)]
    [int]$JobId,

    [Parameter(Mandatory)]
    [string]$JobType,

    [Parameter(Mandatory = $false)]
    [hashtable]$Config = @{},

    [Parameter(Mandatory)]
    [string]$ApiKey
)

$ErrorActionPreference = 'Stop'
$apiBaseUrl = $env:WEB_API_URL
if (-not $apiBaseUrl) { $apiBaseUrl = 'http://web:3001/api' }
$apiBaseUrl = $apiBaseUrl.TrimEnd('/')

# In v5 the dispatcher updates job progress and result via the REST API.
# Both call the existing /api/crawlers/job-progress endpoint that the
# crawler scripts already use for fine-grained progress reporting.
function Update-JobProgress {
    param([string]$Step, [int]$Pct = 0, [string]$Detail = '')
    try {
        $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $body = @{ jobId = $JobId; step = $Step; pct = $Pct; detail = $Detail } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/job-progress" -Method Post -Headers $headers -Body $body -TimeoutSec 10 | Out-Null
    }
    catch {
        Write-Host "  Warning: failed to update progress — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Set-JobResult {
    param([hashtable]$Result)
    # In v5 the result is set via /crawlers/jobs/:id/complete which the
    # scheduler calls after this dispatcher returns. We can also call it now
    # to attach a partial result; for simplicity we just log and let the
    # scheduler do the final mark-complete.
    Write-Host "  Job result: $($Result | ConvertTo-Json -Compress)" -ForegroundColor Gray
}

# ─── Per-job trace log ───────────────────────────────────────────────
# Every line this dispatcher and its child scripts print is captured to
# /data/uploads/jobs/{id}.log so the UI's "Trace" tab can show operators
# exactly what the crawler was doing at each step — without requiring
# SSH into the worker container. The job_data volume is shared between
# worker and web, so the web container can read the file back out.
$traceDir  = '/data/uploads/jobs'
$traceFile = Join-Path $traceDir "$JobId.log"
$transcriptStarted = $false
try {
    New-Item -ItemType Directory -Path $traceDir -Force -ErrorAction SilentlyContinue | Out-Null
    Start-Transcript -Path $traceFile -Force | Out-Null
    $transcriptStarted = $true
} catch {
    Write-Host "  (trace: failed to start transcript: $($_.Exception.Message))" -ForegroundColor Yellow
}

# Retention — keep the 20 most recent job logs, drop the rest. Cheap to
# run here (a few dozen `stat`s against a single directory) and avoids
# adding a separate cron or web-bootstrap hook.
try {
    $keep = 20
    $all = Get-ChildItem -Path $traceDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending
    if ($all -and $all.Count -gt $keep) {
        $all | Select-Object -Skip $keep | Remove-Item -Force -ErrorAction SilentlyContinue
    }
} catch {
    # Non-fatal: a failed retention sweep never blocks the job itself.
}

try {
switch ($JobType) {

    'demo' {
        Update-JobProgress -Step 'Loading demo dataset' -Pct 10
        $datasetPath = '/app/test/demo-dataset/demo-company.json'
        $ingestScript = '/app/test/demo-dataset/Ingest-DemoDataset.ps1'

        if (-not (Test-Path $datasetPath)) {
            # Generate it first
            Update-JobProgress -Step 'Generating demo dataset' -Pct 5
            $genScript = '/app/test/demo-dataset/Generate-DemoDataset.ps1'
            if (Test-Path $genScript) {
                & $genScript
            } else {
                throw "Demo dataset not found at $datasetPath and generator not available"
            }
        }

        Update-JobProgress -Step 'Ingesting demo data' -Pct 30

        & $ingestScript -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -DatasetPath $datasetPath

        Update-JobProgress -Step 'Refreshing views' -Pct 90

        # Views are refreshed by the ingest script, but ensure it's done
        try {
            $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
            Invoke-RestMethod -Uri "$apiBaseUrl/ingest/refresh-views" -Method Post -Headers $headers -Body '{}' -ErrorAction SilentlyContinue
        } catch {}

        Update-JobProgress -Step 'Complete' -Pct 100
        Set-JobResult @{ status = 'Demo data loaded successfully' }
    }

    'entra-id' {
        Update-JobProgress -Step 'Preparing Entra ID sync' -Pct 5

        # Write a temporary config file for the crawler
        $tempConfig = "/tmp/entra-config-$JobId.json"
        $graphConfig = @{
            Graph = @{
                TenantId     = $Config['tenantId']
                ClientId     = $Config['clientId']
                ClientSecret = $Config['clientSecret']
            }
        }
        $graphConfig | ConvertTo-Json -Depth 5 | Set-Content $tempConfig -Encoding UTF8

        try {
            Update-JobProgress -Step 'Running Entra ID crawler' -Pct 10

            $crawlerParams = @{
                ApiBaseUrl = $apiBaseUrl
                ApiKey     = $ApiKey
                ConfigFile = $tempConfig
                JobId      = $JobId
            }

            # Forward sync mode. POST /admin/crawler-jobs stamps `_syncMode`
            # into the config blob from CrawlerConfigs.nextRunMode. Absent/
            # unknown values default to 'delta' so legacy configs keep
            # working (they simply haven't opted into delta yet — the
            # crawler's priming call still harvests a token the first run).
            $syncMode = if ($Config['_syncMode'] -in @('full','delta')) { $Config['_syncMode'] } else { 'delta' }
            $crawlerParams['SyncMode'] = $syncMode
            Write-Host "  Sync mode: $syncMode" -ForegroundColor Gray

            # Apply sync toggles from selectedObjects or direct config keys
            $objects = $Config['selectedObjects']
            if ($objects) {
                if ($objects.ContainsKey('identity'))           { $crawlerParams['SyncPrincipals']         = [bool]$objects['identity'] }
                if ($objects.ContainsKey('usersGroupsMembers')) {
                    $crawlerParams['SyncPrincipals']  = [bool]$objects['usersGroupsMembers']
                    $crawlerParams['SyncResources']   = [bool]$objects['usersGroupsMembers']
                    $crawlerParams['SyncAssignments'] = [bool]$objects['usersGroupsMembers']
                }
                if ($objects.ContainsKey('servicePrincipals'))  { $crawlerParams['SyncServicePrincipals']   = [bool]$objects['servicePrincipals'] }
                if ($objects.ContainsKey('identityGovernance')) { $crawlerParams['SyncGovernance']          = [bool]$objects['identityGovernance'] }
                if ($objects.ContainsKey('pim'))                { $crawlerParams['SyncPim']                 = [bool]$objects['pim'] }
                if ($objects.ContainsKey('signInLogs'))         { $crawlerParams['SyncSignInLogs']          = [bool]$objects['signInLogs'] }
                if ($objects.ContainsKey('oauth2Grants'))       { $crawlerParams['SyncOAuth2Grants']        = [bool]$objects['oauth2Grants'] }
            }
            # Direct sync toggles (backward compat)
            if ($Config.ContainsKey('syncPrincipals'))         { $crawlerParams['SyncPrincipals']         = [bool]$Config['syncPrincipals'] }
            if ($Config.ContainsKey('syncServicePrincipals'))   { $crawlerParams['SyncServicePrincipals']   = [bool]$Config['syncServicePrincipals'] }
            if ($Config.ContainsKey('syncResources'))           { $crawlerParams['SyncResources']           = [bool]$Config['syncResources'] }
            if ($Config.ContainsKey('syncAssignments'))         { $crawlerParams['SyncAssignments']         = [bool]$Config['syncAssignments'] }
            if ($Config.ContainsKey('syncGovernance'))          { $crawlerParams['SyncGovernance']          = [bool]$Config['syncGovernance'] }
            if ($Config.ContainsKey('syncSignInLogs'))          { $crawlerParams['SyncSignInLogs']          = [bool]$Config['syncSignInLogs'] }
            if ($Config.ContainsKey('signInLogsDays'))          { $crawlerParams['SignInLogsDays']          = [int]$Config['signInLogsDays'] }
            if ($Config.ContainsKey('syncOAuth2Grants'))        { $crawlerParams['SyncOAuth2Grants']        = [bool]$Config['syncOAuth2Grants'] }

            # Custom attributes — merge identityAttributes into CustomUserAttributes
            # so they're fetched in the same Graph call AND included in identity records
            $userAttrs = @()
            if ($Config['customUserAttributes']) { $userAttrs += @($Config['customUserAttributes']) }
            if ($Config['identityAttributes']) { $userAttrs += @($Config['identityAttributes']) }
            $userAttrs = $userAttrs | Select-Object -Unique
            if ($userAttrs.Count -gt 0) {
                $crawlerParams['CustomUserAttributes'] = $userAttrs
            }
            if ($Config['customGroupAttributes']) {
                $crawlerParams['CustomGroupAttributes'] = @($Config['customGroupAttributes'])
            }
            if ($Config['aiNamePatterns']) {
                $crawlerParams['AINamePatterns'] = @($Config['aiNamePatterns'])
            }

            # Identity filter
            if ($Config['identityFilter'] -and $Config['identityFilter']['attribute']) {
                $crawlerParams['IdentityFilter'] = $Config['identityFilter']
            }

            & /app/tools/crawlers/entra-id/Start-EntraIDCrawler.ps1 @crawlerParams

            # ── Post-sync: build contexts from principal data ────────────
            Update-JobProgress -Step 'Building contexts from principal data' -Pct 80
            try {
                & /app/setup/docker/Build-FGContexts.ps1
            } catch {
                Write-Host "  Context build failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
            }

            # ── Post-sync: account-to-identity correlation ───────────────
            Update-JobProgress -Step 'Linking accounts to identities' -Pct 90
            try {
                if (Get-Command Invoke-FGAccountCorrelation -ErrorAction SilentlyContinue) {
                    Invoke-FGAccountCorrelation
                } else {
                    Write-Host "  Invoke-FGAccountCorrelation not available — skipping" -ForegroundColor Yellow
                }
            } catch {
                Write-Host "  Account correlation failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
            }

            Update-JobProgress -Step 'Complete' -Pct 100

            # If this was a full-mode run (operator-requested re-sync), flip
            # the source config back to delta so the next scheduled run uses
            # the fast path. Failure here is non-fatal: next run will just
            # also be full, which is slow but correct.
            if ($syncMode -eq 'full' -and $Config['_scheduledByConfigId']) {
                try {
                    $cid = [int]$Config['_scheduledByConfigId']
                    $headers = @{ 'Authorization' = "Bearer $ApiKey" }
                    Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/configs/$cid/mark-delta-mode" `
                        -Method Post -Headers $headers -TimeoutSec 10 | Out-Null
                    Write-Host "  Reset nextRunMode to 'delta' on config $cid" -ForegroundColor Gray
                } catch {
                    Write-Host "  (mark-delta-mode failed: $($_.Exception.Message))" -ForegroundColor DarkGray
                }
            }

            Set-JobResult @{ status = 'Entra ID sync completed successfully' }
        }
        finally {
            # Clean up temp config file (contains secrets)
            if (Test-Path $tempConfig) { Remove-Item $tempConfig -Force }
        }
    }

    'csv' {
        Update-JobProgress -Step 'Preparing CSV import' -Pct 5

        $csvFolder = $Config['csvFolder']
        if (-not $csvFolder) { $csvFolder = '/data/csv' }
        $systemName = $Config['systemName']
        if (-not $systemName) { $systemName = 'CSV Import' }
        $systemType = $Config['systemType']
        if (-not $systemType) { $systemType = 'CSV' }

        if (-not (Test-Path $csvFolder)) {
            throw "CSV folder not found: $csvFolder"
        }

        Update-JobProgress -Step 'Running CSV crawler' -Pct 10

        & /app/tools/crawlers/csv/Start-CSVCrawler.ps1 `
            -ApiBaseUrl $apiBaseUrl `
            -ApiKey $ApiKey `
            -CsvFolder $csvFolder `
            -SystemName $systemName `
            -SystemType $systemType `
            -JobId $JobId

        # Post-sync: contexts + account correlation
        Update-JobProgress -Step 'Building contexts from principal data' -Pct 80
        try { & /app/setup/docker/Build-FGContexts.ps1 } catch { Write-Host "  Context build failed: $($_.Exception.Message)" -ForegroundColor Yellow }

        Update-JobProgress -Step 'Linking accounts to identities' -Pct 90
        try {
            if (Get-Command Invoke-FGAccountCorrelation -ErrorAction SilentlyContinue) { Invoke-FGAccountCorrelation }
        } catch { Write-Host "  Account correlation failed: $($_.Exception.Message)" -ForegroundColor Yellow }

        Update-JobProgress -Step 'Complete' -Pct 100
        Set-JobResult @{ status = 'CSV import completed successfully' }
    }

    'azure-devops' {
        Update-JobProgress -Step 'Preparing Azure DevOps sync' -Pct 5

        $credentials  = $Config['credentials']
        $orgUrl       = $credentials['organizationUrl']
        $secret       = $Config['_resolvedSecret']   # resolved from vault by scheduler/jobs.js

        if (-not $orgUrl) { throw "Azure DevOps config is missing credentials.organizationUrl" }
        if (-not $secret)  { throw "Azure DevOps config is missing resolved credential — job may have been queued without secret resolution" }

        Update-JobProgress -Step 'Running Azure DevOps crawler' -Pct 10

        $crawlerParams = @{
            ApiBaseUrl      = $apiBaseUrl
            ApiKey          = $ApiKey
            OrganizationUrl = $orgUrl
            Secret          = $secret
            JobId           = $JobId
        }

        # Map selectedObjects to crawler switches
        $objects = $Config['selectedObjects']
        if ($objects) {
            if ($objects.ContainsKey('users'))    { $crawlerParams['SyncUsers']    = [bool]$objects['users'] }
            if ($objects.ContainsKey('projects')) { $crawlerParams['SyncProjects'] = [bool]$objects['projects'] }
            if ($objects.ContainsKey('teams'))    { $crawlerParams['SyncTeams']    = [bool]$objects['teams'] }
            if ($objects.ContainsKey('groups'))   { $crawlerParams['SyncGroups']   = [bool]$objects['groups'] }
            if ($objects.ContainsKey('repos'))    { $crawlerParams['SyncRepos']    = [bool]$objects['repos'] }
        }

        # Options
        $options = $Config['options']
        if ($options) {
            if ($options.ContainsKey('correlateWithEntraId')) { $crawlerParams['CorrelateWithEntraId'] = [bool]$options['correlateWithEntraId'] }
            if ($options.ContainsKey('includeStakeholders'))  { $crawlerParams['IncludeStakeholders']  = [bool]$options['includeStakeholders'] }
        }

        & /app/tools/crawlers/azure-devops/Start-AzureDevOpsCrawler.ps1 @crawlerParams

        Update-JobProgress -Step 'Linking accounts to identities' -Pct 90
        try {
            if (Get-Command Invoke-FGAccountCorrelation -ErrorAction SilentlyContinue) {
                Invoke-FGAccountCorrelation
            }
        } catch {
            Write-Host "  Account correlation failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
        }

        Update-JobProgress -Step 'Complete' -Pct 100
        Set-JobResult @{ status = 'Azure DevOps sync completed successfully' }
    }

    default {
        throw "Unknown job type: $JobType"
    }
}
} finally {
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
}
